"""서비스의 모든 업무 시간을 한국 표준시로 통일한다."""
from datetime import datetime
from zoneinfo import ZoneInfo
import asyncio
import httpx

KST = ZoneInfo("Asia/Seoul")


def now() -> datetime:
    return datetime.now(KST)


def normalize(value: datetime) -> datetime:
    """기존 SQLite의 시간대 없는 값은 과거 화면 표시와 같은 KST로 해석한다."""
    if value.tzinfo is None:
        return value.replace(tzinfo=KST)
    return value.astimezone(KST)


def parse(value: str) -> datetime:
    return normalize(datetime.fromisoformat(value))


def school_access_allowed(value: datetime | None = None) -> bool:
    current = normalize(value) if value is not None else now()
    return 7 <= current.hour < 22


class SchoolClosed(httpx.RequestError):
    """No school traffic may be sent outside 07:00–22:00 KST."""


class SchoolTransport(httpx.AsyncBaseTransport):
    """Check every HTTP request, including subsequent requests in the same login session."""

    def __init__(self, inner: httpx.AsyncBaseTransport | None = None):
        self.inner = inner if inner is not None else httpx.AsyncHTTPTransport(retries=0)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        current = now()
        if not school_access_allowed(current):
            raise SchoolClosed("학교 연동은 오전 7시부터 가능합니다.", request=request)
        deadline = current.replace(hour=22, minute=0, second=0, microsecond=0)
        try:
            return await asyncio.wait_for(self.inner.handle_async_request(request), (deadline - current).total_seconds())
        except TimeoutError as exc:
            raise SchoolClosed("학교 연동 시간이 종료되었습니다.", request=request) from exc

    async def aclose(self):
        await self.inner.aclose()
