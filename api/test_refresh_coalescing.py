import asyncio
import unittest
from unittest.mock import patch

import collector


class RefreshCoalescingTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.previous = collector._manual_refresh_task
        collector._manual_refresh_task = None

    async def asyncTearDown(self):
        collector._manual_refresh_task = self.previous

    async def test_fifty_immediate_refreshes_share_one_kiosk_scan(self):
        calls = 0

        async def fake_refresh(_corners):
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.01)

        with patch.object(collector, "_refresh_serial", side_effect=fake_refresh):
            await asyncio.gather(*(collector.refresh_now() for _ in range(50)))

        self.assertEqual(calls, 1)


# These tests exercise daytime behavior; night boundary cases live in test_school_hours.py.
def setUpModule():
    global _school_clock_patch
    import clock
    _school_clock_patch = patch.object(clock, "now", return_value=clock.datetime(2026, 9, 7, 12, 0, tzinfo=clock.KST))
    _school_clock_patch.start()


def tearDownModule():
    _school_clock_patch.stop()
