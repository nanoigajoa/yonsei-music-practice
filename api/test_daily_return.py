import asyncio
import os
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch
os.environ.setdefault("BOOKING_TOKEN_SECRET", "practice-test-secret-at-least-32-characters")
import main
import reservations as r
import auto_return
from clock import KST


class DailyReturnTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.now = datetime(2026, 9, 8, 21, 50, tzinfo=KST)
        for obj, name, value in [(r, "DB_PATH", Path(temp.name)/"db.sqlite"), (r, "kst_now", lambda: self.now), (main, "kst_now", lambda: self.now)]:
            patcher = patch.object(obj, name, value); patcher.start(); self.addCleanup(patcher.stop)
        for name in ("clear_reserved", "refresh_corner_now"):
            patcher = patch.object(main.collector, name, AsyncMock()); patcher.start(); self.addCleanup(patcher.stop)

    def record(self, ident="old", status="active", start=None, number="777"):
        start = start or self.now.replace(hour=20, minute=10)
        with patch.object(r, "kst_now", return_value=start):
            r.acquire(id=ident, uid=ident, student_id="student", student_key=ident, corner_no=1, room_no=ident)
            r.finalize(ident, start_at=start, duration_min=120, kiosk_booking_no=number)
            r.set_status(ident, status)
        return r.get(ident)

    async def test_only_tagged_pre_cutoff_records_and_correct_ids_are_returned(self):
        self.record()
        self.record("pending", status="pending_tag", start=self.now-timedelta(minutes=5))
        self.record("new", start=self.now)
        self.record("missing", number=None)
        self.record("ended", start=self.now-timedelta(hours=2))
        with patch.object(main.booking, "return_room", AsyncMock(return_value={"success": True})) as call:
            count = await auto_return.process_daily(main._daily_return, self.now)
        self.assertEqual(count, 1)
        call.assert_awaited_once_with("student", 1, "777")
        self.assertEqual(r.get("old").status, "returned")
        self.assertEqual(r.get("new").status, "active")
        with r._connection() as conn:
            self.assertEqual(conn.execute("SELECT returned_at FROM reservations WHERE id='old'").fetchone()[0], self.now.isoformat())

    async def test_no_run_before_cutoff_or_after_retry_window(self):
        self.record()
        call = AsyncMock()
        for when in [self.now-timedelta(seconds=1), self.now.replace(hour=22, minute=0), self.now+timedelta(days=1, minutes=11)]:
            self.assertEqual(await auto_return.process_daily(call, when), 0)
        call.assert_not_awaited()

    async def test_retry_throttle_survives_fresh_db_connections(self):
        self.record()
        with patch.object(main.booking, "return_room", AsyncMock(side_effect=[{"success": False}, {"success": True}])) as call:
            self.assertFalse(await main._daily_return("old"))
            self.assertFalse(await main._daily_return("old"))
            self.now += timedelta(seconds=30)
            self.assertTrue(await main._daily_return("old"))
            self.assertEqual(call.await_count, 2)

    async def test_manual_return_and_old_job_cannot_return_a_new_record(self):
        self.record(); r.set_status("old", "returned")
        self.record("new", start=self.now)
        with patch.object(main.booking, "return_room", AsyncMock()) as call:
            self.assertFalse(await main._daily_return("old"))
            self.assertFalse(await main._daily_return("new"))
        call.assert_not_awaited()

    async def test_concurrent_workers_send_one_return(self):
        self.record()
        with patch.object(main.booking, "return_room", AsyncMock(return_value={"success": True})) as call:
            results = await asyncio.gather(main._daily_return("old"), main._daily_return("old"))
        self.assertEqual(sum(results), 1); call.assert_awaited_once()

    async def test_failed_request_does_not_mark_returned_and_stops_at_22(self):
        self.record()
        with patch.object(main.booking, "return_room", AsyncMock(side_effect=RuntimeError("offline"))) as call:
            self.assertEqual(await auto_return.process_daily(main._daily_return, self.now), 0)
            self.assertEqual(r.get("old").status, "active")
            self.now = self.now.replace(hour=22, minute=0)
            self.assertFalse(await main._daily_return("old"))
        call.assert_awaited_once()

    async def test_expiration_during_school_request_updates_only_original_history(self):
        self.record()
        async def school(*args):
            r.set_status("old", "ended")
            self.record("new", start=self.now)
            return {"success": True}
        with patch.object(main.booking, "return_room", side_effect=school):
            self.assertTrue(await main._daily_return("old"))
        self.assertEqual(r.get("old").status, "returned")
        self.assertEqual(r.get("new").status, "active")

    async def test_notice_is_published_only_when_feature_is_enabled(self):
        for enabled in [False, True]:
            with patch.object(main, "DAILY_RETURN_ENABLED", enabled):
                data = await main.announcements()
            self.assertEqual(bool(data["items"]), enabled)
