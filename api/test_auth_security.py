import os
import tempfile
import unittest
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

os.environ["BOOKING_TOKEN_SECRET"] = "test-secret-that-is-at-least-32-characters-long"
os.environ["BOOKING_ENABLED"] = "true"
os.environ["ALLOWED_TEST_ROOMS"] = "119"

import main
import reservations
from auth_security import issue_return_token, student_key


class BookingSecurityTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.original_db = reservations.DB_PATH
        reservations.DB_PATH = __import__("pathlib").Path(self.tempdir.name) / "reservations.sqlite3"
        main.app.dependency_overrides[main.current_user] = lambda: {"uid": "user-a"}
        reservations.bind_student("user-a", student_key("2022172528"))
        self.client = TestClient(main.app)

    def tearDown(self):
        main.app.dependency_overrides.clear()
        reservations.DB_PATH = self.original_db
        self.tempdir.cleanup()

    @staticmethod
    def reserve_result():
        return {"success": True, "message": "ok", "start_at": "2026-09-02T13:10:00"}

    def test_reserve_issues_capability_for_authenticated_user(self):
        with patch.object(main.booking, "reserve", AsyncMock(return_value=self.reserve_result())):
            response = self.client.post("/booking/reserve", json={
                "student_id": "2022172528", "corner_no": 1, "room_no": "119", "limit_time": 60,
            })
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["return_token"])

    def test_reserve_rejects_room_outside_allowlist(self):
        response = self.client.post("/booking/reserve", json={
            "student_id": "2022172528", "corner_no": 1, "room_no": "118", "limit_time": 60,
        })
        self.assertEqual(response.status_code, 403)

    def test_reserve_allows_any_room_with_production_wildcard(self):
        with patch.object(main, "ALLOWED_TEST_ROOMS", {"*"}), patch.object(
            main.booking, "reserve", AsyncMock(return_value=self.reserve_result())
        ):
            response = self.client.post("/booking/reserve", json={
                "student_id": "2022172528", "corner_no": 3, "room_no": "318", "limit_time": 60,
            })
        self.assertEqual(response.status_code, 200)

    def test_reserve_rejects_non_music_college_student_id(self):
        response = self.client.post("/booking/reserve", json={
            "student_id": "2022123456", "corner_no": 1, "room_no": "119", "limit_time": 60,
        })
        self.assertEqual(response.status_code, 422)

    def test_google_account_cannot_change_student_id_and_duplicate_is_rejected(self):
        main.app.dependency_overrides[main.current_user] = lambda: {
            "uid": "user-a", "firebase": {"sign_in_provider": "google.com"},
        }
        same = self.client.post("/identity/bind", json={"student_id": "2022172528"})
        self.assertEqual(same.status_code, 200)
        different = self.client.post("/identity/bind", json={"student_id": "2023172528"})
        self.assertEqual(different.status_code, 409)
        main.app.dependency_overrides[main.current_user] = lambda: {
            "uid": "user-b", "firebase": {"sign_in_provider": "google.com"},
        }
        duplicate = self.client.post("/identity/bind", json={"student_id": "2022172528", "privacy_notice_version": main.PRIVACY_NOTICE_VERSION})
        self.assertEqual(duplicate.status_code, 409)

    def test_new_binding_requires_privacy_notice_acknowledgement(self):
        main.app.dependency_overrides[main.current_user] = lambda: {
            "uid": "new-user", "firebase": {"sign_in_provider": "google.com"},
        }
        response = self.client.post("/identity/bind", json={"student_id": "2023172528"})
        self.assertEqual(response.status_code, 422)

    def test_new_binding_rejects_student_unknown_to_kiosk(self):
        main.app.dependency_overrides[main.current_user] = lambda: {
            "uid": "new-user", "firebase": {"sign_in_provider": "google.com"},
        }
        with patch.object(main.booking, "validate_student", AsyncMock(return_value=False)):
            response = self.client.post("/identity/bind", json={"student_id": "2022172999", "privacy_notice_version": main.PRIVACY_NOTICE_VERSION})

        self.assertEqual(response.status_code, 422)
        self.assertIsNone(reservations.binding_for_uid("new-user"))

    def test_new_binding_accepts_student_verified_by_kiosk(self):
        main.app.dependency_overrides[main.current_user] = lambda: {
            "uid": "new-user", "firebase": {"sign_in_provider": "google.com"},
        }
        with patch.object(main.booking, "validate_student", AsyncMock(return_value=True)):
            response = self.client.post("/identity/bind", json={"student_id": "2023172528", "privacy_notice_version": main.PRIVACY_NOTICE_VERSION})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(reservations.binding_for_uid("new-user"), student_key("2023172528"))

    def test_return_accepts_matching_user_and_capability(self):
        reservations.acquire(id="reservation-a", uid="user-a", student_id="2022172528", student_key="student-a", corner_no=1,
                             room_no="119")
        record = reservations.finalize("reservation-a", start_at=__import__("datetime").datetime.now(), duration_min=60,
                                       kiosk_booking_no=None)
        reservations.set_status(record.id, "active")
        token = issue_return_token("user-a", "2022172528", 1, "119", record.id)
        with patch.object(main.booking, "return_room", AsyncMock(return_value={"success": True})) as mocked, patch.object(
            main.collector, "refresh_now", AsyncMock()
        ):
            response = self.client.post("/booking/return", json={
                "student_id": "2022172528", "corner_no": 1, "return_token": token,
            })
        self.assertEqual(response.status_code, 200)
        mocked.assert_awaited_once()

    def test_return_rejects_other_google_user(self):
        token = issue_return_token("user-b", "2022172528", 1, "119")
        with patch.object(main.booking, "return_room", AsyncMock()) as mocked:
            response = self.client.post("/booking/return", json={
                "student_id": "2022172528", "corner_no": 1, "return_token": token,
            })
        self.assertEqual(response.status_code, 403)
        mocked.assert_not_awaited()

    def test_return_rejects_other_student_or_tampered_token(self):
        token = issue_return_token("user-a", "2022172528", 1, "119")
        wrong_student = self.client.post("/booking/return", json={
            "student_id": "2023172529", "corner_no": 1, "return_token": token,
        })
        tampered = self.client.post("/booking/return", json={
            "student_id": "2022172528", "corner_no": 1, "return_token": token[:-1] + "x",
        })
        self.assertEqual(wrong_student.status_code, 403)
        self.assertEqual(tampered.status_code, 403)

    def test_return_rejects_other_corner_or_expired_token(self):
        with patch("auth_security.time.time", return_value=1_000):
            token = issue_return_token("user-a", "2022172528", 1, "119")
        wrong_corner = self.client.post("/booking/return", json={
            "student_id": "2022172528", "corner_no": 2, "return_token": token,
        })
        with patch("auth_security.time.time", return_value=1_000 + 4 * 60 * 60 + 1):
            expired = self.client.post("/booking/return", json={
                "student_id": "2022172528", "corner_no": 1, "return_token": token,
            })
        self.assertEqual(wrong_corner.status_code, 403)
        self.assertEqual(expired.status_code, 403)

    def test_cancel_after_tag_deadline_returns_clean_completed_state(self):
        past_start = datetime.now() - timedelta(minutes=20)
        reservations.acquire(id="expired-one", uid="user-a", student_id="2022172528", student_key="student-a", corner_no=1,
                             room_no="119")
        reservations.finalize("expired-one", start_at=past_start, duration_min=120, kiosk_booking_no="old")
        token = issue_return_token("user-a", "2022172528", 1, "119", "expired-one")
        with patch.object(main.collector, "refresh_now", AsyncMock()):
            response = self.client.post("/booking/cancel", json={
                "student_id": "2022172528", "corner_no": 1, "return_token": token,
            })
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["success"])
        self.assertIn("자동 취소", response.json()["message"])


class LoginRequiredTest(unittest.TestCase):
    def test_reserve_without_login_is_rejected(self):
        client = TestClient(main.app)
        response = client.post("/booking/reserve", json={
            "student_id": "2022172528", "corner_no": 1, "room_no": "119", "limit_time": 60,
        })
        self.assertEqual(response.status_code, 401)


if __name__ == "__main__":
    unittest.main()
