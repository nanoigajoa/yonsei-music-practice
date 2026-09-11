import assert from 'node:assert/strict'
import test from 'node:test'

import { isCurrentlyAvailable, isEndingSoon, isOperatingHours } from '../src/lib/roomAvailability.ts'

test('빈 방이면서 예약 가능한 시간이 있을 때만 현재 공실이다', () => {
  assert.equal(isCurrentlyAvailable({ occupied: false, available_periods: [{ start: '10:00' }] }), true)
})

test('인증대기·사용 중인 방은 빈 시간이 보여도 공실에서 제외한다', () => {
  assert.equal(isCurrentlyAvailable({ occupied: true, available_periods: [{ start: '10:00' }] }), false)
})

test('빈 방이어도 즉시 예약 가능한 시간이 없으면 공실만 보기에 포함하지 않는다', () => {
  assert.equal(isCurrentlyAvailable({ occupied: false, available_periods: [] }), false)
})

test('키오스크 인증대기는 운영시간에만 표시한다', () => {
  assert.equal(isOperatingHours(Date.parse('2026-09-08T07:00:00+09:00')), true)
  assert.equal(isOperatingHours(Date.parse('2026-09-08T21:59:59+09:00')), true)
  assert.equal(isOperatingHours(Date.parse('2026-09-08T06:59:59+09:00')), false)
  assert.equal(isOperatingHours(Date.parse('2026-09-08T22:00:00+09:00')), false)
  assert.equal(isOperatingHours(null), false)
})

const occupiedRoom = { occupied: true, occupied_until: '18:00' }

test('종료 20분 전부터 종료 직전까지 빨간색으로 표시한다', () => {
  for (const [time, expected] of [
    ['17:39:59.999', false], ['17:40:00', true], ['17:49:59', true],
    ['17:50:00', true], ['17:59:59.999', true], ['18:00:00', false], ['18:00:01', false],
  ] as const) {
    assert.equal(isEndingSoon(occupiedRoom, Date.parse(`2026-09-07T${time}+09:00`)), expected, time)
  }
})

test('브라우저 시간대와 무관하게 서울 시각으로 계산한다', () => {
  assert.equal(isEndingSoon(occupiedRoom, Date.parse('2026-09-07T08:40:00Z')), true)
  assert.equal(isEndingSoon({ ...occupiedRoom, occupied_until: '07:00' }, Date.parse('2026-09-06T21:40:00Z')), true)
})

test('공실·인증대기·종료시각 누락은 빨간색으로 오인하지 않는다', () => {
  const now = Date.parse('2026-09-07T17:50:00+09:00')
  assert.equal(isEndingSoon({ ...occupiedRoom, occupied: false }, now), false)
  assert.equal(isEndingSoon({ ...occupiedRoom, reservation_state: 'pending_tag' }, now), false)
  for (const occupied_until of [null, '', '잘못된 시각', '25:00', '18:60']) {
    assert.equal(isEndingSoon({ ...occupiedRoom, occupied_until }, now), false)
  }
  assert.equal(isEndingSoon(occupiedRoom, null), false)
  assert.equal(isEndingSoon(occupiedRoom, NaN), false)
})
