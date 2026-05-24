import { NextRequest, NextResponse } from 'next/server'
import { Timestamp, FieldValue } from 'firebase-admin/firestore'
import { getAdminDb, getAdminAuth } from '@/lib/firebase-admin'

export const dynamic = 'force-dynamic'

// GET: 내 연습 기록 조회
export async function GET(req: NextRequest) {
  const auth = req.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  let uid: string
  try {
    const decoded = await getAdminAuth().verifyIdToken(auth.slice(7))
    uid = decoded.uid
  } catch {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50'), 200)

  const snap = await getAdminDb()
    .collection('practice_sessions')
    .where('uid', '==', uid)
    .orderBy('startedAt', 'desc')
    .limit(limit)
    .get()

  const sessions = snap.docs.map((d) => ({
    id:          d.id,
    ...d.data(),
    startedAt:   (d.data().startedAt as Timestamp).toMillis(),
    endedAt:     (d.data().endedAt   as Timestamp).toMillis(),
    createdAt:   (d.data().createdAt as Timestamp)?.toMillis() ?? null,
  }))

  return NextResponse.json({ sessions })
}

// POST: 수동 연습 기록 추가
export async function POST(req: NextRequest) {
  const auth = req.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  let uid: string
  try {
    const decoded = await getAdminAuth().verifyIdToken(auth.slice(7))
    uid = decoded.uid
  } catch {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
  }

  const { startedAt, endedAt, roomHint } = await req.json()
  if (!startedAt || !endedAt) {
    return NextResponse.json({ error: 'Missing startedAt or endedAt' }, { status: 400 })
  }

  const startMs     = typeof startedAt === 'number' ? startedAt : new Date(startedAt).getTime()
  const endMs       = typeof endedAt   === 'number' ? endedAt   : new Date(endedAt).getTime()
  const durationMin = Math.round((endMs - startMs) / 60000)

  if (durationMin < 5 || durationMin > 240) {
    return NextResponse.json({ error: 'Duration must be 5–240 minutes' }, { status: 400 })
  }

  // 프로필에서 department / nickname 가져오기
  const profileSnap = await getAdminDb().collection('user_profiles').doc(uid).get()
  const profile = profileSnap.data()

  const docRef = await getAdminDb().collection('practice_sessions').add({
    uid,
    department:  profile?.department ?? null,
    nickname:    profile?.nickname   ?? null,
    roomHint:    roomHint?.trim()    || null,
    startedAt:   Timestamp.fromMillis(startMs),
    endedAt:     Timestamp.fromMillis(endMs),
    durationMin,
    source:      'manual',
    createdAt:   FieldValue.serverTimestamp(),
  })

  return NextResponse.json({ id: docRef.id, durationMin })
}
