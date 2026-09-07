import unittest
import asyncio
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import collector
from models import Period, Room, StatusResponse


def room(name: str) -> Room:
    return Room(name=name, corner_no=1, floor=1, occupied=False, available_periods=[])


class CollectorPaginationTest(unittest.IsolatedAsyncioTestCase):
    async def test_fetch_corner_includes_next_page_and_deduplicates(self):
        client = SimpleNamespace(get=AsyncMock(side_effect=[
            SimpleNamespace(status_code=200, text="page1"),
            SimpleNamespace(status_code=200, text="page2"),
            SimpleNamespace(status_code=200, text="page3"),
        ]))
        parsed = {
            "page1": [room("연습실(126호)")],
            "page2": [room("연습실(126호)"), room("연습실(127호)")],
            "page3": [room("연습실(126호)"), room("연습실(127호)")],
        }
        with patch.object(collector, "_parse_html", side_effect=lambda html, _: parsed[html]):
            rooms = await collector._fetch_corner(client, 1)

        self.assertEqual([item.name for item in rooms], ["연습실(126호)", "연습실(127호)"])
        self.assertEqual(client.get.await_count, 3)


def status_html(statuses: list[str]) -> str:
    cells = []
    for index, status in enumerate(statuses):
        if status == "past":
            title, src, link = "지난 시간은 예약이 불가합니다.", "time_red.gif", ""
        elif status == "booked":
            title, src, link = "예약된 좌석", "time_blue.gif", ""
        else:
            title, src, link = "", "time_gray.gif", "<a>예약</a>"
        cells.append(
            f'<li title="{title}">{link}<img class="time_cell3" '
            f'id="time_cell_0_{index}" src="/images/kor/{src}"></li>'
        )
    return (
        '<div class="Body-List">'
        '<div class="title"><table><tr><td></td><td>연습실 108호</td></tr></table></div>'
        f'<div class="contents"><ul>{"".join(cells)}</ul></div>'
        '</div>'
    )


class CollectorHandoverTest(unittest.TestCase):
    def test_only_room_freeing_in_next_slot_is_handover(self):
        room = collector._parse_html(status_html(["past", "booked", "available"]), 1)[0]

        self.assertTrue(room.occupied)
        self.assertTrue(room.handover)
        self.assertEqual(room.occupied_until, "07:20")

    def test_room_booked_beyond_next_slot_is_not_handover(self):
        room = collector._parse_html(
            status_html(["past", "booked", "booked", "available"]), 1
        )[0]

        self.assertTrue(room.occupied)
        self.assertFalse(room.handover)
        self.assertEqual(room.occupied_until, "07:30")


class CollectorImmediateReleaseTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.old_state = collector._state
        self.old_pending = collector._pending_reservations
        self.old_refresh_gate = collector._refresh_gate
        self.old_corner_tasks = collector._corner_refresh_tasks
        self.old_corner_versions = collector._corner_versions
        collector._pending_reservations = {}
        collector._refresh_gate = asyncio.Lock()
        collector._corner_refresh_tasks = {}
        collector._corner_versions = {}

    async def asyncTearDown(self):
        collector._state = self.old_state
        collector._pending_reservations = self.old_pending
        collector._refresh_gate = self.old_refresh_gate
        collector._corner_refresh_tasks = self.old_corner_tasks
        collector._corner_versions = self.old_corner_versions

    @staticmethod
    def _room(number: str, *, corner: int = 1, occupied: bool = False) -> Room:
        return Room(
            name=f"연습실 {number}호", corner_no=corner, floor=int(number[0]),
            occupied=occupied,
            available_periods=[] if occupied else [Period(start="15:10", end="22:00")],
        )

    def _set_state(self, rooms: list[Room]) -> None:
        collector._state = StatusResponse(
            updated_at="2026-09-07T15:00:00+09:00", total=len(rooms),
            occupied_count=sum(1 for item in rooms if item.occupied),
            available_count=sum(1 for item in rooms if item.available_periods), rooms=rooms,
        )

    async def test_cancel_refreshes_only_the_corner_and_notifies_free_room(self):
        self._set_state([self._room("119"), self._room("201", corner=2)])
        now = collector.kst_now()
        await collector.mark_reserved(
            1, "119", start_at=now, end_at=now + timedelta(hours=2),
            tag_deadline=now + timedelta(minutes=10),
        )
        queue = collector.subscribe()
        try:
            await collector.clear_reserved(1, "119")
            with patch.object(collector, "_fetch_corner", AsyncMock(return_value=[self._room("119")])) as fetch:
                refreshed = await collector.refresh_corner_now(1)
            self.assertTrue(refreshed)
            fetch.assert_awaited_once()
            changed = next(item for item in collector.get_state().rooms if item.name.endswith("119호"))
            untouched = next(item for item in collector.get_state().rooms if item.name.endswith("201호"))
            self.assertFalse(changed.occupied)
            self.assertIsNone(changed.reservation_state)
            self.assertTrue(changed.available_periods)
            self.assertEqual(untouched.corner_no, 2)
            pushed = queue.get_nowait()
            self.assertFalse(next(item for item in pushed["rooms"] if item["name"].endswith("119호"))["occupied"])
        finally:
            collector.unsubscribe(queue)

    async def test_failed_school_refresh_never_guesses_that_room_is_free(self):
        self._set_state([self._room("119", occupied=True)])
        await collector.clear_reserved(1, "119")
        with patch.object(collector, "_fetch_corner", AsyncMock(return_value=[])):
            refreshed = await collector.refresh_corner_now(1)
        self.assertFalse(refreshed)
        self.assertTrue(collector.get_state().rooms[0].occupied)

    async def test_room_rebooked_by_someone_else_stays_occupied_after_refresh(self):
        self._set_state([self._room("119", occupied=True)])
        await collector.clear_reserved(1, "119")
        with patch.object(
            collector, "_fetch_corner", AsyncMock(return_value=[self._room("119", occupied=True)])
        ):
            refreshed = await collector.refresh_corner_now(1)
        self.assertTrue(refreshed)
        room = collector.get_state().rooms[0]
        self.assertTrue(room.occupied)
        self.assertIsNone(room.reservation_state)

    async def test_other_pending_room_in_same_corner_stays_reserved(self):
        self._set_state([self._room("119"), self._room("120")])
        now = collector.kst_now()
        await collector.mark_reserved(
            1, "119", start_at=now, end_at=now + timedelta(hours=2),
            tag_deadline=now + timedelta(minutes=10),
        )
        await collector.mark_reserved(
            1, "120", start_at=now, end_at=now + timedelta(hours=2),
            tag_deadline=now + timedelta(minutes=10),
        )
        await collector.clear_reserved(1, "119")
        with patch.object(
            collector, "_fetch_corner", AsyncMock(return_value=[self._room("119"), self._room("120")])
        ):
            await collector.refresh_corner_now(1)
        rooms = {item.name[-4:-1]: item for item in collector.get_state().rooms}
        self.assertFalse(rooms["119"].occupied)
        self.assertTrue(rooms["120"].occupied)
        self.assertEqual(rooms["120"].reservation_state, "pending_tag")

    async def test_late_old_cancel_cannot_clear_new_reservation_for_same_room(self):
        self._set_state([self._room("119")])
        now = collector.kst_now()
        await collector.mark_reserved(
            1, "119", start_at=now, end_at=now + timedelta(hours=1),
            tag_deadline=now + timedelta(minutes=10), reservation_id="new-reservation",
        )
        cleared = await collector.clear_reserved(1, "119", reservation_id="old-reservation")
        self.assertFalse(cleared)
        self.assertEqual(
            collector._pending_reservations[(1, "119")]["reservation_id"],
            "new-reservation",
        )
        self.assertTrue(collector.get_state().rooms[0].occupied)

    async def test_fifty_same_corner_refreshes_share_one_school_request(self):
        started = asyncio.Event()
        release = asyncio.Event()

        async def refresh(_corner_no: int) -> bool:
            started.set()
            await release.wait()
            return True

        with patch.object(collector, "_refresh_one_corner", AsyncMock(side_effect=refresh)) as original:
            tasks = [asyncio.create_task(collector.refresh_corner_now(1)) for _ in range(50)]
            await started.wait()
            release.set()
            results = await asyncio.gather(*tasks)
        self.assertTrue(all(results))
        original.assert_awaited_once_with(1)

    async def test_new_cancel_during_corner_fetch_forces_one_fresh_followup(self):
        first_started = asyncio.Event()
        release_first = asyncio.Event()
        calls = 0

        async def refresh(_corner_no: int) -> bool:
            nonlocal calls
            calls += 1
            if calls == 1:
                first_started.set()
                await release_first.wait()
            return True

        collector._corner_versions[1] = 1
        with patch.object(collector, "_refresh_one_corner", AsyncMock(side_effect=refresh)):
            first = asyncio.create_task(collector.refresh_corner_now(1))
            await first_started.wait()
            # 첫 조회가 학교 상태를 읽는 도중 같은 코너에서 다른
            # 방의 취소가 성공한 상황을 재현한다.
            await collector.clear_reserved(1, "120")
            second = asyncio.create_task(collector.refresh_corner_now(1))
            release_first.set()
            self.assertTrue(all(await asyncio.gather(first, second)))

        self.assertEqual(calls, 2)


if __name__ == "__main__":
    unittest.main()
