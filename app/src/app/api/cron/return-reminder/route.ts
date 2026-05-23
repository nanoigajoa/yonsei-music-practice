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

async function sendFcm(
  tokens: string[],
  title: string,
  body: string,
  clickAction: string,
) {
  if (tokens.length === 0) return
  await getAdminMessaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: { click_action: clickAction },
    webpush: { fcmOptions: { link: clickAction } },
  })
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get('Authorization')
  if (!auth || auth !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now = Date.now()

  // endTime이 있는 활성 세션 중 "현재 기준 최대 16분 후 이내에 종료되는" 것만 조회
  // — 단일 필드 범위 쿼리로 복합 인덱스 없이 동작
  const windowEnd = Timestamp.fromMillis(now + 16 * 60 * 1000)
  const windowStart = Timestamp.fromMillis(now - 60 * 60 * 1000) // 과거 1시간 안전 버퍼

  const snap = await getAdminDb()
    .collection('alarm_sessions')
    .where('endTime', '>=', windowStart)
    .where('endTime', '<=', windowEnd)
    .get()

  const batch = getAdminDb().batch()
  const tasks: Promise<void>[] = []
  let processed = 0

  for (const doc of snap.docs) {
    const data = doc.data()

    // 이미 만료됐거나 endTime 없는 세션 제외 (클라이언트 필터)
    if (data.status !== 'active' || !data.endTime) continue

    const endMs = (data.endTime as Timestamp).toMillis()
    const remaining = endMs - now // 종료까지 남은 밀리초

    // 15분 전 알림: 남은 시간이 15분 이하이고 아직 미발송
    if (!data.notifiedReturn15 && remaining <= 15 * 60 * 1000) {
      batch.update(doc.ref, {
        notifiedReturn15: true,
        updatedAt: FieldValue.serverTimestamp(),
      })
      tasks.push(
        getUserTokens(data.userId).then((tokens) =>
          sendFcm(
            tokens,
            '⏰ 15분 후 예약 종료',
            '반납 또는 연장을 준비하세요',
            '/alarm',
          ),
        ),
      )
      processed++
    }

    // 5분 전 알림: 남은 시간이 5분 이하이고 아직 미발송
    if (!data.notifiedReturn5 && remaining <= 5 * 60 * 1000) {
      batch.update(doc.ref, {
        notifiedReturn5: true,
        updatedAt: FieldValue.serverTimestamp(),
      })
      tasks.push(
        getUserTokens(data.userId).then((tokens) =>
          sendFcm(
            tokens,
            '곧 종료돼요',
            '5분 후 종료 — 조기 반납으로 학우에게 양보하기 🙏',
            '/early-return',
          ),
        ),
      )
      processed++
    }
  }

  await Promise.all([batch.commit(), ...tasks])

  return NextResponse.json({ scanned: snap.size, processed })
}
