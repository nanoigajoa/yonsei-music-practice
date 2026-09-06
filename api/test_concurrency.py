"""예약 선점이 외부 키오스크 요청 폭주를 막는지 검증한다."""
import asyncio
import os
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch

os.environ.setdefault("BOOKING_TOKEN_SECRET", "concurrency-test-secret-that-is-at-least-32-characters-long")

import collector
import main
import reservations
from auth_security import issue_return_token, student_key
from fastapi import HTTPException


class ReservationConcurrencyTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.old_db = reservations.DB_PATH
        self.old_enabled = main.BOOKING_ENABLED
        self.old_rooms = main.ALLOWED_TEST_ROOMS
        reservations.DB_PATH = Path(self.tempdir.name) / "reservations.sqlite3"
        main.BOOKING_ENABLED = True
        main.ALLOWED_TEST_ROOMS = {"*"}
        main._reservation_gate = None
        main._reservation_gate_loop = None
        main._tag_sync_gate = None
        main._tag_sync_gate_loop = None
        collector._pending_reservations.clear()

    async def asyncTearDown(self):
        reservations.DB_PATH = self.old_db
        main.BOOKING_ENABLED = self.old_enabled
        main.ALLOWED_TEST_ROOMS = self.old_rooms
        self.tempdir.cleanup()

    async def _run(self, uids: list[str]) -> tuple[list[str], int]:
        calls = 0
        start = (datetime.now() + timedelta(minutes=20)).replace(second=0, microsecond=0)

        async def fake_kiosk(*_args):
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.02)
            return {"success": True, "message": "ok", "start_at": start.isoformat(), "booking_no": "mock-1"}

        request = main.BookingRequest(student_id="2022172528", corner_no=1, room_no="119", limit_time=120)
        reservations.bind_student(uids[0], student_key("2022172528"))

        async def reserve(uid: str) -> str:
            try:
                result = await main.reserve_room(request, user={"uid": uid})
                return "success" if result.get("success") else "failed"
            except HTTPException as exc:
                return f"http_{exc.status_code}"

        with patch.object(main.booking, "reserve", side_effect=fake_kiosk):
            results = await asyncio.gather(*(reserve(uid) for uid in uids))
        return results, calls

    async def test_same_user_fifty_clicks_calls_kiosk_once(self):
        results, calls = await self._run(["one-user"] * 50)
        self.assertEqual(results.count("success"), 1)
        self.assertEqual(results.count("http_409"), 49)
        self.assertEqual(calls, 1)

    async def test_same_request_id_recovers_the_original_success_without_second_kiosk_call(self):
        start = (datetime.now() + timedelta(minutes=20)).replace(second=0, microsecond=0)
        reservations.bind_student("one-user", student_key("2022172528"))
        request = main.BookingRequest(
            student_id="2022172528", corner_no=1, room_no="119", limit_time=120,
            request_id="same-browser-request-0001",
        )

        with patch.object(main.booking, "reserve", AsyncMock(return_value={
            "success": True, "message": "ok", "start_at": start.isoformat(), "booking_no": "mock-1",
        })) as reserve:
            first = await main.reserve_room(request, user={"uid": "one-user"})
            recovered = await main.reserve_room(request, user={"uid": "one-user"})

        self.assertTrue(first["success"])
        self.assertTrue(recovered["success"])
        self.assertTrue(first["return_token"])
        self.assertTrue(recovered["return_token"])
        reserve.assert_awaited_once()

    async def test_same_student_on_fifty_accounts_calls_kiosk_once(self):
        results, calls = await self._run([f"account-{index}" for index in range(50)])
        self.assertEqual(results.count("success"), 1)
        self.assertEqual(results.count("http_403"), 49)
        self.assertEqual(calls, 1)

    async def test_return_then_immediate_new_reservation_succeeds(self):
        """반납 완료를 기록한 직후에는 다음 10분 예약 선점이 가능해야 한다."""
        start = datetime.now().replace(second=0, microsecond=0)
        reservations.acquire(id="active-one", uid="user", student_id="2022172528", student_key="same-student",
                             corner_no=1, room_no="119")
        reservations.bind_student("user", student_key("2022172528"))
        reservations.finalize("active-one", start_at=start, duration_min=120, kiosk_booking_no="old-booking")
        reservations.set_status("active-one", "active")
        token = issue_return_token("user", "2022172528", 1, "119", "active-one")
        action = main.BookingActionRequest(student_id="2022172528", corner_no=1, return_token=token)
        with patch.object(main.booking, "return_room", AsyncMock(return_value={"success": True, "message": "반납 완료"})):
            returned = await main.return_booking(action, user={"uid": "user"})
        self.assertTrue(returned["success"])

        next_start = start + timedelta(minutes=10)
        with patch.object(main.booking, "reserve", AsyncMock(return_value={
            "success": True, "message": "예약 완료", "start_at": next_start.isoformat(), "booking_no": "new-booking",
        })) as reserve:
            result = await main.reserve_room(
                main.BookingRequest(student_id="2022172528", corner_no=1, room_no="119", limit_time=120),
                user={"uid": "user"},
            )
        self.assertTrue(result["success"])
        reserve.assert_awaited_once()

    async def test_import_restores_existing_active_booking_without_new_kiosk_lookup(self):
        start = datetime.now().replace(second=0, microsecond=0)
        reservations.bind_student("user", student_key("2022172528"))
        reservations.acquire(id="active-one", uid="user", student_id="2022172528", student_key=student_key("2022172528"),
                             corner_no=1, room_no="119")
        reservations.finalize("active-one", start_at=start, duration_min=120, kiosk_booking_no="old-booking")
        reservations.set_status("active-one", "active")

        with patch.object(main.booking, "active_details", AsyncMock()) as active_details:
            result = await main.import_active_booking(
                main.KioskImportRequest(student_id="2022172528", corner_no=1, room_no="119"),
                user={"uid": "user"},
            )
        self.assertTrue(result["success"])
        self.assertTrue(result["return_token"])
        self.assertEqual(result["booking_no"], "old-booking")
        active_details.assert_not_awaited()

    async def test_tag_check_before_reservation_start_does_not_query_kiosk(self):
        start = (datetime.now() + timedelta(minutes=5)).replace(second=0, microsecond=0)
        reservations.bind_student("user", student_key("2022172528"))
        reservations.acquire(id="pending-one", uid="user", student_id="2022172528", student_key=student_key("2022172528"),
                             corner_no=1, room_no="119")
        reservations.finalize("pending-one", start_at=start, duration_min=120, kiosk_booking_no="booking")
        token = issue_return_token("user", "2022172528", 1, "119", "pending-one")

        with patch.object(main.booking, "active", AsyncMock()) as active:
            result = await main.active_booking(
                main.BookingActionRequest(student_id="2022172528", corner_no=1, return_token=token),
                user={"uid": "user"},
            )
        self.assertFalse(result["active"])
        self.assertIn(start.strftime("%H:%M"), result["message"])
        active.assert_not_awaited()

    async def test_tagged_reservation_becomes_active_without_user_pressing_check(self):
        start = datetime.now().replace(second=0, microsecond=0)
        reservations.bind_student("user", student_key("2022172528"))
        reservations.acquire(id="pending-one", uid="user", student_id="2022172528", student_key=student_key("2022172528"),
                             corner_no=1, room_no="119")
        reservations.finalize("pending-one", start_at=start, duration_min=120, kiosk_booking_no="booking")

        with patch.object(main.booking, "active_once", AsyncMock(return_value={"success": True, "active": True})), patch.object(
            main.collector, "mark_active", AsyncMock()
        ) as mark_active:
            updated = await main.sync_pending_tags_once()

        self.assertEqual(updated, 1)
        self.assertEqual(reservations.get("pending-one").status, "active")
        mark_active.assert_awaited_once()

    async def test_different_rooms_are_throttled_to_three_kiosk_requests(self):
        active = 0
        peak = 0
        start = (datetime.now() + timedelta(minutes=20)).replace(second=0, microsecond=0)

        async def fake_kiosk(*_args):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.01)
            active -= 1
            return {"success": True, "message": "ok", "start_at": start.isoformat(), "booking_no": "mock"}

        async def reserve(index: int):
            student_id = f"2022172{index:03d}"
            reservations.bind_student(f"user-{index}", student_key(student_id))
            return await main.reserve_room(
                main.BookingRequest(
                    student_id=student_id, corner_no=1, room_no=f"{100 + index:03d}", limit_time=120,
                ),
                user={"uid": f"user-{index}"},
            )

        with patch.object(main.booking, "reserve", side_effect=fake_kiosk):
            results = await asyncio.gather(*(reserve(index) for index in range(12)))
        self.assertTrue(all(result["success"] for result in results))
        self.assertLessEqual(peak, 3)


if __name__ == "__main__":
    unittest.main()
