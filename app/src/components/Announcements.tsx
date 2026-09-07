'use client'
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { useAnonymousAuth } from '@/hooks/useAnonymousAuth'
import { COMMUNITY_API } from '@/lib/community'

type Notice = { id: string; title: string; body: string }
const Context = createContext<{ dailyEnabled: boolean; notices: Notice[] }>({ dailyEnabled: false, notices: [] })
export const useAnnouncements = () => useContext(Context)

export function Announcements({ children }: { children: React.ReactNode }) {
  const { user } = useAnonymousAuth()
  const [state, setState] = useState<{ dailyEnabled: boolean; notices: Notice[] }>({ dailyEnabled: false, notices: [] })
  const [pending, setPending] = useState<Notice | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (!user) return
    let alive = true
    const read = async () => {
      try {
        const response = await fetch(`${COMMUNITY_API}/announcements`, { cache: 'no-store', signal: AbortSignal.timeout(10000) })
        if (!response.ok) return
        const data = await response.json()
        if (!alive || !Array.isArray(data.items)) return
        setState({ dailyEnabled: data.daily_return_enabled === true, notices: data.items })
        const unread = data.items.find((item: Notice) => {
          try { return localStorage.getItem(`practice-notice:${user.uid}:${item.id}`) !== 'read' } catch { return true }
        })
        setPending(unread ?? null)
      } catch { /* Old gateways do not publish this policy yet. */ }
    }
    void read()
    const visible = () => { if (document.visibilityState === 'visible') void read() }
    document.addEventListener('visibilitychange', visible)
    return () => { alive = false; document.removeEventListener('visibilitychange', visible) }
  }, [user])
  useEffect(() => {
    if (pending && !dialog.current?.open) dialog.current?.showModal()
    else if (!pending) dialog.current?.close()
  }, [pending])
  const confirm = () => {
    if (pending && user) {
      try { localStorage.setItem(`practice-notice:${user.uid}:${pending.id}`, 'read') } catch { /* Keep the app usable without storage. */ }
    }
    setPending(null)
  }
  return <Context.Provider value={state}>{children}
    <dialog ref={dialog} onCancel={event => event.preventDefault()} aria-labelledby="announcement-title"
      className="m-auto w-[calc(100%-40px)] max-w-sm rounded-2xl bg-white p-6 text-gray-900 shadow-xl backdrop:bg-black/50">
      {pending && <><h2 id="announcement-title" className="text-lg font-bold">{pending.title}</h2>
        <p className="mt-3 text-sm leading-6 text-gray-600">{pending.body}</p>
        <button autoFocus onClick={confirm} className="mt-5 h-12 w-full rounded-xl bg-rb-600 font-bold text-white">확인</button></>}
    </dialog>
  </Context.Provider>
}

export function DailyReturnNotice() {
  const { notices } = useAnnouncements()
  return <>{notices.map(notice => <article key={notice.id} className="rounded-2xl border border-gray-200 p-5">
    <time dateTime="2026-09-08" className="text-xs text-gray-500">2026.09.08</time>
    <h2 className="mt-2 text-lg font-bold">{notice.title}</h2>
    <p className="mt-3 text-sm leading-6 text-gray-600">{notice.body}</p>
    <p className="mt-2 text-xs leading-5 text-gray-500">휴대폰에서 이 앱으로 예약하고 태그를 완료한 방에 적용돼요. 현장 키오스크에서 직접 빌린 방과 미태그 예약은 제외해요. 21:50에 대상을 확정하고 그 예약만 재시도해요. 학교 연결 실패 시 22:00 전까지 재시도하니, 미완료 시 직접 반납해 주세요.</p>
  </article>)}</>
}
