import { NextRequest, NextResponse } from 'next/server'
import { FieldValue } from 'firebase-admin/firestore'
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

  const { roomId, floor } = await req.json()
  if (!roomId || !floor) return NextResponse.json({ error: 'Missing fields' }, { status: 400 })

  const docRef = await getAdminDb().collection('transfer_requests').add({
    roomId,
    floor,
    userId: uid,
    endTime: null,
    type: 'give',
    swapNote: null,
    matchedBy: null,
    status: 'urgent',
    createdAt: FieldValue.serverTimestamp(),
  })

  // 전체 FCM 브로드캐스트 (본인 제외)
  const tokensSnap = await getAdminDb().collectionGroup('fcm_tokens').get()
  const tokens = tokensSnap.docs
    .filter((d) => d.ref.parent.parent?.id !== uid)
    .map((d) => d.data().token as string)
    .filter(Boolean)

  const chunks: string[][] = []
  for (let i = 0; i < tokens.length; i += 500) chunks.push(tokens.slice(i, i + 500))

  await Promise.all(
    chunks.map((chunk) =>
      getAdminMessaging().sendEachForMulticast({
        tokens: chunk,
        notification: {
          title: '🚨 긴급 방 올라왔어요!',
          body: `${floor}층 ${roomId}호 — 지금 바로 확인하세요`,
        },
        data: { click_action: '/transfer' },
        webpush: { fcmOptions: { link: '/transfer' } },
      }),
    ),
  )

  return NextResponse.json({ id: docRef.id })
}
