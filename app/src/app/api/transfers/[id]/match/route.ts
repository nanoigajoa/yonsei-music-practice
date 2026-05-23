import { NextRequest, NextResponse } from 'next/server'
import { FieldValue } from 'firebase-admin/firestore'
import { getAdminDb, getAdminMessaging, getAdminAuth } from '@/lib/firebase-admin'

async function getTokens(userId: string): Promise<string[]> {
  const snap = await getAdminDb().collection('users').doc(userId).collection('fcm_tokens').get()
  return snap.docs.map((d) => d.data().token as string).filter(Boolean)
}

async function sendFcm(tokens: string[], title: string, body: string) {
  if (!tokens.length) return
  await getAdminMessaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: { click_action: '/transfer' },
    webpush: { fcmOptions: { link: '/transfer' } },
  })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let matcherUid: string
  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7))
    matcherUid = decoded.uid
  } catch {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
  }

  const db = getAdminDb()
  const docRef = db.collection('transfer_requests').doc(id)

  let posterId = ''
  let roomId = ''
  let transferType = ''

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef)
      if (!snap.exists) throw new Error('not_found')
      const data = snap.data()!
      if (data.status !== 'open') throw new Error('already_matched')
      if (data.userId === matcherUid) throw new Error('own_post')

      posterId = data.userId
      roomId = data.roomId
      transferType = data.type

      tx.update(docRef, {
        matchedBy: matcherUid,
        status: 'matched',
        updatedAt: FieldValue.serverTimestamp(),
      })
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error'
    if (msg === 'already_matched') return NextResponse.json({ error: '이미 매칭됐어요' }, { status: 409 })
    if (msg === 'own_post') return NextResponse.json({ error: '본인 게시물입니다' }, { status: 400 })
    if (msg === 'not_found') return NextResponse.json({ error: '게시물 없음' }, { status: 404 })
    throw e
  }

  const typeLabel = transferType === 'give' ? '양도' : '바꿔치기'

  const [posterTokens, matcherTokens] = await Promise.all([getTokens(posterId), getTokens(matcherUid)])
  await Promise.all([
    sendFcm(posterTokens, '매칭됐어요! 🎉', `${roomId}호 ${typeLabel} 상대를 찾았어요 — 지금 만나러 가세요`),
    sendFcm(matcherTokens, '매칭 완료! ✅', `${roomId}호 방 ${typeLabel}가 확정됐어요`),
  ])

  return NextResponse.json({ ok: true })
}
