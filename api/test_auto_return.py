import unittest
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, patch

import auto_return


class AutoReturnTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        auto_return._pending.clear()

    async def test_does_not_return_before_reservation_end(self):
        now = datetime(2026, 9, 2, 13, 10)
        await auto_return.register("u1", "2022172528", 1, "119", due_at=now + timedelta(minutes=120))
        with patch.object(auto_return.booking, "return_room", AsyncMock()) as mocked:
            count = await auto_return.process_due(now)
        self.assertEqual(count, 0)
        mocked.assert_not_awaited()

    async def test_returns_at_reservation_end(self):
        now = datetime(2026, 9, 2, 15, 10)
        await auto_return.register("u1", "2022172528", 1, "119", due_at=now, booking_no="123")
        with patch.object(auto_return.booking, "return_room", AsyncMock(return_value={"success": True})) as mocked:
            count = await auto_return.process_due(now)
        self.assertEqual(count, 1)
        mocked.assert_awaited_once_with("2022172528", 1, "123")
        self.assertEqual(await auto_return.pending_count(), 0)

    async def test_failed_return_stays_queued_for_retry(self):
        now = datetime(2026, 9, 2, 15, 10)
        await auto_return.register("u1", "2022172528", 1, "119", due_at=now)
        with patch.object(auto_return.booking, "return_room", AsyncMock(return_value={"success": False, "message": "failed"})):
            await auto_return.process_due(now)
        self.assertEqual(await auto_return.pending_count(), 1)

    async def test_late_old_cancel_does_not_remove_new_auto_return(self):
        now = datetime(2026, 9, 2, 15, 10)
        await auto_return.register(
            "u1", "2022172528", 1, "119", due_at=now,
            reservation_id="new-reservation",
        )
        await auto_return.forget("u1", 1, reservation_id="old-reservation")
        self.assertEqual(await auto_return.pending_count(), 1)


if __name__ == "__main__":
    unittest.main()
