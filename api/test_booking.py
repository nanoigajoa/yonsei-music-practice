import unittest
from datetime import datetime
import httpx
from clock import KST
from unittest.mock import AsyncMock, patch

import booking
from bs4 import BeautifulSoup


ROOM_HTML = """
<div class="Body-List">
  <div class="title"><table><tr><td></td><td>연습실(318호)</td></tr></table></div>
  <div class="reserve"><a onclick="go('3','pc318','1','2','21','50')">예약</a></div>
</div>
"""
OCCUPIED_HTML = """
<div class="Body-List">
  <div class="title"><table><tr><td></td><td>연습실(411호)</td></tr></table></div>
  <div class="contents"><ul><li title="현재 예약된 시간"><img id="time_cell_5_0" src="/images/time_blue.gif"></li></ul></div>
  <div class="reserve"><a onclick="go('4','38','1','2','15','16')">예약</a></div>
</div>
"""
FORM_HTML = """
<select name="begin_hour"><option value="21">21</option></select>
<select name="begin_min"><option value="50">50</option></select>
"""
NATIVE_FORM_HTML = """
<form>
  <input type="hidden" name="native_token" value="kiosk-generated-token">
  <input type="hidden" name="stime" value="2026-09-07 20:04:01">
  <input type="hidden" name="etime" value="">
  <input type="hidden" name="now_cell_time" value="20">
  <input type="hidden" name="cell_min" value="04">
  <input type="checkbox" name="unchecked" value="no">
  <input type="checkbox" name="checked" value="yes" checked>
</form>
"""
OFF_GRID_ROOM_HTML = """
<div class="Body-List">
  <div class="title"><table><tr><td></td><td>연습실(318호)</td></tr></table></div>
  <div class="reserve"><a onclick="go('3','pc318','1','2','20','04')">예약</a></div>
</div>
"""


LOGIN_HTML = "<script>window.opener.location = '/booking/index.php';</script>"


def receipt(start="20:10", end="22:09", room="318", number="777", date="2026-09-07"):
    return f"<table><tr><td>{date} {room}호 {start}~{end}</td><td><a onclick=\"booking_del('{number}')\">취소</a></td></tr></table>"


class Response:
    def __init__(self, text, status_code=200):
        self.text = text
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            request = httpx.Request("GET", "https://test.invalid")
            raise httpx.HTTPStatusError("HTTP error", request=request, response=httpx.Response(self.status_code, request=request))


class BookingPaginationTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        fixed = patch.object(booking, "kst_now", return_value=datetime(2026, 9, 7, 19, 0, tzinfo=KST))
        fixed.start()
        self.addCleanup(fixed.stop)

    def test_next_ten_minute_always_uses_a_future_slot(self):
        self.assertEqual(booking._next_ten_minute("18", "50"), ("19", "00"))
        self.assertEqual(booking._next_ten_minute("18", "51"), ("19", "00"))

    def test_native_form_values_keeps_hidden_values_and_omits_unchecked_controls(self):
        values = booking._native_form_values(NATIVE_FORM_HTML)
        self.assertEqual(values["native_token"], "kiosk-generated-token")
        self.assertEqual(values["stime"], "2026-09-07 20:04:01")
        self.assertEqual(values["checked"], "yes")
        self.assertNotIn("unchecked", values)

    def test_current_occupied_slot_is_detected(self):
        soup = BeautifulSoup(OCCUPIED_HTML, "html.parser")
        self.assertEqual(booking._current_room_status(soup.select_one("div.Body-List")), "occupied")

    async def test_student_validation_requires_kiosk_login_success_marker(self):
        client = AsyncMock()
        client.get.return_value = Response("<html></html>")
        client.post.side_effect = [
            Response("Not Found"),
            Response("<script>window.opener.location = '/booking/index.php';</script>"),
        ]
        context = AsyncMock()
        context.__aenter__.return_value = client
        context.__aexit__.return_value = False

        with patch.object(booking.httpx, "AsyncClient", return_value=context):
            self.assertTrue(await booking.validate_student("2022172528"))
        self.assertEqual(client.post.await_count, 2)

    async def test_reserve_finds_room_on_second_page(self):
        client = AsyncMock()
        client.get.side_effect = [
            Response(""),  # main_view login preparation
            Response("<html></html>"),  # main_list page 1
            Response(ROOM_HTML),  # main_list page 2
            Response(FORM_HTML),  # reserve form
            Response(receipt("22:00", "22:30")),  # exact confirmed receipt
        ]
        client.post.side_effect = [Response(LOGIN_HTML), Response("예약 완료")]
        context = AsyncMock()
        context.__aenter__.return_value = client
        context.__aexit__.return_value = False

        with patch.object(booking.httpx, "AsyncClient", return_value=context):
            result = await booking.reserve("2022172528", 3, "318", 30)

        self.assertTrue(result["success"])
        page_calls = [call.kwargs.get("params", {}).get("page") for call in client.get.await_args_list]
        self.assertIn("2", page_calls)
        reserve_payload = client.post.await_args_list[1].kwargs["data"]
        self.assertEqual(reserve_payload["pc_name_no"], "연습실(318)")
        self.assertEqual(reserve_payload["limit_time"], "30")

    async def test_reserve_always_uses_next_ten_minute_boundary_for_120_minutes(self):
        client = AsyncMock()
        client.get.side_effect = [
            Response("<html></html>"),  # main_view login preparation
            Response(OFF_GRID_ROOM_HTML),  # main_list page 1
            Response("<html></html>"),  # reserve form: structure may be absent
            Response(receipt()),  # booking_info
        ]
        client.post.side_effect = [Response(LOGIN_HTML), Response("예약 완료")]
        context = AsyncMock()
        context.__aenter__.return_value = client
        context.__aexit__.return_value = False

        with patch.object(booking.httpx, "AsyncClient", return_value=context):
            result = await booking.reserve("2022172528", 3, "318", 120)

        self.assertTrue(result["success"])
        reserve_payload = client.post.await_args_list[1].kwargs["data"]
        self.assertEqual(reserve_payload["begin_hour"], "20")
        self.assertEqual(reserve_payload["begin_min"], "10")
        self.assertEqual(reserve_payload["finish_hour"], "22")
        self.assertEqual(reserve_payload["finish_min"], "09")
        self.assertEqual(reserve_payload["now_cell_time"], "20")
        self.assertEqual(reserve_payload["cell_min"], "10")
        self.assertEqual(reserve_payload["limit_time"], "120")

    async def test_reserve_preserves_kiosk_native_time_values(self):
        client = AsyncMock()
        client.get.side_effect = [
            Response("<html></html>"),  # main_view login preparation
            Response(OFF_GRID_ROOM_HTML),  # main_list page 1
            Response(NATIVE_FORM_HTML),  # reserve form
            Response(receipt()),  # booking_info
        ]
        client.post.side_effect = [Response(LOGIN_HTML), Response("예약 완료")]
        context = AsyncMock()
        context.__aenter__.return_value = client
        context.__aexit__.return_value = False

        with patch.object(booking.httpx, "AsyncClient", return_value=context):
            result = await booking.reserve("2022172528", 3, "318", 120)

        self.assertTrue(result["success"])
        payload = client.post.await_args_list[1].kwargs["data"]
        self.assertEqual(payload["native_token"], "kiosk-generated-token")
        self.assertEqual(payload["stime"], "2026-09-07 20:10:00")
        self.assertEqual((payload["now_cell_time"], payload["cell_min"]), ("20", "10"))
        self.assertEqual((payload["begin_hour"], payload["begin_min"]), ("20", "10"))
        self.assertEqual((payload["finish_hour"], payload["finish_min"]), ("22", "09"))
        self.assertEqual((payload["stime"], payload["etime"]), ("2026-09-07 20:10:00", "2026-09-07 22:09:59"))
        self.assertEqual(client.post.await_count, 2)  # login 1회 + 예약 전송 1회

    async def test_reserve_retries_once_only_after_explicit_kiosk_login_failure(self):
        client = AsyncMock()
        client.get.side_effect = [
            Response("<html></html>"),  # first main_view
            Response(ROOM_HTML),  # main_list
            Response(FORM_HTML),  # first reserve form
            Response("<html></html>"),  # retry main_view
            Response(FORM_HTML),  # retry reserve form
            Response(receipt("22:00", "23:00")),  # booking_info
        ]
        client.post.side_effect = [
            Response(LOGIN_HTML),  # first login
            Response('location.href="result.php?msg=로그인 후에 사용하세요"'),
            Response(LOGIN_HTML),  # retry login
            Response("예약 완료"),
        ]
        context = AsyncMock()
        context.__aenter__.return_value = client
        context.__aexit__.return_value = False

        with patch.object(booking.httpx, "AsyncClient", return_value=context):
            result = await booking.reserve("2022172528", 3, "318", 60)

        self.assertTrue(result["success"])
        self.assertEqual(client.post.await_count, 4)
        self.assertEqual(
            client.post.await_args_list[1].kwargs["data"],
            client.post.await_args_list[3].kwargs["data"],
        )

    async def test_active_rechecks_after_tag_terminal_sync_delay(self):
        client = AsyncMock()
        client.get.side_effect = [
            Response("<html></html>"),  # main_view login preparation
            Response("<html></html>"),  # first index: terminal sync not complete
            Response('<script>var booking_no = "777";</script>'),  # second index: synced
        ]
        client.post.side_effect = [Response("")]
        context = AsyncMock()
        context.__aenter__.return_value = client
        context.__aexit__.return_value = False

        with patch.object(booking.httpx, "AsyncClient", return_value=context), patch.object(
            booking, "TAG_CONFIRM_WAIT_SECONDS", 0.1
        ), patch.object(booking, "TAG_CONFIRM_RETRY_SECONDS", 0.001):
            result = await booking.active("2022172528", 1, "777")

        self.assertTrue(result["active"])
        self.assertEqual(result["booking_no"], "777")

    async def test_cancel_failure_text_is_not_success(self):
        for text, success in (("예약 취소 실패", False), ("취소 버튼", False), ("예약 취소되었습니다.", True)):
            client = AsyncMock()
            client.get.side_effect = [Response(""), Response(receipt(room="119")), Response(text)]
            client.post.return_value = Response(LOGIN_HTML)
            context = AsyncMock()
            context.__aenter__.return_value = client
            with patch.object(booking.httpx, "AsyncClient", return_value=context):
                result = await booking.cancel("2022172528", 1, "119", "777")
            self.assertEqual(result["success"], success)

    async def test_cancel_never_targets_unknown_or_different_booking(self):
        for number, room in [(None, "119"), ("888", "119"), ("777", "1119")]:
            client = AsyncMock()
            client.get.return_value = Response(receipt(room=room))
            context = AsyncMock(); context.__aenter__.return_value = client
            with patch.object(booking.httpx, "AsyncClient", return_value=context), patch.object(booking, "_login", AsyncMock()):
                result = await booking.cancel("student", 1, "119", number)
            self.assertFalse(result["success"])
            self.assertEqual(client.get.await_count, 1)

    async def test_return_requires_exact_active_booking_and_explicit_success(self):
        for expected, actual, text, success in [
            (None, "777", "반납 되었습니다", False),
            ("777", "888", "반납 되었습니다", False),
            ("777", None, "반납 되었습니다", False),
            ("777", "", "", True),
            ("777", "777", "반납 되었습니다", True),
            ("777", "777", "오류: 반납 되었습니다", False),
        ]:
            client = AsyncMock(); client.get.return_value = Response(text)
            context = AsyncMock(); context.__aenter__.return_value = client
            with patch.object(booking.httpx, "AsyncClient", return_value=context), patch.object(booking, "_login", AsyncMock()), patch.object(booking, "_active_booking_no", AsyncMock(return_value=actual)):
                result = await booking.return_room("student", 1, expected)
            self.assertEqual(result["success"], success)
            if actual == "":
                self.assertTrue(result["already_returned"])
            self.assertEqual(client.get.await_count, int(bool(expected) and expected == actual))


if __name__ == "__main__":
    unittest.main()
