import { NextRequest, NextResponse } from 'next/server'
import { Timestamp, FieldValue } from 'firebase-admin/firestore'
import { getAdminDb, getAdminMessaging } from '@/lib/firebase-admin'

const CRON_SECRET = process.env.CRON_SECRET

async function getUserTokens(userId: string): Promise<string[]> {
  const snap = await getAdminDb()
    .collection('users').doc(userId)
    .collection('fcm_tokens').get()
  return snap.docs.map((d) => d.data().token as string).filter(Boolean)
}

async function sendFcm(tokens: string[], title: string, body: string) {
  if (tokens.length === 0) return
  await getAdminMessaging().sendEachForMulticast({ tokens, notification: { title, body } })
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get('Authorization')
  if (!auth || auth !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now = Date.now()
  const twelveMinAgo = Timestamp.fromMillis(now - 12 * 60 * 1000)

  // 최근 12분 이내 활성 세션만 조회
  const snap = await getAdminDb()
    .collection('alarm_sessions')
    .where('status', '==', 'active')
    .where('reservedAt', '>=', twelveMinAgo)
    .get()

  const batch = getAdminDb().batch()
  const tasks: Promise<void>[] = []

  for (const doc of snap.docs) {
    const data = doc.data()
    const reservedMs = (data.reservedAt as Timestamp).toMillis()
    const elapsed = now - reservedMs

    // T+11분 경과 → 만료
    if (elapsed >= 11 * 60 * 1000) {
      batch.update(doc.ref, { status: 'expired', updatedAt: FieldValue.serverTimestamp() })
      continue
    }

    // T+5분 경과: 중간 경고 (5분 남음)
    if (!data.notified5 && elapsed >= 5 * 60 * 1000) {
      batch.update(doc.ref, { notified5: true })
      tasks.push(
        getUserTokens(data.userId).then((tokens) =>
          sendFcm(
            tokens,
            '태그 확인해주세요',
            `아직 ${Math.ceil((10 * 60 * 1000 - elapsed) / 60000)}분 남았어요. 방 앞 단말기에 학생증을 태그하세요.`,
          ),
        ),
      )
    }

    // T+8분 경과: 긴급 경고 (2분 남음)
    if (!data.notified1 && elapsed >= 8 * 60 * 1000) {
      batch.update(doc.ref, { notified1: true })
      tasks.push(
        getUserTokens(data.userId).then((tokens) =>
          sendFcm(tokens, '⚠️ 2분 남았어요!', '지금 바로 카드 태그하지 않으면 예약이 취소될 수 있어요.'),
        ),
      )
    }
  }

  await Promise.all([batch.commit(), ...tasks])

  return NextResponse.json({ processed: snap.size })
}
