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

    def record(self, ident="old", status="active", start=None, number="777", source="app"):
        start = start or self.now.replace(hour=20, minute=10)
        with patch.object(r, "kst_now", return_value=start):
            r.acquire(id=ident, uid=ident, student_id="student", student_key=ident, corner_no=1, room_no=ident, booking_source=source)
            r.finalize(ident, start_at=start, duration_min=120, kiosk_booking_no=number)
            r.set_status(ident, status)
        return r.get(ident)

    async def test_cutoff_includes_current_usage_independent_of_planned_start(self):
        self.record()
        self.record("pending", status="pending_tag", start=self.now-timedelta(minutes=5))
        self.record("at-cutoff", start=self.now)
        self.record("new", start=self.now+timedelta(minutes=1))
        self.record("missing", number=None)
        self.record("ended", start=self.now-timedelta(hours=2))
        with patch.object(main.booking, "return_room", AsyncMock(return_value={"success": True})) as call:
            count = await auto_return.process_daily(main._daily_return, self.now)
        self.assertEqual(count, 3)
        self.assertEqual(call.await_count, 3)
        self.assertEqual(r.get("at-cutoff").status, "returned")
        self.assertEqual(r.get("ended").status, "returned")
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
        r.daily_return_snapshot(self.now)
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
        r.daily_return_snapshot(self.now)
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
        r.daily_return_snapshot(self.now)
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

    async def test_snapshot_is_frozen_across_connections_and_late_tagging(self):
        self.record()
        self.record("late-tag", status="pending_tag", start=self.now-timedelta(minutes=5))
        self.assertEqual([x.id for x in r.daily_return_snapshot(self.now)], ["old"])
        self.now += timedelta(minutes=1)
        r.transition("late-tag", expected_status="pending_tag", status="active")
        self.record("new", start=self.now)
        self.assertEqual([x.id for x in r.daily_return_snapshot(self.now)], ["old"])
        with patch.object(main.booking, "return_room", AsyncMock(return_value={"success": True})) as call:
            self.assertFalse(await main._daily_return("new"))
            self.assertFalse(await main._daily_return("late-tag"))
            self.assertEqual(await auto_return.process_daily(main._daily_return, self.now), 1)
        call.assert_awaited_once()

    async def test_delayed_first_poll_excludes_post_cutoff_tag_even_with_old_start(self):
        self.record()
        self.record("late-tag", status="pending_tag", start=self.now-timedelta(minutes=5))
        self.now += timedelta(seconds=4)
        r.set_status("late-tag", "active")
        self.assertEqual([x.id for x in r.daily_return_snapshot(self.now)], ["old"])

    async def test_empty_snapshot_stays_empty_when_booking_is_added_later(self):
        self.assertEqual(r.daily_return_snapshot(self.now), [])
        self.now += timedelta(minutes=1)
        self.record("new", start=self.now)
        self.assertEqual(r.daily_return_snapshot(self.now), [])

    async def test_kiosk_imports_and_unknown_legacy_sources_are_excluded(self):
        self.record("phone")
        self.record("kiosk", source="kiosk")
        self.record("legacy")
        with r._connection() as conn:
            conn.execute("UPDATE reservations SET booking_source='unknown' WHERE id='legacy'")
        self.assertEqual([x.id for x in r.daily_return_snapshot(self.now)], ["phone"])

    async def test_expired_locally_after_cutoff_remains_in_original_retry_cohort(self):
        self.record()
        r.daily_return_snapshot(self.now)
        r.set_status("old", "ended")
        self.now += timedelta(minutes=1)
        with patch.object(main.booking, "return_room", AsyncMock(return_value={"success": True})) as call:
            self.assertEqual(await auto_return.process_daily(main._daily_return, self.now), 1)
        call.assert_awaited_once()
        self.assertEqual(r.get("old").status, "returned")

    async def test_school_booking_identity_changed_since_snapshot_is_never_returned(self):
        self.record()
        r.daily_return_snapshot(self.now)
        with r._connection() as conn:
            conn.execute("UPDATE reservations SET kiosk_booking_no='new-school-id' WHERE id='old'")
        with patch.object(main.booking, "return_room", AsyncMock()) as call:
            self.assertFalse(await main._daily_return("old"))
        call.assert_not_awaited()

    async def test_import_endpoint_marks_kiosk_booking_outside_phone_cohort(self):
        from auth_security import student_key
        student = "2026000001"
        r.bind_student("import-user", student_key(student))
        request = main.KioskImportRequest(student_id=student, corner_no=1, room_no="119")
        with patch.object(main.booking, "active_details", AsyncMock(return_value={
            "success": True, "room_no": "119", "booking_no": "kiosk-only",
            "start_at": (self.now-timedelta(minutes=20)).isoformat(),
            "end_at": (self.now+timedelta(minutes=100)).isoformat(),
        })), patch.object(main.collector, "mark_active", AsyncMock()):
            result = await main.import_active_booking(request, user={"uid": "import-user"})
        self.assertTrue(result["success"])
        with r._connection() as conn:
            self.assertEqual(conn.execute("SELECT booking_source FROM reservations WHERE uid='import-user'").fetchone()[0], "kiosk")
        self.assertEqual(r.daily_return_snapshot(self.now), [])

    async def test_migration_distinguishes_proven_phone_request_from_legacy_import(self):
        self.record("phone")
        self.record("import")
        with r._connection() as conn:
            conn.execute("UPDATE reservations SET request_id='phone-request' WHERE id='phone'")
            conn.execute("ALTER TABLE reservations DROP COLUMN booking_source")
            conn.execute("ALTER TABLE reservations DROP COLUMN active_at")
        self.assertEqual([x.id for x in r.daily_return_snapshot(self.now)], ["phone"])
