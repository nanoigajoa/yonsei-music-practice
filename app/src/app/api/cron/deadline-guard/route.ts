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

async function isTagNotifyEnabled(userId: string): Promise<boolean> {
  const snap = await getAdminDb().collection('user_profiles').doc(userId).get()
  const data = snap.data()
  // 필드 없으면 기본값 true (기존 사용자 호환)
  return data?.notifyTag !== false
}

async function sendFcm(tokens: string[], title: string, body: string) {
  if (tokens.length === 0) return
  await getAdminMessaging().sendEachForMulticast({ tokens, notification: { title, body } })
}

export const GET = POST

export async function POST(req: NextRequest) {
  const auth = req.headers.get('Authorization')
  if (!auth || auth !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now = Date.now()
  const twentyMinAgo = Timestamp.fromMillis(now - 20 * 60 * 1000)

  // 최근 20분 이내 활성 세션 조회 (크론 지연 대비 여유 확보)
  const snap = await getAdminDb()
    .collection('alarm_sessions')
    .where('status', '==', 'active')
    .where('reservedAt', '>=', twentyMinAgo)
    .get()

  const batch = getAdminDb().batch()
  const tasks: Promise<void>[] = []

  for (const doc of snap.docs) {
    const data = doc.data()
    const reservedMs = (data.reservedAt as Timestamp).toMillis()
    const elapsed = now - reservedMs

    // T+10분 경과 → 슬롯 종료, 만료
    if (elapsed >= 10 * 60 * 1000) {
      batch.update(doc.ref, { status: 'expired', updatedAt: FieldValue.serverTimestamp() })
      continue
    }

    // T+5분 경과: 중간 경고 (5분 남음)
    if (!data.notified5 && elapsed >= 5 * 60 * 1000) {
      batch.update(doc.ref, { notified5: true })
      tasks.push(
        isTagNotifyEnabled(data.userId).then((enabled) => {
          if (!enabled) return
          return getUserTokens(data.userId).then((tokens) =>
            sendFcm(
              tokens,
              '태그 확인해주세요',
              `아직 ${Math.ceil((10 * 60 * 1000 - elapsed) / 60000)}분 남았어요. 방 앞 단말기에 학생증을 태그하세요.`,
            ),
          )
        }),
      )
    }

    // T+8분 경과: 긴급 경고 (2분 남음)
    if (!data.notified1 && elapsed >= 8 * 60 * 1000) {
      batch.update(doc.ref, { notified1: true })
      tasks.push(
        isTagNotifyEnabled(data.userId).then((enabled) => {
          if (!enabled) return
          return getUserTokens(data.userId).then((tokens) =>
            sendFcm(tokens, '⚠️ 2분 남았어요!', '지금 바로 카드 태그하지 않으면 예약이 취소될 수 있어요.'),
          )
        }),
      )
    }
  }

  await Promise.all([batch.commit(), ...tasks])

  return NextResponse.json({ processed: snap.size })
}
