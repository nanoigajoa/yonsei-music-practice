import { DailyReturnNotice } from '@/components/Announcements'
import Link from 'next/link'
import { AppMenu } from '@/components/AppMenu'

export default function NoticesPage() {
  return <div className="min-h-dvh max-w-md mx-auto bg-white pb-[calc(env(safe-area-inset-bottom)+24px)]">
    <header className="bg-rb-600 px-5 pt-[calc(env(safe-area-inset-top)+16px)] pb-5 text-white">
      <div className="flex items-center justify-between"><Link href="/" className="text-sm">← 연습실</Link><AppMenu /></div>
      <h1 className="text-2xl font-bold mt-3">공지사항</h1><p className="mt-1 text-sm text-rb-100">연습실 앱의 새 소식과 이용 안내</p>
    </header>
    <main className="p-5 space-y-4">
      <DailyReturnNotice />
      <article className="rounded-2xl border border-gray-200 p-5">
        <time dateTime="2026-09-08" className="text-xs text-gray-500">2026.09.08</time>
        <h2 className="font-bold text-lg mt-2">라운지와 찜한 방 알림을 시작해요</h2>
        <div className="mt-3 space-y-3 text-sm leading-6 text-gray-600">
          <p>헤더의 메뉴 버튼에서 찜한 방 관리, 알림 설정, 운영자 문의, 음대 라운지를 한곳에서 열 수 있어요.</p>
          <p><Link href="/favorites" className="font-semibold text-rb-700 underline underline-offset-2">찜한 방 관리</Link>에서 원하는 방을 선택하고, <Link href="/alarm" className="font-semibold text-rb-700 underline underline-offset-2">알림 설정</Link>에서 이 기기 알림을 켜 주세요. 테스트 알림으로 실제 수신 여부도 확인할 수 있어요.</p>
          <p><Link href="/lounge" className="font-semibold text-rb-700 underline underline-offset-2">음대 라운지</Link>는 학우들이 텍스트로 대화하는 전체 채팅방이에요. 입장 후 이용 규칙을 확인하고 서로 배려하며 대화해 주세요.</p>
          <p>개선 아이디어나 불편한 점은 메뉴의 운영자 문의를 통해 오픈채팅으로 알려 주세요.</p>
        </div>
      </article>
    </main>
  </div>
}
