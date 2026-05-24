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

  // endTime 기준: 최대 42분 후 이내에 종료되는 세션 조회 (40분 알림 + 2분 버퍼)
  const windowEnd   = Timestamp.fromMillis(now + 42 * 60 * 1000)
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

    // 만료됐거나 endTime 없는 세션 제외
    if (data.status !== 'active' || !data.endTime) continue

    const endMs     = (data.endTime as Timestamp).toMillis()
    const remaining = endMs - now

    // ── 40분 전 연장 알림 ─────────────────────────────────
    if (!data.notifiedReturn40 && remaining <= 40 * 60 * 1000) {
      batch.update(doc.ref, {
        notifiedReturn40: true,
        updatedAt: FieldValue.serverTimestamp(),
      })
      const mins = Math.round(remaining / 60000)
      tasks.push(
        getUserTokens(data.userId).then((tokens) =>
          sendFcm(
            tokens,
            `⏰ ${mins}분 후 예약 종료`,
            '연장하려면 지금 키오스크로! 아니면 조기 반납을 등록해주세요 🙏',
            '/early-return',
          ),
        ),
      )
      processed++
    }

    // ── 10분 전 반납 알림 ─────────────────────────────────
    if (!data.notifiedReturn10 && remaining <= 10 * 60 * 1000) {
      batch.update(doc.ref, {
        notifiedReturn10: true,
        updatedAt: FieldValue.serverTimestamp(),
      })
      tasks.push(
        getUserTokens(data.userId).then((tokens) =>
          sendFcm(
            tokens,
            '🚪 10분 후 반납 시간',
            '반납 후 키오스크 카드를 꼭 빼주세요. 조기 반납하면 다른 학우에게 알림이 가요!',
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
