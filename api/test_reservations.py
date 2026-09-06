import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

import reservations
import clock


class ReservationStateTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.original_db = reservations.DB_PATH
        reservations.DB_PATH = Path(self.tempdir.name) / "reservations.sqlite3"

    def tearDown(self):
        reservations.DB_PATH = self.original_db
        self.tempdir.cleanup()

    def test_tag_deadline_is_start_plus_ten_minutes_not_creation_time(self):
        start = datetime(2026, 9, 2, 13, 10)
        reservations.acquire(id="one", uid="u", student_id="2022172528", student_key="student-a", corner_no=1, room_no="119")
        record = reservations.finalize("one", start_at=start, duration_min=120, kiosk_booking_no="123")
        self.assertEqual(record.tag_deadline, datetime(2026, 9, 2, 13, 20, tzinfo=clock.KST))
        self.assertEqual(record.end_at, datetime(2026, 9, 2, 15, 10, tzinfo=clock.KST))

    def test_one_user_cannot_hold_two_rooms(self):
        now = datetime.now() + timedelta(minutes=10)
        reservations.acquire(id="one", uid="u", student_id="2022172528", student_key="student-a", corner_no=1, room_no="119")
        with self.assertRaises(reservations.ReservationConflict):
            reservations.acquire(id="two", uid="another-uid", student_id="2022172528", student_key="student-a", corner_no=9, room_no="419")

    def test_expired_pending_reservation_no_longer_blocks_user(self):
        start = datetime.now() - timedelta(minutes=20)
        reservations.acquire(id="one", uid="u", student_id="2022172528", student_key="student-a", corner_no=1, room_no="119")
        reservations.finalize("one", start_at=start, duration_min=120, kiosk_booking_no=None)
        self.assertIsNone(reservations.open_for_uid("u"))

    def test_stale_creating_reservation_no_longer_blocks_user(self):
        reservations.acquire(id="one", uid="u", student_id="2022172528", student_key="student-a", corner_no=1, room_no="119")
        reservations.expire_pending(datetime.now() + reservations.CREATING_TTL + timedelta(seconds=1))
        replacement = reservations.acquire(
            id="two", uid="u", student_id="2022172528", student_key="student-a", corner_no=9, room_no="419"
        )
        self.assertEqual(replacement.status, "creating")

    def test_ended_active_reservation_no_longer_blocks_user(self):
        start = datetime.now() - timedelta(hours=3)
        reservations.acquire(id="one", uid="u", student_id="2022172528", student_key="student-a", corner_no=1, room_no="119")
        reservations.finalize("one", start_at=start, duration_min=120, kiosk_booking_no="old")
        reservations.set_status("one", "active")
        replacement = reservations.acquire(
            id="two", uid="u", student_id="2022172528", student_key="student-a", corner_no=1, room_no="119"
        )
        self.assertEqual(replacement.status, "creating")

    def test_one_room_cannot_be_acquired_by_different_students(self):
        reservations.acquire(id="one", uid="u1", student_id="2022172528", student_key="student-a", corner_no=1, room_no="119")
        with self.assertRaises(reservations.ReservationConflict):
            reservations.acquire(id="two", uid="u2", student_id="2023172529", student_key="student-b", corner_no=1, room_no="119")

    def test_student_binding_is_immutable_and_unique(self):
        self.assertTrue(reservations.bind_student("google-a", "student-a"))
        self.assertFalse(reservations.bind_student("google-a", "student-a"))
        with self.assertRaises(reservations.StudentBindingConflict):
            reservations.bind_student("google-a", "student-b")
        with self.assertRaises(reservations.StudentBindingConflict):
            reservations.bind_student("google-b", "student-a")


if __name__ == "__main__":
    unittest.main()
