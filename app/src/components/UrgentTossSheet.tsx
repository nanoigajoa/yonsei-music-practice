'use client'

import { useState } from 'react'
import { User } from 'firebase/auth'

interface Props {
  user: User | null
  onClose: () => void
  onSuccess: (roomId: string, floor: number) => void
}

export function UrgentTossSheet({ user, onClose, onSuccess }: Props) {
  const [roomId, setRoomId] = useState('')
  const [floor, setFloor] = useState<1 | 2 | 3 | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  async function handleToss() {
    if (!user || !roomId.trim() || !floor) return
    setSubmitting(true)
    setError('')
    try {
      const idToken = await user.getIdToken()
      const res = await fetch('/api/transfers/urgent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ roomId: roomId.trim(), floor }),
      })
      if (!res.ok) throw new Error((await res.json()).error || '실패')
      onSuccess(roomId.trim(), floor)
    } catch (e) {
      setError(e instanceof Error ? e.message : '실패했어요')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50">
      <div className="w-full max-w-md rounded-t-3xl bg-white px-5 pt-5 pb-[calc(env(safe-area-inset-bottom)+24px)]">
        {/* 핸들 */}
        <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto mb-5" />

        <h2 className="text-lg font-bold text-gray-900">🚨 지금 방 토스하기</h2>
        <p className="text-sm text-gray-500 mt-1 mb-5">전체 알림이 즉시 발송돼요</p>

        {/* 방 번호 + 층 */}
        <div className="flex gap-2 mb-4">
          <input
            type="text"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            placeholder="방 번호 (예: 302)"
            inputMode="numeric"
            className="flex-1 h-14 rounded-2xl border-2 border-gray-200 bg-gray-50 px-4 text-lg font-bold text-gray-900 placeholder:text-gray-300 placeholder:font-normal focus:border-rb-500 focus:bg-white focus:outline-none transition-colors"
          />
          <div className="flex gap-1.5">
            {([1, 2, 3] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFloor(f)}
                className={`w-14 h-14 rounded-2xl text-sm font-bold border-2 transition-all active:scale-95 ${
                  floor === f ? 'border-red-500 bg-red-500 text-white' : 'border-gray-200 bg-white text-gray-600'
                }`}
              >
                {f}층
              </button>
            ))}
          </div>
        </div>

        {error && <p className="text-sm text-red-500 mb-3 font-medium">{error}</p>}

        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 h-14 rounded-2xl border-2 border-gray-200 text-gray-600 font-bold active:scale-[0.98] transition-all"
          >
            취소
          </button>
          <button
            onClick={handleToss}
            disabled={submitting || !roomId.trim() || !floor}
            className="flex-[2] h-14 rounded-2xl bg-red-500 text-white font-bold disabled:opacity-30 active:scale-[0.98] transition-all"
          >
            {submitting ? '전송 중...' : '🚨 지금 토스하기'}
          </button>
        </div>
      </div>
    </div>
  )
}
