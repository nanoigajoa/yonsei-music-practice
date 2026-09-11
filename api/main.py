"""
main.py - 연습실 현황 API 서버

실행:
    uvicorn main:app --reload --port 8000

엔드포인트:
    GET /health        서버 상태 확인
    GET /status        전체 방 현황 (JSON 스냅샷)
    GET /stream        실시간 SSE 스트림
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
from datetime import datetime
from contextlib import asynccontextmanager

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

import collector
import booking
import auto_return
import community
import reservations
from auth_security import current_user, issue_return_token, student_key, verify_return_token
from models import StatusResponse
from pydantic import BaseModel, Field
from clock import now as kst_now, parse as parse_kst

PUSH_SECRET = os.getenv("PUSH_SECRET", "")
BOOKING_ENABLED = os.getenv("BOOKING_ENABLED", "false").lower() == "true"
AUTO_RETURN_ENABLED = os.getenv("AUTO_RETURN_ENABLED", "false").lower() == "true"
DAILY_RETURN_ENABLED = BOOKING_ENABLED and os.getenv("DAILY_RETURN_ENABLED", "true").lower() == "true"
MAX_CONCURRENT_KIOSK_RESERVATIONS = max(1, int(os.getenv("MAX_CONCURRENT_KIOSK_RESERVATIONS", "3")))
MAX_CONCURRENT_TAG_SYNC_CHECKS = max(1, int(os.getenv("MAX_CONCURRENT_TAG_SYNC_CHECKS", "3")))
TAG_SYNC_INTERVAL_SECONDS = max(3, int(os.getenv("TAG_SYNC_INTERVAL_SECONDS", "5")))
RECOVERY_INTERVAL_SECONDS = 15
_recovery_attempts: dict[str, float] = {}
_pending_missing_checks: dict[str, int] = {}
_inflight_reservations: set[str] = set()
_recovery_gate: asyncio.Semaphore | None = None
_recovery_gate_loop: asyncio.AbstractEventLoop | None = None

PRIVACY_NOTICE_VERSION = "2026-09-06"
ALLOWED_TEST_ROOMS = {
    room.strip() for room in os.getenv("ALLOWED_TEST_ROOMS", "").split(",") if room.strip()
}
ALLOWED_ORIGINS = [
    origin.strip() for origin in os.getenv("ALLOWED_ORIGINS", "http://localhost:3000").split(",")
    if origin.strip()
]

# ── 로깅 ───────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(name)s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)
# ──────────────────────────────────────────────────────

# 한 번에 수십 명이 다른 방을 눌러도 학교 키오스크에는 제한된 수만 전송한다.
# 이벤트 루프마다 gate를 따로 만들어 테스트/재시작 루프 간 공유 문제도 피한다.
_reservation_gate: asyncio.Semaphore | None = None
_reservation_gate_loop: asyncio.AbstractEventLoop | None = None
_tag_sync_gate: asyncio.Semaphore | None = None
_tag_sync_gate_loop: asyncio.AbstractEventLoop | None = None
# 같은 예약에 대한 태그 확인·취소·반납이 서로 덮어쓰지 않도록
# 예약 ID별로 직렬화한다. 값은 [lock, waiter_count]다.
_action_gates: dict[tuple[int, str], list] = {}


def _kiosk_reservation_gate() -> asyncio.Semaphore:
    global _reservation_gate, _reservation_gate_loop
    loop = asyncio.get_running_loop()
    if _reservation_gate is None or _reservation_gate_loop is not loop:
        _reservation_gate = asyncio.Semaphore(MAX_CONCURRENT_KIOSK_RESERVATIONS)
        _reservation_gate_loop = loop
    return _reservation_gate


def _kiosk_tag_sync_gate() -> asyncio.Semaphore:
    global _tag_sync_gate, _tag_sync_gate_loop
    loop = asyncio.get_running_loop()
    if _tag_sync_gate is None or _tag_sync_gate_loop is not loop:
        _tag_sync_gate = asyncio.Semaphore(MAX_CONCURRENT_TAG_SYNC_CHECKS)
        _tag_sync_gate_loop = loop
    return _tag_sync_gate


@asynccontextmanager
async def _reservation_action_gate(reservation_id: str):
    """같은 예약의 상태 변경과 학교 요청을 한 번에 하나씩 수행한다."""
    key = (id(asyncio.get_running_loop()), reservation_id)
    entry = _action_gates.get(key)
    if entry is None:
        entry = [asyncio.Lock(), 0]
        _action_gates[key] = entry
    entry[1] += 1
    acquired = False
    try:
        await entry[0].acquire()
        acquired = True
        yield
    finally:
        if acquired:
            entry[0].release()
        entry[1] -= 1
        if entry[1] == 0 and _action_gates.get(key) is entry:
            _action_gates.pop(key, None)


async def _mark_tagged_active(record: reservations.Reservation) -> bool:
    """학교의 인증 완료나 현장 취소를 pending_tag에 단 한 번 반영한다."""
    async with _reservation_action_gate(record.id):
        current = reservations.get(record.id)
        if not current or current.status != "pending_tag":
            _pending_missing_checks.pop(record.id, None)
            return False
        try:
            async with _kiosk_tag_sync_gate():
                result = await booking.pending_state_once(
                    current.student_id, current.corner_no, current.kiosk_booking_no,
                )
        except httpx.HTTPError as exc:
            _pending_missing_checks.pop(current.id, None)
            log.warning("자동 태그 상태 확인 실패 | room=%s error=%s", current.room_no, exc)
            return False
        state = result.get("state")
        if state == "missing":
            misses = _pending_missing_checks.get(current.id, 0) + 1
            _pending_missing_checks[current.id] = misses
            if misses < 2:
                return False
            cancelled = reservations.transition(current.id, expected_status="pending_tag", status="cancelled")
            if not cancelled:
                return False
            _pending_missing_checks.pop(current.id, None)
            await collector.clear_reserved(
                cancelled.corner_no, cancelled.room_no, reservation_id=cancelled.id,
            )
            await collector.refresh_corner_now(cancelled.corner_no)
            log.info("키오스크 현장 취소 확인 완료 | room=%s", cancelled.room_no)
            return False
        _pending_missing_checks.pop(current.id, None)
        if state != "active":
            return False
        active_record = reservations.transition(current.id, expected_status="pending_tag", status="active")
        if not active_record:
            return False
        await collector.mark_active(active_record.corner_no, active_record.room_no,
                                    start_at=active_record.start_at, end_at=active_record.end_at,
                                    reservation_id=active_record.id)
        if AUTO_RETURN_ENABLED:
            await auto_return.register(active_record.uid, active_record.student_id, active_record.corner_no,
                                       active_record.room_no, due_at=active_record.end_at,
                                       booking_no=active_record.kiosk_booking_no,
                                       reservation_id=active_record.id)
        log.info("태그 자동 확인 완료 | room=%s", active_record.room_no)
        return True


async def _reconcile_kiosk_return(record: reservations.Reservation) -> bool:
    """방 앞 키오스크에서 먼저 반납한 active 기록만 종료한다.

    로그인이 확인되고, 저장된 예약 번호가 활성·대기 목록 모두에서
    사라진 경우만 missing이다. 다른 활성 예약이 있거나 응답을 판독할 수
    없는 경우에는 기존 차단을 유지한다.
    """
    if record.status != "active" or not record.kiosk_booking_no:
        return False
    async with _reservation_action_gate(record.id):
        current = reservations.get(record.id)
        if not current or current.status != "active" or not current.kiosk_booking_no:
            return False
        try:
            state = await booking.pending_state_once(
                current.student_id, current.corner_no, current.kiosk_booking_no,
            )
        except httpx.HTTPError as exc:
            log.warning("키오스크 수동 반납 확인 실패 | room=%s error=%s", current.room_no, exc)
            return False
        if state.get("state") not in {"missing", "different_active"}:
            return False
        returned = reservations.set_status(current.id, "returned")
        if not returned or returned.status != "returned":
            return False
        if AUTO_RETURN_ENABLED:
            await auto_return.forget(returned.uid, returned.corner_no, reservation_id=returned.id)
        await collector.clear_reserved(returned.corner_no, returned.room_no, reservation_id=returned.id)
        await collector.refresh_corner_now(returned.corner_no)
        log.info("키오스크 수동 반납 동기화 완료 | room=%s", returned.room_no)
        return True


async def _publish_reservation(record: reservations.Reservation) -> None:
    if record.status == "active":
        await collector.mark_active(record.corner_no, record.room_no, start_at=record.start_at,
                                    end_at=record.end_at, reservation_id=record.id)
        if AUTO_RETURN_ENABLED:
            await auto_return.register(record.uid, record.student_id, record.corner_no, record.room_no,
                                       due_at=record.end_at, booking_no=record.kiosk_booking_no, reservation_id=record.id)
    elif record.status in {"pending_tag", "submitting", "uncertain"}:
        await collector.mark_reserved(record.corner_no, record.room_no, start_at=record.start_at,
                                      end_at=record.end_at, tag_deadline=record.tag_deadline,
                                      status="pending_tag" if record.status == "pending_tag" else "uncertain",
                                      reservation_id=record.id)


def _kiosk_recovery_gate() -> asyncio.Semaphore:
    global _recovery_gate, _recovery_gate_loop
    loop = asyncio.get_running_loop()
    if _recovery_gate is None or _recovery_gate_loop is not loop:
        _recovery_gate, _recovery_gate_loop = asyncio.Semaphore(1), loop
    return _recovery_gate


async def reservation_recovery_loop() -> None:
    while True:
        try:
            records = reservations.open_reservations()
            ids = {record.id for record in records}
            for old_id in list(_recovery_attempts):
                if old_id not in ids:
                    _recovery_attempts.pop(old_id, None)
            await asyncio.gather(*(_recover_uncertain(record) for record in records if record.status == "uncertain"))
        except Exception:
            log.exception("예약 결과 복구 작업 오류")
        await asyncio.sleep(RECOVERY_INTERVAL_SECONDS)


async def _recover_uncertain(record: reservations.Reservation) -> reservations.Reservation:
    """조회만 재시도한다. 일치하는 학교 증거가 없으면 선점을 그대로 유지한다."""
    if record.status != "uncertain" or record.id in _inflight_reservations:
        return record
    async with _reservation_action_gate(record.id):
        current = reservations.get(record.id) or record
        if current.status != "uncertain":
            return current
        timestamp = asyncio.get_running_loop().time()
        if timestamp - _recovery_attempts.get(current.id, float('-inf')) < RECOVERY_INTERVAL_SECONDS:
            return current
        _recovery_attempts[current.id] = timestamp
        if current.dispatch_started != 1 or current.duration_min not in (30, 60, 90, 120):
            # 구버전 기록에는 전송 계획이 없어 다른 예약을 잘못 연결할 수 있다.
            return current
        try:
            async with _kiosk_recovery_gate():
                evidence = await booking.recover_submission(current.student_id, current.corner_no, current.room_no,
                                                            current.start_at, current.duration_min)
            if not evidence:
                return current
            if (not evidence.get("booking_no") or evidence.get("room_no") != current.room_no
                    or parse_kst(evidence["start_at"]) != current.start_at
                    or evidence.get("duration_min") != current.duration_min
                    or evidence.get("status") not in {"pending_tag", "active"}):
                return current
            confirmed = reservations.finalize(current.id, start_at=current.start_at, duration_min=current.duration_min,
                                               kiosk_booking_no=evidence["booking_no"], status=evidence["status"])
            await _publish_reservation(confirmed)
            _recovery_attempts.pop(current.id, None)
            return confirmed
        except Exception:
            log.exception("학교 예약 결과 재확인 실패 | reservation=%s", current.id)
            return reservations.get(current.id) or current


def _require_same_request(record: reservations.Reservation, data: BookingRequest) -> None:
    if (record.corner_no != data.corner_no or record.room_no != data.room_no
            or record.student_key != student_key(data.student_id) or record.duration_min != data.limit_time):
        raise HTTPException(409, "같은 요청 번호의 방 또는 예약 시간을 변경할 수 없습니다.")


async def sync_pending_tags_once() -> int:
    """사용자가 앱을 열지 않아도 태그 완료와 현장 취소를 동기화한다."""
    expired = reservations.expire_pending()
    for record in expired:
        _pending_missing_checks.pop(record.id, None)
        await collector.clear_reserved(record.corner_no, record.room_no, reservation_id=record.id)
    if expired:
        # 미태그 자동 취소/이용 종료도 수동 취소와 동일하게
        # 해당 코너만 즉시 다시 읽어 잔류 선점 표시를 없앤다.
        await asyncio.gather(*(
            collector.refresh_corner_now(corner_no)
            for corner_no in sorted({record.corner_no for record in expired})
        ))

    now = kst_now()
    open_records = reservations.open_reservations()
    open_ids = {record.id for record in open_records}
    for old_id in list(_pending_missing_checks):
        if old_id not in open_ids:
            _pending_missing_checks.pop(old_id, None)
    pending = [record for record in open_records
               if record.status == "pending_tag" and now <= record.tag_deadline + reservations.PENDING_TAG_GRACE]
    results = await asyncio.gather(*(_mark_tagged_active(record) for record in pending))
    return sum(results)


async def pending_tag_sync_loop() -> None:
    while True:
        try:
            await sync_pending_tags_once()
        except Exception:
            log.exception("자동 태그 상태 동기화 오류")
        await asyncio.sleep(TAG_SYNC_INTERVAL_SECONDS)


# ── 서버 생명주기 ────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    interval = app.state.poll_interval
    task = asyncio.create_task(collector.polling_loop(interval))
    tag_task = asyncio.create_task(pending_tag_sync_loop())
    recovery_task = asyncio.create_task(reservation_recovery_loop())
    notifications_task = asyncio.create_task(community.notification_loop())
    # 미확정 요청은 학교 POST를 재실행하지 않고 durable 계획으로 조회 복구한다.
    for record in reservations.open_reservations():
        if record.status == "submitting" or (record.status == "creating" and record.dispatch_started is None):
            record = reservations.mark_uncertain(record.id) or record
        await _publish_reservation(record)
    return_task = asyncio.create_task(auto_return.scheduler_loop()) if AUTO_RETURN_ENABLED else None
    daily_task = asyncio.create_task(auto_return.daily_scheduler_loop(_daily_return)) if DAILY_RETURN_ENABLED else None
    log.info("백그라운드 폴링 시작 (%d초 간격)", interval)
    try:
        yield
    finally:
        tasks = [task, tag_task, recovery_task, notifications_task] + ([return_task] if return_task else []) + ([daily_task] if daily_task else [])
        for running in tasks:
            running.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        log.info("서버 종료")


app = FastAPI(
    title="연습실 현황 API",
    description="음악대학 연습실 실시간 예약 현황",
    version="0.1.0",
    lifespan=lifespan,
)
app.include_router(community.router)
app.state.poll_interval = max(10, int(os.getenv("POLL_INTERVAL_SECONDS", "20")))


app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["*"],
)


class BookingRequest(BaseModel):
    student_id: str = Field(pattern=r"^20\d{8}$")
    corner_no: int
    room_no: str = Field(pattern=r"^\d{3}$")
    limit_time: int = Field(default=120, ge=30, le=120, multiple_of=30)
    # 네트워크 재시도·브라우저 응답 유실에서도 키오스크 예약을 한 번만 보내기 위한 키.
    request_id: str | None = Field(default=None, min_length=16, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")


class BookingActionRequest(BaseModel):
    student_id: str = Field(pattern=r"^20\d{8}$")
    corner_no: int
    return_token: str = Field(min_length=20)


class KioskImportRequest(BaseModel):
    student_id: str = Field(pattern=r"^20\d{8}$")
    corner_no: int
    room_no: str = Field(pattern=r"^\d{3}$")


class StudentBindingRequest(BaseModel):
    student_id: str = Field(pattern=r"^20\d{8}$")
    privacy_notice_version: str | None = Field(default=None, max_length=32)


class BookingResultRequest(BaseModel):
    student_id: str = Field(pattern=r"^20\d{8}$")
    request_id: str = Field(min_length=16, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")


class CurrentBookingRequest(BaseModel):
    student_id: str = Field(pattern=r"^20\d{8}$")


def _result_for_existing_request(record: reservations.Reservation, user: dict, student_id: str) -> dict:
    """이미 처리 중이거나 완료된 동일 요청의 현재 결과를 안전하게 복원한다."""
    if record.status in reservations.UNCONFIRMED_STATUSES:
        return {
            "success": False, "pending": True, "request_id": record.request_id,
            "code": "confirmation_pending" if record.status == "uncertain" else "processing",
            "room_no": record.room_no, "corner_no": record.corner_no,
            "message": f"예약을 확정하지 못했습니다. {record.end_at:%H:%M} 이후 다시 예약할 수 있습니다." if record.status == "uncertain" else "예약 요청을 처리하고 있습니다.",
        }
    if record.status in {"pending_tag", "active"}:
        return {
            "success": True, "pending": False, "request_id": record.request_id,
            "room_no": record.room_no, "corner_no": record.corner_no,
            "message": f"{record.room_no}호 예약을 확인했습니다.",
            "return_token": issue_return_token(
                user["uid"], student_id, record.corner_no, record.room_no, record.id,
            ),
            "reservation": _reservation_payload(record),
        }
    return {
        "success": False, "pending": False, "request_id": record.request_id,
        "message": "이전 예약 요청은 완료되지 않았습니다. 다시 시도해 주세요.",
    }
# ──────────────────────────────────────────────────────


def _require_bound_student(user: dict, student_id: str) -> None:
    try:
        reservations.require_bound_student(user["uid"], student_key(student_id))
    except reservations.StudentBindingConflict as exc:
        raise HTTPException(403, str(exc)) from exc


def _require_google_account(user: dict) -> None:
    provider = user.get("firebase", {}).get("sign_in_provider")
    if provider != "google.com":
        raise HTTPException(403, "학번 등록은 Google 로그인 계정에서만 할 수 있습니다.")


@app.post("/identity/bind")
async def bind_student(data: StudentBindingRequest, user: dict = Depends(current_user)):
    """Google 계정과 학번을 최초 1회만 연결한다.

    학번 외의 예약 정보는 받지 않는다.
    """
    _require_google_account(user)
    key = student_key(data.student_id)
    # 기존 연결은 학교 서버 상태와 무관하게 빠르게 확인한다. 최초 등록만 학교
    # 키오스크 로그인을 검증해 형식만 그럴듯한 가짜 학번이 계정에 고정되지 않게 한다.
    if reservations.binding_for_uid(user["uid"]) is None:
        if data.privacy_notice_version != PRIVACY_NOTICE_VERSION:
            raise HTTPException(422, "개인정보 처리 안내를 확인해 주세요.")
        if reservations.binding_uid_for_key(key) is not None:
            raise HTTPException(409, "이 학번은 이미 다른 Google 계정에 등록되어 있습니다.")
        try:
            valid_student = await booking.validate_student(data.student_id)
        except httpx.HTTPError as exc:
            log.warning("최초 학번 확인 실패: %s", exc)
            raise HTTPException(502, "학교 키오스크에서 학번을 확인할 수 없습니다. 잠시 뒤 다시 시도해 주세요.") from exc
        if not valid_student:
            raise HTTPException(422, "학교 키오스크에서 확인되지 않는 학번입니다. 본인 학번을 다시 확인해 주세요.")
    try:
        created = reservations.bind_student(
            user["uid"], key,
            notice_version=PRIVACY_NOTICE_VERSION if data.privacy_notice_version == PRIVACY_NOTICE_VERSION else None,
        )
    except reservations.StudentBindingConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    return {
        "success": True,
        "message": "학번 등록을 완료했습니다." if created else "등록된 학번을 확인했습니다.",
        "created": created,
    }


@app.get("/health")
async def health():
    state = collector.get_state()
    return {
        "status": "ok",
        "data_ready": state is not None,
        "updated_at": state.updated_at if state else None,
        "booking_enabled": BOOKING_ENABLED,
        "school_access_allowed": True,
        "community_enabled": True,
        "auto_return_enabled": AUTO_RETURN_ENABLED or DAILY_RETURN_ENABLED,
        "daily_return_enabled": DAILY_RETURN_ENABLED,
        "daily_return_time": "21:50" if DAILY_RETURN_ENABLED else None,
    }


@app.get("/status", response_model=StatusResponse)
async def status(
    floor: int = Query(None, description="층 필터 (1~4). 생략 시 전체"),
    occupied: bool = Query(None, description="true=사용중만, false=공실만"),
    refresh_corner: int = Query(None, description="해당 구역만 학교에서 즉시 다시 조회"),
):
    state = collector.get_state()
    if state is None:
        raise HTTPException(503, "데이터 준비 중입니다. 잠시 후 다시 시도하세요.")
    if refresh_corner is not None:
        if refresh_corner not in booking.CORNER_NAMES:
            raise HTTPException(422, "지원하지 않는 구역입니다.")
        await collector.refresh_corner_now(refresh_corner)
        state = collector.get_state() or state

    rooms = state.rooms
    if floor is not None:
        rooms = [r for r in rooms if r.floor == floor]
    if occupied is not None:
        rooms = [r for r in rooms if r.occupied == occupied]

    return StatusResponse(
        updated_at=state.updated_at,
        total=len(rooms),
        occupied_count=sum(1 for r in rooms if r.occupied),
        available_count=sum(1 for r in rooms if r.available_periods),
        rooms=rooms,
    )


@app.get("/stream")
async def stream(request: Request):
    """
    SSE 실시간 스트림.
    - 연결 즉시 현재 상태 전송
    - 데이터 변경 시마다 이벤트 전송
    - 30초마다 heartbeat (연결 유지)
    """
    queue = collector.subscribe()

    async def generate():
        try:
            # 연결 즉시 현재 상태 전송
            state = collector.get_state()
            if state:
                yield _sse(state.model_dump())

            while True:
                if await request.is_disconnected():
                    break
                try:
                    data = await asyncio.wait_for(queue.get(), timeout=30)
                    yield _sse(data)
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"

        finally:
            collector.unsubscribe(queue)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # nginx 버퍼링 비활성화
        },
    )


@app.post("/booking/reserve")
async def reserve_room(data: BookingRequest, user: dict = Depends(current_user)):
    if not BOOKING_ENABLED:
        raise HTTPException(503, "예약 시험 기능이 비활성화되어 있습니다.")
    if "*" not in ALLOWED_TEST_ROOMS and data.room_no not in ALLOWED_TEST_ROOMS:
        raise HTTPException(403, "현재 시험이 허용된 방이 아닙니다.")
    _require_bound_student(user, data.student_id)
    if data.request_id:
        existing = reservations.find_by_request(user["uid"], data.request_id)
        if existing:
            _require_same_request(existing, data)
            return _result_for_existing_request(existing, user, data.student_id)
    # DB에 요청을 선점한 뒤에만 학교로 전송한다. 동시 재시도는 같은 행을 읽는다.
    async with _kiosk_reservation_gate():
        if data.request_id:
            existing = reservations.find_by_request(user["uid"], data.request_id)
            if existing:
                _require_same_request(existing, data)
                return _result_for_existing_request(existing, user, data.student_id)
        open_record = reservations.open_for_uid(user["uid"])
        if open_record and open_record.status == "active":
            await _reconcile_kiosk_return(open_record)
        try:
            intent = reservations.acquire(
                id=secrets.token_urlsafe(18), uid=user["uid"], student_id=data.student_id,
                student_key=student_key(data.student_id), corner_no=data.corner_no, room_no=data.room_no,
                request_id=data.request_id, duration_min=data.limit_time,
            )
        except reservations.ReservationConflict as exc:
            raise HTTPException(409, str(exc)) from exc

        async with _reservation_action_gate(intent.id):
            _inflight_reservations.add(intent.id)
            try:
                result = await booking.reserve(
                    data.student_id, data.corner_no, data.room_no, data.limit_time,
                    before_submit=lambda start: reservations.begin_submission(intent.id, start_at=start),
                )
                if result.get("success"):
                    if not result.get("start_at") or not result.get("booking_no"):
                        raise booking.ReservationOutcomeUnknown("학교 예약 증거가 불완전합니다.")
                    record = reservations.finalize(intent.id, start_at=parse_kst(result["start_at"]),
                                                   duration_min=data.limit_time, kiosk_booking_no=result["booking_no"],
                                                   status=result.get("status", "pending_tag"))
                    return _result_for_existing_request(record, user, data.student_id)
                if result.get("success") is False and not result.get("pending"):
                    reservations.reject_submission(intent.id)
                    return {**result, "request_id": data.request_id, "pending": False}
                raise booking.ReservationOutcomeUnknown("학교 예약 결과가 불명확합니다.")
            except BaseException as exc:
                # 취소·timeout·파싱·DB 확정 오류 모두 전송 이후라면 실패로 추정하지 않는다.
                current = reservations.get(intent.id)
                if current and (current.dispatch_started != 0 or isinstance(exc, booking.ReservationOutcomeUnknown)):
                    current = reservations.mark_uncertain(intent.id) or current
                    if isinstance(exc, (asyncio.CancelledError, KeyboardInterrupt, SystemExit)):
                        raise
                    log.warning("예약 결과 확인 필요 | reservation=%s error_type=%s", intent.id, type(exc).__name__)
                    return _result_for_existing_request(current, user, data.student_id)
                reservations.fail(intent.id)
                if isinstance(exc, (asyncio.CancelledError, KeyboardInterrupt, SystemExit)):
                    raise
                raise HTTPException(502, "학교 예약 준비에 실패했습니다. 예약은 전송하지 않았습니다.") from exc
            finally:
                _inflight_reservations.discard(intent.id)
                current = reservations.get(intent.id)
                if current:
                    try:
                        await _publish_reservation(current)
                    except Exception:
                        # 확정된 DB 결과를 UI 갱신 실패로 되돌리지 않는다.
                        log.exception("예약 현황 반영 실패 | reservation=%s", intent.id)


@app.post("/booking/current")
async def current_booking(data: CurrentBookingRequest, user: dict = Depends(current_user)):
    """브라우저 저장소가 사라져도 서버가 알고 있는 진행 예약을 복원한다."""
    _require_bound_student(user, data.student_id)
    record = reservations.open_for_uid(user["uid"])
    if record is None:
        return {"success": True, "found": False, "message": "진행 중인 예약이 없습니다."}
    if record.status in reservations.UNCONFIRMED_STATUSES:
        return {
            "success": True, "found": True, "pending": True,
            "request_id": record.request_id, "code": "confirmation_pending", "duration_min": record.duration_min,
            "room_no": record.room_no, "corner_no": record.corner_no,
            "message": f"예약을 확정하지 못했습니다. {record.end_at:%H:%M} 이후 다시 예약할 수 있습니다." if record.status == "uncertain" else "예약 요청을 처리하고 있습니다.",
        }
    return {
        "success": True, "found": True, "pending": False, "request_id": record.request_id,
        "room_no": record.room_no, "corner_no": record.corner_no,
        "return_token": issue_return_token(
            user["uid"], data.student_id, record.corner_no, record.room_no, record.id,
        ),
        "reservation": _reservation_payload(record),
        "message": f"진행 중인 {record.room_no}호 예약을 불러왔습니다.",
    }


@app.post("/booking/reserve-result")
async def reservation_result(data: BookingResultRequest, user: dict = Depends(current_user)):
    """응답을 잃은 브라우저가 동일 요청의 완료 결과를 복구한다."""
    _require_bound_student(user, data.student_id)
    record = reservations.find_by_request(user["uid"], data.request_id)
    if record is None:
        return {
            "success": False, "pending": True, "request_id": data.request_id, "code": "not_recorded",
            "message": "예약 요청이 서버 대기열에 있습니다. 잠시 후 다시 확인해 주세요.",
        }
    record = await _recover_uncertain(record)
    return _result_for_existing_request(record, user, data.student_id)


@app.post("/booking/active")
async def active_booking(data: BookingActionRequest, user: dict = Depends(current_user)):
    claims = verify_return_token(data.return_token, user["uid"], data.student_id, data.corner_no)
    _require_bound_student(user, data.student_id)
    reservation_id = str(claims.get("reservation", ""))
    async with _reservation_action_gate(reservation_id):
        record = reservations.open_for_uid(user["uid"])
        if not record or record.id != reservation_id:
            return {"success": False, "active": False, "message": "인증대기 예약을 찾지 못했습니다."}
        # 태그 동기화 작업이 이미 active로 전환한 뒤에도 브라우저에는
        # 이전 tag 단계가 남을 수 있으므로 키오스크 재조회 없이 복원한다.
        if record.status == "active":
            return {
                "success": True, "active": True, "booking_no": record.kiosk_booking_no,
                "room_no": record.room_no,
                "message": f"태그 인증된 {record.room_no}호 사용을 확인했습니다.",
                "reservation": _reservation_payload(record),
            }
        if record.status != "pending_tag":
            return {"success": False, "active": False, "message": "인증대기 예약을 찾지 못했습니다."}
        if kst_now() < record.start_at:
            return {
                "success": False, "active": False,
                "message": f"{record.start_at.strftime('%H:%M')}부터 학생증을 태그한 뒤 확인할 수 있습니다.",
            }
        if kst_now() > record.tag_deadline + reservations.PENDING_TAG_GRACE:
            reservations.transition(record.id, expected_status="pending_tag", status="expired")
            await collector.clear_reserved(record.corner_no, record.room_no, reservation_id=record.id)
            await collector.refresh_corner_now(record.corner_no)
            return {"success": False, "active": False, "message": "태그 시간이 지나 예약이 자동 취소되었습니다."}
        try:
            result = await booking.active(data.student_id, data.corner_no, record.kiosk_booking_no)
            if result.get("active"):
                active_record = reservations.transition(record.id, expected_status="pending_tag", status="active")
                if not active_record:
                    return {"success": False, "active": False, "message": "예약 상태가 변경되어 다시 확인해 주세요."}
                await collector.mark_active(active_record.corner_no, active_record.room_no,
                                            start_at=active_record.start_at, end_at=active_record.end_at,
                                            reservation_id=active_record.id)
                if AUTO_RETURN_ENABLED:
                    await auto_return.register(
                        active_record.uid, active_record.student_id, active_record.corner_no,
                        active_record.room_no, due_at=active_record.end_at,
                        booking_no=active_record.kiosk_booking_no, reservation_id=active_record.id,
                    )
                result["reservation"] = _reservation_payload(active_record)
            return result
        except httpx.HTTPError as exc:
            log.warning("태그 확인 실패: %s", exc)
            raise HTTPException(502, "키오스크 서버에 연결할 수 없습니다.")


@app.post("/booking/import-active")
async def import_active_booking(data: KioskImportRequest, user: dict = Depends(current_user)):
    """앱 밖 키오스크에서 태그한 현재 사용 건을 안전하게 앱에 연결한다."""
    _require_bound_student(user, data.student_id)
    # 불러오기는 앱 DB가 아니라 키오스크의 현재 상태를 기준으로 한다. 앱에만
    # 남은 이전 사용 기록은 아래 재확인에서 반납 완료로 닫아 다음 예약을 막지
    # 않게 하고, 키오스크에 실제로 남은 사용 건만 앱에 연결한다.
    try:
        result = await booking.active_details(data.student_id, data.corner_no)
    except httpx.HTTPError as exc:
        log.warning("키오스크 사용 예약 불러오기 실패: %s", exc)
        raise HTTPException(502, "키오스크 서버에 연결할 수 없습니다.")

    existing = reservations.open_for_uid(user["uid"])
    if existing:
        current_matches_existing = (
            existing.status == "active"
            and result.get("success")
            and result.get("booking_no") == existing.kiosk_booking_no
            and result.get("room_no") == existing.room_no
        )
        if current_matches_existing:
            if result.get("room_no") != data.room_no:
                return {"success": False, "message": "선택한 방과 키오스크에서 사용 중인 방이 다릅니다."}
            restored = {
                "success": True,
                "active": True,
                "booking_no": existing.kiosk_booking_no,
                "room_no": existing.room_no,
                "start_at": existing.start_at.isoformat(),
                "end_at": existing.end_at.isoformat(),
                "message": f"진행 중인 {existing.room_no}호 사용을 불러왔습니다.",
            }
            restored["return_token"] = issue_return_token(
                user["uid"], data.student_id, data.corner_no, data.room_no, existing.id
            )
            restored["reservation"] = _reservation_payload(existing)
            return restored
        if existing.status != "active" or not await _reconcile_kiosk_return(existing):
            raise HTTPException(409, "기존 예약 상태를 키오스크와 확인 중입니다. 잠시 후 다시 불러와 주세요.")
        # 재확인 사이에 키오스크 상태가 바뀌었을 수 있으므로, 이전 행을 닫은 뒤
        # 실제로 가져올 현재 사용 건을 한 번 더 읽는다.
        try:
            result = await booking.active_details(data.student_id, data.corner_no)
        except httpx.HTTPError as exc:
            log.warning("키오스크 사용 예약 재조회 실패: %s", exc)
            raise HTTPException(502, "키오스크 서버에 연결할 수 없습니다.")

    if not result.get("success"):
        return result
    if result.get("room_no") != data.room_no:
        return {"success": False, "message": "선택한 방과 키오스크에서 사용 중인 방이 다릅니다."}

    try:
        intent = reservations.acquire(
            id=secrets.token_urlsafe(18), uid=user["uid"], student_id=data.student_id,
            student_key=student_key(data.student_id), corner_no=data.corner_no, room_no=data.room_no, booking_source="kiosk",
        )
    except reservations.ReservationConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    try:
        start_at = parse_kst(result["start_at"])
        end_at = parse_kst(result["end_at"])
        duration = max(1, int((end_at - start_at).total_seconds() // 60))
        record = reservations.finalize(intent.id, start_at=start_at, duration_min=duration,
                                       kiosk_booking_no=result["booking_no"])
        record = reservations.set_status(record.id, "active") or record
        result["return_token"] = issue_return_token(user["uid"], data.student_id, data.corner_no, data.room_no, record.id)
        result["reservation"] = _reservation_payload(record)
        await collector.mark_active(record.corner_no, record.room_no, start_at=record.start_at,
                                    end_at=record.end_at, reservation_id=record.id)
        return result
    except (KeyError, ValueError) as exc:
        reservations.fail(intent.id)
        raise HTTPException(502, "키오스크 사용 예약 정보를 해석하지 못했습니다.") from exc


@app.post("/booking/return")
async def return_booking(data: BookingActionRequest, user: dict = Depends(current_user)):
    claims = verify_return_token(data.return_token, user["uid"], data.student_id, data.corner_no)
    _require_bound_student(user, data.student_id)
    async with _reservation_action_gate(str(claims.get("reservation", ""))):
        return await _return_booking_locked(data, user, claims)


async def _return_booking_locked(data: BookingActionRequest, user: dict, claims: dict):
    record = reservations.open_for_uid(user["uid"])
    if not record or record.id != claims.get("reservation") or record.status != "active":
        raise HTTPException(409, "태그 인증된 사용 중 예약을 찾지 못했습니다.")
    try:
        result = await booking.return_room(data.student_id, data.corner_no, record.kiosk_booking_no)
        if result.get("success") and AUTO_RETURN_ENABLED:
            await auto_return.forget(user["uid"], data.corner_no, reservation_id=record.id)
        if result.get("success"):
            reservations.set_status(record.id, "returned")
            await collector.clear_reserved(data.corner_no, str(claims.get("room", "")),
                                           reservation_id=record.id)
            # 응답 전에 해당 코너만 원본에서 다시 읽어, 반납 후
            # 예전 '사용중' 카드가 남은 채로 사용자 화면에 돌아가지 않게 한다.
            await collector.refresh_corner_now(data.corner_no)
        return result
    except httpx.HTTPError as exc:
        log.warning("반납 연동 실패: %s", exc)
        raise HTTPException(502, "키오스크 서버에 연결할 수 없습니다.")


@app.post("/booking/cancel")
async def cancel_booking(data: BookingActionRequest, user: dict = Depends(current_user)):
    claims = verify_return_token(data.return_token, user["uid"], data.student_id, data.corner_no)
    _require_bound_student(user, data.student_id)
    async with _reservation_action_gate(str(claims.get("reservation", ""))):
        return await _cancel_booking_locked(data, user, claims)


async def _cancel_booking_locked(data: BookingActionRequest, user: dict, claims: dict):
    record = reservations.open_for_uid(user["uid"])
    # 응답을 놓친 취소 재시도는 이미 완료된 원래 예약의 결과를 반환한다.
    previous = reservations.get(str(claims.get("reservation", "")))
    terminal_messages = {
        "cancelled": "예약 취소 완료",
        "expired": "태그 시간이 지나 예약이 자동 취소되었습니다.",
        "ended": "이미 이용 시간이 종료된 예약입니다.",
        "returned": "이미 반납한 예약입니다.",
    }
    if previous and previous.uid == user["uid"] and previous.status in terminal_messages:
        await collector.clear_reserved(previous.corner_no, previous.room_no, reservation_id=previous.id)
        if previous.status == "expired":
            await collector.refresh_corner_now(previous.corner_no)
        return {"success": True, "message": terminal_messages[previous.status]}
    if not record or record.id != claims.get("reservation") or record.status != "pending_tag":
        raise HTTPException(409, "취소할 인증대기 예약을 찾지 못했습니다.")
    try:
        result = await booking.cancel(data.student_id, data.corner_no, str(claims.get("room", "")), record.kiosk_booking_no)
        log.info("취소 결과 | corner=%d success=%s message=%s",
                 data.corner_no, result.get("success"), result.get("message", ""))
        if result.get("success"):
            reservations.set_status(record.id, "cancelled")
            if AUTO_RETURN_ENABLED:
                # 취소와 태그 자동 확인이 겹친 극소수 경합에서 자동 반납
                # 대기열이 등록되었더라도 취소 성공 후에는 반드시 제거한다.
                await auto_return.forget(record.uid, record.corner_no, reservation_id=record.id)
            await collector.clear_reserved(data.corner_no, str(claims.get("room", "")),
                                           reservation_id=record.id)
            # 학교 취소 결과가 반영된 코너만 응답 전에 갱신한다.
            # 동시에 다른 사용자가 예약했다면 공실로 오표시하지 않는다.
            await collector.refresh_corner_now(data.corner_no)
        return result
    except httpx.HTTPError as exc:
        log.warning("예약 취소 연동 실패: %s", exc)
        raise HTTPException(502, "키오스크 서버에 연결할 수 없습니다.")


@app.post("/push")
async def push(
    data: StatusResponse,
    x_push_secret: str = Header(default=""),
):
    """캠퍼스 네트워크 안의 pusher.py가 스크레이핑 결과를 업로드하는 엔드포인트."""
    if not PUSH_SECRET:
        raise HTTPException(503, "PUSH_SECRET is not configured")
    if x_push_secret != PUSH_SECRET:
        raise HTTPException(401, "Invalid push secret")
    async with collector._lock:
        collector._state = collector._status_with_rooms(collector._apply_pending_overlays(data.rooms))
    await collector._notify()
    log.info("push 수신 | 전체 %d개 | 사용중 %d | 예약가능 %d",
             data.total, data.occupied_count, data.available_count)
    return {"ok": True, "total": data.total}


def _sse(data: dict) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


def _reservation_payload(record: reservations.Reservation) -> dict:
    return {
        "id": record.id,
        "status": record.status,
        "start_at": record.start_at.isoformat(),
        "end_at": record.end_at.isoformat(),
        "tag_deadline": record.tag_deadline.isoformat(),
    }


async def _daily_return(reservation_id: str) -> bool:
    async with _reservation_action_gate(reservation_id):
        record = reservations.get(reservation_id)
        current = kst_now()
        cutoff, stop = auto_return.daily_window(current)
        if not record or not cutoff <= current < stop or record.status not in {"active", "ended"}:
            return False
        if not reservations.claim_daily_return(record.id, record.kiosk_booking_no, current):
            return False
        result = await booking.return_room(record.student_id, record.corner_no, record.kiosk_booking_no)
        if not result.get("success"):
            log.warning("21:50 자동 반납 미완료 | room=%s", record.room_no)
            return False
        reservations.confirm_daily_return(record.id, record.kiosk_booking_no)
        await collector.clear_reserved(record.corner_no, record.room_no, reservation_id=record.id)
        await collector.refresh_corner_now(record.corner_no)
        return True


@app.get("/announcements")
async def announcements():
    return {"daily_return_enabled": DAILY_RETURN_ENABLED, "items": [{
        "id": "daily-return-2150-v2", "title": "21:50 자동 반납 안내",
        "body": "매일 21:50에 이 앱으로 빌려 사용 중인 방을 자동 반납해요. 남은 시간과 관계없이 적용되니 완료 여부를 확인해 주세요.",
    }] if DAILY_RETURN_ENABLED else []}
