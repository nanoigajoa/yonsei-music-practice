import assert from 'node:assert/strict'
import test from 'node:test'

import { isCurrentlyAvailable } from '../src/lib/roomAvailability.ts'

test('빈 방이면서 예약 가능한 시간이 있을 때만 현재 공실이다', () => {
  assert.equal(isCurrentlyAvailable({ occupied: false, available_periods: [{ start: '10:00', end: '10:30' }] }), true)
})

test('인증대기·사용 중인 방은 빈 시간이 보여도 공실에서 제외한다', () => {
  assert.equal(isCurrentlyAvailable({ occupied: true, available_periods: [{ start: '10:00', end: '12:00' }] }), false)
})

test('빈 방이어도 즉시 예약 가능한 시간이 없으면 공실만 보기에 포함하지 않는다', () => {
  assert.equal(isCurrentlyAvailable({ occupied: false, available_periods: [] }), false)
})

test('10분짜리 빈 구간은 최소 30분을 예약할 수 없어 공실에서 제외한다', () => {
  assert.equal(isCurrentlyAvailable({
    occupied: false,
    available_periods: [{ start: '19:20', end: '19:30' }],
  }), false)
})

test('22시까지 열린 마지막 구간은 22시 이후 종료 예약이 가능하므로 공실이다', () => {
  assert.equal(isCurrentlyAvailable({
    occupied: false,
    available_periods: [{ start: '21:50', end: '22:00' }],
  }), true)
})
