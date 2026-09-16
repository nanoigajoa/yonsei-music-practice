"""
models.py - API 응답 Pydantic 스키마
"""
from typing import List, Optional

from pydantic import BaseModel


class Period(BaseModel):
    """예약 가능한 연속 시간대."""
    start: str  # "16:50"
    end: str    # "18:00"


class Room(BaseModel):
    name: str
    corner_no: int
    floor: int
    occupied: bool
    occupied_until: Optional[str] = None   # "18:10" (사용중일 때)
    handover: bool = False                # 현재 사용 중이지만 다음 슬롯이 곧 열리는 상태
    # kiosk 원본의 색과 별개로, 이 API에서 막 예약한 방의 상태다.
    # pending_tag 는 회색 '곧 가능'이 아니라 별도의 인증대기 상태다.
    reservation_state: Optional[str] = None  # pending_tag | active
    reservation_start: Optional[str] = None
    tag_deadline: Optional[str] = None
    available_periods: List[Period] = []   # 오늘 남은 예약 가능 시간대


class StatusResponse(BaseModel):
    updated_at: str        # ISO 8601
    total: int             # 전체 방 수
    occupied_count: int    # 사용중
    available_count: int   # 현재 예약 가능
    rooms: List[Room]
