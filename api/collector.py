"""
collector.py - 키오스크 서버 비동기 폴링 + 상태 관리

- httpx AsyncClient로 순차 요청 (코너 간 1초 대기)
- 파싱 로직은 kiosk/scraper.py와 동일
- SSE 구독자에게 asyncio.Queue로 업데이트 푸시
"""
import asyncio
import json
import logging
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional, Set

import httpx
from bs4 import BeautifulSoup

from models import Period, Room, StatusResponse

# ── 설정 ──────────────────────────────────────────────
KIOSK_URL = "http://165.132.176.173/booking/main_list.php"
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; practice-room-monitor/1.0)"}
ROOMS_FILE = Path(__file__).parent / "rooms.json"
INTER_CORNER_DELAY = 1.0   # 코너 간 대기(초)
REQUEST_TIMEOUT = 5.0
SLOT_START_HOUR = 7
SLOT_MINUTES = 10
# ──────────────────────────────────────────────────────

log = logging.getLogger(__name__)


# ── 슬롯 상태 상수 ─────────────────────────────────────
class S:
    PAST = "past"
    BOOKED = "booked"
    BLOCKED = "blocked"
    AVAILABLE = "available"
# ──────────────────────────────────────────────────────


def _slot_to_dt(slot_idx: int) -> datetime:
    today = datetime.now().replace(second=0, microsecond=0)
    total_min = SLOT_START_HOUR * 60 + slot_idx * SLOT_MINUTES
    return today.replace(hour=total_min // 60, minute=total_min % 60)


def _slot_status(li) -> str:
    title = li.get("title", "")
    bgcolor = li.get("bgcolor", "")
    img = li.find("img")
    src = img.get("src", "") if img else ""

    if "지난 시간" in title:
        return S.PAST
    if bgcolor == "#333333" or "예약불가" in title:
        return S.BLOCKED
    if "time_blue" in src or "예약된" in title:
        return S.BOOKED
    if li.find("a") and ("time_gray" in src or "time_green" in src):
        return S.AVAILABLE
    if li.find("a"):
        return S.AVAILABLE
    return S.PAST


def _parse_html(html: str, corner_no: int) -> List[Room]:
    soup = BeautifulSoup(html, "html.parser")
    rooms: List[Room] = []

    for seat_div in soup.select("div.Body-List"):
        title_td = seat_div.select_one("div.title tr td:nth-child(2)")
        name = title_td.get_text(strip=True) if title_td else "알 수 없음"

        # 층 번호 (방 번호 첫 자리)
        m = re.search(r"(\d)\d{2}호", name)
        floor = int(m.group(1)) if m else 0

        # 슬롯 파싱 (img 기준 → 부모 <li> 상태)
        slots: Dict[int, str] = {}
        contents = seat_div.select_one("div.contents")
        if contents:
            for img in contents.find_all("img", class_=re.compile(r"^time_cell")):
                cell_id = img.get("id", "")
                match = re.match(r"time_cell_\d+_(\d+)$", cell_id)
                if not match:
                    continue
                idx = int(match.group(1))
                li = img.find_parent("li")
                if li is None:
                    continue
                status = _slot_status(li)
                if idx not in slots or status == S.AVAILABLE:
                    slots[idx] = status

        # 연속 예약 가능 구간 계산 (PAST 슬롯 제외)
        available_periods: List[Period] = []
        period_start: Optional[datetime] = None
        for idx in sorted(slots):
            if slots[idx] == S.PAST:
                continue
            dt = _slot_to_dt(idx)
            st = slots[idx]
            if st == S.AVAILABLE:
                if period_start is None:
                    period_start = dt
            else:
                if period_start is not None:
                    available_periods.append(Period(
                        start=period_start.strftime("%H:%M"),
                        end=dt.strftime("%H:%M"),
                    ))
                    period_start = None
        if period_start is not None:
            last_dt = _slot_to_dt(max(slots)) + timedelta(minutes=SLOT_MINUTES)
            available_periods.append(Period(
                start=period_start.strftime("%H:%M"),
                end=last_dt.strftime("%H:%M"),
            ))

        # 현재 슬롯: 키오스크 PAST 마커 기준 (서버 타임존 독립)
        sorted_idxs = sorted(slots)
        current_idx: Optional[int] = None
        current_status = S.PAST
        for idx in sorted_idxs:
            if slots[idx] != S.PAST:
                current_idx = idx
                current_status = slots[idx]
                break

        occupied = current_status == S.BOOKED
        occupied_until: Optional[str] = None

        # 반납 직전 handover 감지:
        # 이전 슬롯이 BOOKED였는데 현재 슬롯이 AVAILABLE로 바뀐 경우
        # → 키오스크가 다음 예약을 허용하지만 실제 방은 아직 사용 중
        if current_idx is not None and current_status == S.AVAILABLE:
            prev_booked = [i for i in sorted_idxs if i < current_idx and slots[i] == S.BOOKED]
            if prev_booked:
                occupied = True
                occupied_until = (_slot_to_dt(current_idx) + timedelta(minutes=SLOT_MINUTES)).strftime("%H:%M")
                # 현재 슬롯을 available_periods에서 제거 (아직 사용 중)
                current_slot_time = _slot_to_dt(current_idx).strftime("%H:%M")
                available_periods = [p for p in available_periods if p.start != current_slot_time]

        # 사용중이면 현재 슬롯 이후 첫 번째 비BOOKED 슬롯이 반납 시각
        if occupied and occupied_until is None and current_idx is not None:
            for idx in sorted_idxs:
                if idx > current_idx and slots[idx] != S.BOOKED:
                    occupied_until = _slot_to_dt(idx).strftime("%H:%M")
                    break

        rooms.append(Room(
            name=name,
            corner_no=corner_no,
            floor=floor,
            occupied=occupied,
            occupied_until=occupied_until,
            available_periods=available_periods,
        ))

    return rooms


# ── 전역 상태 ──────────────────────────────────────────
_state: Optional[StatusResponse] = None
_subscribers: Set[asyncio.Queue] = set()
_lock = asyncio.Lock()
# ──────────────────────────────────────────────────────


def get_state() -> Optional[StatusResponse]:
    return _state


def subscribe() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    _subscribers.add(q)
    return q


def unsubscribe(q: asyncio.Queue) -> None:
    _subscribers.discard(q)


async def _notify() -> None:
    if _state is None:
        return
    data = _state.model_dump()
    for q in list(_subscribers):
        await q.put(data)


def _load_corners() -> List[int]:
    with open(ROOMS_FILE, encoding="utf-8") as f:
        return sorted(int(k) for k in json.load(f))


async def _fetch_corner(client: httpx.AsyncClient, corner_no: int) -> List[Room]:
    try:
        res = await client.get(
            KIOSK_URL,
            params={"corner_no": corner_no, "TimeCellSize": 0, "page": ""},
            timeout=REQUEST_TIMEOUT,
        )
        if res.status_code != 200:
            log.warning("corner_no=%d → HTTP %d", corner_no, res.status_code)
            return []
        return _parse_html(res.text, corner_no)
    except httpx.RequestError as e:
        log.warning("corner_no=%d 요청 실패: %s", corner_no, e)
        return []


async def _refresh(client: httpx.AsyncClient, corners: List[int]) -> None:
    global _state
    all_rooms: List[Room] = []

    for corner_no in corners:
        rooms = await _fetch_corner(client, corner_no)
        all_rooms.extend(rooms)
        await asyncio.sleep(INTER_CORNER_DELAY)

    if not all_rooms:
        log.warning("방 목록이 비어있습니다 — 키오스크 접근 불가 또는 push 모드. 기존 상태 유지.")
        return

    occupied_count = sum(1 for r in all_rooms if r.occupied)
    available_count = sum(1 for r in all_rooms if r.available_periods)

    async with _lock:
        _state = StatusResponse(
            updated_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            total=len(all_rooms),
            occupied_count=occupied_count,
            available_count=available_count,
            rooms=all_rooms,
        )

    log.info(
        "갱신 완료 | 전체 %d개 | 사용중 %d | 예약가능 %d",
        len(all_rooms), occupied_count, available_count,
    )
    await _notify()


async def polling_loop(interval: int = 60) -> None:
    """FastAPI lifespan에서 백그라운드 태스크로 실행."""
    corners = _load_corners()
    log.info("폴링 시작 | corner %s | %d초 간격", corners, interval)

    async with httpx.AsyncClient(headers=HEADERS) as client:
        while True:
            try:
                await _refresh(client, corners)
            except Exception:
                log.exception("_refresh 오류")
            await asyncio.sleep(interval)
