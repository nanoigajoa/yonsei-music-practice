"""
pusher.py - 캠퍼스 네트워크에서 키오스크 스크레이핑 후 Fly.io에 업로드

실행: python3 pusher.py
종료: Ctrl+C
"""
import asyncio
import logging
import os
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional

import duckdb
import httpx
from bs4 import BeautifulSoup

# ── 설정 ──────────────────────────────────────────────
KIOSK_URL    = "http://165.132.176.173/booking/main_list.php"
API_URL      = os.getenv("KIOSK_API_URL", "https://yonsei-practice-api.fly.dev")
PUSH_SECRET  = os.getenv("PUSH_SECRET",   "ujBAVj56uI7ZEam0Q4uK4DZhzdcYyW9Hi4IQsAe5GQc")
INTERVAL     = int(os.getenv("PUSH_INTERVAL", "60"))   # 초
ROOMS_FILE   = Path(__file__).parent / "api" / "rooms.json"
DB_PATH      = Path(os.getenv("SNAPSHOT_DB", Path.home() / ".yonsei-practice" / "snapshots.duckdb"))

HEADERS      = {"User-Agent": "Mozilla/5.0 (compatible; practice-room-monitor/1.0)"}
REQUEST_TIMEOUT    = 10.0
INTER_CORNER_DELAY = 1.0
SLOT_START_HOUR    = 7
SLOT_MINUTES       = 10
# ──────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(message)s",
    datefmt="%H:%M:%S",
    stream=sys.stdout,
)
log = logging.getLogger(__name__)


# ── 슬롯 상태 ─────────────────────────────────────────
class S:
    PAST      = "past"
    BOOKED    = "booked"
    BLOCKED   = "blocked"
    AVAILABLE = "available"


def _slot_to_dt(idx: int) -> datetime:
    today     = datetime.now().replace(second=0, microsecond=0)
    total_min = SLOT_START_HOUR * 60 + idx * SLOT_MINUTES
    return today.replace(hour=total_min // 60, minute=total_min % 60)


def _slot_status(li) -> str:
    title  = li.get("title", "")
    bgcolor = li.get("bgcolor", "")
    img    = li.find("img")
    src    = img.get("src", "") if img else ""

    if "지난 시간" in title:             return S.PAST
    if bgcolor == "#333333" or "예약불가" in title: return S.BLOCKED
    if "time_blue" in src or "예약된" in title:     return S.BOOKED
    if li.find("a") and ("time_gray" in src or "time_green" in src): return S.AVAILABLE
    if li.find("a"):
        log.info("⚠ 슬롯분류불명 src=%s title=%s bgcolor=%s", src.split("/")[-1], title[:20], bgcolor)
        return S.AVAILABLE
    return S.PAST


def _parse_html(html: str, corner_no: int) -> List[dict]:
    soup  = BeautifulSoup(html, "html.parser")
    rooms = []

    for seat_div in soup.select("div.Body-List"):
        title_td = seat_div.select_one("div.title tr td:nth-child(2)")
        name     = title_td.get_text(strip=True) if title_td else "알 수 없음"

        m     = re.search(r"(\d)\d{2}호", name)
        floor = int(m.group(1)) if m else 0

        slots: Dict[int, str] = {}
        contents = seat_div.select_one("div.contents")
        if contents:
            for img in contents.find_all("img", class_=re.compile(r"^time_cell")):
                cell_id = img.get("id", "")
                match   = re.match(r"time_cell_\d+_(\d+)$", cell_id)
                if not match:
                    continue
                idx = int(match.group(1))
                li  = img.find_parent("li")
                if li is None:
                    continue
                status = _slot_status(li)
                if idx not in slots or status == S.AVAILABLE:
                    slots[idx] = status

        # 연속 예약가능 구간
        available_periods: List[dict] = []
        period_start: Optional[datetime] = None
        for idx in sorted(slots):
            dt = _slot_to_dt(idx)
            if slots[idx] == S.AVAILABLE:
                if period_start is None:
                    period_start = dt
            else:
                if period_start is not None:
                    available_periods.append({"start": period_start.strftime("%H:%M"),
                                              "end":   dt.strftime("%H:%M")})
                    period_start = None
        if period_start is not None:
            last_dt = _slot_to_dt(max(slots)) + timedelta(minutes=SLOT_MINUTES)
            available_periods.append({"start": period_start.strftime("%H:%M"),
                                      "end":   last_dt.strftime("%H:%M")})

        # 현재 슬롯 상태 (키오스크 PAST 마커 기준 — 로컬 시계/타임존 독립)
        # 키오스크가 직접 "지난 시간" 표시 → PAST 아닌 첫 슬롯 = 현재 슬롯
        current_idx: Optional[int] = None
        current_status = S.PAST
        for idx in sorted(slots):
            if slots[idx] != S.PAST:
                current_idx = idx
                current_status = slots[idx]
                break

        occupied       = current_status == S.BOOKED
        occupied_until: Optional[str] = None
        if occupied and current_idx is not None:
            for idx in sorted(slots):
                if idx > current_idx and slots[idx] != S.BOOKED:
                    occupied_until = _slot_to_dt(idx).strftime("%H:%M")
                    break

        rooms.append({
            "name":              name,
            "corner_no":         corner_no,
            "floor":             floor,
            "occupied":          occupied,
            "occupied_until":    occupied_until,
            "available_periods": available_periods,
        })

    return rooms


async def _fetch_corner(client: httpx.AsyncClient, corner_no: int) -> List[dict]:
    """코너별 전체 방 목록 수집 (페이지 pagination 대응)."""
    all_rooms: List[dict] = []
    seen_names: set = set()
    # 첫 페이지는 ""(빈 문자열), 이후 2, 3, … 으로 순회
    page_keys = ["", "2", "3", "4"]

    for page in page_keys:
        try:
            res = await client.get(
                KIOSK_URL,
                params={"corner_no": corner_no, "TimeCellSize": 0, "page": page},
                timeout=REQUEST_TIMEOUT,
            )
            if res.status_code != 200:
                log.warning("corner_no=%d page=%s HTTP %d", corner_no, page or "1", res.status_code)
                break
            html = res.content.decode(res.encoding or "utf-8", errors="replace")
            rooms = _parse_html(html, corner_no)
            new_rooms = [r for r in rooms if r["name"] not in seen_names]
            if not new_rooms:
                break   # 새 방 없음 → 페이지 끝
            for r in new_rooms:
                seen_names.add(r["name"])
            all_rooms.extend(new_rooms)
            if page:    # 1페이지 이후엔 짧은 딜레이
                await asyncio.sleep(0.3)
        except httpx.RequestError as e:
            log.warning("corner_no=%d page=%s 요청 실패: %s", corner_no, page or "1", e)
            break

    return all_rooms


def _load_corners() -> List[int]:
    import json
    with open(ROOMS_FILE, encoding="utf-8") as f:
        return sorted(int(k) for k in json.load(f))


# ── DuckDB 저장 ───────────────────────────────────────
def _init_db() -> None:
    """DB 파일·테이블 초기화 (없으면 생성)."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(DB_PATH))
    con.execute("""
        CREATE TABLE IF NOT EXISTS room_snapshots (
            captured_at      TIMESTAMPTZ NOT NULL,
            day_of_week      TINYINT     NOT NULL,
            hour_of_day      TINYINT     NOT NULL,
            minute_of_day    TINYINT     NOT NULL,
            room_name        VARCHAR     NOT NULL,
            floor            TINYINT     NOT NULL,
            corner_no        TINYINT     NOT NULL,
            occupied         BOOLEAN     NOT NULL,
            occupied_until   VARCHAR,
            avail_count      TINYINT     NOT NULL,
            next_avail_start VARCHAR,
            next_avail_end   VARCHAR
        )
    """)
    con.close()
    log.info("🦆 DuckDB 초기화 완료 | %s", DB_PATH)


def _save_snapshot(rooms: List[dict], captured_at: datetime) -> None:
    """현재 방 상태 스냅샷을 DuckDB에 저장."""
    dow = captured_at.weekday()   # 0=월 … 6=일
    rows = [
        (
            captured_at,
            dow,
            captured_at.hour,
            captured_at.minute,
            r["name"],
            r["floor"],
            r["corner_no"],
            r["occupied"],
            r.get("occupied_until"),
            len(r["available_periods"]),
            r["available_periods"][0]["start"] if r["available_periods"] else None,
            r["available_periods"][0]["end"]   if r["available_periods"] else None,
        )
        for r in rooms
    ]
    con = duckdb.connect(str(DB_PATH))
    con.executemany(
        "INSERT INTO room_snapshots VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        rows,
    )
    con.close()
# ──────────────────────────────────────────────────────


async def run():
    corners = _load_corners()
    _init_db()
    log.info("pusher 시작 | %d개 코너 | %ds 간격 | → %s", len(corners), INTERVAL, API_URL)

    async with httpx.AsyncClient(headers=HEADERS) as client:
        while True:
            now = datetime.now()
            try:
                all_rooms: List[dict] = []
                for corner_no in corners:
                    rooms = await _fetch_corner(client, corner_no)
                    all_rooms.extend(rooms)
                    await asyncio.sleep(INTER_CORNER_DELAY)

                occupied_count  = sum(1 for r in all_rooms if r["occupied"])
                available_count = sum(1 for r in all_rooms if r["available_periods"])

                payload = {
                    "updated_at":      now.isoformat(timespec="seconds"),
                    "total":           len(all_rooms),
                    "occupied_count":  occupied_count,
                    "available_count": available_count,
                    "rooms":           all_rooms,
                }

                resp = await client.post(
                    f"{API_URL}/push",
                    json=payload,
                    headers={"x-push-secret": PUSH_SECRET},
                    timeout=10,
                )
                resp.raise_for_status()
                log.info("✅ 업로드 완료 | 전체 %d개 | 사용중 %d | 공실 %d",
                         len(all_rooms), occupied_count, available_count)

                # DuckDB 로컬 저장 (실패해도 pusher 중단 안 함)
                try:
                    _save_snapshot(all_rooms, now)
                    log.info("🦆 DuckDB 저장 | %d rows", len(all_rooms))
                except Exception as db_err:
                    log.warning("DuckDB 저장 실패 (계속): %s", db_err)

            except Exception as e:
                log.error("❌ 오류: %s", e)

            await asyncio.sleep(INTERVAL)


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        log.info("종료")
