import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

import collector
import main
from models import Period, Room, StatusResponse


class StatusRefreshTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.previous_state = collector._state
        collector._state = StatusResponse(
            updated_at="2026-09-09T15:00:00+09:00",
            total=1,
            occupied_count=0,
            available_count=1,
            rooms=[Room(
                name="연습실 302호", corner_no=3, floor=3, occupied=False,
                occupied_until=None, available_periods=[Period(start="15:00", end="22:00")],
            )],
        )

    async def asyncTearDown(self):
        collector._state = self.previous_state

    async def test_refresh_reads_only_requested_corner_before_returning_status(self):
        with patch.object(collector, "refresh_corner_now", AsyncMock(return_value=True)) as refresh:
            result = await main.status(floor=None, occupied=None, refresh_corner=3)
        refresh.assert_awaited_once_with(3)
        self.assertEqual(result.rooms[0].corner_no, 3)

    async def test_refresh_rejects_unknown_corner(self):
        with self.assertRaises(HTTPException) as raised, patch.object(
            collector, "refresh_corner_now", AsyncMock()
        ) as refresh:
            await main.status(floor=None, occupied=None, refresh_corner=5)
        self.assertEqual(raised.exception.status_code, 422)
        refresh.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
