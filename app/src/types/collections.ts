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
  floor: 1 | 2 | 3
  userId: string
  endTime: Timestamp
  type: 'give' | 'swap'
  swapNote: string | null
  matchedBy: string | null
  status: 'open' | 'urgent' | 'matched' | 'done' | 'cancelled'
  createdAt: Timestamp
}

export interface FcmToken {
  token: string
  updatedAt: Timestamp
}

export const DEPARTMENTS = ['피아노과', '성악과', '관현악과', '교회음악과', '작곡과'] as const
export type Department = typeof DEPARTMENTS[number]

export interface UserProfile {
  uid: string
  nickname: string
  department: Department | null
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface AlarmSession {
  id?: string
  userId: string
  reservedAt: Timestamp
  endTime: Timestamp | null
  roomHint: string | null
  notified5: boolean
  notified1: boolean
  notifiedReturn15: boolean
  notifiedReturn5: boolean
  status: 'active' | 'expired'
  createdAt: Timestamp
}

export interface FacilityReport {
  id?: string
  name: string
  studentId: string        // 학번
  roomId: string           // 호실 (예: "302")
  floor: number | null     // 층 (roomId에서 자동 추출)
  issues: string[]         // 신고 유형 (다중 선택)
  description: string      // 상세 설명
  contact: string | null   // 연락처 (선택)
  status: 'pending' | 'in_progress' | 'resolved'
  userId: string | null
  createdAt: Timestamp
}

// Firestore 컬렉션 경로 상수
export const COLLECTIONS = {
  CONGESTION:     'congestion_reports',
  ROOMS:          'rooms',
  EARLY_RETURN:   'early_returns',
  TRANSFERS:      'transfer_requests',
  FCM_TOKENS:     'fcm_tokens',        // users/{uid}/fcm_tokens/{tokenId}
  ALARM_SESSIONS:    'alarm_sessions',
  FACILITY_REPORTS:  'facility_reports',
  USER_PROFILES:     'user_profiles',
} as const
