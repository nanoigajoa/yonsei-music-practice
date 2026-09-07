import asyncio
from datetime import datetime
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.testclient import TestClient
import clock
import main


class SchoolTransportTest(unittest.IsolatedAsyncioTestCase):
    async def test_all_http_methods_are_blocked_without_transport_call_at_night(self):
        inner = httpx.MockTransport(lambda request: self.fail("Night request reached transport"))
        async with httpx.AsyncClient(transport=clock.SchoolTransport(inner)) as client:
            for hour, minute in [(0, 0), (6, 59), (22, 0), (23, 59)]:
                with patch.object(clock, "now", return_value=datetime(2026, 9, 7, hour, minute, tzinfo=clock.KST)):
                    for method in ("GET", "POST", "DELETE", "PUT"):
                        with self.assertRaises(clock.SchoolClosed):
                            await client.request(method, "http://school.test/booking/return.php")

    async def test_same_client_rechecks_time_for_next_request(self):
        sent = []
        def respond(request):
            sent.append(request.url.path)
            return httpx.Response(200, text="OK")
        async with httpx.AsyncClient(transport=clock.SchoolTransport(httpx.MockTransport(respond))) as client:
            with patch.object(clock, "now", return_value=datetime(2026, 9, 7, 21, 59, 59, tzinfo=clock.KST)):
                await client.get("http://school.test/login")
            with patch.object(clock, "now", return_value=datetime(2026, 9, 7, 22, 0, tzinfo=clock.KST)):
                with self.assertRaises(clock.SchoolClosed):
                    await client.post("http://school.test/reserve")
        self.assertEqual(sent, ["/login"])

    async def test_request_crossing_close_is_cancelled(self):
        cancelled = asyncio.Event()
        async def stalled(request):
            try:
                await asyncio.sleep(10)
            finally:
                cancelled.set()
        transport = clock.SchoolTransport(httpx.MockTransport(stalled))
        with patch.object(clock, "now", return_value=datetime(2026, 9, 7, 21, 59, 59, 999000, tzinfo=clock.KST)):
            async with httpx.AsyncClient(transport=transport) as client:
                with self.assertRaises(clock.SchoolClosed):
                    await client.get("http://school.test/status")
        self.assertTrue(cancelled.is_set())

    async def test_opening_time_permits_request(self):
        with patch.object(clock, "now", return_value=datetime(2026, 9, 7, 7, 0, tzinfo=clock.KST)):
            async with httpx.AsyncClient(transport=clock.SchoolTransport(httpx.MockTransport(lambda r: httpx.Response(200)))) as client:
                self.assertEqual((await client.get("http://school.test/status")).status_code, 200)


class SchoolRouteTest(unittest.TestCase):
    def test_night_routes_reject_before_database_or_school(self):
        with patch.object(clock, "now", return_value=datetime(2026, 9, 7, 22, 0, tzinfo=clock.KST)), patch.object(main.reservations, "acquire") as acquire, patch.object(main.booking, "active_details", AsyncMock()) as details:
            client = TestClient(main.app)
            for route in ("reserve", "import-active", "active", "cancel", "return"):
                response = client.post("/booking/" + route, json={})
                self.assertEqual(response.status_code, 423)
                self.assertEqual(response.json()["code"], "school_closed")
            self.assertEqual(client.post("/identity/bind", json={}).status_code, 423)
            self.assertEqual(client.get("/health").status_code, 200)
            acquire.assert_not_called()
            details.assert_not_awaited()
