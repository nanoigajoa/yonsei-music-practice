"""키오스크 예약·태그 확인·반납 연동."""
import re

import httpx
from bs4 import BeautifulSoup

BASE = "http://165.132.176.173"
HEADERS = {"User-Agent": "Mozilla/5.0 Edge"}
TIMEOUT = 10.0

CORNER_NAMES = {
    1: "음악관A 1층", 2: "음악관A 2층", 3: "음악관A 3층", 4: "음악관A 4층",
    6: "음악관B 1층", 8: "음악관B 3층", 9: "음악관B 4층",
}


async def _login(client: httpx.AsyncClient, student_id: str, corner_no: int) -> None:
    await client.get(
        f"{BASE}/booking/main_view.php",
        params={"corner_no": corner_no, "TimeCellSize": 0},
    )
    await client.post(
        f"{BASE}/booking/login_proc.php",
        data={"rfid": student_id},
        headers={**HEADERS, "Referer": f"{BASE}/booking/main_view.php"},
    )


async def reserve(student_id: str, corner_no: int, room_no: str, limit_time: int) -> dict:
    if corner_no not in CORNER_NAMES:
        return {"success": False, "message": "지원하지 않는 건물/층입니다."}
    if limit_time not in (30, 60, 90, 120):
        return {"success": False, "message": "예약 시간은 30분 단위로 최대 2시간입니다."}

    async with httpx.AsyncClient(headers=HEADERS, timeout=TIMEOUT) as client:
        await _login(client, student_id, corner_no)
        listing = await client.get(
            f"{BASE}/booking/main_list.php",
            params={"corner_no": corner_no, "TimeCellSize": 0, "page": ""},
            headers={**HEADERS, "Referer": f"{BASE}/booking/main_view.php"},
        )
        soup = BeautifulSoup(listing.text, "html.parser")
        params = None
        for seat in soup.select("div.Body-List"):
            title = seat.select_one("div.title tr td:nth-child(2)")
            title_room = re.search(r"(\d+)호", title.get_text(" ", strip=True) if title else "")
            if not title_room or title_room.group(1) != room_no:
                continue
            link = seat.select_one("div.reserve a[onclick]")
            values = re.findall(r"'([^']+)'", link.get("onclick", "")) if link else []
            if len(values) >= 6:
                params = values[:6]
            break

        if not params:
            return {"success": False, "message": f"{room_no}호는 현재 예약할 수 없습니다. 현황을 새로고침해 주세요."}

        corner, pc_id, open_ts, close_ts, now_cell, cell_min = params
        form = await client.get(
            f"{BASE}/booking/reserve.php",
            params={
                "corner_no": corner, "pc_id": pc_id, "open_timestamp": open_ts,
                "close_timestamp": close_ts, "now_cell_time": now_cell, "cell_min": cell_min,
            },
            headers={**HEADERS, "Referer": f"{BASE}/booking/main_list.php"},
        )
        form_soup = BeautifulSoup(form.text, "html.parser")
        begin_hour = form_soup.select_one("select[name=begin_hour] option")
        begin_min = form_soup.select_one("select[name=begin_min] option")
        b_hour = begin_hour.get("value", now_cell) if begin_hour else now_cell
        b_min = begin_min.get("value", cell_min) if begin_min else cell_min
        finish_total = int(b_hour) * 60 + int(b_min) + limit_time

        result = await client.post(
            f"{BASE}/booking/reserve_proc.php",
            data={
                "admin_mode": "", "corner_no": corner, "pc_id": pc_id, "quick": "",
                "corner_name": CORNER_NAMES[corner_no], "pc_name_no": f"연습실({room_no})",
                "limit_time": str(limit_time), "now_cell_time": now_cell, "cell_min": cell_min,
                "stime": "", "etime": "", "begin_hour": b_hour, "begin_min": b_min,
                "finish_hour": str(finish_total // 60), "finish_min": str(finish_total % 60),
            },
            headers={**HEADERS, "Referer": f"{BASE}/booking/reserve.php"},
        )
        error = re.search(r"msg=([^\"&]+)", result.text)
        if error:
            return {"success": False, "message": error.group(1)}
        return {"success": True, "message": f"{room_no}호 예약 완료"}


async def _booking_no(client: httpx.AsyncClient, corner_no: int) -> str | None:
    index = await client.get(
        f"{BASE}/booking/index.php",
        params={"reload": 1, "corner_no": corner_no, "TimeCellSize": 0},
    )
    match = re.search(r'var booking_no\s*=\s*["\'](\d+)["\']', index.text)
    if match:
        return match.group(1)
    info = await client.get(
        f"{BASE}/booking/info1.php",
        headers={**HEADERS, "Referer": f"{BASE}/booking/index.php"},
    )
    matches = re.findall(r"booking_no=(\d+)", info.text)
    return matches[0] if matches else None


async def active(student_id: str, corner_no: int) -> dict:
    async with httpx.AsyncClient(headers=HEADERS, timeout=TIMEOUT) as client:
        await _login(client, student_id, corner_no)
        number = await _booking_no(client, corner_no)
    if not number:
        return {"success": False, "active": False, "message": "아직 태그 인증이 확인되지 않았습니다."}
    return {"success": True, "active": True, "booking_no": number, "message": "태그 인증 확인 완료"}


async def return_room(student_id: str, corner_no: int) -> dict:
    async with httpx.AsyncClient(headers=HEADERS, timeout=TIMEOUT) as client:
        await _login(client, student_id, corner_no)
        number = await _booking_no(client, corner_no)
        if not number:
            return {"success": False, "message": "활성 예약이 없습니다."}
        result = await client.get(f"{BASE}/booking/return.php", params={"booking_no": number})
    if "반납 되었습니다" in result.text:
        return {"success": True, "message": "반납 완료"}
    return {"success": False, "message": "반납 처리에 실패했습니다."}
