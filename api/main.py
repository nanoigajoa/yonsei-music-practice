"""
main.py - 연습실 현황 API 서버

실행:
    uvicorn main:app --reload --port 8000

엔드포인트:
    GET /health        서버 상태 확인
    GET /status        전체 방 현황 (JSON 스냅샷)
    GET /stream        실시간 SSE 스트림
"""
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
import reservations
from auth_security import current_user, issue_return_token, student_key, verify_return_token
from models import StatusResponse
from pydantic import BaseModel, Field

PUSH_SECRET = os.getenv("PUSH_SECRET", "")
BOOKING_ENABLED = os.getenv("BOOKING_ENABLED", "false").lower() == "true"
AUTO_RETURN_ENABLED = os.getenv("AUTO_RETURN_ENABLED", "false").lower() == "true"
MAX_CONCURRENT_KIOSK_RESERVATIONS = max(1, int(os.getenv("MAX_CONCURRENT_KIOSK_RESERVATIONS", "3")))
MAX_CONCURRENT_TAG_SYNC_CHECKS = max(1, int(os.getenv("MAX_CONCURRENT_TAG_SYNC_CHECKS", "3")))
TAG_SYNC_INTERVAL_SECONDS = max(3, int(os.getenv("TAG_SYNC_INTERVAL_SECONDS", "5")))
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


async def _mark_tagged_active(record: reservations.Reservation) -> bool:
    """키오스크가 태그 완료를 보이면 pending_tag를 active로 단 한 번 전이한다."""
    try:
        async with _kiosk_tag_sync_gate():
            result = await booking.active_once(record.student_id, record.corner_no, record.kiosk_booking_no)
    except httpx.HTTPError as exc:
        log.warning("자동 태그 상태 확인 실패 | room=%s error=%s", record.room_no, exc)
        return False
    if not result.get("active"):
        return False
    active_record = reservations.transition(record.id, expected_status="pending_tag", status="active")
    if not active_record:
        return False
    await collector.mark_active(active_record.corner_no, active_record.room_no,
                                start_at=active_record.start_at, end_at=active_record.end_at)
    if AUTO_RETURN_ENABLED:
        await auto_return.register(active_record.uid, active_record.student_id, active_record.corner_no,
                                   active_record.room_no, due_at=active_record.end_at,
                                   booking_no=active_record.kiosk_booking_no)
    log.info("태그 자동 확인 완료 | room=%s", active_record.room_no)
    return True


async def sync_pending_tags_once() -> int:
    """사용자가 앱의 확인 버튼을 누르지 않아도 태그 상태를 동기화한다."""
    expired = reservations.expire_pending()
    for record in expired:
        await collector.clear_reserved(record.corner_no, record.room_no)

    now = datetime.now()
    pending = [record for record in reservations.open_reservations()
               if record.status == "pending_tag" and record.start_at <= now <= record.tag_deadline + reservations.PENDING_TAG_GRACE]
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
    # 재시작 후에도 이미 확정된 예약이 공실로 잠깐 보이지 않도록 복원한다.
    for record in reservations.open_reservations():
        if record.status == "active":
            await collector.mark_active(record.corner_no, record.room_no, start_at=record.start_at, end_at=record.end_at)
            if AUTO_RETURN_ENABLED:
                await auto_return.register(record.uid, record.student_id, record.corner_no, record.room_no,
                                           due_at=record.end_at, booking_no=record.kiosk_booking_no)
        else:
            await collector.mark_reserved(record.corner_no, record.room_no, start_at=record.start_at,
                                          end_at=record.end_at, tag_deadline=record.tag_deadline)
    return_task = asyncio.create_task(auto_return.scheduler_loop()) if AUTO_RETURN_ENABLED else None
    log.info("백그라운드 폴링 시작 (%d초 간격)", interval)
    yield
    task.cancel()
    tag_task.cancel()
    if return_task:
        return_task.cancel()
    log.info("서버 종료")


app = FastAPI(
    title="연습실 현황 API",
    description="음악대학 연습실 실시간 예약 현황",
    version="0.1.0",
    lifespan=lifespan,
)
app.state.poll_interval = max(10, int(os.getenv("POLL_INTERVAL_SECONDS", "20")))

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


class BookingRequest(BaseModel):
    student_id: str = Field(pattern=r"^20\d{2}172\d{3}$")
    corner_no: int
    room_no: str = Field(pattern=r"^\d{3}$")
    limit_time: int = 120


class BookingActionRequest(BaseModel):
    student_id: str = Field(pattern=r"^20\d{2}172\d{3}$")
    corner_no: int
    return_token: str = Field(min_length=20)


class KioskImportRequest(BaseModel):
    student_id: str = Field(pattern=r"^20\d{2}172\d{3}$")
    corner_no: int
    room_no: str = Field(pattern=r"^\d{3}$")


class StudentBindingRequest(BaseModel):
    student_id: str = Field(pattern=r"^20\d{2}172\d{3}$")
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
        created = reservations.bind_student(user["uid"], key)
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
        "auto_return_enabled": AUTO_RETURN_ENABLED,
    }


@app.get("/status", response_model=StatusResponse)
async def status(
    floor: int = Query(None, description="층 필터 (1~4). 생략 시 전체"),
    occupied: bool = Query(None, description="true=사용중만, false=공실만"),
):
    state = collector.get_state()
    if state is None:
        raise HTTPException(503, "데이터 준비 중입니다. 잠시 후 다시 시도하세요.")

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
    # 방/학생 선점은 gate 안에서 수행한다. 그러면 대기열에 있는 요청이 장시간
    # creating 상태로 남지 않으며, gate를 통과한 첫 요청만 외부 키오스크로 간다.
    async with _kiosk_reservation_gate():
        try:
            intent = reservations.acquire(
                id=secrets.token_urlsafe(18), uid=user["uid"], student_id=data.student_id,
                student_key=student_key(data.student_id), corner_no=data.corner_no, room_no=data.room_no,
            )
        except reservations.ReservationConflict as exc:
            raise HTTPException(409, str(exc)) from exc
        try:
            result = await booking.reserve(data.student_id, data.corner_no, data.room_no, data.limit_time)
            log.info("예약 결과 | corner=%d room=%s success=%s message=%s",
                     data.corner_no, data.room_no, result.get("success"), result.get("message", ""))
            if result.get("success"):
                if not result.get("start_at"):
                    log.error("키오스크 예약 성공 응답에 예약 시작 시각이 없습니다.")
                    raise HTTPException(502, "키오스크가 예약 시작 시각을 반환하지 않았습니다. 예약현황을 확인해 주세요.")
                start_at = datetime.fromisoformat(result["start_at"])
                record = reservations.finalize(intent.id, start_at=start_at, duration_min=data.limit_time,
                                               kiosk_booking_no=result.get("booking_no"))
                result["return_token"] = issue_return_token(
                    user["uid"], data.student_id, data.corner_no, data.room_no, record.id
                )
                result["reservation"] = _reservation_payload(record)
                # 다음 정기 폴링 전에도 다른 사용자 화면에 선점 상태를 알린다.
                await collector.mark_reserved(data.corner_no, data.room_no, start_at=record.start_at,
                                              end_at=record.end_at, tag_deadline=record.tag_deadline)
            else:
                reservations.fail(intent.id)
            return result
        except HTTPException:
            reservations.fail(intent.id)
            raise
        except httpx.HTTPError as exc:
            reservations.fail(intent.id)
            log.warning("예약 연동 실패: %s", exc)
            raise HTTPException(502, "키오스크 서버에 연결할 수 없습니다.")
        except ValueError as exc:
            reservations.fail(intent.id)
            # 동시 요청 사이에 같은 사용자의 예약이 만들어진 경우다.
            raise HTTPException(409, str(exc)) from exc


@app.post("/booking/active")
async def active_booking(data: BookingActionRequest, user: dict = Depends(current_user)):
    claims = verify_return_token(data.return_token, user["uid"], data.student_id, data.corner_no)
    _require_bound_student(user, data.student_id)
    record = reservations.open_for_uid(user["uid"])
    if not record or record.id != claims.get("reservation") or record.status != "pending_tag":
        return {"success": False, "active": False, "message": "인증대기 예약을 찾지 못했습니다."}
    if datetime.now() < record.start_at:
        return {
            "success": False,
            "active": False,
            "message": f"{record.start_at.strftime('%H:%M')}부터 학생증을 태그한 뒤 확인할 수 있습니다.",
        }
    if datetime.now() > record.tag_deadline + reservations.PENDING_TAG_GRACE:
        reservations.set_status(record.id, "expired")
        await collector.clear_reserved(record.corner_no, record.room_no)
        return {"success": False, "active": False, "message": "태그 시간이 지나 예약이 자동 취소되었습니다."}
    try:
        result = await booking.active(data.student_id, data.corner_no, record.kiosk_booking_no)
        if result.get("active"):
            record = reservations.set_status(record.id, "active") or record
            await collector.mark_active(record.corner_no, record.room_no, start_at=record.start_at, end_at=record.end_at)
            if AUTO_RETURN_ENABLED:
                await auto_return.register(record.uid, record.student_id, record.corner_no, record.room_no,
                                           due_at=record.end_at, booking_no=record.kiosk_booking_no)
            result["reservation"] = _reservation_payload(record)
        return result
    except httpx.HTTPError as exc:
        log.warning("태그 확인 실패: %s", exc)
        raise HTTPException(502, "키오스크 서버에 연결할 수 없습니다.")


@app.post("/booking/import-active")
async def import_active_booking(data: KioskImportRequest, user: dict = Depends(current_user)):
    """앱 밖 키오스크에서 태그한 현재 사용 건을 안전하게 앱에 연결한다."""
    _require_bound_student(user, data.student_id)
    # 브라우저 저장소를 지웠거나 다른 기기에서 접속했어도, 이 API가 이전에
    # 확인한 본인 사용 기록은 새 예약으로 만들지 않는다. 새 반납 권한만 다시
    # 발급해 '이미 예약 또는 사용 중' 충돌 없이 현재 사용 화면을 복원한다.
    existing = reservations.open_for_uid(user["uid"])
    if existing:
        if existing.status == "active" and existing.corner_no == data.corner_no and existing.room_no == data.room_no:
            result = {
                "success": True,
                "active": True,
                "booking_no": existing.kiosk_booking_no,
                "room_no": existing.room_no,
                "start_at": existing.start_at.isoformat(),
                "end_at": existing.end_at.isoformat(),
                "message": f"진행 중인 {existing.room_no}호 사용을 불러왔습니다.",
            }
            result["return_token"] = issue_return_token(
                user["uid"], data.student_id, data.corner_no, data.room_no, existing.id
            )
            result["reservation"] = _reservation_payload(existing)
            return result
        raise HTTPException(409, "이미 예약 또는 사용 중인 연습실이 있습니다. 기존 예약을 취소하거나 반납해 주세요.")
    try:
        intent = reservations.acquire(
            id=secrets.token_urlsafe(18), uid=user["uid"], student_id=data.student_id,
            student_key=student_key(data.student_id), corner_no=data.corner_no, room_no=data.room_no,
        )
    except reservations.ReservationConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    try:
        result = await booking.active_details(data.student_id, data.corner_no)
        if not result.get("success"):
            reservations.fail(intent.id)
            return result
        if result.get("room_no") != data.room_no:
            reservations.fail(intent.id)
            return {"success": False, "message": "선택한 방과 키오스크에서 사용 중인 방이 다릅니다."}
        start_at = datetime.fromisoformat(result["start_at"])
        end_at = datetime.fromisoformat(result["end_at"])
        duration = max(1, int((end_at - start_at).total_seconds() // 60))
        record = reservations.finalize(intent.id, start_at=start_at, duration_min=duration,
                                       kiosk_booking_no=result["booking_no"])
        record = reservations.set_status(record.id, "active") or record
        result["return_token"] = issue_return_token(user["uid"], data.student_id, data.corner_no, data.room_no, record.id)
        result["reservation"] = _reservation_payload(record)
        await collector.mark_active(record.corner_no, record.room_no, start_at=record.start_at, end_at=record.end_at)
        return result
    except httpx.HTTPError as exc:
        reservations.fail(intent.id)
        log.warning("키오스크 사용 예약 불러오기 실패: %s", exc)
        raise HTTPException(502, "키오스크 서버에 연결할 수 없습니다.")
    except (KeyError, ValueError) as exc:
        reservations.fail(intent.id)
        raise HTTPException(502, "키오스크 사용 예약 정보를 해석하지 못했습니다.") from exc


@app.post("/booking/return")
async def return_booking(data: BookingActionRequest, user: dict = Depends(current_user)):
    claims = verify_return_token(data.return_token, user["uid"], data.student_id, data.corner_no)
    _require_bound_student(user, data.student_id)
    record = reservations.open_for_uid(user["uid"])
    if not record or record.id != claims.get("reservation") or record.status != "active":
        raise HTTPException(409, "태그 인증된 사용 중 예약을 찾지 못했습니다.")
    try:
        result = await booking.return_room(data.student_id, data.corner_no, record.kiosk_booking_no)
        if result.get("success") and AUTO_RETURN_ENABLED:
            await auto_return.forget(user["uid"], data.corner_no)
        if result.get("success"):
            await collector.clear_reserved(data.corner_no, str(claims.get("room", "")))
            reservations.set_status(record.id, "returned")
            # 원본 키오스크 상태를 다시 읽어 카드의 선점 표시를 빠르게 해제한다.
            asyncio.create_task(collector.refresh_now())
        return result
    except httpx.HTTPError as exc:
        log.warning("반납 연동 실패: %s", exc)
        raise HTTPException(502, "키오스크 서버에 연결할 수 없습니다.")


@app.post("/booking/cancel")
async def cancel_booking(data: BookingActionRequest, user: dict = Depends(current_user)):
    claims = verify_return_token(data.return_token, user["uid"], data.student_id, data.corner_no)
    _require_bound_student(user, data.student_id)
    record = reservations.open_for_uid(user["uid"])
    # 태그 마감 직후에는 expire_pending()이 이미 DB 상태를 expired로 바꾼다.
    # 이 경우도 사용자 입장에서는 '취소 완료'이므로 로컬 화면을 정상적으로 닫는다.
    if not record:
        expired = reservations.get(str(claims.get("reservation", "")))
        if expired and expired.uid == user["uid"] and expired.status == "expired":
            await collector.clear_reserved(expired.corner_no, expired.room_no)
            asyncio.create_task(collector.refresh_now())
            return {"success": True, "message": "태그 시간이 지나 예약이 자동 취소되었습니다."}
    if not record or record.id != claims.get("reservation") or record.status != "pending_tag":
        raise HTTPException(409, "취소할 인증대기 예약을 찾지 못했습니다.")
    try:
        result = await booking.cancel(data.student_id, data.corner_no, str(claims.get("room", "")), record.kiosk_booking_no)
        log.info("취소 결과 | corner=%d success=%s message=%s",
                 data.corner_no, result.get("success"), result.get("message", ""))
        if result.get("success"):
            await collector.clear_reserved(data.corner_no, str(claims.get("room", "")))
            reservations.set_status(record.id, "cancelled")
            # 취소 직후 학교 서버 원본으로 상태를 다시 읽어 예약 선점을 해제한다.
            asyncio.create_task(collector.refresh_now())
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
        collector._state = data
    await collector._notify()
    log.info("push 수신 | 전체 %d개 | 사용중 %d | 예약가능 %d",
             data.total, data.occupied_count, data.available_count)
    return {"ok": True, "total": data.total}


def _sse(data: dict) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


def _reservation_payload(record: reservations.Reservation) -> dict:
    return {
        "status": record.status,
        "start_at": record.start_at.isoformat(),
        "end_at": record.end_at.isoformat(),
        "tag_deadline": record.tag_deadline.isoformat(),
    }
