import { NextRequest, NextResponse } from 'next/server'
import { getAdminDb, getAdminAuth, getAdminMessaging } from '@/lib/firebase-admin'

async function getUserTokens(userId: string): Promise<string[]> {
  const snap = await getAdminDb()
    .collection('users').doc(userId)
    .collection('fcm_tokens').get()
  return snap.docs.map((d) => d.data().token as string).filter(Boolean)
}

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

  const { title, body } = await req.json()
  if (!title || !body) {
    return NextResponse.json({ error: 'Missing title or body' }, { status: 400 })
  }

  const tokens = await getUserTokens(uid)
  if (tokens.length === 0) {
    return NextResponse.json({ ok: true, sent: 0 })
  }

  const result = await getAdminMessaging().sendEachForMulticast({ tokens, notification: { title, body } })
  return NextResponse.json({ ok: true, sent: result.successCount })
}
