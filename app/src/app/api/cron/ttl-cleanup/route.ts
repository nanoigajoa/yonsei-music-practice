import { NextRequest, NextResponse } from 'next/server'
import { Timestamp, FieldValue } from 'firebase-admin/firestore'
import { getAdminDb } from '@/lib/firebase-admin'

const CRON_SECRET = process.env.CRON_SECRET

export const GET = POST

export async function POST(req: NextRequest) {
  const auth = req.headers.get('Authorization')
  if (!auth || auth !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db  = getAdminDb()
  const now = Timestamp.fromMillis(Date.now())
  const batch = db.batch()
  let expiredSessions     = 0
  let closedTransfers     = 0
  let cleanedEarlyReturns = 0
  let practiceCreated     = 0

  // ── 1. alarm_sessions: endTime 지난 활성 세션 만료 + 연습 기록 생성 ──
  const sessionsSnap = await db
    .collection('alarm_sessions')
    .where('status', '==', 'active')
    .where('endTime', '<=', now)
    .get()

  // 사용자 프로필 일괄 조회 (중복 조회 방지)
  const uids = [...new Set(sessionsSnap.docs.map((d) => d.data().userId as string))]
  const profileMap = new Map<string, { department: string | null; nickname: string | null }>()
  await Promise.all(
    uids.map(async (uid) => {
      const snap = await db.collection('user_profiles').doc(uid).get()
      const data = snap.data()
      profileMap.set(uid, {
        department: data?.department ?? null,
        nickname:   data?.nickname   ?? null,
      })
    }),
  )

  for (const doc of sessionsSnap.docs) {
    const data = doc.data()
    if (!data.endTime) continue

    // 만료 처리
    batch.update(doc.ref, {
      status:    'expired',
      updatedAt: FieldValue.serverTimestamp(),
    })
    expiredSessions++

    // 연습 기록 생성 (아직 안 했고, reservedAt + endTime 모두 있을 때)
    if (!data.practiceLogged && data.reservedAt) {
      const startMs    = (data.reservedAt as Timestamp).toMillis()
      const endMs      = (data.endTime    as Timestamp).toMillis()
      const durationMin = Math.round((endMs - startMs) / 60000)

      // 최소 5분 이상인 세션만 기록 (잘못된 입력 방지)
      if (durationMin >= 5) {
        const profile = profileMap.get(data.userId)
        const sessionRef = db.collection('practice_sessions').doc()
        batch.set(sessionRef, {
          uid:         data.userId,
          department:  profile?.department  ?? null,
          nickname:    profile?.nickname    ?? null,
          roomHint:    data.roomHint        ?? null,
          startedAt:   data.reservedAt,
          endedAt:     data.endTime,
          durationMin,
          source:      'alarm',
          createdAt:   FieldValue.serverTimestamp(),
        })
        // alarm_session에 practiceLogged 마킹
        batch.update(doc.ref, { practiceLogged: true })
        practiceCreated++
      }
    }
  }

  // ── 2. transfer_requests: endTime 지난 open/urgent 마감 ──
  const transfersSnap = await db
    .collection('transfer_requests')
    .where('status', 'in', ['open', 'urgent'])
    .where('endTime', '<=', now)
    .get()

  for (const doc of transfersSnap.docs) {
    if (!doc.data().endTime) continue
    batch.update(doc.ref, {
      status:    'done',
      updatedAt: FieldValue.serverTimestamp(),
    })
    closedTransfers++
  }

  // ── 3. early_returns: 2시간 이상 지난 항목 정리 ──
  const twoHoursAgo = Timestamp.fromMillis(Date.now() - 2 * 60 * 60 * 1000)
  const earlyReturnSnap = await db
    .collection('early_returns')
    .where('plannedTime', '<=', twoHoursAgo)
    .where('isTransferred', '==', false)
    .get()

  for (const doc of earlyReturnSnap.docs) {
    batch.update(doc.ref, {
      isTransferred: true,
      updatedAt:     FieldValue.serverTimestamp(),
    })
    cleanedEarlyReturns++
  }

  await batch.commit()

  return NextResponse.json({
    expiredSessions,
    practiceCreated,
    closedTransfers,
    cleanedEarlyReturns,
  })
}
