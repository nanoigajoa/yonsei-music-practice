"""
scraper.py - 음악대학 연습실 예약 현황 폴링

rooms.json(explore.py 출력)을 읽어 전체 방의 예약 현황을 주기적으로 조회합니다.
요청 간 1초 대기 + 코너 간 1초 대기로 서버 부하를 최소화합니다.

사용법:
    python scraper.py            # 기본 60초 간격
    python scraper.py --interval 120   # 2분 간격
"""

import argparse
import json
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple

import requests
from bs4 import BeautifulSoup

# ── 설정 ──────────────────────────────────────────────
BASE_URL = "http://165.132.176.173/booking/main_list.php"
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; practice-room-monitor/1.0)"}
TIMEOUT = 5
INTER_CORNER_DELAY = 1.0   # 코너 간 대기(초)
ROOMS_FILE = "rooms.json"

# 타임슬롯: 7:00부터 10분 단위
SLOT_START_HOUR = 7
SLOT_MINUTES = 10
# ──────────────────────────────────────────────────────


# ── 데이터 클래스 ───────────────────────────────────────
@dataclass
class SlotStatus:
    PAST = "past"          # 지난 시간 (예약 불가)
    BOOKED = "booked"      # 예약된 좌석
    BLOCKED = "blocked"    # 운영 외 시간 (예약불가)
    AVAILABLE = "available"  # 예약 가능


@dataclass
class TimeSlot:
    index: int
    status: str
    time: datetime  # 슬롯 시작 시각


@dataclass
class RoomStatus:
    name: str
    corner_no: int
    pc_id: Optional[int]
    slots: List[TimeSlot] = field(default_factory=list)

    @property
    def available_periods(self) -> List[Tuple[datetime, datetime]]:
        """연속된 예약 가능 시간대 목록 반환."""
        periods = []
        start = None
        for slot in self.slots:
            if slot.status == SlotStatus.AVAILABLE:
                if start is None:
                    start = slot.time
            else:
                if start is not None:
                    end = slot.time  # 직전 슬롯 끝 = 이 슬롯 시작
                    periods.append((start, end))
                    start = None
        if start is not None:
            periods.append((start, self.slots[-1].time + timedelta(minutes=SLOT_MINUTES)))
        return periods

    @property
    def is_available_now(self) -> bool:
        """현재 시각 기준 예약 가능 여부."""
        now = datetime.now()
        for s, e in self.available_periods:
            if s <= now < e:
                return True
        return False

    @property
    def next_available(self) -> Optional[datetime]:
        """가장 가까운 예약 가능 시작 시각."""
        now = datetime.now()
        for s, _ in self.available_periods:
            if s >= now:
                return s
        return None
# ──────────────────────────────────────────────────────


def slot_to_time(slot_index: int) -> datetime:
    """슬롯 인덱스 → 오늘 날짜의 datetime."""
    today = datetime.now().replace(second=0, microsecond=0)
    total_minutes = SLOT_START_HOUR * 60 + slot_index * SLOT_MINUTES
    return today.replace(hour=total_minutes // 60, minute=total_minutes % 60)


def parse_slot_status(li_tag) -> str:
    """<li> 태그 하나의 슬롯 상태 판별."""
    title = li_tag.get("title", "")
    bgcolor = li_tag.get("bgcolor", "")
    img = li_tag.find("img")
    src = img.get("src", "") if img else ""

    if "지난 시간" in title:
        return SlotStatus.PAST
    if bgcolor == "#333333" or "예약불가" in title:
        return SlotStatus.BLOCKED
    if "time_blue" in src or "예약된" in title:
        return SlotStatus.BOOKED
    if li_tag.find("a") and ("time_gray" in src or "time_green" in src):
        return SlotStatus.AVAILABLE
    # 이미지 없는 빈 슬롯도 AVAILABLE로 처리
    if li_tag.find("a"):
        return SlotStatus.AVAILABLE

    return SlotStatus.PAST  # 기본값: 과거 처리


def parse_corner_html(html: str, corner_no: int) -> List[RoomStatus]:
    """HTML에서 모든 방의 예약 현황을 파싱."""
    soup = BeautifulSoup(html, "html.parser")
    rooms: List[RoomStatus] = []

    for seat_idx, seat_div in enumerate(soup.select("div.Body-List")):
        # 방 이름
        title_td = seat_div.select_one("div.title tr td:nth-child(2)")
        name = title_td.get_text(strip=True) if title_td else f"방 {seat_idx}"

        # pc_id: reserve() 인수에서 추출
        pc_id = None
        reserve_a = seat_div.select_one("div.reserve a[onclick]")
        if reserve_a:
            m = re.search(r"reserve\(['\"](\d+)['\"],\s*['\"](\d+)['\"]", reserve_a["onclick"])
            if m:
                pc_id = int(m.group(2))

        # 슬롯 파싱: img.time_cell을 기준으로 부모 <li>의 상태를 읽는다.
        # → 외부 <li>(시간 레이블)가 내부 슬롯과 중복 파싱되는 문제 방지
        slots_map: Dict[int, TimeSlot] = {}
        contents_div = seat_div.select_one("div.contents")
        if contents_div:
            for img in contents_div.find_all("img", class_=re.compile(r"^time_cell")):
                cell_id = img.get("id", "")  # "time_cell_{seat}_{slot}"
                m = re.match(r"time_cell_\d+_(\d+)$", cell_id)
                if not m:
                    continue
                slot_idx = int(m.group(1))
                li_parent = img.find_parent("li")
                if li_parent is None:
                    continue
                status = parse_slot_status(li_parent)
                # 같은 슬롯이 여러 번 나올 경우 AVAILABLE 우선 유지
                if slot_idx not in slots_map or status == SlotStatus.AVAILABLE:
                    slots_map[slot_idx] = TimeSlot(
                        index=slot_idx,
                        status=status,
                        time=slot_to_time(slot_idx),
                    )

        slots = sorted(slots_map.values(), key=lambda s: s.index)
        rooms.append(RoomStatus(name=name, corner_no=corner_no, pc_id=pc_id, slots=slots))

    return rooms


def fetch_corner(corner_no: int) -> Optional[List[RoomStatus]]:
    """corner_no의 현황을 HTTP로 가져와 파싱."""
    try:
        res = requests.get(
            BASE_URL,
            params={"corner_no": corner_no, "TimeCellSize": 0, "page": ""},
            headers=HEADERS,
            timeout=TIMEOUT,
        )
        if res.status_code != 200:
            return None
        return parse_corner_html(res.text, corner_no)
    except requests.RequestException as e:
        print(f"  ⚠  corner_no={corner_no} 네트워크 오류: {e}")
        return None


def fmt_time(dt: datetime) -> str:
    return dt.strftime("%H:%M")


def fmt_period(start: datetime, end: datetime) -> str:
    return f"{fmt_time(start)}~{fmt_time(end)}"


def print_status(all_rooms: Dict[int, List[RoomStatus]]) -> None:
    """전체 방 현황을 사람이 읽기 좋게 출력."""
    now = datetime.now()
    print(f"\n{'='*55}")
    print(f"  연습실 현황  [{now.strftime('%Y-%m-%d %H:%M:%S')}]")
    print(f"{'='*55}")

    any_available = False

    for corner_no, rooms in sorted(all_rooms.items()):
        if not rooms:
            continue

        # 층/구역 헤더 추정 (방 번호 앞자리로 층 식별)
        first_room = rooms[0].name
        m = re.search(r"(\d)(\d{2})호", first_room)
        floor = m.group(1) if m else "?"
        print(f"\n  [ corner {corner_no}  ({floor}층 구역) ]")

        for room in rooms:
            periods = room.available_periods
            avail_count = sum(
                1 for s in room.slots if s.status == SlotStatus.AVAILABLE
            )

            if periods:
                any_available = True
                period_strs = [fmt_period(s, e) for s, e in periods[:3]]
                extra = f" (+{len(periods)-3})" if len(periods) > 3 else ""
                print(f"    🟢 {room.name:18s}  예약가능: {', '.join(period_strs)}{extra}")
            else:
                # 현재 상태 파악
                current = next(
                    (s for s in room.slots if s.time <= now < s.time + timedelta(minutes=SLOT_MINUTES)),
                    None,
                )
                if current and current.status == SlotStatus.BOOKED:
                    # 언제까지 예약인지
                    booked_until = next(
                        (s.time for s in room.slots if s.time > now and s.status != SlotStatus.BOOKED),
                        None,
                    )
                    until_str = f"~{fmt_time(booked_until)}" if booked_until else ""
                    print(f"    🔵 {room.name:18s}  사용중{until_str}")
                else:
                    print(f"    ⬜ {room.name:18s}  운영 외 시간")

    if not any_available:
        print("\n  현재 예약 가능한 방이 없습니다.")
    print()


def load_corners(rooms_file: str) -> List[int]:
    """rooms.json에서 유효한 corner_no 목록 반환."""
    try:
        with open(rooms_file, encoding="utf-8") as f:
            data = json.load(f)
        return sorted(int(k) for k in data.keys())
    except FileNotFoundError:
        print(f"오류: {rooms_file} 없음. explore.py 먼저 실행하세요.")
        raise


def run_once(valid_corners: List[int]) -> Dict[int, List[RoomStatus]]:
    """모든 코너를 한 번 조회해 결과 반환."""
    all_rooms: Dict[int, List[RoomStatus]] = {}
    for corner_no in valid_corners:
        rooms = fetch_corner(corner_no)
        if rooms is not None:
            all_rooms[corner_no] = rooms
        time.sleep(INTER_CORNER_DELAY)
    return all_rooms


def main() -> None:
    parser = argparse.ArgumentParser(description="연습실 예약 현황 폴링")
    parser.add_argument(
        "--interval", type=int, default=60,
        help="갱신 간격(초), 기본값 60 (최소 30)",
    )
    parser.add_argument(
        "--once", action="store_true",
        help="한 번만 조회하고 종료",
    )
    args = parser.parse_args()
    interval = max(30, args.interval)

    valid_corners = load_corners(ROOMS_FILE)
    print(f"폴링 대상 corner: {valid_corners}")
    print(f"갱신 간격: {interval}초  |  Ctrl+C로 종료\n")

    try:
        while True:
            all_rooms = run_once(valid_corners)
            print_status(all_rooms)

            if args.once:
                break

            print(f"  다음 갱신: {interval}초 후 ({datetime.now().strftime('%H:%M:%S')} 기준)")
            time.sleep(interval)

    except KeyboardInterrupt:
        print("\n종료.")


if __name__ == "__main__":
    main()
