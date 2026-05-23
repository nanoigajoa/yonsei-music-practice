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
    available_periods: List[Period] = []   # 오늘 남은 예약 가능 시간대


class StatusResponse(BaseModel):
    updated_at: str        # ISO 8601
    total: int             # 전체 방 수
    occupied_count: int    # 사용중
    available_count: int   # 현재 예약 가능
    rooms: List[Room]
