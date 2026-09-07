'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { SUPPORT_URL } from '@/lib/community'
import { ThemeSettings } from '@/components/ThemeSettings'

const links = [
  ['/', '연습실 현황', '지금 이용할 수 있는 방'],
  ['/favorites', '찜한 방 관리', '공실 알림 받을 방 선택'],
  ['/alarm', '알림 설정', '기기 등록 · 알림 종류 · 최근 알림'],
  ['/notices', '공지사항', '새 소식과 이용 안내'],
  ['/lounge', '음대 라운지', '학우들과 나누는 전체 채팅'],
  ['/facility-report', '시설 신문고', '준비 중'],
  ['/mypage', '마이페이지', '내 프로필과 이용 기록'],
] as const

export function AppMenu() {
  const dialog = useRef<HTMLDialogElement>(null)
  const [open, setOpen] = useState(false)
  const pathname = usePathname()

  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [open])

  function close() { dialog.current?.close() }

  return <>
    <button type="button" aria-label="전체 메뉴 열기" aria-haspopup="dialog" aria-expanded={open}
      onClick={() => { dialog.current?.showModal(); setOpen(true) }}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/15 text-white active:bg-white/25">
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5"><path strokeLinecap="round" d="M4 6h16M4 12h16M4 18h16" /></svg>
    </button>
    <dialog ref={dialog} aria-label="전체 메뉴" onClose={() => setOpen(false)}
      onClick={event => { if (event.target === event.currentTarget) close() }}
      className="fixed inset-y-0 left-auto right-0 m-0 h-dvh max-h-none w-[min(85vw,340px)] max-w-none border-0 bg-white p-0 text-gray-900 shadow-2xl backdrop:bg-slate-950/40">
      <div className="min-h-full px-5 pt-[calc(env(safe-area-inset-top)+20px)] pb-[calc(env(safe-area-inset-bottom)+24px)]">
        <div className="flex items-center justify-between mb-5">
          <div><p className="text-xs font-semibold tracking-widest text-rb-600">YONSEI MUSIC</p><h2 className="text-xl font-bold mt-1">전체 메뉴</h2></div>
          <button type="button" onClick={close} aria-label="메뉴 닫기" className="h-11 w-11 rounded-full bg-gray-100 text-xl">×</button>
        </div>
        <nav aria-label="서비스 메뉴" className="space-y-1">
          {links.map(([href, label, description]) => <Link key={href} href={href} onClick={close} aria-current={pathname === href ? 'page' : undefined}
            className={`block rounded-xl px-4 py-3 ${pathname === href ? 'bg-rb-50 text-rb-700' : 'text-gray-800 hover:bg-gray-50'}`}>
            <span className="block text-sm font-bold">{label}</span><span className="block text-xs text-gray-500 mt-1">{description}</span>
          </Link>)}
          <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer" onClick={close} className="block rounded-xl px-4 py-3 text-gray-800 hover:bg-gray-50">
            <span className="block text-sm font-bold">운영자 문의 ↗</span><span className="block text-xs text-gray-500 mt-1">개선 아이디어 · 문의 · 라운지 신고</span>
          </a>
        </nav>
        <ThemeSettings />
        <div className="mt-5 border-t border-gray-100 pt-4 px-4"><Link href="/privacy" onClick={close} className="text-xs text-gray-500 underline underline-offset-4">개인정보처리방침</Link></div>
      </div>
    </dialog>
  </>
}
