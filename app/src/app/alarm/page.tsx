'use client'
import Link from 'next/link'
import { useCommunity } from '@/components/CommunityProvider'
import { AppMenu } from '@/components/AppMenu'

export default function AlarmPage() {
  const n = useCommunity()
  return <div className="min-h-dvh max-w-md mx-auto bg-white pb-[calc(env(safe-area-inset-bottom)+24px)]">
    <header className="bg-rb-600 px-5 pt-[calc(env(safe-area-inset-top)+16px)] pb-5 text-white">
      <div className="flex items-center justify-between"><Link href="/" className="text-sm">← 연습실</Link><AppMenu /></div><h1 className="text-2xl font-bold mt-3">알림 설정</h1>
      <p className="mt-1 text-sm text-rb-100">찜한 방부터 내 예약까지, 필요한 알림만</p>
    </header>
    <main className="p-5 space-y-5">
      <section className="rounded-2xl border border-rb-200 bg-rb-50 p-4 space-y-3">
        <h2 className="font-bold">이 기기의 알림</h2>
        <dl className="text-sm space-y-2">
          <div className="flex justify-between"><dt>브라우저 권한</dt><dd>{n.permission === 'granted' ? '허용됨' : n.permission === 'denied' ? '차단됨' : '아직 허용하지 않음'}</dd></div>
          <div className="flex justify-between"><dt>푸시 수신 등록</dt><dd className="font-bold">{n.registered ? '켜짐' : '꺼짐'}</dd></div>
          <div className="flex justify-between"><dt>알림 서버</dt><dd>{n.connected ? '연결됨' : '연결 확인 필요'}</dd></div>
        </dl>
        {n.needsInstall && <p className="rounded-xl bg-white p-3 text-sm leading-6">iPhone·iPad는 브라우저의 공유 버튼에서 <strong>홈 화면에 추가</strong>한 뒤, 앱 아이콘으로 열어 알림을 켜 주세요.</p>}
        {n.supported === false && !n.needsInstall && <p className="text-sm text-amber-800">현재 브라우저에서는 푸시를 사용할 수 없어요. 최신 Safari 또는 Chrome에서 열어 주세요.</p>}
        {n.permission === 'denied' && <p className="text-sm text-amber-800">브라우저의 이 사이트 설정에서 알림 차단을 해제한 뒤 다시 등록해 주세요.</p>}
        <div className="flex gap-2">
          <button disabled={n.busy} onClick={n.registered ? n.disable : n.enable} className="flex-1 h-12 rounded-xl bg-rb-600 text-white text-sm font-bold disabled:opacity-50">{n.busy ? '처리 중…' : n.registered ? '이 기기 알림 끄기' : '이 기기 알림 켜기'}</button>
          <button disabled={n.busy || !n.registered} onClick={n.test} className="flex-1 h-12 rounded-xl border border-rb-300 bg-white text-rb-700 text-sm font-bold disabled:opacity-40">테스트 알림</button>
        </div>
        <button onClick={() => void n.refresh()} className="text-sm text-rb-700 underline underline-offset-4">설정 상태 다시 확인</button>
        <p className="text-xs text-gray-500 leading-5">권한 허용과 기기 등록은 별개예요. 테스트 알림이 실제 도착하는지 확인해 주세요. 집중 모드·배터리 절약·네트워크에 따라 알림이 늦어질 수 있어요.</p>
      </section>
      {n.error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{n.error}</p>}
      {n.notice && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">{n.notice}</p>}
      <section className="rounded-2xl border border-gray-200 p-4">
        <h2 className="font-bold mb-3">받을 알림</h2>
        {([
          ['room_alerts','찜한 방 공실 알림','찜한 방이 사용 중에서 공실로 바뀌면'],
          ['tag_reminders','학생증 태그 알림','내 예약의 태그 마감 5분·2분 전'],
          ['return_reminders','반납 리마인더','태그 완료된 내 예약의 종료 10분 전'],
        ] as const).map(([key,label,desc]) => <label key={key} className="flex items-center justify-between gap-3 py-3">
          <span><span className="block text-sm font-semibold">{label}</span><span className="block text-xs text-gray-500 mt-1">{desc}</span></span>
          <input type="checkbox" role="switch" aria-label={label} checked={n.data?.settings[key] ?? false} disabled={n.busy || !n.data} onChange={e => n.data && void n.saveSettings({...n.data.settings, [key]: e.target.checked})} className="h-6 w-6 accent-blue-600" />
        </label>)}
        <p className="text-xs text-gray-500 leading-5 mt-2">예약 알림은 앱에서 예약하거나 불러온 예약에 자동으로 연결됩니다. 취소·태그 완료 후에는 해당 태그 알림을 보내지 않습니다.</p>
      </section>
      <section className="rounded-2xl border border-gray-200 p-4">
        <div className="flex items-center justify-between"><h2 className="font-bold">찜한 방 <span className="text-rb-600">{n.data?.watches.length ?? 0}</span></h2><Link href="/favorites" className="text-sm font-semibold text-rb-700 underline underline-offset-4">찜한 방 관리</Link></div>
        <p className="text-xs text-gray-500 mt-2 leading-5">찜한 방 관리에서 알림 받을 방을 선택하세요. 서버가 학교 현황에서 공실 전환을 확인한 직후 알려드립니다. 예약 선점이나 순번 보장은 아닙니다.</p>
        <ul className="mt-3 divide-y divide-gray-100">{n.data?.watches.map(w => <li key={w.room_key} className="flex justify-between items-center gap-2 py-3 text-sm"><Link href={`/?room=${w.room_key}`} className="font-semibold">{w.name}</Link><button disabled={n.busy} onClick={() => void n.removeWatch(w.room_key)} className="p-2 text-gray-500">찜 해제</button></li>)}</ul>
        {n.data?.watches.length === 0 && <p className="text-sm text-gray-500 py-3">아직 찜한 방이 없습니다.</p>}
      </section>
      <section><h2 className="font-bold mb-3">최근 알림</h2><ul className="space-y-2">{n.data?.history.map(h => <li key={h.id} className="rounded-xl bg-gray-50 p-3"><Link href={h.url} className="block"><p className="font-semibold text-sm">{h.title}</p><p className="text-xs text-gray-600 mt-1">{h.body}</p><p className="text-[11px] text-gray-500 mt-2">{new Date(h.created*1000).toLocaleString('ko-KR', {timeZone:'Asia/Seoul'})} · {({sent:'푸시 서버 전달 완료',pending:'전송 대기·재시도 중',skipped:'상태 변경으로 발송 생략',no_device:'수신 기기 없음'} as Record<string,string>)[h.status] ?? h.status}</p></Link></li>)}</ul>{n.data?.history.length === 0 && <p className="text-sm text-gray-500">아직 알림 기록이 없습니다.</p>}</section>
    </main>
  </div>
}
