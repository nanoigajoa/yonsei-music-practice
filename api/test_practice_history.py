from datetime import datetime, timedelta
from pathlib import Path
import os
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

os.environ.setdefault('BOOKING_TOKEN_SECRET', 'practice-test-secret-at-least-32-characters')
from fastapi.testclient import TestClient
import community
import main
import reservations as r
from clock import KST


class PracticeHistoryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = datetime(2026, 9, 8, 13, 0, tzinfo=KST)
        for name, value in [('DB_PATH', Path(self.temp.name)/'reservations.sqlite3'), ('kst_now', lambda: self.now)]:
            p = patch.object(r, name, value); p.start(); self.addCleanup(p.stop)
        self.user = {'uid': 'owner', 'firebase': {'sign_in_provider': 'google.com'}}
        r.bind_student('owner', 'bound-owner')
        p = patch.dict(main.app.dependency_overrides, {community.current_user: lambda: self.user})
        p.start(); self.addCleanup(p.stop)
        self.client = TestClient(main.app)
        self.addCleanup(self.client.close)

    def booking(self, ident='one', status='pending_tag', start=None, uid='owner', created=None):
        start = start or self.now
        with patch.object(r, 'kst_now', return_value=created or start):
            r.acquire(id=ident, uid=uid, student_id='', student_key='bound-'+uid,
                      corner_no=1, room_no='119', request_id='request-'+ident)
            r.finalize(ident, start_at=start, duration_min=120, kiosk_booking_no='private-school-id')
        if status != 'pending_tag':
            r.set_status(ident, status)
        return ident

    def history(self, **kwargs):
        return r.practice_history('owner', now=self.now, **kwargs)

    def test_booking_appears_immediately_without_recording_planned_time_as_used(self):
        self.booking()
        data = self.history()
        self.assertEqual(len(data['sessions']), 1)
        self.assertEqual(data['sessions'][0]['status'], 'pending_tag')
        self.assertEqual(data['sessions'][0]['duration_min'], 120)
        self.assertIsNone(data['sessions'][0]['usage_minutes'])
        self.assertEqual(data['summary']['minutes'], 0)
        r.transition('one', expected_status='pending_tag', status='active')
        self.now += timedelta(minutes=15)
        data = self.history()
        self.assertEqual(len(data['sessions']), 1)
        self.assertEqual(data['sessions'][0]['id'], 'one')
        self.assertEqual(data['summary']['minutes'], 15)

    def test_early_return_time_is_durable_and_repeat_does_not_inflate_it(self):
        self.booking(status='active', start=self.now-timedelta(minutes=35))
        r.set_status('one', 'returned')
        first = self.history()['sessions'][0]
        self.now += timedelta(minutes=50)
        r.set_status('one', 'returned')
        data = self.history()
        self.assertEqual(data['sessions'][0]['returned_at'], first['returned_at'])
        self.assertEqual(data['summary']['minutes'], 35)
        self.assertEqual(data['sessions'][0]['usage_minutes'], 35)

    def test_cancelled_expired_failed_and_uncertain_do_not_count_as_practice(self):
        for ident, status in enumerate(['cancelled', 'expired', 'failed', 'uncertain']):
            self.booking(str(ident), status, start=self.now-timedelta(minutes=10))
        result = self.history()
        self.assertEqual(len(result['sessions']), 4)
        self.assertEqual(result['summary']['session_count'], 0)
        self.assertTrue(all(x['usage_minutes'] is None for x in result['sessions']))

    def test_legacy_return_is_unknown_while_confirmed_scheduled_end_is_capped(self):
        self.booking('old', 'returned', start=self.now-timedelta(hours=4))
        self.booking('ended', 'active', start=self.now-timedelta(hours=2, minutes=10))
        result = self.history()
        self.assertEqual(result['summary'], {'minutes': 120, 'session_count': 1, 'unknown_count': 1})
        self.assertEqual(result['sessions'][0]['status'], 'ended')
        # A history read does not mutate the reservation's state.
        self.assertEqual(r.get('ended').status, 'active')

    def test_kst_daily_boundary_clips_cross_midnight_session(self):
        self.now = datetime(2026, 9, 8, 0, 30, tzinfo=KST)
        self.booking(status='active', start=self.now-timedelta(hours=1))
        result = self.history(period='daily')
        self.assertEqual(result['summary']['minutes'], 30)
        self.assertEqual(result['sessions'][0]['usage_minutes'], 60)
        self.assertEqual(result['period_start'], '2026-09-08T00:00:00+09:00')

    def test_week_and_month_start_are_kst_and_clip_previous_period(self):
        self.now = datetime(2026, 9, 7, 0, 30, tzinfo=KST)  # Monday
        self.booking('week', 'active', start=self.now-timedelta(hours=1))
        self.assertEqual(self.history(period='weekly')['summary']['minutes'], 30)
        r.set_status('week', 'ended')
        self.now = datetime(2026, 10, 1, 0, 30, tzinfo=KST)
        self.booking('month', 'active', start=self.now-timedelta(hours=1))
        self.assertEqual(self.history(period='monthly')['summary']['minutes'], 30)

    def test_latest_first_pagination_owner_isolation_and_private_fields(self):
        self.booking('old', 'cancelled', created=self.now-timedelta(days=1))
        self.booking('new', 'cancelled')
        self.booking('someone-else', 'cancelled', uid='other')
        first = self.history(limit=1)
        second = self.history(limit=1, offset=first['next_offset'])
        self.assertEqual([first['sessions'][0]['id'], second['sessions'][0]['id']], ['new', 'old'])
        self.assertTrue(first['has_more']); self.assertFalse(second['has_more'])
        for private in ['uid', 'student_id', 'student_key', 'kiosk_booking_no', 'request_id', 'return_token']:
            self.assertNotIn(private, first['sessions'][0])

    def test_api_uses_token_owner_and_validates_query(self):
        self.booking('mine', 'cancelled')
        self.booking('theirs', 'cancelled', uid='other')
        result = self.client.get('/community/practice?uid=other')
        self.assertEqual(result.status_code, 200)
        self.assertEqual([s['id'] for s in result.json()['sessions']], ['mine'])
        self.assertEqual(result.headers['cache-control'], 'private, no-store')
        for query in ['period=all', 'limit=0', 'limit=101', 'offset=-1']:
            self.assertEqual(self.client.get('/community/practice?'+query).status_code, 422)

    def test_anonymous_and_unbound_accounts_cannot_read(self):
        with patch.dict(main.app.dependency_overrides, {}, clear=True):
            self.assertEqual(self.client.get('/community/practice').status_code, 401)
        self.user = {'uid':'unbound','firebase':{'sign_in_provider':'google.com'}}
        self.assertEqual(self.client.get('/community/practice').status_code, 403)

    def test_existing_database_upgrade_preserves_rows_and_unknown_return_time(self):
        self.booking('legacy', 'returned')
        with sqlite3.connect(r.DB_PATH) as conn:
            conn.execute('ALTER TABLE reservations DROP COLUMN returned_at')
        data = self.history()
        self.assertEqual(data['sessions'][0]['id'], 'legacy')
        self.assertIsNone(data['sessions'][0]['returned_at'])
        self.assertIsNone(data['sessions'][0]['usage_minutes'])
        self.assertEqual(r.binding_for_uid('owner'), 'bound-owner')


if __name__ == '__main__':
    unittest.main()
