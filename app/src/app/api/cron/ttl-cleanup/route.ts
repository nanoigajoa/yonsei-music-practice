import { NextRequest, NextResponse } from 'next/server'
import { Timestamp, FieldValue } from 'firebase-admin/firestore'
import { getAdminDb } from '@/lib/firebase-admin'

const CRON_SECRET = process.env.CRON_SECRET

export async function POST(req: NextRequest) {
  const auth = req.headers.get('Authorization')
  if (!auth || auth !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = getAdminDb()
  const now = Timestamp.fromMillis(Date.now())
  const batch = db.batch()
  let expiredSessions = 0
  let closedTransfers = 0

  // 1. alarm_sessions: endTime 지난 활성 세션 만료
  const sessionsSnap = await db
    .collection('alarm_sessions')
    .where('status', '==', 'active')
    .where('endTime', '<=', now)
    .get()

  for (const doc of sessionsSnap.docs) {
    if (!doc.data().endTime) continue
    batch.update(doc.ref, {
      status: 'expired',
      updatedAt: FieldValue.serverTimestamp(),
    })
    expiredSessions++
  }

  // 2. transfer_requests: endTime 지난 open/urgent 게시물 자동 마감
  const transfersSnap = await db
    .collection('transfer_requests')
    .where('status', 'in', ['open', 'urgent'])
    .where('endTime', '<=', now)
    .get()

  for (const doc of transfersSnap.docs) {
    if (!doc.data().endTime) continue
    batch.update(doc.ref, {
      status: 'done',
      updatedAt: FieldValue.serverTimestamp(),
    })
    closedTransfers++
  }

  // 3. early_returns: plannedTime 2시간 이상 지난 항목 정리
  const twoHoursAgo = Timestamp.fromMillis(Date.now() - 2 * 60 * 60 * 1000)
  const earlyReturnSnap = await db
    .collection('early_returns')
    .where('plannedTime', '<=', twoHoursAgo)
    .where('isTransferred', '==', false)
    .get()

  let cleanedEarlyReturns = 0
  for (const doc of earlyReturnSnap.docs) {
    batch.update(doc.ref, {
      isTransferred: true,
      updatedAt: FieldValue.serverTimestamp(),
    })
    cleanedEarlyReturns++
  }

  await batch.commit()

  return NextResponse.json({ expiredSessions, closedTransfers, cleanedEarlyReturns })
}
