import assert from 'node:assert/strict'
import test from 'node:test'

import { isCurrentlyAvailable } from '../src/lib/roomAvailability.ts'

test('빈 방이면서 예약 가능한 시간이 있을 때만 현재 공실이다', () => {
  assert.equal(isCurrentlyAvailable({ occupied: false, available_periods: [{ start: '10:00' }] }), true)
})

test('인증대기·사용 중인 방은 빈 시간이 보여도 공실에서 제외한다', () => {
  assert.equal(isCurrentlyAvailable({ occupied: true, available_periods: [{ start: '10:00' }] }), false)
})

test('빈 방이어도 즉시 예약 가능한 시간이 없으면 곧 가능이며 공실이 아니다', () => {
  assert.equal(isCurrentlyAvailable({ occupied: false, available_periods: [] }), false)
})

