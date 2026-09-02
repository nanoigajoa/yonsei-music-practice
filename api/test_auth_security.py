import os
import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

os.environ["BOOKING_TOKEN_SECRET"] = "test-secret-that-is-at-least-32-characters-long"
os.environ["BOOKING_ENABLED"] = "true"
os.environ["ALLOWED_TEST_ROOMS"] = "119"

import main
from auth_security import issue_return_token


class BookingSecurityTest(unittest.TestCase):
    def setUp(self):
        main.app.dependency_overrides[main.current_user] = lambda: {"uid": "user-a"}
        self.client = TestClient(main.app)

    def tearDown(self):
        main.app.dependency_overrides.clear()

    def test_reserve_issues_capability_for_authenticated_user(self):
        with patch.object(main.booking, "reserve", AsyncMock(return_value={"success": True, "message": "ok"})):
            response = self.client.post("/booking/reserve", json={
                "student_id": "20260001", "corner_no": 1, "room_no": "119", "limit_time": 60,
            })
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["return_token"])

    def test_reserve_rejects_room_outside_allowlist(self):
        response = self.client.post("/booking/reserve", json={
            "student_id": "20260001", "corner_no": 1, "room_no": "118", "limit_time": 60,
        })
        self.assertEqual(response.status_code, 403)

    def test_return_accepts_matching_user_and_capability(self):
        token = issue_return_token("user-a", "20260001", 1, "119")
        with patch.object(main.booking, "return_room", AsyncMock(return_value={"success": True})) as mocked:
            response = self.client.post("/booking/return", json={
                "student_id": "20260001", "corner_no": 1, "return_token": token,
            })
        self.assertEqual(response.status_code, 200)
        mocked.assert_awaited_once()

    def test_return_rejects_other_google_user(self):
        token = issue_return_token("user-b", "20260001", 1, "119")
        with patch.object(main.booking, "return_room", AsyncMock()) as mocked:
            response = self.client.post("/booking/return", json={
                "student_id": "20260001", "corner_no": 1, "return_token": token,
            })
        self.assertEqual(response.status_code, 403)
        mocked.assert_not_awaited()

    def test_return_rejects_other_student_or_tampered_token(self):
        token = issue_return_token("user-a", "20260001", 1, "119")
        wrong_student = self.client.post("/booking/return", json={
            "student_id": "20260002", "corner_no": 1, "return_token": token,
        })
        tampered = self.client.post("/booking/return", json={
            "student_id": "20260001", "corner_no": 1, "return_token": token[:-1] + "x",
        })
        self.assertEqual(wrong_student.status_code, 403)
        self.assertEqual(tampered.status_code, 403)

    def test_return_rejects_other_corner_or_expired_token(self):
        with patch("auth_security.time.time", return_value=1_000):
            token = issue_return_token("user-a", "20260001", 1, "119")
        wrong_corner = self.client.post("/booking/return", json={
            "student_id": "20260001", "corner_no": 2, "return_token": token,
        })
        with patch("auth_security.time.time", return_value=1_000 + 4 * 60 * 60 + 1):
            expired = self.client.post("/booking/return", json={
                "student_id": "20260001", "corner_no": 1, "return_token": token,
            })
        self.assertEqual(wrong_corner.status_code, 403)
        self.assertEqual(expired.status_code, 403)


class LoginRequiredTest(unittest.TestCase):
    def test_reserve_without_login_is_rejected(self):
        client = TestClient(main.app)
        response = client.post("/booking/reserve", json={
            "student_id": "20260001", "corner_no": 1, "room_no": "119", "limit_time": 60,
        })
        self.assertEqual(response.status_code, 401)


if __name__ == "__main__":
    unittest.main()
