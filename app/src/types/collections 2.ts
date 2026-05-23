// Firestore 컬렉션 타입 정의
import { Timestamp } from 'firebase/firestore'

export interface CongestionReport {
  id?: string
  floor: 1 | 2 | 3
  queueCount: number
  reportedBy: string | null   // uid 또는 null(익명)
  createdAt: Timestamp
}

export interface Room {
  id?: string                 // 방 번호 (문자열로 사용)
  floor: 1 | 2 | 3
  name: string
  type: 'piano' | 'church' | 'general'
  pianoChairs: number
  regularChairs: number
  musicStands: number
  updatedAt: Timestamp
}

export interface EarlyReturn {
  id?: string
  roomId: string
  userId: string
  plannedTime: Timestamp
  note: string | null
  isTransferred: boolean
  createdAt: Timestamp
}

export interface TransferRequest {
  id?: string
  roomId: string
  userId: string
  endTime: Timestamp
  type: 'give' | 'swap'
  matchedBy: string | null
  status: 'open' | 'matched' | 'done' | 'cancelled'
  createdAt: Timestamp
}

export interface FcmToken {
  token: string
  updatedAt: Timestamp
}

// Firestore 컬렉션 경로 상수
export const COLLECTIONS = {
  CONGESTION:  'congestion_reports',
  ROOMS:       'rooms',
  EARLY_RETURN: 'early_returns',
  TRANSFERS:   'transfer_requests',
  FCM_TOKENS:  'fcm_tokens',           // users/{uid}/fcm_tokens/{tokenId}
} as const
