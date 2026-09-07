'use client'

import Link from 'next/link'
import { AppMenu } from '@/components/AppMenu'
import { useCommunity } from '@/components/CommunityProvider'
import { useRoomStatus } from '@/hooks/useRoomStatus'
import { watchKey } from '@/lib/community'

export default function FavoritesPage() {
  const n = useCommunity()
  const { status, byFloor, connState, refresh, refreshing } = useRoomStatus()
  const selected = new Set(n.data?.watches.map(w => w.room_key))

  return <div className="min-h-dvh max-w-md mx-auto bg-white pb-[calc(env(safe-area-inset-bottom)+24px)]">
    <header className="bg-rb-600 px-5 pt-[calc(env(safe-area-inset-top)+16px)] pb-5 text-white">
      <div className="flex items-center justify-between"><Link href="/" className="text-sm">← 연습실</Link><AppMenu /></div>
      <h1 className="text-2xl font-bold mt-3">찜한 방 관리</h1><p className="mt-1 text-sm text-rb-100">공실 알림을 받고 싶은 방을 선택하세요</p>
    </header>
    <main className="p-5 space-y-5">
      <section className="rounded-2xl bg-rb-50 p-4 text-sm leading-6">
        <p className="font-bold text-rb-800">선택한 방 {selected.size}개 · 선택 즉시 저장</p>
        <p className="mt-1 text-gray-600">찜한 방이 사용 중에서 공실로 바뀌면 알려드려요. 이미 비어 있는 방은 다음 공실 전환부터 알림을 받아요.</p>
        <Link href="/alarm" className="inline-block mt-3 font-semibold text-rb-700 underline underline-offset-4">알림 설정 확인 →</Link>
        {n.data && (!n.registered || !n.data.settings.room_alerts) && <p className="mt-2 text-xs text-amber-800">알림 설정에서 이 기기 알림과 찜한 방 공실 알림을 모두 켜 주세요.</p>}
      </section>
      {n.error && <div role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{n.error}<button onClick={() => void n.refresh()} className="ml-2 underline">다시 연결</button></div>}
      {n.notice && <p role="status" className="text-sm text-emerald-800">{n.notice}</p>}
      {selected.size > 0 && <section>
        <h2 className="font-bold mb-2">찜한 방</h2>
        <ul className="divide-y divide-gray-100">{n.data?.watches.map(w => <li key={w.room_key} className="flex items-center justify-between gap-3 py-2 text-sm"><span>{w.name}</span><button disabled={n.busy} onClick={() => void n.removeWatch(w.room_key)} className="shrink-0 rounded-lg px-3 py-2 text-gray-600 hover:bg-gray-50 disabled:opacity-40">찜 해제</button></li>)}</ul>
      </section>}
      {!status && <div role="status" className="py-6 text-center text-sm text-gray-600">{connState === 'error' ? '방 목록을 불러오지 못했어요.' : '방 목록을 불러오는 중…'}<button onClick={refresh} disabled={refreshing} className="block mx-auto mt-3 text-rb-700 underline">다시 불러오기</button></div>}
      {Object.entries(byFloor).sort(([a], [b]) => Number(a) - Number(b)).map(([floor, corners]) => <section key={floor} className="rounded-2xl border border-gray-200 p-4">
        <h2 className="font-bold mb-3">{floor}층</h2>
        {Object.entries(corners).sort(([a], [b]) => Number(a) - Number(b)).map(([corner, rooms]) => <fieldset key={corner} className="mt-3">
          <legend className="text-xs font-semibold text-gray-500">{[1,2,3,4].includes(Number(corner)) ? 'A동' : 'B동'} · {rooms.length}개 방</legend>
          <div className="grid grid-cols-2 gap-2 mt-2">{[...rooms].sort((a,b) => a.name.localeCompare(b.name, 'ko', {numeric:true})).map(room => <label key={watchKey(room)} className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-3 text-sm ${selected.has(watchKey(room)) ? 'border-rb-300 bg-rb-50 text-rb-800' : 'border-gray-200 text-gray-700'}`}>
            <input type="checkbox" checked={selected.has(watchKey(room))} disabled={n.busy || !n.data} onChange={() => void n.toggleWatch(room)} aria-label={`${room.name} 찜`} className="h-5 w-5 shrink-0 accent-blue-600" />
            <span>{room.name.match(/\d+호/)?.[0] ?? room.name}{room.name.includes('오르간') && <span className="block text-[11px] text-gray-500">오르간</span>}</span>
          </label>)}</div>
        </fieldset>)}
      </section>)}
      <p className="text-xs text-gray-500 leading-5">학교 현황에서 공실 전환을 확인한 뒤 알림을 보냅니다. 예약 선점이나 순번을 보장하지 않으며 기기·네트워크 상태에 따라 도착이 늦어질 수 있어요.</p>
    </main>
  </div>
}
