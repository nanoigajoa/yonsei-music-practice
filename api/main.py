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
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

import collector
from models import StatusResponse

# ── 로깅 ───────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(name)s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)
# ──────────────────────────────────────────────────────


# ── 서버 생명주기 ────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    interval = app.state.poll_interval
    task = asyncio.create_task(collector.polling_loop(interval))
    log.info("백그라운드 폴링 시작 (%d초 간격)", interval)
    yield
    task.cancel()
    log.info("서버 종료")


app = FastAPI(
    title="연습실 현황 API",
    description="음악대학 연습실 실시간 예약 현황",
    version="0.1.0",
    lifespan=lifespan,
)
app.state.poll_interval = 60  # 초 단위, 필요 시 변경

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # 프론트 도메인으로 좁혀도 됨
    allow_methods=["GET"],
    allow_headers=["*"],
)
# ──────────────────────────────────────────────────────


@app.get("/health")
async def health():
    state = collector.get_state()
    return {
        "status": "ok",
        "data_ready": state is not None,
        "updated_at": state.updated_at if state else None,
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


def _sse(data: dict) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"
