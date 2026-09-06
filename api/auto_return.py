"""예약 종료 시각 후의 자동 반납 대기열.

태그 전 예약은 절대 반납하지 않는다. 실제로 태그된 사용만 예약 종료 시각부터
반납을 시도한다. 학교의 패널티 부여는 키오스크 측 규칙이므로 이 서비스는
반납 요청과 실패 로그만 담당한다.
"""
import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime

import booking
from clock import now as kst_now, normalize as kst_normalize

log = logging.getLogger(__name__)
RETRY_SECONDS = 60


@dataclass
class PendingReturn:
    uid: str
    student_id: str
    corner_no: int
    room_no: str
    due_at: datetime
    booking_no: str | None = None
    last_attempt: float = 0


_pending: dict[tuple[str, int, str], PendingReturn] = {}
_lock = asyncio.Lock()


async def register(uid: str, student_id: str, corner_no: int, room_no: str, *, due_at: datetime,
                   booking_no: str | None = None) -> None:
    async with _lock:
        _pending[(uid, corner_no, room_no)] = PendingReturn(
            uid=uid, student_id=student_id, corner_no=corner_no, room_no=room_no,
            due_at=kst_normalize(due_at), booking_no=booking_no,
        )


async def forget(uid: str, corner_no: int) -> None:
    async with _lock:
        for key in [key for key in _pending if key[0] == uid and key[1] == corner_no]:
            _pending.pop(key, None)


async def process_due(now: datetime | None = None) -> int:
    current = kst_normalize(now) if now else kst_now()
    timestamp = current.timestamp()
    async with _lock:
        due = [item for item in _pending.values()
               if current >= item.due_at and timestamp - item.last_attempt >= RETRY_SECONDS]
        for item in due:
            item.last_attempt = timestamp

    completed = 0
    for item in due:
        try:
            result = await booking.return_room(item.student_id, item.corner_no, item.booking_no)
        except Exception as exc:
            log.warning("자동 반납 실패, 재시도 예정 | room=%s error=%s", item.room_no, exc)
            continue
        if result.get("success") or result.get("message") == "활성 예약이 없습니다.":
            async with _lock:
                _pending.pop((item.uid, item.corner_no, item.room_no), None)
            completed += 1
            log.info("예약 종료 자동 반납 처리 | room=%s", item.room_no)
        else:
            log.warning("예약 종료 자동 반납 거절, 재시도 예정 | room=%s", item.room_no)
    return completed


async def scheduler_loop() -> None:
    while True:
        await process_due()
        await asyncio.sleep(30)


async def pending_count() -> int:
    async with _lock:
        return len(_pending)
