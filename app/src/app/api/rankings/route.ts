import { NextRequest, NextResponse } from 'next/server'
import { Timestamp } from 'firebase-admin/firestore'
import { getAdminDb } from '@/lib/firebase-admin'

export const dynamic = 'force-dynamic'

function periodStart(period: string): Date {
  const now = new Date()
  if (period === 'daily') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate())
  }
  if (period === 'weekly') {
    const day = now.getDay()                       // 0=일
    const mon = now.getDate() - ((day + 6) % 7)   // 이번 주 월요일
    return new Date(now.getFullYear(), now.getMonth(), mon)
  }
  // monthly
  return new Date(now.getFullYear(), now.getMonth(), 1)
}

export interface DeptRank {
  department:   string
  totalMin:     number
  avgMin:       number   // totalMin / 사용자 수
  sessionCount: number
  userCount:    number
}

export interface UserRank {
  uid:          string
  nickname:     string | null
  department:   string | null
  totalMin:     number
  sessionCount: number
}

export interface RankingsData {
  period:       string
  periodStart:  string
  deptRankings: DeptRank[]
  userRankings: UserRank[]   // 상위 20명
  myRank?: {
    dept:        DeptRank | null
    user:        UserRank | null
    userRankPos: number | null
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const period = searchParams.get('period') ?? 'weekly'   // daily | weekly | monthly
  const myUid  = searchParams.get('uid') ?? null

  const from = periodStart(period)
  const snap = await getAdminDb()
    .collection('practice_sessions')
    .where('startedAt', '>=', Timestamp.fromDate(from))
    .get()

  // ── 집계 ─────────────────────────────────────────────
  const deptMap = new Map<string, { totalMin: number; uids: Set<string>; sessionCount: number }>()
  const userMap = new Map<string, { uid: string; nickname: string | null; department: string | null; totalMin: number; sessionCount: number }>()

  for (const doc of snap.docs) {
    const d = doc.data()
    const uid:        string       = d.uid
    const dept:       string       = d.department ?? '미설정'
    const dMin:       number       = d.durationMin ?? 0
    const nickname:   string|null  = d.nickname ?? null

    // 과별
    if (!deptMap.has(dept)) deptMap.set(dept, { totalMin: 0, uids: new Set(), sessionCount: 0 })
    const dEntry = deptMap.get(dept)!
    dEntry.totalMin += dMin
    dEntry.uids.add(uid)
    dEntry.sessionCount++

    // 개인별
    if (!userMap.has(uid)) userMap.set(uid, { uid, nickname, department: d.department ?? null, totalMin: 0, sessionCount: 0 })
    const uEntry = userMap.get(uid)!
    uEntry.totalMin += dMin
    uEntry.sessionCount++
    if (nickname && !uEntry.nickname) uEntry.nickname = nickname  // 최신 닉네임 보정
  }

  // ── 정렬 ─────────────────────────────────────────────
  const deptRankings: DeptRank[] = [...deptMap.entries()]
    .map(([department, v]) => ({
      department,
      totalMin:     v.totalMin,
      avgMin:       v.uids.size > 0 ? Math.round(v.totalMin / v.uids.size) : 0,
      sessionCount: v.sessionCount,
      userCount:    v.uids.size,
    }))
    .sort((a, b) => b.avgMin - a.avgMin)   // 평균 연습시간 기준 정렬

  const allUserRankings: UserRank[] = [...userMap.values()]
    .sort((a, b) => b.totalMin - a.totalMin)

  const userRankings = allUserRankings.slice(0, 20)

  // ── 내 순위 계산 ──────────────────────────────────────
  let myRank: RankingsData['myRank'] = undefined
  if (myUid) {
    const myUser  = userMap.get(myUid) ?? null
    const myDept  = myUser ? deptMap.get(myUser.department ?? '미설정') : null
    const myPos   = myUser ? allUserRankings.findIndex((u) => u.uid === myUid) + 1 : null
    myRank = {
      dept:        myUser && myDept ? {
        department:   myUser.department ?? '미설정',
        totalMin:     myDept.totalMin,
        avgMin:       Math.round(myDept.totalMin / myDept.uids.size),
        sessionCount: myDept.sessionCount,
        userCount:    myDept.uids.size,
      } : null,
      user:        myUser ? { ...myUser } : null,
      userRankPos: myPos,
    }
  }

  const result: RankingsData = {
    period,
    periodStart: from.toISOString(),
    deptRankings,
    userRankings,
    ...(myRank !== undefined ? { myRank } : {}),
  }

  return NextResponse.json(result, {
    headers: { 'Cache-Control': 's-maxage=60, stale-while-revalidate=120' },
  })
}
