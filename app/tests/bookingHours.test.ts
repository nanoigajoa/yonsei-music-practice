import assert from 'node:assert/strict'
import test from 'node:test'
import { canStartBooking } from '../src/lib/bookingHours.ts'

test('서울 시각 07:00부터 22:00 직전까지 신규 예약을 허용한다', () => {
  for (const [time, expected] of [['06:59:59', false], ['07:00:00', true], ['21:59:59', true], ['22:00:00', false], ['00:00:00', false]] as const) {
    assert.equal(canStartBooking(new Date(`2026-09-07T${time}+09:00`)), expected)
  }
  assert.equal(canStartBooking(new Date('2026-09-06T22:00:00Z')), true)
})
