"""키오스크 예약·태그 확인·반납 연동."""
import logging
import os
import re
import asyncio
from datetime import datetime, timedelta
from urllib.parse import unquote

import httpx
from bs4 import BeautifulSoup
from clock import now as kst_now

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

    예약 페이지에는 화면에 보이지 않는 시간·세션 보조 필드가 포함될 수 있다.
    이를 빈 값으로 다시 만들면 키오스크 화면과 다른 경계 계산이 발생할 수
    있으므로, 실제 브라우저 폼과 같은 기본값을 먼저 수집한다.
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
    await client.get(
        f"{BASE}/booking/main_view.php",
        params={"corner_no": corner_no, "TimeCellSize": 0},
    )
    return await client.post(
        f"{BASE}/booking/login_proc.php",
        data={"rfid": student_id},
        headers={**HEADERS, "Referer": f"{BASE}/booking/main_view.php"},
    )


async def validate_student(student_id: str, corner_no: int = 1) -> bool:
    """학교 키오스크가 학번을 실제 이용자로 로그인시키는지 확인한다."""
    async with httpx.AsyncClient(headers=HEADERS, timeout=TIMEOUT) as client:
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


async def reserve(student_id: str, corner_no: int, room_no: str, limit_time: int) -> dict:
    if corner_no not in CORNER_NAMES:
        return {"success": False, "message": "지원하지 않는 건물/층입니다."}
    if limit_time not in (30, 60, 90, 120):
        return {"success": False, "message": "예약 시간은 30분 단위로 최대 2시간입니다."}

    async with httpx.AsyncClient(headers=HEADERS, timeout=TIMEOUT) as client:
        await _login(client, student_id, corner_no)
        params = None
        blocked_message = None
        for page in ["", "2", "3", "4"]:
            listing = await client.get(
                f"{BASE}/booking/main_list.php",
                params={"corner_no": corner_no, "TimeCellSize": 0, "page": page},
                headers={**HEADERS, "Referer": f"{BASE}/booking/main_view.php"},
            )
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
            if params:
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
        # 시작은 서비스 규칙대로 항상 다음 10분 정각이다. 다만 종료·경계
        # 계산에 필요한 hidden/select 값은 키오스크가 만든 예약 폼의 값을
        # 그대로 보존해, 화면에서 직접 누른 예약과 같은 요청을 만든다.
        b_hour, b_min = _next_ten_minute(now_cell, cell_min)
        start_total = int(b_hour) * 60 + int(b_min)
        # finish_*는 예약의 실제 종료 시각이다. 예를 들어 10:10부터 120분은
        # 12:10으로 전송해야 한다. 마지막 슬롯 시작 시각(12:00)을 보내면
        # 키오스크가 110분 예약으로 확정한다.
        finish_total = start_total + limit_time
        # 키오스크는 예약 시작·종료와 별도로 now_cell_time부터 종료까지를
        # 최대시간으로 검사한다. 정확히 120:00이면 경계값을 초과로 처리하므로,
        # 120분 예약만 검사용 기준을 시작 1분 뒤로 둔다. begin/finish는 전혀
        # 바꾸지 않으므로 실제 예약은 정확히 120분이며 POST도 한 번뿐이다.
        check_total = start_total + (1 if limit_time == 120 else 0)
        check_hour, check_min = str((check_total // 60) % 24), f"{check_total % 60:02d}"

        native_values = _native_form_values(form.text)
        reserve_data = {
            **native_values,
            "admin_mode": "", "corner_no": corner, "pc_id": pc_id, "quick": "",
            "corner_name": CORNER_NAMES[corner_no], "pc_name_no": f"연습실({room_no})",
            "limit_time": str(limit_time),
            "now_cell_time": check_hour if limit_time == 120 else native_values.get("now_cell_time", now_cell),
            "cell_min": check_min if limit_time == 120 else native_values.get("cell_min", cell_min),
            "begin_hour": b_hour, "begin_min": b_min,
            "finish_hour": str(finish_total // 60), "finish_min": f"{finish_total % 60:02d}",
        }
        result = await client.post(
            f"{BASE}/booking/reserve_proc.php",
            data=reserve_data,
            headers={**HEADERS, "Referer": f"{BASE}/booking/reserve.php"},
        )
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
        error = re.search(r"msg=([^\"&]+)", result.text)
        if error:
            return {"success": False, "message": unquote(error.group(1))}
        now = kst_now()
        start_at = now.replace(hour=int(b_hour), minute=int(b_min), second=0, microsecond=0)
        # 자정을 넘기는 예약도 키오스크가 허용하는 경우를 보존한다.
        if start_at < now - timedelta(minutes=10):
            start_at += timedelta(days=1)
        booking_no = await _pending_booking_no(client, corner_no, room_no)
        return {
            "success": True, "message": f"실시간 확인 및 {room_no}호 예약 완료",
            "start_at": start_at.isoformat(), "duration_min": limit_time, "booking_no": booking_no,
        }


async def _booking_no(client: httpx.AsyncClient, corner_no: int) -> str | None:
    index = await client.get(
        f"{BASE}/booking/index.php",
        params={"reload": 1, "corner_no": corner_no, "TimeCellSize": 0},
    )
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
    match = re.search(r'var booking_no\s*=\s*["\'](\d+)["\']', index.text)
    return match.group(1) if match else None


async def _active_once(client: httpx.AsyncClient, corner_no: int, booking_no: str | None = None) -> dict:
    number = await _active_booking_no(client, corner_no)
    if not number or (booking_no and number != booking_no):
        return {"success": False, "active": False, "message": "아직 태그 인증이 확인되지 않았습니다."}
    return {"success": True, "active": True, "booking_no": number, "message": "태그 인증 확인 완료"}


async def active_once(student_id: str, corner_no: int, booking_no: str | None = None) -> dict:
    """자동 상태 동기화용 단일 확인. 태그 결과를 기다리며 재시도하지 않는다."""
    async with httpx.AsyncClient(headers=HEADERS, timeout=TIMEOUT) as client:
        await _login(client, student_id, corner_no)
        return await _active_once(client, corner_no, booking_no)


async def active(student_id: str, corner_no: int, booking_no: str | None = None) -> dict:
    async with httpx.AsyncClient(headers=HEADERS, timeout=TIMEOUT) as client:
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
    async with httpx.AsyncClient(headers=HEADERS, timeout=TIMEOUT) as client:
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
    async with httpx.AsyncClient(headers=HEADERS, timeout=TIMEOUT) as client:
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
    async with httpx.AsyncClient(headers=HEADERS, timeout=TIMEOUT) as client:
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
    if "취소" in result.text or "삭제" in result.text:
        return {"success": True, "message": "예약 취소 완료"}
    return {"success": False, "message": "예약 취소 처리에 실패했습니다."}
