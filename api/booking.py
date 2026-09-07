"""키오스크 예약·태그 확인·반납 연동."""
import logging
import os
import re
import asyncio
from datetime import datetime, timedelta
from urllib.parse import unquote
from collections.abc import Callable

import httpx
from bs4 import BeautifulSoup
from clock import SchoolTransport, now as kst_now

BASE = "http://165.132.176.173"
HEADERS = {"User-Agent": "Mozilla/5.0 Edge"}
TIMEOUT = 10.0
TAG_CONFIRM_WAIT_SECONDS = max(0, float(os.getenv("TAG_CONFIRM_WAIT_SECONDS", "22")))
TAG_CONFIRM_RETRY_SECONDS = max(0.5, float(os.getenv("TAG_CONFIRM_RETRY_SECONDS", "2")))

CORNER_NAMES = {
    1: "음악관A 1층", 2: "음악관A 2층", 3: "음악관A 3층", 4: "음악관A 4층",
    6: "음악관B 1층", 8: "음악관B 3층", 9: "음악관B 4층",
}
log = logging.getLogger(__name__)


class ReservationOutcomeUnknown(RuntimeError):
    """학교에 전송했을 수 있으나 일치하는 예약 내역을 아직 확인하지 못했다."""


def _submission_evidence(html: str, room_no: str, start_at: datetime, duration_min: int,
                         active_booking_no: str | None = None) -> dict | None:
    """방·날짜·시작·종료·학교 식별자가 일치하는 단 하나의 예약만 복원한다."""
    matches = []
    end_at = start_at + timedelta(minutes=duration_min)
    ends = {end_at.strftime("%H:%M")}
    if duration_min == 120:
        ends.add((end_at - timedelta(minutes=1)).strftime("%H:%M"))
    for row in BeautifulSoup(html, "html.parser").select("tr"):
        if row.find("tr") is not None:
            continue
        text = row.get_text(" ", strip=True)
        rooms = re.findall(r"(?<!\d)(\d{3})호", text)
        times = re.search(r"(\d{1,2}:\d{2})(?::\d{2})?\s*~\s*(\d{1,2}:\d{2})(?::\d{2})?", text)
        if rooms != [room_no] or not times:
            continue
        start_label, end_label = (value.zfill(5) for value in times.groups())
        if start_label != start_at.strftime("%H:%M") or end_label not in ends:
            continue
        dates = re.findall(r"\d{4}-\d{2}-\d{2}", text)
        if dates:
            if dates[0] != start_at.date().isoformat():
                continue
        elif start_at.date() != kst_now().date():
            # 날짜 없는 내역으로 과거 요청을 오늘의 다른 예약에 연결하지 않는다.
            continue
        cancel_ids = re.findall(r"booking_del\(['\"](\d+)", str(row))
        return_ids = re.findall(r"return\.php\?booking_no=(\d+)", str(row))
        active = "이용중" in text or "사용중" in text
        if active:
            if not active_booking_no or return_ids != [active_booking_no]:
                continue
            number = active_booking_no
        else:
            if len(cancel_ids) != 1:
                continue
            number = cancel_ids[0]
        matches.append({"success": True, "booking_no": number, "room_no": room_no,
                        "start_at": start_at.isoformat(), "duration_min": duration_min,
                        "status": "active" if active else "pending_tag"})
    return matches[0] if len(matches) == 1 else None


async def _read_submission(client: httpx.AsyncClient, corner_no: int, room_no: str,
                           start_at: datetime, duration_min: int) -> dict | None:
    page = await client.get(f"{BASE}/booking/booking_info.php", params={"corner_no": corner_no},
                            headers={**HEADERS, "Referer": f"{BASE}/booking/index.php"})
    page.raise_for_status()
    evidence = _submission_evidence(page.text, room_no, start_at, duration_min)
    if evidence:
        return evidence
    # 태그가 먼저 완료됐다면 index의 활성 식별자까지 일치해야 한다.
    if "이용중" in page.text or "사용중" in page.text:
        number = await _active_booking_no(client, corner_no)
        return _submission_evidence(page.text, room_no, start_at, duration_min, number)
    return None


async def recover_submission(student_id: str, corner_no: int, room_no: str,
                             start_at: datetime, duration_min: int) -> dict | None:
    """예약 POST를 재전송하지 않고 본인의 학교 내역만 읽는다. 없음은 실패 증거가 아니다."""
    async with httpx.AsyncClient(transport=SchoolTransport(), headers=HEADERS, timeout=TIMEOUT) as client:
        response = await _login(client, student_id, corner_no)
        response.raise_for_status()
        if "window.opener.location" not in response.text or "/booking/index.php" not in response.text:
            return None
        return await _read_submission(client, corner_no, room_no, start_at, duration_min)


def _current_room_status(seat) -> str:
    """목록 HTML에서 현재 슬롯의 상태를 추출한다 (past 슬롯은 제외)."""
    for img in seat.select("img"):
        if not img.get("id", "").startswith("time_cell_"):
            continue
        li = img.find_parent("li")
        if li is None or "지난 시간" in li.get("title", ""):
            continue
        src = img.get("src", "")
        title = li.get("title", "")
        if "time_blue" in src or "예약된" in title or "예약중" in title:
            return "occupied"
        if "time_green" in src or "time_gray" in src or li.find("a"):
            return "available"
        return "unknown"
    return "unknown"


def _next_ten_minute(hour: str, minute: str) -> tuple[str, str]:
    """키오스크 목록의 현재 시각을 다음 예약 시작 시각으로 정규화한다.

    목록 onclick의 cell_min은 실제 분(예: 04)일 수 있다. 이를 그대로
    reserve_proc에 보내면 10분 단위 규칙을 깨므로 항상 올림한다. 이미
    10분 정각이어도 그 시각은 시작할 수 있는 "다음" 슬롯이 아니므로 다음
    슬롯을 사용한다.
    """
    total = int(hour) * 60 + int(minute)
    rounded = ((total // 10) + 1) * 10
    return str(rounded // 60), f"{rounded % 60:02d}"


def _native_form_values(html: str) -> dict[str, str]:
    """키오스크 예약 폼이 기본으로 넣은 전송값을 보존한다.

    예약 페이지에는 화면에 보이지 않는 세션 보조 필드가 포함될 수 있다.
    이를 누락하면 키오스크 화면과 다른 요청이 될 수 있으므로, 실제 브라우저
    폼과 같은 기본값을 먼저 수집한다. 시간 제어값은 reserve()에서 명시적으로
    같은 10분 칸 기준으로 덮어쓴다.
    """
    soup = BeautifulSoup(html, "html.parser")
    values: dict[str, str] = {}
    for field in soup.select("input[name], select[name], textarea[name]"):
        if field.has_attr("disabled"):
            continue
        name = field.get("name")
        if not name:
            continue
        if field.name == "select":
            option = field.select_one("option[selected]") or field.select_one("option")
            if option is not None:
                values[name] = option.get("value", option.get_text(strip=True))
            continue
        if field.name == "textarea":
            values[name] = field.get_text()
            continue
        field_type = field.get("type", "text").lower()
        if field_type in {"submit", "button", "reset", "file", "image"}:
            continue
        if field_type in {"checkbox", "radio"} and not field.has_attr("checked"):
            continue
        values[name] = field.get("value", "")
    return values


async def _login(client: httpx.AsyncClient, student_id: str, corner_no: int) -> httpx.Response:
    preparation = await client.get(
        f"{BASE}/booking/main_view.php",
        params={"corner_no": corner_no, "TimeCellSize": 0},
    )
    preparation.raise_for_status()
    return await client.post(
        f"{BASE}/booking/login_proc.php",
        data={"rfid": student_id},
        headers={**HEADERS, "Referer": f"{BASE}/booking/main_view.php"},
    )


async def validate_student(student_id: str, corner_no: int = 1) -> bool:
    """학교 키오스크가 학번을 실제 이용자로 로그인시키는지 확인한다."""
    async with httpx.AsyncClient(transport=SchoolTransport(), headers=HEADERS, timeout=TIMEOUT) as client:
        for _ in range(2):
            response = await _login(client, student_id, corner_no)
            text = response.text
            if "window.opener.location" in text and "/booking/index.php" in text:
                return True
    return False


async def _pending_booking_no(client: httpx.AsyncClient, corner_no: int, room_no: str) -> str | None:
    """예약 직후 예약확인 표의 취소 식별자를 얻는다.

    이 번호를 저장하면 이후 다른 방을 예약하려다 생긴 화면 갱신과 무관하게
    정확히 처음 예약한 건만 취소할 수 있다.
    """
    page = await client.get(
        f"{BASE}/booking/booking_info.php", params={"corner_no": corner_no},
        headers={**HEADERS, "Referer": f"{BASE}/booking/index.php"},
    )
    soup = BeautifulSoup(page.text, "html.parser")
    for row in soup.select("tr"):
        if f"{room_no}호" not in row.get_text():
            continue
        link = row.find("a", onclick=re.compile(r"booking_del\(['\"](\d+)"))
        if link:
            match = re.search(r"booking_del\(['\"](\d+)", link.get("onclick", ""))
            return match.group(1) if match else None
    return None


async def reserve(student_id: str, corner_no: int, room_no: str, limit_time: int,
                  *, before_submit: Callable[[datetime], None] | None = None) -> dict:
    if corner_no not in CORNER_NAMES:
        return {"success": False, "message": "지원하지 않는 건물/층입니다."}
    if limit_time not in (30, 60, 90, 120):
        return {"success": False, "message": "예약 시간은 30분 단위로 최대 2시간입니다."}

    async with httpx.AsyncClient(transport=SchoolTransport(), headers=HEADERS, timeout=TIMEOUT) as client:
        login = await _login(client, student_id, corner_no)
        login.raise_for_status()
        if "window.opener.location" not in login.text or "/booking/index.php" not in login.text:
            return {"success": False, "message": "학교 로그인을 확인하지 못해 예약을 전송하지 않았습니다."}
        params = None
        blocked_message = None
        for page in ["", "2", "3", "4"]:
            listing = await client.get(
                f"{BASE}/booking/main_list.php",
                params={"corner_no": corner_no, "TimeCellSize": 0, "page": page},
                headers={**HEADERS, "Referer": f"{BASE}/booking/main_view.php"},
            )
            listing.raise_for_status()
            soup = BeautifulSoup(listing.text, "html.parser")
            for seat in soup.select("div.Body-List"):
                title = seat.select_one("div.title tr td:nth-child(2)")
                title_room = re.search(r"(\d+)호", title.get_text(" ", strip=True) if title else "")
                if not title_room or title_room.group(1) != room_no:
                    continue
                if _current_room_status(seat) == "occupied":
                    blocked_message = f"실시간 확인 결과: {room_no}호는 현재 사용중입니다."
                    break
                link = seat.select_one("div.reserve a[onclick]")
                values = re.findall(r"'([^']+)'", link.get("onclick", "")) if link else []
                if len(values) >= 6:
                    params = values[:6]
                break
            if params or blocked_message:
                break

        if not params:
            if blocked_message:
                return {"success": False, "message": blocked_message}
            return {"success": False, "message": f"실시간 확인 결과: {room_no}호는 현재 예약할 수 없습니다."}

        corner, pc_id, open_ts, close_ts, now_cell, cell_min = params
        form = await client.get(
            f"{BASE}/booking/reserve.php",
            params={
                "corner_no": corner, "pc_id": pc_id, "open_timestamp": open_ts,
                "close_timestamp": close_ts, "now_cell_time": now_cell, "cell_min": cell_min,
            },
            headers={**HEADERS, "Referer": f"{BASE}/booking/main_list.php"},
        )
        form.raise_for_status()
        # 실제 확보된 reserve.php 응답은 HTTP 200이어도 ERROR 팝업일 수 있다.
        # 이 준비 거절을 무시하고 예약 POST를 조립하지 않는다.
        if re.search(r"var\s+title\s*=\s*['\"]ERROR['\"]", form.text):
            error = re.search(r"msg=([^\"'&<>]+)", form.text)
            return {"success": False, "message": unquote(error.group(1)) if error else "학교에서 예약 준비를 거절했습니다."}
        # 시작은 서비스 규칙대로 항상 다음 10분 정각이다. 다만 종료·경계
        # 계산에 필요한 hidden/select 값은 키오스크가 만든 예약 폼의 값을
        # 그대로 보존해, 화면에서 직접 누른 예약과 같은 요청을 만든다.
        b_hour, b_min = _next_ten_minute(now_cell, cell_min)
        start_total = int(b_hour) * 60 + int(b_min)
        # 학교 기록은 시작을 :01, 종료를 :59로 저장하고 분 단위 이용시간을
        # 올림해 표시한다. 따라서 최대 120분은 종료 '분'을 시작+119분으로
        # 보내야 10:10:01~12:09:59가 되어 학교 기준 정확히 120분이다.
        # 시작+120분(12:10)을 보내면 121분으로 판정되어 최대시간 오류가 난다.
        # 30/60/90분은 최대 경계가 아니므로 기존 키오스크 동작을 유지한다.
        finish_total = start_total + limit_time - (1 if limit_time == 120 else 0)
        now = kst_now()
        start_at = now.replace(hour=int(b_hour), minute=int(b_min), second=0, microsecond=0)
        if start_at < now - timedelta(minutes=10):
            start_at += timedelta(days=1)
        end_at = start_at + timedelta(minutes=limit_time)

        native_values = _native_form_values(form.text)
        reserve_data = {
            **native_values,
            "admin_mode": "", "corner_no": corner, "pc_id": pc_id, "quick": "",
            "corner_name": CORNER_NAMES[corner_no], "pc_name_no": f"연습실({room_no})",
            # 이 세 값은 동일한 첫 10분 칸을 가리켜야 한다. 목록의 실제 분
            # (예: 10:04)을 그대로 쓰면 학교가 126분으로 계산할 수 있다.
            "limit_time": str(limit_time), "now_cell_time": b_hour, "cell_min": b_min,
            # 숨은 종료값도 finish_hour/min과 동일한 초 경계를 가리키게 한다.
            "stime": start_at.strftime("%Y-%m-%d %H:%M:%S"),
            "etime": (end_at - timedelta(seconds=1)).strftime("%Y-%m-%d %H:%M:%S"),
            "begin_hour": b_hour, "begin_min": b_min,
            "finish_hour": str(finish_total // 60), "finish_min": f"{finish_total % 60:02d}",
        }
        if before_submit is not None:
            before_submit(start_at)
        result = await client.post(
            f"{BASE}/booking/reserve_proc.php",
            data=reserve_data,
            headers={**HEADERS, "Referer": f"{BASE}/booking/reserve.php"},
        )
        result.raise_for_status()
        error = re.search(r"msg=([^\"&]+)", result.text)
        message = unquote(error.group(1)) if error else ""
        if "로그인 후" in message:
            # 학교 서버가 드물게 준비 요청과 예약 전송 사이에 PHP 세션을 잃는다.
            # 첫 전송이 명시적으로 로그인 오류를 반환한 경우에만 같은 세션 흐름을
            # 한 번 다시 만든다. 성공 여부가 불명확한 응답은 재전송하지 않아
            # 중복 예약 가능성을 피한다.
            log.warning("키오스크 로그인 세션 재설정 후 예약 1회 재시도 | room=%s", room_no)
            await _login(client, student_id, corner_no)
            await client.get(
                f"{BASE}/booking/reserve.php",
                params={
                    "corner_no": corner, "pc_id": pc_id, "open_timestamp": open_ts,
                    "close_timestamp": close_ts, "now_cell_time": now_cell, "cell_min": cell_min,
                },
                headers={**HEADERS, "Referer": f"{BASE}/booking/main_list.php"},
            )
            result = await client.post(
                f"{BASE}/booking/reserve_proc.php",
                data=reserve_data,
                headers={**HEADERS, "Referer": f"{BASE}/booking/reserve.php"},
            )
        log.info("키오스크 예약 전송 | room=%s start=%s:%s last_slot=%s:%02d duration=%s",
                 room_no, b_hour, b_min, finish_total // 60, finish_total % 60, limit_time)
        result.raise_for_status()
        error = re.search(r"msg=([^\"&]+)", result.text)
        message = unquote(error.group(1)) if error else ""
        if re.search(r"로그인 후|이미.*(?:예약|사용)|다른 이용자.*예약|예약.*불가|예약할 수 없|최대.*(?:120|2시간)|시간선택|시간 선택|예약.*(?:실패|초과|제한|않|없)|(?:이용|사용).*제한", message):
            return {"success": False, "message": message}
        # 알 수 없는 msg도 거절로 추측하지 않고 일치하는 내역을 확인한다.
        evidence = await _read_submission(client, corner_no, room_no, start_at, limit_time)
        if not evidence:
            raise ReservationOutcomeUnknown("학교 예약 내역을 확인 중입니다. 같은 예약을 다시 전송하지 않습니다.")
        return {**evidence, "message": f"실시간 확인 및 {room_no}호 예약 완료"}


async def _booking_no(client: httpx.AsyncClient, corner_no: int) -> str | None:
    index = await client.get(
        f"{BASE}/booking/index.php",
        params={"reload": 1, "corner_no": corner_no, "TimeCellSize": 0},
    )
    index.raise_for_status()
    match = re.search(r'var booking_no\s*=\s*["\'](\d+)["\']', index.text)
    if match:
        return match.group(1)
    # 시작 전 예약은 index/info1에 아직 활성 예약으로 표시되지 않는다.
    # 예약현황 팝업(booking_info.php)에는 미래 예약의 반납/취소 식별자가 포함된다.
    info = await client.get(
        f"{BASE}/booking/booking_info.php",
        params={"corner_no": corner_no},
        headers={**HEADERS, "Referer": f"{BASE}/booking/index.php"},
    )
    matches = re.findall(r"(?:return\.php\?booking_no=|booking_no[\"'=]+)(\d+)", info.text)
    if matches:
        return matches[0]
    info = await client.get(
        f"{BASE}/booking/info1.php",
        headers={**HEADERS, "Referer": f"{BASE}/booking/index.php"},
    )
    matches = re.findall(r"booking_no=(\d+)", info.text)
    return matches[0] if matches else None


async def _active_booking_no(client: httpx.AsyncClient, corner_no: int) -> str | None:
    """태그 후 실제 이용중인 예약만 index 화면에서 읽는다."""
    index = await client.get(
        f"{BASE}/booking/index.php",
        params={"reload": 1, "corner_no": corner_no, "TimeCellSize": 0},
    )
    index.raise_for_status()
    match = re.search(r'var booking_no\s*=\s*["\'](\d+)["\']', index.text)
    return match.group(1) if match else None


async def _active_once(client: httpx.AsyncClient, corner_no: int, booking_no: str | None = None) -> dict:
    number = await _active_booking_no(client, corner_no)
    if not number or (booking_no and number != booking_no):
        return {"success": False, "active": False, "message": "아직 태그 인증이 확인되지 않았습니다."}
    return {"success": True, "active": True, "booking_no": number, "message": "태그 인증 확인 완료"}


async def active_once(student_id: str, corner_no: int, booking_no: str | None = None) -> dict:
    """자동 상태 동기화용 단일 확인. 태그 결과를 기다리며 재시도하지 않는다."""
    async with httpx.AsyncClient(transport=SchoolTransport(), headers=HEADERS, timeout=TIMEOUT) as client:
        await _login(client, student_id, corner_no)
        return await _active_once(client, corner_no, booking_no)


async def active(student_id: str, corner_no: int, booking_no: str | None = None) -> dict:
    async with httpx.AsyncClient(transport=SchoolTransport(), headers=HEADERS, timeout=TIMEOUT) as client:
        await _login(client, student_id, corner_no)
        # 방 앞 단말기의 태그 결과가 키오스크 중앙 서버에 도착하기까지 수 초가
        # 걸릴 수 있다. 사용자가 버튼을 여러 번 누르지 않도록 한 번의 요청에서
        # 짧게 재확인한다. 로그인 세션은 한 번만 만든다.
        deadline = asyncio.get_running_loop().time() + TAG_CONFIRM_WAIT_SECONDS
        while True:
            result = await _active_once(client, corner_no, booking_no)
            if result["active"]:
                return result
            if asyncio.get_running_loop().time() >= deadline:
                break
            await asyncio.sleep(min(TAG_CONFIRM_RETRY_SECONDS, max(0, deadline - asyncio.get_running_loop().time())))
    return {
        "success": False,
        "active": False,
        "message": "태그 정보가 아직 키오스크에 반영되지 않았습니다. 잠시 뒤 태그 완료 확인을 다시 눌러 주세요.",
    }


async def active_details(student_id: str, corner_no: int) -> dict:
    """키오스크에서 직접 태그해 사용 중인 단 하나의 예약을 읽는다."""
    async with httpx.AsyncClient(transport=SchoolTransport(), headers=HEADERS, timeout=TIMEOUT) as client:
        await _login(client, student_id, corner_no)
        number = await _active_booking_no(client, corner_no)
        if not number:
            return {"success": False, "message": "키오스크에서 사용 중인 예약을 찾지 못했습니다."}
        info = await client.get(
            f"{BASE}/booking/booking_info.php", params={"corner_no": corner_no},
            headers={**HEADERS, "Referer": f"{BASE}/booking/index.php"},
        )
    soup = BeautifulSoup(info.text, "html.parser")
    active_rows = [row.get_text(" ", strip=True) for row in soup.select("tr")
                   if "이용중" in row.get_text() or "사용중" in row.get_text()]
    if len(active_rows) != 1:
        return {"success": False, "message": "키오스크 사용 중 방 정보를 확인하지 못했습니다."}
    text = active_rows[0]
    room_match = re.search(r"(\d{3})호", text)
    times = re.search(r"(\d{1,2}:\d{2})\s*~\s*(\d{1,2}:\d{2})", text)
    if not room_match or not times:
        return {"success": False, "message": "키오스크 사용 중 예약의 방 또는 시간을 확인하지 못했습니다."}
    now = kst_now()
    start_hour, start_min = map(int, times.group(1).split(":"))
    end_hour, end_min = map(int, times.group(2).split(":"))
    start_at = now.replace(hour=start_hour, minute=start_min, second=0, microsecond=0)
    end_at = now.replace(hour=end_hour, minute=end_min, second=0, microsecond=0)
    if end_at <= start_at:
        end_at += timedelta(days=1)
    return {"success": True, "booking_no": number, "room_no": room_match.group(1),
            "start_at": start_at.isoformat(), "end_at": end_at.isoformat(),
            "message": f"키오스크 {room_match.group(1)}호 사용 중 예약을 불러왔습니다."}


async def return_room(student_id: str, corner_no: int, booking_no: str | None = None) -> dict:
    async with httpx.AsyncClient(transport=SchoolTransport(), headers=HEADERS, timeout=TIMEOUT) as client:
        await _login(client, student_id, corner_no)
        number = booking_no or await _booking_no(client, corner_no)
        if not number:
            return {"success": False, "message": "활성 예약이 없습니다."}
        result = await client.get(f"{BASE}/booking/return.php", params={"booking_no": number})
    if "반납 되었습니다" in result.text:
        return {"success": True, "message": "반납 완료"}
    return {"success": False, "message": "반납 처리에 실패했습니다."}


async def cancel(student_id: str, corner_no: int, room_no: str, booking_no: str | None = None) -> dict:
    """예약현황의 booking_del 경로로 시작 전 예약을 취소한다."""
    async with httpx.AsyncClient(transport=SchoolTransport(), headers=HEADERS, timeout=TIMEOUT) as client:
        await _login(client, student_id, corner_no)
        page = await client.get(
            f"{BASE}/booking/booking_info.php",
            params={"corner_no": corner_no},
            headers={**HEADERS, "Referer": f"{BASE}/booking/index.php"},
        )
        soup = BeautifulSoup(page.text, "html.parser")
        number = booking_no
        if not number:
            for row in soup.select("tr"):
                if f"{room_no}호" not in row.get_text():
                    continue
                cancel_link = row.find("a", onclick=re.compile(r"booking_del\(['\"](\d+)"))
                if cancel_link:
                    number = re.search(r"booking_del\(['\"](\d+)", cancel_link["onclick"]).group(1)
                    break
        if not number:
            return {"success": False, "message": "취소할 예약을 찾지 못했습니다. 키오스크 상태를 확인해 주세요."}
        result = await client.get(
            f"{BASE}/booking/booking_result.php",
            params={"result_code": 7, "booking_no": number},
            headers={**HEADERS, "Referer": f"{BASE}/booking/booking_info.php"},
        )
    result.raise_for_status()
    # '취소 실패', 취소 버튼, 오류 페이지를 성공으로 오인하지 않는다.
    if not re.search(r"실패|오류|불가|할 수 없", result.text) and re.search(
        r"(?:취소|삭제)(?:가)?\s*(?:되었습니다|되었|완료)", result.text
    ):
        return {"success": True, "message": "예약 취소 완료"}
    return {"success": False, "message": "예약 취소 처리에 실패했습니다."}
