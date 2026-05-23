import { NextResponse } from 'next/server'
import { Timestamp } from 'firebase-admin/firestore'
import { getAdminDb } from '@/lib/firebase-admin'

export interface RoomStatusItem {
  roomHint: string
  endTime: number   // ms
  floor: number | null
  remainingMs: number
}

export interface DashboardData {
  occupied: RoomStatusItem[]   // roomHint 있는 활성 세션
  unknownCount: number         // roomHint 없는 활성 세션 수
  todayTotal: number           // 오늘 등록된 세션 수
  fetchedAt: number
}

function extractFloor(hint: string): number | null {
  const m = hint.match(/(\d{3})/)
  if (!m) return null
  const n = parseInt(m[1])
  if (n >= 100 && n < 200) return 1
  if (n >= 200 && n < 300) return 2
  if (n >= 300 && n < 400) return 3
  return null
}

export async function GET() {
  const db = getAdminDb()
  const now = Date.now()

  const [activeSnap, todaySnap] = await Promise.all([
    db.collection('alarm_sessions')
      .where('status', '==', 'active')
      .get(),
    db.collection('alarm_sessions')
      .where('createdAt', '>=', Timestamp.fromMillis(new Date().setHours(0, 0, 0, 0)))
      .get(),
  ])

  const occupied: RoomStatusItem[] = []
  let unknownCount = 0

  for (const doc of activeSnap.docs) {
    const d = doc.data()
    const endMs = d.endTime ? (d.endTime as Timestamp).toMillis() : null
    if (endMs && endMs < now) continue   // endTime 지난 세션 제외

    const hint = d.roomHint as string | null
    if (!hint) {
      unknownCount++
      continue
    }
    occupied.push({
      roomHint: hint,
      endTime: endMs ?? 0,
      floor: extractFloor(hint),
      remainingMs: endMs ? endMs - now : 0,
    })
  }

  occupied.sort((a, b) => a.endTime - b.endTime)

  return NextResponse.json({
    occupied,
    unknownCount,
    todayTotal: todaySnap.size,
    fetchedAt: now,
  } satisfies DashboardData)
}
