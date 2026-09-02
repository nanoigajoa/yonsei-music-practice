// Supabase CLI로 자동 생성하려면:
// supabase gen types typescript --project-id <project-id> > src/types/database.types.ts
// 아래는 수동 정의 (초기 개발용)

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[]

export interface Database {
  public: {
    Tables: {
      congestion_reports: {
        Row: {
          id: string
          floor: number
          queue_count: number
          reported_by: string | null
          created_at: string
        }
        Insert: {
          id?: string
          floor: number
          queue_count: number
          reported_by?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          floor?: number
          queue_count?: number
          reported_by?: string | null
          created_at?: string
        }
      }
      rooms: {
        Row: {
          id: number
          floor: number
          name: string
          type: 'piano' | 'church' | 'general'
          piano_chairs: number
          regular_chairs: number
          music_stands: number
          updated_at: string
        }
        Insert: {
          id: number
          floor: number
          name: string
          type: 'piano' | 'church' | 'general'
          piano_chairs?: number
          regular_chairs?: number
          music_stands?: number
          updated_at?: string
        }
        Update: {
          id?: number
          floor?: number
          name?: string
          type?: 'piano' | 'church' | 'general'
          piano_chairs?: number
          regular_chairs?: number
          music_stands?: number
          updated_at?: string
        }
      }
      push_subscriptions: {
        Row: {
          id: string
          user_id: string
          subscription: Json
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          subscription: Json
          created_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          subscription?: Json
          created_at?: string
        }
      }
    }
    Functions: {
      get_congestion_avg: {
        Args: { p_floor: number }
        Returns: { avg_queue: number; report_count: number }[]
      }
    }
  }
}
