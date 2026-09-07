'use client'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useAnonymousAuth } from '@/hooks/useAnonymousAuth'
import { COMMUNITY_API, SUPPORT_URL } from '@/lib/community'
import { AppMenu } from '@/components/AppMenu'
interface Message { id: number; text: string; created_at: number; mine: boolean }
export default function LoungePage() {
  const { user } = useAnonymousAuth()
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [connected, setConnected] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const socket = useRef<WebSocket | null>(null)
  const pending = useRef<{ client_id: string; text: string } | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  useEffect(() => {
    if (!user) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    let attempts = 0
    async function connect() {
      try {
        const token = await user!.getIdToken()
        if (stopped) return
        const url = new URL(`${COMMUNITY_API}/community/lounge/ws`)
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        const ws = new WebSocket(url)
        socket.current = ws
        ws.onopen = () => ws.send(JSON.stringify({ token }))
        ws.onmessage = event => {
          if (stopped) return
          let data
          try { data = JSON.parse(event.data) } catch { return }
          if (data.type === 'history') {
            attempts = 0
            setMessages(data.messages)
            setConnected(true)
            setError('')
            if (pending.current) ws.send(JSON.stringify(pending.current))
          } else if (data.type === 'message') {
            setMessages(old => old.some(m => m.id === data.message.id) ? old : [...old, data.message].sort((a,b) => a.id-b.id).slice(-100))
          } else if (data.type === 'ack' && data.client_id === pending.current?.client_id) {
            pending.current = null; setSending(false); setDraft(''); setError('')
          } else if (data.type === 'error') {
            pending.current = null; setSending(false); setError(data.message)
          } else if (data.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }))
        }
        ws.onerror = () => { if (!stopped) setError('라운지에 연결하지 못했습니다. 연결을 다시 시도합니다.') }
        ws.onclose = event => {
          if (stopped) return
          setConnected(false)
          if (event.code === 1008) { setError('로그인 또는 라운지 연결을 확인해 주세요. 다시 연결할 수 있습니다.'); setSending(false); return }
          timer = setTimeout(connect, Math.min(15000, 1000*2**Math.min(attempts++,4)))
        }
      } catch { if (!stopped) { setConnected(false); setError('로그인 상태를 확인하지 못했습니다.'); timer = setTimeout(connect,5000) } }
    }
    void connect()
    return () => { stopped = true; clearTimeout(timer); socket.current?.close() }
  }, [user, retry])
  useEffect(() => { if (follow.current) bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }) }, [messages])
  function send() {
    if (!draft.trim() || sending || !connected || socket.current?.readyState !== WebSocket.OPEN) return
    const message = { client_id: crypto.randomUUID(), text: draft.trim() }
    pending.current = message
    setSending(true); setError(''); follow.current = true
    socket.current.send(JSON.stringify(message))
  }
  return <div className="flex flex-col h-dvh max-w-md mx-auto bg-white">
    <header className="bg-rb-600 text-white px-5 pt-[calc(env(safe-area-inset-top)+16px)] pb-4 shrink-0">
      <div className="flex justify-between items-center"><Link href="/" className="text-sm">← 연습실</Link><AppMenu /></div>
      <h1 className="text-2xl font-bold mt-3">음대 라운지</h1><p className="text-sm text-rb-100 mt-1">학우들과 나누는 전체 채팅방</p>
    </header>
    <div className="px-4 py-3 border-b border-gray-100 text-xs text-gray-600 shrink-0">
      <p><span className={connected ? 'text-emerald-700 font-bold' : 'text-amber-700 font-bold'}>{connected ? '● 실시간 연결' : '○ 연결 중'}</span><span> · 모두 익명으로 대화해요</span></p>
      <p className="mt-2 leading-5">서로 존중하며 이야기해요. 개인정보·비방·도배는 올리지 마세요.</p>
      <details className="mt-2 rounded-xl bg-slate-50 p-3 max-h-[30dvh] overflow-y-auto">
        <summary className="cursor-pointer font-semibold text-rb-700">라운지 이용 규칙</summary>
        <ul className="list-disc pl-4 mt-2 space-y-2 leading-5">
          <li>음대 학우들이 함께 보는 전체 채팅방이에요. 서로 존중하는 말로 대화해 주세요.</li>
          <li>욕설·비방·혐오 표현, 특정인을 괴롭히는 글은 올리지 마세요.</li>
          <li>본인과 타인의 학번·연락처·실명 등 개인정보를 공유하지 마세요.</li>
          <li>같은 내용의 도배, 광고·홍보와 사칭은 삼가 주세요.</li>
          <li>모든 작성자는 ‘익명’으로 표시돼요. 내 메시지는 나에게만 ‘익명 (나)’로 보여요. 메시지 내용은 라운지 이용자 모두에게 공개돼요.</li>
          <li>서비스 이용에는 로그인이 필요하며, 운영을 위해 메시지와 계정 연결 정보는 서버에 보관돼요.</li>
          <li>텍스트만 한 번에 500자까지 보낼 수 있어요. 대화는 최대 7일·최근 1,000개까지 보관하며 최근 100개를 보여드려요.</li>
        </ul>
        <p className="mt-3 leading-5">불편한 대화나 개선 의견은 <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer" className="font-semibold text-rb-700 underline underline-offset-2">운영자 문의 ↗</a>로 알려 주세요.</p>
      </details>
    </div>
    {error && <div role="alert" className="px-4 py-2 bg-rose-50 text-sm text-rose-800 shrink-0">{error}<button onClick={() => setRetry(v=>v+1)} className="ml-2 underline">다시 연결</button></div>}
    <div ref={scroller} role="log" aria-label="음대 라운지 대화" aria-live="polite" className="flex-1 overflow-y-auto px-4 py-5 space-y-4 bg-slate-50" onScroll={() => { const el = scroller.current; if (el) follow.current = el.scrollHeight-el.scrollTop-el.clientHeight < 120 }}>
      {connected && messages.length === 0 && <p className="text-sm text-gray-500 text-center py-10">첫 인사를 남겨 보세요. 🎵</p>}
      {messages.map(m => <article key={m.id} className={`flex flex-col ${m.mine ? 'items-end' : 'items-start'}`}>
        <p className="text-[11px] text-gray-500 mb-1">{m.mine ? '익명 (나)' : '익명'}</p>
        <p className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-sm leading-6 ${m.mine ? 'bg-rb-600 text-white rounded-tr-sm' : 'bg-white border border-gray-200 text-gray-800 rounded-tl-sm'}`}>{m.text}</p>
        <time className="mt-1 text-[10px] text-gray-500" dateTime={new Date(m.created_at*1000).toISOString()}>{new Date(m.created_at*1000).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hour12:false})}</time>
      </article>)}<div ref={bottom} />
    </div>
    <form onSubmit={e=>{e.preventDefault();send()}} className="border-t border-gray-200 bg-white px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+12px)] shrink-0">
      <div className="flex items-end gap-2"><textarea aria-label="메시지" placeholder="학우들에게 메시지를 남겨 보세요" value={draft} maxLength={500} disabled={sending} onChange={e=>setDraft(e.target.value)} rows={2} className="min-w-0 flex-1 resize-none rounded-xl border border-gray-300 p-3 text-sm focus:outline-rb-500" /><button type="submit" disabled={!connected || sending || !draft.trim()} className="h-12 rounded-xl bg-rb-600 text-white px-4 text-sm font-bold disabled:opacity-40">{sending ? '전송 중' : '보내기'}</button></div>
      <p className="mt-1.5 text-[11px] text-gray-500 text-right">{draft.length}/500 · 학번·연락처 등 개인정보는 올리지 마세요</p>
    </form>
  </div>
}
