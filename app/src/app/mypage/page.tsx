'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { useAnonymousAuth } from '@/hooks/useAnonymousAuth'
import { useUserProfile } from '@/hooks/useUserProfile'
import { OnboardingModal } from '@/components/OnboardingModal'
import type { RankingsData, DeptRank, UserRank } from '@/app/api/rankings/route'

type Period = 'daily' | 'weekly' | 'monthly'

const PERIOD_LABELS: Record<Period, string> = {
  daily:   '오늘',
  weekly:  '이번 주',
  monthly: '이번 달',
}

const DEPT_EMOJI: Record<string, string> = {
  '피아노과':   '🎹',
  '성악과':     '🎤',
  '관현악과':   '🎻',
  '교회음악과': '⛪',
  '작곡과':     '🎼',
  '미설정':     '🎵',
}

function minToHM(min: number) {
  if (min < 60) return `${min}분`
  return `${Math.floor(min / 60)}시간 ${min % 60}분`
}

function BackIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5M12 5l-7 7 7 7" />
    </svg>
  )
}

// ── 과별 랭킹 아이템 ────────────────────────────────────
function DeptRankItem({ rank, dept, isMyDept }: { rank: number; dept: DeptRank; isMyDept: boolean }) {
  const maxBar = 100
  const emoji  = DEPT_EMOJI[dept.department] ?? '🎵'
  return (
    <div className={`rounded-2xl border-2 px-4 py-3.5 ${isMyDept ? 'border-rb-400 bg-rb-50' : 'border-gray-100 bg-white'}`}>
      <div className="flex items-center gap-3 mb-2">
        <span className={`text-sm font-bold w-6 text-center ${rank <= 3 ? 'text-rb-600' : 'text-gray-400'}`}>
          {rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}`}
        </span>
        <span className="text-lg">{emoji}</span>
        <div className="flex-1">
          <div className="flex items-center justify-between">
            <span className={`text-sm font-bold ${isMyDept ? 'text-rb-700' : 'text-gray-900'}`}>
              {dept.department}
              {isMyDept && <span className="ml-1 text-[10px] text-rb-500 font-medium">내 과</span>}
            </span>
            <span className="text-sm font-bold text-gray-800">{minToHM(dept.avgMin)}</span>
          </div>
          <div className="text-xs text-gray-400 mt-0.5">
            평균 연습시간 · {dept.userCount}명 · {dept.sessionCount}세션
          </div>
        </div>
      </div>
    </div>
  )
}

// ── 개인 랭킹 아이템 ────────────────────────────────────
function UserRankItem({ rank, user, isMe }: { rank: number; user: UserRank; isMe: boolean }) {
  const emoji = DEPT_EMOJI[user.department ?? '미설정'] ?? '🎵'
  return (
    <div className={`flex items-center gap-3 px-4 py-3 rounded-2xl border-2 ${isMe ? 'border-rb-400 bg-rb-50' : 'border-gray-100 bg-white'}`}>
      <span className={`text-sm font-bold w-6 text-center ${rank <= 3 ? 'text-rb-600' : 'text-gray-400'}`}>
        {rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}`}
      </span>
      <span className="text-base">{emoji}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={`text-sm font-bold truncate ${isMe ? 'text-rb-700' : 'text-gray-900'}`}>
            {user.nickname ?? '익명'}
          </span>
          {isMe && <span className="text-[10px] text-rb-500 font-medium shrink-0">나</span>}
        </div>
        <span className="text-xs text-gray-400">{user.department ?? '미설정'} · {user.sessionCount}세션</span>
      </div>
      <span className="text-sm font-bold text-gray-800 shrink-0">{minToHM(user.totalMin)}</span>
    </div>
  )
}

// ── 수동 연습 기록 모달 ──────────────────────────────────
function ManualLogModal({
  onClose,
  onSave,
}: {
  onClose: () => void
  onSave: (startedAt: Date, endedAt: Date, room: string) => Promise<void>
}) {
  const now      = new Date()
  const pad      = (n: number) => n.toString().padStart(2, '0')
  const toHHMM   = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const fromHHMM = (s: string, base: Date) => {
    const [h, m] = s.split(':').map(Number)
    const d = new Date(base)
    d.setHours(h, m, 0, 0)
    return d
  }

  const [startStr, setStartStr] = useState(toHHMM(new Date(now.getTime() - 60 * 60 * 1000)))
  const [endStr,   setEndStr]   = useState(toHHMM(now))
  const [room,     setRoom]     = useState('')
  const [saving,   setSaving]   = useState(false)
  const [err,      setErr]      = useState('')

  async function handleSave() {
    const startedAt = fromHHMM(startStr, now)
    const endedAt   = fromHHMM(endStr, now)
    if (endedAt <= startedAt) { setErr('종료 시각이 시작 시각보다 늦어야 해요'); return }
    const dMin = Math.round((endedAt.getTime() - startedAt.getTime()) / 60000)
    if (dMin < 5)   { setErr('최소 5분 이상이어야 해요'); return }
    if (dMin > 240) { setErr('4시간 이내만 입력 가능해요'); return }
    setSaving(true)
    try { await onSave(startedAt, endedAt, room) } catch (e) { setErr('저장 실패. 다시 시도해주세요') }
    setSaving(false)
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />
      <div className="fixed bottom-0 left-0 right-0 z-50 flex justify-center">
        <div className="w-full max-w-md bg-white rounded-t-3xl px-6 pt-5 pb-10 shadow-2xl">
          <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto mb-5" />
          <h2 className="text-lg font-bold text-gray-900 mb-5">🎵 연습 기록 직접 입력</h2>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs font-bold text-rb-600 mb-2">시작 시각</p>
                <input type="time" value={startStr} onChange={(e) => setStartStr(e.target.value)}
                  className="w-full h-12 rounded-xl border-2 border-gray-200 px-3 text-base font-bold text-center focus:border-rb-500 focus:outline-none" />
              </div>
              <div>
                <p className="text-xs font-bold text-rb-600 mb-2">종료 시각</p>
                <input type="time" value={endStr} onChange={(e) => setEndStr(e.target.value)}
                  className="w-full h-12 rounded-xl border-2 border-gray-200 px-3 text-base font-bold text-center focus:border-rb-500 focus:outline-none" />
              </div>
            </div>
            <div>
              <p className="text-xs font-bold text-rb-600 mb-2">방 번호 <span className="font-normal text-gray-400">(선택)</span></p>
              <input type="text" value={room} onChange={(e) => setRoom(e.target.value)}
                placeholder="예: 302호" inputMode="numeric"
                className="w-full h-12 rounded-xl border-2 border-gray-200 px-4 text-base font-medium focus:border-rb-500 focus:outline-none" />
            </div>
            {err && <p className="text-sm text-red-500 font-medium">{err}</p>}
            <button onClick={handleSave} disabled={saving}
              className="w-full h-13 rounded-2xl bg-rb-600 text-white text-base font-bold disabled:opacity-30 active:scale-[0.98] transition-all">
              {saving ? '저장 중...' : '기록 저장'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

// ── 메인 페이지 ────────────────────────────────────────
export default function MyPage() {
  const { user } = useAnonymousAuth()
  const { profile, isNew, suggestedNickname, rerollNickname, saveProfile } = useUserProfile(user)

  const [period,   setPeriod]   = useState<Period>('weekly')
  const [tab,      setTab]      = useState<'dept' | 'user'>('user')
  const [data,     setData]     = useState<RankingsData | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [showLog,  setShowLog]  = useState(false)
  const [logDone,  setLogDone]  = useState(false)

  const fetchRankings = useCallback(async () => {
    if (!user) return
    setLoading(true)
    try {
      const res  = await fetch(`/api/rankings?period=${period}&uid=${user.uid}`)
      if (res.ok) setData(await res.json())
    } finally {
      setLoading(false)
    }
  }, [user, period])

  useEffect(() => { fetchRankings() }, [fetchRankings])

  async function handleManualLog(startedAt: Date, endedAt: Date, room: string) {
    if (!user) return
    const idToken = await user.getIdToken()
    const res = await fetch('/api/practice', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body:    JSON.stringify({ startedAt: startedAt.getTime(), endedAt: endedAt.getTime(), roomHint: room }),
    })
    if (!res.ok) throw new Error('failed')
    setShowLog(false)
    setLogDone(true)
    fetchRankings()
  }

  const myProfile = data?.myRank
  const myUser    = myProfile?.user
  const myDept    = myProfile?.dept

  return (
    <div className="flex flex-col min-h-dvh max-w-md mx-auto bg-white">

      {/* ── 헤더 ── */}
      <header className="bg-rb-600 px-5 pt-[calc(env(safe-area-inset-top)+16px)] pb-5">
        <div className="flex items-center gap-3 mb-4">
          <Link href="/" className="text-white/70 p-1 -ml-1"><BackIcon /></Link>
          <div>
            <h1 className="text-xl font-bold text-white">마이페이지</h1>
            <p className="text-rb-200 text-xs mt-0.5">연습 기록 · 랭킹</p>
          </div>
        </div>

        {/* 프로필 카드 */}
        {profile ? (
          <div className="rounded-2xl bg-white/10 px-4 py-3.5 flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-white/20 flex items-center justify-center text-2xl">
              {DEPT_EMOJI[profile.department ?? '미설정'] ?? '🎵'}
            </div>
            <div className="flex-1">
              <p className="text-white font-bold text-base">{profile.nickname}</p>
              <p className="text-rb-200 text-xs">{profile.department ?? '학과 미설정'}</p>
            </div>
            {/* 내 주간 연습시간 */}
            {myUser && (
              <div className="text-right">
                <p className="text-white font-bold text-lg">{minToHM(myUser.totalMin)}</p>
                <p className="text-rb-200 text-xs">
                  {PERIOD_LABELS[period]} 연습
                  {myProfile?.userRankPos ? ` · ${myProfile.userRankPos}위` : ''}
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-2xl bg-white/10 px-4 py-3 text-rb-200 text-sm">
            로딩 중...
          </div>
        )}
      </header>

      <main className="flex-1 px-4 pt-5 pb-[calc(env(safe-area-inset-bottom)+90px)] space-y-5">

        {/* ── 기간 탭 ── */}
        <div className="flex gap-2">
          {(['daily', 'weekly', 'monthly'] as Period[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`flex-1 py-2 rounded-xl text-sm font-bold transition-all ${
                period === p ? 'bg-rb-600 text-white' : 'bg-rb-50 text-rb-600'
              }`}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>

        {/* ── 내 과 순위 카드 ── */}
        {myDept && (
          <div className="rounded-2xl bg-rb-50 border-2 border-rb-200 px-4 py-3.5">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs font-bold text-rb-600 uppercase tracking-wider">내 과 ({myDept.department})</p>
              <span className="text-xs text-rb-500">
                {data!.deptRankings.findIndex((d) => d.department === myDept.department) + 1}위 / {data!.deptRankings.length}개 과
              </span>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-2xl font-bold text-rb-700">{minToHM(myDept.avgMin)}</p>
                <p className="text-xs text-rb-500">평균 연습시간</p>
              </div>
              <div className="text-right">
                <p className="text-sm font-bold text-rb-600">{minToHM(myDept.totalMin)}</p>
                <p className="text-xs text-rb-400">총 {myDept.userCount}명 · {myDept.sessionCount}세션</p>
              </div>
            </div>
          </div>
        )}

        {/* ── 랭킹 탭 (개인만 표시) ── */}
        <div className="flex items-center gap-2">
          <p className="text-xs font-bold text-gray-500 uppercase tracking-wider">🏆 개인 랭킹</p>
          <div className="h-px flex-1 bg-gray-100" />
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="w-6 h-6 border-2 border-rb-200 border-t-rb-600 rounded-full animate-spin" />
          </div>
        ) : !data || (tab === 'dept' ? data.deptRankings.length : data.userRankings.length) === 0 ? (
          <div className="flex flex-col items-center py-12 gap-3">
            <p className="text-3xl">🎵</p>
            <p className="text-gray-400 text-sm">아직 기록이 없어요</p>
            <p className="text-xs text-gray-300 text-center">
              알림 등록 후 연습하거나 아래 버튼으로 직접 기록해보세요
            </p>
          </div>
        ) : tab === 'dept' ? (
          /* 과별 랭킹 */
          <div className="space-y-2">
            {data.deptRankings.map((dept, i) => (
              <DeptRankItem
                key={dept.department}
                rank={i + 1}
                dept={dept}
                isMyDept={dept.department === profile?.department}
              />
            ))}
            <p className="text-center text-xs text-gray-300 pt-1">
              과별 평균 연습시간 기준 · {PERIOD_LABELS[period]}
            </p>
          </div>
        ) : (
          /* 개인 랭킹 */
          <div className="space-y-2">
            {data.userRankings.map((u, i) => (
              <UserRankItem
                key={u.uid}
                rank={i + 1}
                user={u}
                isMe={u.uid === user?.uid}
              />
            ))}
            {/* 내가 20위 밖이면 별도 표시 */}
            {myProfile?.userRankPos &&
              myProfile.userRankPos > 20 &&
              myProfile.user && (
              <div className="rounded-2xl border-2 border-dashed border-rb-300 px-4 py-3">
                <p className="text-xs text-rb-500 font-bold mb-1">내 순위</p>
                <UserRankItem rank={myProfile.userRankPos} user={myProfile.user} isMe={true} />
              </div>
            )}
            <p className="text-center text-xs text-gray-300 pt-1">
              개인 총 연습시간 기준 · {PERIOD_LABELS[period]} · 상위 20명
            </p>
          </div>
        )}

        {logDone && (
          <div className="rounded-2xl bg-emerald-50 border border-emerald-200 px-4 py-3">
            <p className="text-sm font-bold text-emerald-800">✅ 연습 기록이 저장됐어요!</p>
            <p className="text-xs text-emerald-600 mt-0.5">랭킹에 반영되기까지 잠시 걸릴 수 있어요</p>
          </div>
        )}

      </main>

      {/* ── 하단 버튼 ── */}
      <div className="fixed bottom-0 left-0 right-0 flex justify-center z-10">
        <div className="w-full max-w-md px-4 pb-[calc(env(safe-area-inset-bottom)+16px)] pt-3 bg-white border-t border-gray-100">
          <button
            onClick={() => { setShowLog(true); setLogDone(false) }}
            className="w-full h-13 rounded-2xl bg-rb-600 text-white text-sm font-bold active:scale-[0.98] transition-all shadow-md"
          >
            ✏️ 연습 기록 직접 입력
          </button>
          <p className="text-center text-xs text-gray-400 mt-1.5">알림 등록 시 연습 기록이 자동으로 쌓여요</p>
        </div>
      </div>

      {/* ── 수동 기록 모달 ── */}
      {showLog && (
        <ManualLogModal onClose={() => setShowLog(false)} onSave={handleManualLog} />
      )}

      {/* ── 온보딩 ── */}
      {isNew && suggestedNickname && (
        <OnboardingModal suggestedNickname={suggestedNickname} onReroll={rerollNickname} onSave={saveProfile} />
      )}
    </div>
  )
}
