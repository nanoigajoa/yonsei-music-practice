import unittest
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
OFF_GRID_ROOM_HTML = """
<div class="Body-List">
  <div class="title"><table><tr><td></td><td>연습실(318호)</td></tr></table></div>
  <div class="reserve"><a onclick="go('3','pc318','1','2','20','04')">예약</a></div>
</div>
"""


class Response:
    def __init__(self, text):
        self.text = text


class BookingPaginationTest(unittest.IsolatedAsyncioTestCase):
    def test_next_ten_minute_always_uses_a_future_slot(self):
        self.assertEqual(booking._next_ten_minute("18", "50"), ("19", "00"))
        self.assertEqual(booking._next_ten_minute("18", "51"), ("19", "00"))

    def test_current_occupied_slot_is_detected(self):
        soup = BeautifulSoup(OCCUPIED_HTML, "html.parser")
        self.assertEqual(booking._current_room_status(soup.select_one("div.Body-List")), "occupied")

    async def test_reserve_finds_room_on_second_page(self):
        client = AsyncMock()
        client.get.side_effect = [
            Response(""),  # main_view login preparation
            Response("<html></html>"),  # main_list page 1
            Response(ROOM_HTML),  # main_list page 2
            Response(FORM_HTML),  # reserve form
            Response("<html></html>"),  # booking_info: booking number may not be reflected yet
        ]
        client.post.side_effect = [Response(""), Response("예약 완료")]
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
            Response("<html></html>"),  # booking_info
        ]
        client.post.side_effect = [Response(""), Response("예약 완료")]
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
        self.assertEqual(reserve_payload["finish_min"], "00")
        self.assertEqual(reserve_payload["now_cell_time"], "20")
        self.assertEqual(reserve_payload["cell_min"], "10")
        self.assertEqual(reserve_payload["limit_time"], "120")

    async def test_reserve_retries_once_only_after_explicit_kiosk_login_failure(self):
        client = AsyncMock()
        client.get.side_effect = [
            Response("<html></html>"),  # first main_view
            Response(ROOM_HTML),  # main_list
            Response(FORM_HTML),  # first reserve form
            Response("<html></html>"),  # retry main_view
            Response(FORM_HTML),  # retry reserve form
            Response("<html></html>"),  # booking_info
        ]
        client.post.side_effect = [
            Response(""),  # first login
            Response('location.href="result.php?msg=로그인 후에 사용하세요"'),
            Response(""),  # retry login
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


if __name__ == "__main__":
    unittest.main()
