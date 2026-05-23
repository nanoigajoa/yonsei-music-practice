import { initializeApp, getApps, getApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { getMessaging } from 'firebase-admin/messaging'
import { getAuth } from 'firebase-admin/auth'

function adminApp() {
  if (getApps().length > 0) return getApp()
  const key = process.env.FIREBASE_SERVICE_ACCOUNT_KEY
  if (!key) throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY is not set')
  return initializeApp({ credential: cert(JSON.parse(key)) })
}

export function getAdminDb()        { return getFirestore(adminApp()) }
export function getAdminMessaging() { return getMessaging(adminApp()) }
export function getAdminAuth()      { return getAuth(adminApp()) }
