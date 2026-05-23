import { NextRequest, NextResponse } from 'next/server'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { getAdminDb, getAdminMessaging, getAdminAuth } from '@/lib/firebase-admin'

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let uid: string
  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7))
    uid = decoded.uid
  } catch {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
  }

  const { roomId, minutesLater, note } = await req.json()
  if (!roomId || !minutesLater) {
    return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
  }

  const plannedTime = Timestamp.fromMillis(Date.now() + minutesLater * 60 * 1000)

  const docRef = await getAdminDb().collection('early_returns').add({
    roomId,
    userId: uid,
    plannedTime,
    note: note?.trim() || null,
    isTransferred: false,
    createdAt: FieldValue.serverTimestamp(),
  })

  // 전체 FCM 토큰 수집 후 브로드캐스트
  const tokensSnap = await getAdminDb().collectionGroup('fcm_tokens').get()
  const tokens = tokensSnap.docs
    .filter((d) => d.ref.parent.parent?.id !== uid) // 본인 제외
    .map((d) => d.data().token as string)
    .filter(Boolean)

  // FCM 500개 단위로 분할 전송
  const chunks: string[][] = []
  for (let i = 0; i < tokens.length; i += 500) chunks.push(tokens.slice(i, i + 500))

  await Promise.all(
    chunks.map((chunk) =>
      getAdminMessaging().sendEachForMulticast({
        tokens: chunk,
        notification: {
          title: '곧 빈 방 생겼어요! 🎵',
          body: `${roomId}호 — ${minutesLater}분 후 반납 예정. 지금 이동하면 딱 맞아요`,
        },
        data: { click_action: '/early-return' },
        webpush: { fcmOptions: { link: '/early-return' } },
      }),
    ),
  )

  return NextResponse.json({ id: docRef.id })
}
