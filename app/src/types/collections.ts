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
  notifyTag:    boolean  // 미인증 태그 알림
  notifyExtend: boolean  // 연장 리마인더 (40분 전)
  notifyReturn: boolean  // 반납 리마인더 (10분 전)
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface AlarmSession {
  id?: string
  userId: string
  reservedAt: Timestamp
  endTime: Timestamp | null
  roomHint: string | null
  notified5: boolean          // T+5분 태그 중간 경고
  notified1: boolean          // T+9분 마지막 경고
  notifiedReturn40: boolean   // 종료 40분 전 연장 알림
  notifiedReturn10: boolean   // 종료 10분 전 반납 알림
  practiceLogged: boolean     // 연습 기록 생성 완료 여부
  status: 'active' | 'expired'
  createdAt: Timestamp
}

export interface PracticeSession {
  id?: string
  uid: string
  department: Department | null
  nickname: string | null
  roomHint: string | null
  startedAt: Timestamp
  endedAt: Timestamp
  durationMin: number         // 분 단위 (endedAt - startedAt)
  source: 'alarm' | 'manual'
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
  CONGESTION:        'congestion_reports',
  ROOMS:             'rooms',
  EARLY_RETURN:      'early_returns',
  TRANSFERS:         'transfer_requests',
  FCM_TOKENS:        'fcm_tokens',        // users/{uid}/fcm_tokens/{tokenId}
  ALARM_SESSIONS:    'alarm_sessions',
  FACILITY_REPORTS:  'facility_reports',
  USER_PROFILES:     'user_profiles',
  PRACTICE_SESSIONS: 'practice_sessions',
} as const
