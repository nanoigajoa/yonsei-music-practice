import { initializeApp, getApps } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'
import { getAuth } from 'firebase/auth'
import { getMessaging, isSupported } from 'firebase/messaging'

const SAME_ORIGIN_AUTH_DOMAINS = new Set([
  'app-nanoigajoa-s-projects.vercel.app',
  'app-roan-beta-51.vercel.app',
])

// 모바일 OAuth가 돌아올 때 Firebase의 인증 저장소도 현재 앱 주소에 남게 한다.
// 두 주소 모두 /__/auth 프록시와 Firebase/Google OAuth 허용 목록에 등록돼 있다.
const authDomain = typeof window !== 'undefined' && SAME_ORIGIN_AUTH_DOMAINS.has(window.location.hostname)
  ? window.location.hostname
  : process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN

const firebaseConfig = {
  apiKey:            process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain,
  projectId:         process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket:     process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId:             process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
}

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0]

export const db   = getFirestore(app)
export const auth = getAuth(app)

export async function getMessagingInstance() {
  const supported = await isSupported()
  if (!supported) return null
  return getMessaging(app)
}
