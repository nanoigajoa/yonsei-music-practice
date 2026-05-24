'use client'

import { useState, useEffect } from 'react'
import { DEPARTMENTS, Department } from '@/types/collections'

interface Props {
  suggestedNickname: string
  onReroll: () => void
  onSave: (nickname: string, department: Department) => Promise<void>
}

const DEPT_EMOJI: Record<Department, string> = {
  '피아노과':   '🎹',
  '성악과':     '🎤',
  '관현악과':   '🎻',
  '교회음악과': '⛪',
  '작곡과':     '🎼',
}

export function OnboardingModal({ suggestedNickname, onReroll, onSave }: Props) {
  const [nickname, setNickname]     = useState(suggestedNickname)
  const [department, setDepartment] = useState<Department | null>(null)
  const [saving, setSaving]         = useState(false)
  const [editing, setEditing]       = useState(false)

  // suggestedNickname이 바뀌면(다시뽑기) 입력창 동기화
  useEffect(() => {
    if (!editing) setNickname(suggestedNickname)
  }, [suggestedNickname, editing])

  async function handleSave() {
    if (!department || !nickname.trim()) return
    setSaving(true)
    try {
      await onSave(nickname.trim(), department)
    } finally {
      setSaving(false)
    }
  }

  const canSave = !!department && nickname.trim().length > 0 && !saving

  return (
    <>
      {/* 오버레이 */}
      <div className="fixed inset-0 bg-black/40 z-40" />

      {/* 모달 시트 */}
      <div className="fixed bottom-0 left-0 right-0 z-50 flex justify-center">
        <div className="w-full max-w-md bg-white rounded-t-3xl px-6 pt-5 pb-[calc(env(safe-area-inset-bottom)+28px)] shadow-2xl">

          {/* 핸들 */}
          <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto mb-5" />

          {/* 타이틀 */}
          <div className="text-center mb-6">
            <p className="text-3xl mb-2">👋</p>
            <h2 className="text-xl font-bold text-gray-900">처음 오셨군요!</h2>
            <p className="text-sm text-gray-500 mt-1">닉네임과 과를 설정해주세요</p>
          </div>

          {/* 닉네임 */}
          <div className="mb-5">
            <p className="text-xs font-bold text-rb-600 uppercase tracking-wider mb-2">닉네임</p>
            <div className="flex gap-2 items-center">
              <input
                type="text"
                value={nickname}
                maxLength={16}
                onChange={(e) => { setNickname(e.target.value); setEditing(true) }}
                onFocus={() => setEditing(true)}
                className="flex-1 h-11 rounded-xl border-2 border-gray-200 px-3 text-sm font-bold text-gray-800 focus:border-rb-500 focus:outline-none transition-colors"
                placeholder="닉네임 입력"
              />
              <button
                onClick={() => { setEditing(false); onReroll() }}
                className="h-11 px-3 rounded-xl bg-rb-50 border-2 border-rb-200 text-rb-600 text-xs font-bold active:scale-95 transition-transform whitespace-nowrap"
              >
                🎲 다시뽑기
              </button>
            </div>
            <p className="text-[11px] text-gray-400 mt-1.5 pl-1">최대 16자 · 나중에 변경 가능</p>
          </div>

          {/* 과 선택 */}
          <div className="mb-7">
            <p className="text-xs font-bold text-rb-600 uppercase tracking-wider mb-2">소속 과</p>
            <div className="grid grid-cols-2 gap-2">
              {DEPARTMENTS.map((dept) => (
                <button
                  key={dept}
                  onClick={() => setDepartment(dept)}
                  className={`flex items-center gap-2.5 h-12 px-3 rounded-xl border-2 font-bold text-sm transition-all active:scale-[0.97] ${
                    department === dept
                      ? 'border-rb-600 bg-rb-600 text-white'
                      : 'border-gray-200 bg-white text-gray-700'
                  }`}
                >
                  <span className="text-lg">{DEPT_EMOJI[dept]}</span>
                  <span>{dept}</span>
                </button>
              ))}
            </div>
          </div>

          {/* 시작하기 버튼 */}
          <button
            onClick={handleSave}
            disabled={!canSave}
            className="w-full h-14 rounded-2xl bg-rb-600 text-white text-base font-bold shadow-md disabled:opacity-30 disabled:cursor-not-allowed active:scale-[0.98] transition-all"
          >
            {saving ? '저장 중...' : '시작하기 🎵'}
          </button>
        </div>
      </div>
    </>
  )
}
