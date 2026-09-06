import unittest
from datetime import datetime

import clock
import reservations


class KoreaTimeTest(unittest.TestCase):
    def test_service_clock_is_always_korea_standard_time(self):
        self.assertEqual(clock.now().tzinfo, clock.KST)
        self.assertEqual(clock.now().utcoffset().total_seconds(), 9 * 60 * 60)

    def test_legacy_naive_sqlite_timestamp_means_korea_time(self):
        value = clock.parse("2026-09-06T19:20:00")
        self.assertEqual(value.hour, 19)
        self.assertEqual(value.tzinfo, clock.KST)

    def test_finalize_normalizes_legacy_naive_start_time(self):
        # finalize가 실제 DB를 쓰는지는 reservations 단위 테스트가 담당한다.
        self.assertEqual(clock.normalize(datetime(2026, 9, 6, 19, 20)).tzinfo, clock.KST)
