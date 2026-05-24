import { useEffect, useState, useCallback } from 'react'
import { doc, getDoc, setDoc, updateDoc, serverTimestamp } from 'firebase/firestore'
import { User } from 'firebase/auth'
import { db } from '@/lib/firebase'
import { generateNickname } from '@/lib/nickname'
import { UserProfile, Department, COLLECTIONS } from '@/types/collections'

export type { UserProfile }

export function useUserProfile(user: User | null) {
  const [profile, setProfile]   = useState<UserProfile | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  // isNew: 프로필이 아직 없는 신규 사용자
  const [isNew, setIsNew]       = useState(false)
  // suggestedNickname: 자동 생성 닉네임 (온보딩에서 사용)
  const [suggestedNickname, setSuggestedNickname] = useState('')

  useEffect(() => {
    if (!user) { setIsLoading(false); return }

    const ref = doc(db, COLLECTIONS.USER_PROFILES, user.uid)
    getDoc(ref).then((snap) => {
      if (snap.exists()) {
        setProfile(snap.data() as UserProfile)
        setIsNew(false)
      } else {
        setSuggestedNickname(generateNickname())
        setIsNew(true)
      }
      setIsLoading(false)
    }).catch(() => setIsLoading(false))
  }, [user])

  const rerollNickname = useCallback(() => {
    setSuggestedNickname(generateNickname())
  }, [])

  const saveProfile = useCallback(async (nickname: string, department: Department) => {
    if (!user) return
    const ref  = doc(db, COLLECTIONS.USER_PROFILES, user.uid)
    const now  = serverTimestamp()
    const data = { uid: user.uid, nickname: nickname.trim(), department, updatedAt: now }

    if (isNew) {
      await setDoc(ref, { ...data, createdAt: now })
    } else {
      await updateDoc(ref, data)
    }

    setProfile((prev) => ({
      ...(prev ?? { uid: user.uid, createdAt: null as any }),
      ...data,
      updatedAt: null as any,  // 로컬 임시값, 다음 fetch에서 정확히 갱신됨
    }))
    setIsNew(false)
  }, [user, isNew])

  return { profile, isLoading, isNew, suggestedNickname, rerollNickname, saveProfile }
}
