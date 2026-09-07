"""
collector.py - 키오스크 서버 비동기 폴링 + 상태 관리

- httpx AsyncClient로 순차 요청 (코너 간 1초 대기)
- 파싱 로직은 kiosk/scraper.py와 동일
- SSE 구독자에게 asyncio.Queue로 업데이트 푸시
"""
import asyncio
import json
import logging
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional, Set

import httpx
from bs4 import BeautifulSoup

from models import Period, Room, StatusResponse
from clock import now as kst_now

# ── 설정 ──────────────────────────────────────────────
KIOSK_URL = "http://165.132.176.173/booking/main_list.php"
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; practice-room-monitor/1.0)"}
ROOMS_FILE = Path(__file__).parent / "rooms.json"
INTER_CORNER_DELAY = 1.0   # 코너 간 대기(초)
REQUEST_TIMEOUT = 5.0
SLOT_START_HOUR = 7
SLOT_MINUTES = 10
PENDING_TAG_GRACE_SECONDS = max(0, int(os.getenv("PENDING_TAG_GRACE_SECONDS", "20")))
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
    today = kst_now().replace(second=0, microsecond=0)
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
        handover = False

        # 현재 10분 슬롯은 BOOKED지만 바로 다음 슬롯이 AVAILABLE이면
        # 키오스크에서 곧 예약 가능한 회색 슬롯이 보이는 상태다. 이때만
        # handover로 표시해야 장시간 사용 중인 방까지 '곧 가능'이 되지 않는다.
        if (
            current_idx is not None
            and current_status == S.BOOKED
            and slots.get(current_idx + 1) == S.AVAILABLE
        ):
            handover = True
            occupied_until = _slot_to_dt(current_idx + 1).strftime("%H:%M")

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
            handover=handover,
            available_periods=available_periods,
        ))

    return rooms


# ── 전역 상태 ──────────────────────────────────────────
_state: Optional[StatusResponse] = None
_subscribers: Set[asyncio.Queue] = set()
_lock = asyncio.Lock()
_pending_reservations: Dict[tuple[int, str], dict] = {}
# 주기 폴링과 예약 직후 강제 갱신이 겹치면 같은 키오스크 페이지를 여러 번
# 읽게 된다. 실제 조회는 언제나 하나만 실행하고, 동시 강제 갱신은 같은 작업을
# 함께 기다린다.
_refresh_gate = asyncio.Lock()
_manual_refresh_task: asyncio.Task[None] | None = None
# 취소/반납 직후 같은 코너를 여러 사용자가 동시에 갱신해도
# 원본 조회는 코너당 한 번만 수행한다.
_corner_refresh_tasks: Dict[int, asyncio.Task[bool]] = {}
_corner_versions: Dict[int, int] = {}
# ──────────────────────────────────────────────────────


def get_state() -> Optional[StatusResponse]:
    return _state


def subscribe() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    _subscribers.add(q)
    return q


def unsubscribe(q: asyncio.Queue) -> None:
    _subscribers.discard(q)


async def mark_reserved(corner_no: int, room_no: str, *, start_at: datetime,
                        end_at: datetime, tag_deadline: datetime, status: str = "pending_tag",
                        reservation_id: str | None = None) -> None:
    """예약 성공 직후부터 키오스크 반영 전까지 인증대기/사용중을 보인다."""
    global _state
    suffix = f"{room_no}호"
    _pending_reservations[(corner_no, room_no)] = {
        "start_at": start_at, "end_at": end_at, "tag_deadline": tag_deadline,
        "status": status, "reservation_id": reservation_id,
    }
    _corner_versions[corner_no] = _corner_versions.get(corner_no, 0) + 1
    if _state is None:
        return
    async with _lock:
        rooms = []
        changed = False
        for room in _state.rooms:
            if room.corner_no == corner_no and re.search(r"(?<!\d)" + re.escape(suffix) + r"(?:\D|$)", room.name) is not None:
                room = room.model_copy(update={
                    "occupied": True,
                    "handover": False,
                    "available_periods": [],
                    "reservation_state": status,
                    "reservation_start": start_at.strftime("%H:%M"),
                    "tag_deadline": tag_deadline.strftime("%H:%M"),
                })
                changed = True
            rooms.append(room)
        if not changed:
            return
        _state = _state.model_copy(update={
            "rooms": rooms,
            "occupied_count": sum(1 for room in rooms if room.occupied),
            "available_count": sum(1 for room in rooms if room.available_periods),
            "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        })
    await _notify()


async def clear_reserved(corner_no: int, room_no: str, *, reservation_id: str | None = None) -> bool:
    """예약 취소 성공 후 앱 전용 선점을 해제한다.

    현재 Room을 무조건 공실로 바꾸지는 않는다. 그 사이 다른 사용자가
    예약했을 수도 있으므로 refresh_corner_now()가 학교 원본으로 확정한다.
    """
    key = (corner_no, room_no)
    overlay = _pending_reservations.get(key)
    if overlay is None:
        # 서버 재시작 후에는 메모리 오버레이가 없어도 학교 취소/반납
        # 성공 후 상태 갱신은 필요하다.
        _corner_versions[corner_no] = _corner_versions.get(corner_no, 0) + 1
        return False
    if reservation_id is not None and overlay.get("reservation_id") != reservation_id:
        # 느게 도착한 예전 취소/반납이 이미 새로 예약된 같은 방의
        # 선점을 지우지 못하게 한다.
        return False
    _pending_reservations.pop(key, None)
    _corner_versions[corner_no] = _corner_versions.get(corner_no, 0) + 1
    return True


async def mark_active(corner_no: int, room_no: str, *, start_at: datetime, end_at: datetime,
                      reservation_id: str | None = None) -> None:
    await mark_reserved(corner_no, room_no, start_at=start_at, end_at=end_at,
                        tag_deadline=start_at + timedelta(minutes=10), status="active",
                        reservation_id=reservation_id)


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
    all_rooms: List[Room] = []
    seen_names: set[str] = set()

    for page in ["", "2", "3", "4"]:
        try:
            res = await client.get(
                KIOSK_URL,
                params={"corner_no": corner_no, "TimeCellSize": 0, "page": page},
                timeout=REQUEST_TIMEOUT,
            )
            if res.status_code != 200:
                log.warning("corner_no=%d page=%s → HTTP %d", corner_no, page or "1", res.status_code)
                break
            rooms = _parse_html(res.text, corner_no)
            new_rooms = [room for room in rooms if room.name not in seen_names]
            if not new_rooms:
                break
            all_rooms.extend(new_rooms)
            seen_names.update(room.name for room in new_rooms)
        except httpx.RequestError as e:
            log.warning("corner_no=%d page=%s 요청 실패: %s", corner_no, page or "1", e)
            break

    return all_rooms


def _apply_pending_overlays(rooms: List[Room]) -> List[Room]:
    """학교 원본 위에 앱이 확정한 인증대기/사용중 선점을 적용한다."""
    now_local = kst_now()
    result = list(rooms)
    for key, overlay in list(_pending_reservations.items()):
        expires_at = (
            overlay["tag_deadline"] + timedelta(seconds=PENDING_TAG_GRACE_SECONDS)
            if overlay["status"] == "pending_tag" else overlay["end_at"]
        )
        if overlay["status"] != "uncertain" and expires_at <= now_local:
            _pending_reservations.pop(key, None)
            continue
        corner_no, room_no = key
        suffix = f"{room_no}호"
        for index, room in enumerate(result):
            if room.corner_no == corner_no and re.search(r"(?<!\d)" + re.escape(suffix) + r"(?:\D|$)", room.name) is not None:
                result[index] = room.model_copy(update={
                    "occupied": True,
                    "handover": False,
                    "available_periods": [],
                    "reservation_state": overlay["status"],
                    "reservation_start": overlay["start_at"].strftime("%H:%M"),
                    "tag_deadline": overlay["tag_deadline"].strftime("%H:%M"),
                })
                break
    return result


def _status_with_rooms(rooms: List[Room]) -> StatusResponse:
    return StatusResponse(
        updated_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        total=len(rooms),
        occupied_count=sum(1 for room in rooms if room.occupied),
        available_count=sum(1 for room in rooms if room.available_periods),
        rooms=rooms,
    )


async def _refresh_one_corner(corner_no: int) -> bool:
    """취소/반납한 방이 속한 코너만 원본에서 다시 읽는다."""
    global _state
    # 전체 49개 폴링을 기다리지 않고 해당 코너를 바로 읽는다.
    # 취소 전에 시작한 전체 폴링은 코너 세대 검사로 덮어쓰기를 막는다.
    async with httpx.AsyncClient(headers=HEADERS) as client:
        fetched = await _fetch_corner(client, corner_no)
    if not fetched:
        # 조회 실패를 공실로 오인하는 것보다 기존 상태 유지가 안전하다.
        log.warning("corner_no=%d 즉시 갱신 실패 — 기존 상태 유지", corner_no)
        return False

    fetched = _apply_pending_overlays(fetched)
    async with _lock:
        if _state is None:
            return False
        rooms: List[Room] = []
        inserted = False
        for room in _state.rooms:
            if room.corner_no != corner_no:
                rooms.append(room)
            elif not inserted:
                rooms.extend(fetched)
                inserted = True
        if not inserted:
            rooms.extend(fetched)
        _state = _status_with_rooms(rooms)

    log.info("corner_no=%d 즉시 갱신 완료 | %d개", corner_no, len(fetched))
    await _notify()
    return True


async def _refresh_corner_until_current(corner_no: int) -> bool:
    """조회 도중 추가 취소가 생기면 가장 최신 세대까지 다시 읽는다."""
    while True:
        version = _corner_versions.get(corner_no, 0)
        refreshed = await _refresh_one_corner(corner_no)
        if _corner_versions.get(corner_no, 0) == version:
            return refreshed


async def refresh_corner_now(corner_no: int) -> bool:
    """동시 요청을 코너당 하나의 최신 학교 조회 작업으로 합친다."""
    task = _corner_refresh_tasks.get(corner_no)
    if task is None or task.done():
        task = asyncio.create_task(_refresh_corner_until_current(corner_no))
        _corner_refresh_tasks[corner_no] = task
    try:
        return await asyncio.shield(task)
    except Exception:
        # 학교에서 취소/반납이 이미 성공했다면 후속 화면 갱신
        # 실패가 그 성공 응답을 500으로 바꾸어서는 안 된다.
        log.exception("corner_no=%d 즉시 갱신 오류", corner_no)
        return False
    finally:
        if task.done() and _corner_refresh_tasks.get(corner_no) is task:
            _corner_refresh_tasks.pop(corner_no, None)


async def _refresh(client: httpx.AsyncClient, corners: List[int]) -> None:
    global _state
    all_rooms: List[Room] = []
    # 전체 조회 시작 후 취소/반납된 코너는 이 느린 결과로
    # 덮지 않고, 즉시 갱신된 현재 상태를 보존한다.
    versions_at_start = {corner_no: _corner_versions.get(corner_no, 0) for corner_no in corners}

    for corner_no in corners:
        rooms = await _fetch_corner(client, corner_no)
        all_rooms.extend(rooms)
        await asyncio.sleep(INTER_CORNER_DELAY)

    if not all_rooms:
        log.warning("방 목록이 비어있습니다 — 키오스크 접근 불가 또는 push 모드. 기존 상태 유지.")
        return

    all_rooms = _apply_pending_overlays(all_rooms)

    async with _lock:
        changed_corners = {
            corner_no for corner_no, version in versions_at_start.items()
            if _corner_versions.get(corner_no, 0) != version
        }
        if changed_corners and _state is not None:
            current_by_corner = {
                corner_no: [room for room in _state.rooms if room.corner_no == corner_no]
                for corner_no in changed_corners
            }
            merged: List[Room] = []
            inserted: Set[int] = set()
            for room in all_rooms:
                if room.corner_no not in changed_corners:
                    merged.append(room)
                elif room.corner_no not in inserted:
                    merged.extend(current_by_corner.get(room.corner_no, []))
                    inserted.add(room.corner_no)
            for corner_no in changed_corners - inserted:
                merged.extend(current_by_corner.get(corner_no, []))
            all_rooms = merged
        _state = _status_with_rooms(all_rooms)

    log.info(
        "갱신 완료 | 전체 %d개 | 사용중 %d | 예약가능 %d",
        len(all_rooms), _state.occupied_count, _state.available_count,
    )
    await _notify()


async def _refresh_serial(corners: List[int]) -> None:
    """키오스크 전체 조회는 프로세스당 한 번만 수행한다."""
    async with _refresh_gate:
        async with httpx.AsyncClient(headers=HEADERS) as client:
            await _refresh(client, corners)


async def polling_loop(interval: int = 60) -> None:
    """FastAPI lifespan에서 백그라운드 태스크로 실행."""
    corners = _load_corners()
    log.info("폴링 시작 | corner %s | %d초 간격", corners, interval)

    while True:
        try:
            await _refresh_serial(corners)
        except Exception:
            log.exception("_refresh 오류")
        await asyncio.sleep(interval)


async def refresh_now() -> None:
    """예약/취소 직후 상태를 즉시 원본 키오스크에서 다시 읽는다.

    60명이 동시에 반납해도 전체 조회는 한 번만 보낸다. 호출자는 그 한 번의
    결과를 함께 기다리므로, 오래된 폴링 결과가 새 상태를 덮어쓰지 않는다.
    """
    global _manual_refresh_task
    if _manual_refresh_task is None or _manual_refresh_task.done():
        async def run() -> None:
            try:
                await _refresh_serial(_load_corners())
            except Exception:
                # return/cancel 요청은 이미 키오스크에서 성공했을 수 있다.
                # 후속 화면 갱신 실패가 그 성공 응답을 뒤집지 않게 로그만 남긴다.
                log.exception("즉시 키오스크 상태 갱신 오류")

        _manual_refresh_task = asyncio.create_task(run())
    await asyncio.shield(_manual_refresh_task)
