import { NextRequest, NextResponse } from 'next/server'
import { FieldValue } from 'firebase-admin/firestore'
import { getAdminDb } from '@/lib/firebase-admin'

const CRON_SECRET = process.env.CRON_SECRET

// 실제 방 번호와 비품 현황으로 교체하세요
const ROOMS = [
  // 1층
  { id: '101', floor: 1, name: '101호', type: 'piano',   pianoChairs: 1, regularChairs: 0, musicStands: 1 },
  { id: '102', floor: 1, name: '102호', type: 'piano',   pianoChairs: 1, regularChairs: 0, musicStands: 1 },
  { id: '103', floor: 1, name: '103호', type: 'piano',   pianoChairs: 1, regularChairs: 2, musicStands: 2 },
  { id: '104', floor: 1, name: '104호', type: 'general', pianoChairs: 0, regularChairs: 4, musicStands: 4 },
  { id: '105', floor: 1, name: '105호', type: 'general', pianoChairs: 0, regularChairs: 4, musicStands: 4 },
  { id: '106', floor: 1, name: '106호', type: 'church',  pianoChairs: 1, regularChairs: 2, musicStands: 2 },
  { id: '107', floor: 1, name: '107호', type: 'church',  pianoChairs: 1, regularChairs: 2, musicStands: 2 },
  { id: '108', floor: 1, name: '108호', type: 'piano',   pianoChairs: 1, regularChairs: 1, musicStands: 1 },
  { id: '109', floor: 1, name: '109호', type: 'piano',   pianoChairs: 1, regularChairs: 0, musicStands: 1 },
  { id: '110', floor: 1, name: '110호', type: 'general', pianoChairs: 0, regularChairs: 3, musicStands: 3 },
  // 2층
  { id: '201', floor: 2, name: '201호', type: 'piano',   pianoChairs: 1, regularChairs: 0, musicStands: 1 },
  { id: '202', floor: 2, name: '202호', type: 'piano',   pianoChairs: 1, regularChairs: 1, musicStands: 1 },
  { id: '203', floor: 2, name: '203호', type: 'piano',   pianoChairs: 1, regularChairs: 2, musicStands: 2 },
  { id: '204', floor: 2, name: '204호', type: 'general', pianoChairs: 0, regularChairs: 4, musicStands: 4 },
  { id: '205', floor: 2, name: '205호', type: 'general', pianoChairs: 0, regularChairs: 4, musicStands: 4 },
  { id: '206', floor: 2, name: '206호', type: 'church',  pianoChairs: 1, regularChairs: 3, musicStands: 3 },
  { id: '207', floor: 2, name: '207호', type: 'piano',   pianoChairs: 1, regularChairs: 0, musicStands: 1 },
  { id: '208', floor: 2, name: '208호', type: 'piano',   pianoChairs: 1, regularChairs: 1, musicStands: 2 },
  { id: '209', floor: 2, name: '209호', type: 'general', pianoChairs: 0, regularChairs: 3, musicStands: 3 },
  { id: '210', floor: 2, name: '210호', type: 'piano',   pianoChairs: 1, regularChairs: 0, musicStands: 1 },
  // 3층
  { id: '301', floor: 3, name: '301호', type: 'piano',   pianoChairs: 1, regularChairs: 0, musicStands: 1 },
  { id: '302', floor: 3, name: '302호', type: 'piano',   pianoChairs: 1, regularChairs: 1, musicStands: 1 },
  { id: '303', floor: 3, name: '303호', type: 'piano',   pianoChairs: 1, regularChairs: 2, musicStands: 2 },
  { id: '304', floor: 3, name: '304호', type: 'general', pianoChairs: 0, regularChairs: 4, musicStands: 4 },
  { id: '305', floor: 3, name: '305호', type: 'general', pianoChairs: 0, regularChairs: 4, musicStands: 4 },
  { id: '306', floor: 3, name: '306호', type: 'church',  pianoChairs: 1, regularChairs: 3, musicStands: 3 },
  { id: '307', floor: 3, name: '307호', type: 'piano',   pianoChairs: 1, regularChairs: 0, musicStands: 1 },
  { id: '308', floor: 3, name: '308호', type: 'piano',   pianoChairs: 1, regularChairs: 1, musicStands: 2 },
  { id: '309', floor: 3, name: '309호', type: 'general', pianoChairs: 0, regularChairs: 3, musicStands: 3 },
  { id: '310', floor: 3, name: '310호', type: 'piano',   pianoChairs: 1, regularChairs: 0, musicStands: 1 },
] as const

export async function POST(req: NextRequest) {
  const auth = req.headers.get('Authorization')
  if (!auth || auth !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = getAdminDb()
  const batch = db.batch()

  for (const room of ROOMS) {
    const ref = db.collection('rooms').doc(room.id)
    batch.set(ref, { ...room, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  }

  await batch.commit()
  return NextResponse.json({ seeded: ROOMS.length })
}
