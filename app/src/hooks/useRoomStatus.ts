/**
 * useRoomStatus
 * 키오스크 스크래퍼 FastAPI의 /stream SSE에 연결해
 * 실시간 방 예약 현황을 반환하는 커스텀 훅.
 *
 * - 연결 끊기면 5초 후 자동 재연결
 * - SSE 불가 환경이면 /status 폴링으로 폴백
 * - refresh() 로 즉시 수동 갱신 가능
 */

import { useCallback, useEffect, useRef, useState } from 'react'

const API_URL = process.env.NEXT_PUBLIC_KIOSK_API_URL ?? 'http://localhost:8000'
const RECONNECT_DELAY = 5_000
const POLL_INTERVAL   = 60_000

export interface Period {
  start: string  // "16:50"
  end:   string  // "18:00"
}

export interface Room {
  name:              string
  corner_no:         number
  floor:             number
  occupied:          boolean
  occupied_until:    string | null
  available_periods: Period[]
}

export interface RoomStatus {
  updated_at:      string
  total:           number
  occupied_count:  number
  available_count: number
  rooms:           Room[]
}

type ConnectionState = 'connecting' | 'live' | 'polling' | 'error'

export function useRoomStatus() {
  const [status,      setStatus]      = useState<RoomStatus | null>(null)
  const [connState,   setConnState]   = useState<ConnectionState>('connecting')
  const [refreshing,  setRefreshing]  = useState(false)
  const esRef    = useRef<EventSource | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── /status 단건 fetch (수동 새로고침 + 폴링 폴백 공용) ──
  const fetchOnce = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/status`)
      if (!res.ok) return false
      setStatus(await res.json() as RoomStatus)
      return true
    } catch {
      return false
    }
  }, [])

  // ── 수동 새로고침 ──────────────────────────────────────
  const refresh = useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    await fetchOnce()
    setRefreshing(false)
  }, [refreshing, fetchOnce])

  // ── SSE 연결 ──────────────────────────────────────────
  const connect = useCallback(() => {
    if (typeof EventSource === 'undefined') {
      // SSE 미지원 → 폴링
      setConnState('polling')
      fetchOnce()
      timerRef.current = setInterval(fetchOnce, POLL_INTERVAL) as unknown as ReturnType<typeof setTimeout>
      return
    }

    setConnState('connecting')
    const es = new EventSource(`${API_URL}/stream`)
    esRef.current = es

    es.onopen = () => setConnState('live')

    es.onmessage = (e) => {
      try {
        setStatus(JSON.parse(e.data) as RoomStatus)
        setConnState('live')
      } catch { /* noop */ }
    }

    es.onerror = () => {
      es.close()
      esRef.current = null
      setConnState('error')
      timerRef.current = setTimeout(connect, RECONNECT_DELAY)
    }
  }, [fetchOnce])

  useEffect(() => {
    connect()
    return () => {
      esRef.current?.close()
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [connect])

  // ── 층별 그룹 ─────────────────────────────────────────
  const byFloor = status?.rooms.reduce<Record<number, Record<number, Room[]>>>(
    (acc, room) => {
      acc[room.floor]               ??= {}
      acc[room.floor][room.corner_no] ??= []
      acc[room.floor][room.corner_no].push(room)
      return acc
    },
    {},
  ) ?? {}

  return { status, connState, byFloor, refresh, refreshing }
}
