"""서비스의 모든 업무 시간을 한국 표준시로 통일한다."""
from datetime import datetime
from zoneinfo import ZoneInfo

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
