"""실제 예약 어댑터와 DB를 연결하고 학교 HTTP 경계에서 장애를 주입한다."""
import asyncio
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
import booking
import collector
import main
os.environ.setdefault("BOOKING_TOKEN_SECRET", "integrity-test-secret-at-least-32-characters")
import reservations
from auth_security import student_key
from clock import KST
from fastapi import HTTPException
from models import Room, StatusResponse


class BookingIntegrityTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.now = datetime(2026, 9, 7, 20, 0, tzinfo=KST)
        for module in (booking, main, reservations):
            fixed = patch.object(module, "kst_now", return_value=self.now)
            fixed.start()
            self.addCleanup(fixed.stop)
        self.original_collector_state = collector._state
        self.temp = tempfile.TemporaryDirectory()
        self.old_db = reservations.DB_PATH
        reservations.DB_PATH = Path(self.temp.name) / "test.sqlite3"
        self.enabled = patch.object(main, "BOOKING_ENABLED", True)
        self.allowed = patch.object(main, "ALLOWED_TEST_ROOMS", {"*"})
        self.enabled.start()
        self.allowed.start()
        main._recovery_attempts.clear()
        main._inflight_reservations.clear()
        collector._pending_reservations.clear()
        self.student = "2022172528"
        self.user = {"uid": "integrity-user"}
        reservations.bind_student(self.user["uid"], student_key(self.student))
        hour, minute = booking._next_ten_minute(str(self.now.hour), str(self.now.minute))
        self.start = self.now.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(hours=int(hour), minutes=int(minute))
        self.request = main.BookingRequest(student_id=self.student, corner_no=1, room_no="119", limit_time=120,
                                           request_id="integrity-request-0001")
        self.mode = "valid"
        self.posts = 0
        self.client = AsyncMock()
        self.client.get.side_effect = self.get
        self.client.post.side_effect = self.post
        context = AsyncMock()
        context.__aenter__.return_value = self.client
        self.http = patch.object(booking.httpx, "AsyncClient", return_value=context)
        self.http.start()

    async def asyncTearDown(self):
        self.http.stop()
        self.enabled.stop()
        self.allowed.stop()
        collector._pending_reservations.clear()
        collector._state = self.original_collector_state
        main._recovery_attempts.clear()
        main._inflight_reservations.clear()
        reservations.DB_PATH = self.old_db
        self.temp.cleanup()

    def response(self, url, text, status=200):
        return httpx.Response(status, text=text, request=httpx.Request("GET", url))

    def receipt(self):
        end = self.start + timedelta(minutes=119)
        return (f'<table><tr><td>{self.start.date()} 119호 {self.start:%H:%M}~{end:%H:%M}</td>'
                '<td><a onclick="booking_del(\'777\')">취소</a></td></tr></table>')

    async def get(self, url, **kwargs):
        if url.endswith("main_view.php"):
            if self.mode == "before_send_timeout":
                raise httpx.ReadTimeout("preparation timeout")
            return self.response(url, "ready")
        if url.endswith("main_list.php"):
            return self.response(url, '<div class="Body-List"><div class="title"><table><tr><td></td>'
                                 '<td>119호</td></tr></table></div><div class="reserve">'
                                 f'<a onclick="go(\'1\',\'pc119\',\'1\',\'2\',\'{self.now.hour}\',\'{self.now.minute}\')">예약</a></div></div>')
        if url.endswith("reserve.php"):
            return self.response(url, '<form><input name="native_token" value="test"></form>')
        if url.endswith("booking_info.php"):
            if self.mode == "receipt_timeout":
                raise httpx.ReadTimeout("receipt timeout after school commit")
            return self.response(url, "<html>unknown</html>" if self.mode == "unknown_html" else self.receipt())
        raise AssertionError(url)

    async def post(self, url, **kwargs):
        if url.endswith("login_proc.php"):
            return self.response(url, "<script>window.opener.location='/booking/index.php';</script>")
        self.assertTrue(url.endswith("reserve_proc.php"))
        self.posts += 1
        durable = reservations.find_by_request(self.user["uid"], self.request.request_id)
        self.assertEqual(durable.status, "submitting")
        self.assertEqual(durable.start_at, self.start)
        self.assertEqual(durable.duration_min, 120)
        if self.mode == "post_timeout":
            raise httpx.ReadTimeout("school may have committed")
        if self.mode == "cancelled":
            raise asyncio.CancelledError()
        if self.mode == "http500":
            return self.response(url, "server error", 500)
        if self.mode == "rejected":
            return self.response(url, 'location="result.php?msg=로그인 후에 사용하세요"')
        return self.response(url, "예약 완료")

    async def reserve(self):
        return await main.reserve_room(self.request, self.user)

    def record(self):
        return reservations.find_by_request(self.user["uid"], self.request.request_id)

    async def test_lost_post_response_never_resubmits_or_releases_room(self):
        self.mode = "post_timeout"
        result = await self.reserve()
        self.assertTrue(result["pending"])
        self.assertNotIn("return_token", result)
        results = await asyncio.gather(*(self.reserve() for _ in range(50)))
        self.assertTrue(all(item["pending"] for item in results))
        self.assertEqual(self.posts, 1)
        reservations.expire_pending(self.now + timedelta(days=2))
        self.assertEqual(self.record().status, "uncertain")
        with self.assertRaises(reservations.ReservationConflict):
            reservations.acquire(id="other-room", uid=self.user["uid"], student_id=self.student,
                                 student_key=student_key(self.student), corner_no=1, room_no="120")
        with self.assertRaises(reservations.ReservationConflict):
            reservations.acquire(id="other-user", uid="other", student_id="2023172528",
                                 student_key="other", corner_no=1, room_no="119")

    async def test_receipt_timeout_recovers_from_school_without_new_post(self):
        self.mode = "receipt_timeout"
        await self.reserve()
        self.mode = "valid"
        recovered = await main.reservation_result(main.BookingResultRequest(student_id=self.student,
                                                                           request_id=self.request.request_id), self.user)
        self.assertTrue(recovered["success"])
        self.assertTrue(recovered["return_token"])
        self.assertEqual(self.record().kiosk_booking_no, "777")
        self.assertEqual(self.posts, 1)

    async def test_http500_and_unknown_html_are_not_success(self):
        for mode in ("http500", "unknown_html"):
            with self.subTest(mode=mode):
                self.mode = mode
                self.request.request_id = f"integrity-{mode}-request"
                result = await self.reserve()
                self.assertTrue(result["pending"])
                self.assertEqual(self.record().status, "uncertain")
                # 독립된 장애 사례를 위해 임시 테스트 DB에서만 기록을 지운다.
                with reservations._connection() as conn:
                    conn.execute("DELETE FROM reservations")

    async def test_db_finalize_failure_keeps_durable_plan_for_recovery(self):
        with patch.object(reservations, "finalize", side_effect=sqlite3.OperationalError("disk error")):
            result = await self.reserve()
        self.assertTrue(result["pending"])
        self.assertEqual(self.record().status, "uncertain")
        recovered = await main._recover_uncertain(self.record())
        self.assertEqual(recovered.status, "pending_tag")
        self.assertEqual(self.posts, 1)

    async def test_cancelled_task_preserves_posted_intent(self):
        self.mode = "cancelled"
        with self.assertRaises(asyncio.CancelledError):
            await self.reserve()
        self.assertEqual(self.record().status, "uncertain")
        self.assertEqual(self.posts, 1)

    async def test_preparation_timeout_is_safe_to_fail(self):
        self.mode = "before_send_timeout"
        with self.assertRaises(HTTPException):
            await self.reserve()
        self.assertEqual(self.record().status, "failed")
        self.assertEqual(self.posts, 0)

    async def test_reused_request_id_with_changed_payload_is_rejected(self):
        await self.reserve()
        for change in ({"room_no": "120"}, {"limit_time": 60}, {"corner_no": 2}):
            changed = self.request.model_copy(update=change)
            with self.assertRaises(HTTPException) as caught:
                await main.reserve_room(changed, self.user)
            self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(self.posts, 1)

    async def test_empty_receipt_is_not_evidence_of_failure(self):
        self.mode = "post_timeout"
        await self.reserve()
        self.mode = "unknown_html"
        record = await main._recover_uncertain(self.record())
        self.assertEqual(record.status, "uncertain")
        again = await main._recover_uncertain(record)
        self.assertEqual(again.status, "uncertain")
        self.assertEqual(self.posts, 1)

    async def test_submitting_intent_survives_new_db_connection_and_expiry(self):
        intent = reservations.acquire(id="restart", uid=self.user["uid"], student_id=self.student,
                                      student_key=student_key(self.student), corner_no=1, room_no="119", duration_min=120)
        reservations.begin_submission(intent.id, start_at=self.start)
        reservations.expire_pending(self.now + reservations.CREATING_TTL + timedelta(seconds=1))
        reopened = reservations.get(intent.id)
        self.assertEqual(reopened.status, "uncertain")
        self.assertEqual(reopened.start_at, self.start)
        recovered = await main._recover_uncertain(reopened)
        self.assertEqual(recovered.kiosk_booking_no, "777")
        self.assertEqual(self.posts, 0)

    async def test_uncertain_overlay_survives_clock_and_push(self):
        self.mode = "post_timeout"
        await self.reserve()
        room = Room(name="연습실(119호)", corner_no=1, floor=1, occupied=False, available_periods=[])
        with patch.object(collector, "kst_now", return_value=self.now + timedelta(days=2)):
            self.assertEqual(collector._apply_pending_overlays([room])[0].reservation_state, "uncertain")
        with patch.object(main, "PUSH_SECRET", "test-secret"):
            await main.push(StatusResponse(updated_at=self.now.isoformat(), total=1, occupied_count=0,
                                           available_count=1, rooms=[room]), "test-secret")
        self.assertTrue(collector.get_state().rooms[0].occupied)

    async def test_finalization_cannot_change_the_durable_plan(self):
        self.mode = "post_timeout"
        await self.reserve()
        with self.assertRaises(ValueError):
            reservations.finalize(self.record().id, start_at=self.start + timedelta(minutes=10),
                                  duration_min=120, kiosk_booking_no="777")
        with self.assertRaises(ValueError):
            reservations.finalize(self.record().id, start_at=self.start, duration_min=60, kiosk_booking_no="777")
        self.assertEqual(self.record().status, "uncertain")

    async def test_concurrent_recovery_reads_school_once(self):
        self.mode = "post_timeout"
        await self.reserve()
        self.mode = "valid"
        original = self.record()
        reads_before = self.client.get.await_count
        results = await asyncio.gather(*(main._recover_uncertain(original) for _ in range(20)))
        self.assertTrue(all(record.status == "pending_tag" for record in results))
        self.assertEqual(self.client.get.await_count - reads_before, 2)  # 준비 GET + 내역 GET
        self.assertEqual(self.posts, 1)

    async def test_only_explicit_school_rejection_releases_intent(self):
        self.mode = "rejected"
        result = await self.reserve()
        self.assertFalse(result["success"])
        self.assertFalse(result["pending"])
        self.assertEqual(self.record().status, "failed")

    def test_active_evidence_requires_matching_school_identity(self):
        html = self.receipt().replace("booking_del('777')", "unused()")
        html = html.replace("취소</a>", "사용중</a><a href='return.php?booking_no=777'>반납</a>")
        self.assertIsNone(booking._submission_evidence(html, "119", self.start, 120, "888"))
        evidence = booking._submission_evidence(html, "119", self.start, 120, "777")
        self.assertEqual(evidence["status"], "active")

    def test_legacy_unknown_dispatch_is_never_released_by_ttl(self):
        intent = reservations.acquire(id="legacy", uid=self.user["uid"], student_id=self.student,
                                      student_key=student_key(self.student), corner_no=1, room_no="119")
        with reservations._connection() as conn:
            conn.execute("UPDATE reservations SET dispatch_started=NULL, duration_min=NULL WHERE id=?", (intent.id,))
        reservations.expire_pending(self.now + reservations.CREATING_TTL + timedelta(seconds=1))
        self.assertEqual(reservations.get(intent.id).status, "uncertain")

    def test_database_unique_constraint_blocks_bypassing_application_guard(self):
        first = reservations.acquire(id="first", uid=self.user["uid"], student_id=self.student,
                                     student_key=student_key(self.student), corner_no=1, room_no="119")
        reservations.acquire(id="second", uid="second-user", student_id="2023172528",
                             student_key="second-key", corner_no=1, room_no="120")
        with reservations._connection() as conn:
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute("UPDATE reservations SET room_no=? WHERE id='second'", (first.room_no,))
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute("UPDATE reservations SET student_key=? WHERE id='second'", (first.student_key,))
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute("UPDATE reservations SET uid=? WHERE id='second'", (first.uid,))

    def test_evidence_rejects_other_room_time_date_and_multiple_rows(self):
        receipt = self.receipt()
        self.assertIsNotNone(booking._submission_evidence(receipt, "119", self.start, 120))
        for invalid in (receipt.replace("119호", "120호"), receipt.replace("777", ""), receipt + receipt,
                        receipt.replace(str(self.start.date()), "2000-01-01")):
            self.assertIsNone(booking._submission_evidence(invalid, "119", self.start, 120))
        self.assertIsNone(booking._submission_evidence(receipt, "119", self.start + timedelta(minutes=10), 120))
        self.assertIsNone(booking._submission_evidence(receipt, "119", self.start, 60))
