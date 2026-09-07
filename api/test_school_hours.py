import asyncio
from datetime import datetime
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import os

os.environ.setdefault("BOOKING_TOKEN_SECRET", "test-secret-that-is-at-least-32-characters-long")
from fastapi.testclient import TestClient
import clock
import main
from auth_security import student_key


class NightIdentityTest(unittest.TestCase):
    def setUp(self):
        tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(tempdir.cleanup)
        self.db_patch = patch.object(main.reservations, "DB_PATH", Path(tempdir.name) / "identity.sqlite3")
        self.db_patch.start()
        self.addCleanup(self.db_patch.stop)
        self.clock_patch = patch.object(clock, "now", return_value=datetime(2026, 9, 7, 22, 0, tzinfo=clock.KST))
        self.clock_patch.start()
        self.addCleanup(self.clock_patch.stop)
        self.overrides = patch.dict(main.app.dependency_overrides, {
            main.current_user: lambda: {"uid": "existing-user", "firebase": {"sign_in_provider": "google.com"}},
        })
        self.overrides.start()
        self.addCleanup(self.overrides.stop)
        self.validator = AsyncMock(return_value=True)
        validator_patch = patch.object(main.booking, "validate_student", self.validator)
        validator_patch.start()
        self.addCleanup(validator_patch.stop)
        self.client = TestClient(main.app)
        self.addCleanup(self.client.close)
        self.student_id = "2026000001"

    def bind(self, student_id=None):
        return self.client.post("/identity/bind", json={
            "student_id": student_id or self.student_id,
            "privacy_notice_version": main.PRIVACY_NOTICE_VERSION,
        })

    def test_existing_user_can_restore_registration_at_night_without_school(self):
        key = student_key(self.student_id)
        main.reservations.bind_student("existing-user", key)
        for hour, minute in [(22, 0), (0, 0), (6, 59)]:
            with self.subTest(hour=hour), patch.object(clock, "now", return_value=datetime(2026, 9, 7, hour, minute, tzinfo=clock.KST)):
                response = self.bind()
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.json()["success"])
                self.assertFalse(response.json()["created"])
        self.assertEqual(main.reservations.binding_for_uid("existing-user"), key)
        self.validator.assert_not_awaited()

    def test_new_registration_validates_student_at_night(self):
        response = self.bind()
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["created"])
        self.assertEqual(main.reservations.binding_for_uid("existing-user"), student_key(self.student_id))
        self.validator.assert_awaited_once_with(self.student_id)

    def test_existing_user_cannot_change_student_at_night(self):
        key = student_key(self.student_id)
        main.reservations.bind_student("existing-user", key)
        self.assertEqual(self.bind("2026000002").status_code, 409)
        self.assertEqual(main.reservations.binding_for_uid("existing-user"), key)
        self.validator.assert_not_awaited()

    def test_other_account_cannot_claim_existing_student_at_night(self):
        key = student_key(self.student_id)
        main.reservations.bind_student("other-user", key)
        self.assertEqual(self.bind().status_code, 409)
        self.assertIsNone(main.reservations.binding_for_uid("existing-user"))
        self.assertEqual(main.reservations.binding_for_uid("other-user"), key)
        self.validator.assert_not_awaited()

    def test_non_google_account_cannot_confirm_registration_at_night(self):
        main.reservations.bind_student("existing-user", student_key(self.student_id))
        main.app.dependency_overrides[main.current_user] = lambda: {"uid": "existing-user"}
        self.assertEqual(self.bind().status_code, 403)
        self.validator.assert_not_awaited()

    def test_school_rejection_does_not_register_student_at_night(self):
        self.validator.return_value = False
        self.assertEqual(self.bind().status_code, 422)
        self.assertIsNone(main.reservations.binding_for_uid("existing-user"))
        self.validator.assert_awaited_once_with(self.student_id)

    def test_health_reports_school_access_at_all_hours(self):
        for hour in (0, 6, 7, 21, 22, 23):
            with self.subTest(hour=hour), patch.object(clock, "now", return_value=datetime(2026, 9, 7, hour, tzinfo=clock.KST)):
                response = self.client.get("/health")
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.json()["school_access_allowed"])


class NightCollectionTest(unittest.IsolatedAsyncioTestCase):
    async def test_night_polling_runs_school_scan(self):
        import collector
        for hour in (0, 6, 22, 23):
            with self.subTest(hour=hour), patch.object(clock, "now", return_value=datetime(2026, 9, 7, hour, tzinfo=clock.KST)), patch.object(collector, "_refresh_gate", asyncio.Lock()), patch.object(collector, "_refresh", AsyncMock()) as refresh:
                await collector._refresh_serial([1])
                refresh.assert_awaited_once()
                self.assertEqual(refresh.await_args.args[1], [1])
