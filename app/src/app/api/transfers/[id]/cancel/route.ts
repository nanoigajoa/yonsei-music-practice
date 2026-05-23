import { NextRequest, NextResponse } from 'next/server'
import { FieldValue } from 'firebase-admin/firestore'
import { getAdminDb, getAdminMessaging, getAdminAuth } from '@/lib/firebase-admin'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

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

  const db = getAdminDb()
  const docRef = db.collection('transfer_requests').doc(id)
  const snap = await docRef.get()
  if (!snap.exists) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const data = snap.data()!
  const isPoster = data.userId === uid
  const isMatcher = data.matchedBy === uid

  if (!isPoster && !isMatcher) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (isPoster) {
    await docRef.update({ status: 'cancelled', updatedAt: FieldValue.serverTimestamp() })
  } else {
    // 매처가 취소 → 다시 open으로 복구, 등록자에게 알림
    await docRef.update({ status: 'open', matchedBy: null, updatedAt: FieldValue.serverTimestamp() })
    const posterTokensSnap = await db.collection('users').doc(data.userId).collection('fcm_tokens').get()
    const tokens = posterTokensSnap.docs.map((d) => d.data().token as string).filter(Boolean)
    if (tokens.length) {
      await getAdminMessaging().sendEachForMulticast({
        tokens,
        notification: { title: '매칭이 취소됐어요', body: `${data.roomId}호 매칭이 취소됐어요. 다시 모집 중입니다.` },
        webpush: { fcmOptions: { link: '/transfer' } },
      })
    }
  }

  return NextResponse.json({ ok: true })
}
