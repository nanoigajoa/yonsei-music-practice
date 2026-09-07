'use client'

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { communityRequest } from '@/lib/community'

export interface LoungeMessage { id: number; text: string; created_at: number; mine: boolean }
interface Page { messages: LoungeMessage[]; has_more?: boolean }
interface View { messages: LoungeMessage[]; hasOlder: boolean; hasNewer: boolean }
const WINDOW_SIZE = 500
function unique(messages: LoungeMessage[]) { return [...new Map(messages.map(m => [m.id,m])).values()].sort((a,b) => a.id-b.id) }

export function useLoungeHistory(scrollerRef: RefObject<HTMLDivElement | null>, followRef: RefObject<boolean>) {
  const [view, setView] = useState<View>({messages:[],hasOlder:false,hasNewer:false})
  const current = useRef(view)
  const recentLive = useRef<LoungeMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const generation = useRef(0)
  const anchor = useRef<{id:string;top:number} | null>(null)
  useEffect(() => () => { generation.current++ }, [])
  function update(next: View) { current.current = next; setView(next) }
  function preserve() {
    const el = scrollerRef.current
    if (!el) return
    const top = el.getBoundingClientRect().top
    const first = [...el.querySelectorAll<HTMLElement>('[data-message-id]')].find(node => node.getBoundingClientRect().bottom > top)
    if (first) anchor.current = {id:first.dataset.messageId!,top:first.getBoundingClientRect().top}
  }
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    if (anchor.current) {
      const node = el.querySelector<HTMLElement>(`[data-message-id="${anchor.current.id}"]`)
      if (node) el.scrollTop += node.getBoundingClientRect().top-anchor.current.top
      anchor.current = null
    } else if (followRef.current) el.scrollTop = el.scrollHeight
  }, [view.messages, scrollerRef, followRef])

  function latestView(page: Page): View {
    const last = page.messages.at(-1)?.id ?? 0
    const tail = recentLive.current.filter(m => m.id > last)
    // If many live messages arrived while HTTP was delayed, use the contiguous
    // live tail; older messages remain reachable by the before cursor.
    const skipped = tail.length > 0 && last > 0 && tail[0].id > last+1
    const messages = skipped ? tail : unique([...page.messages,...tail])
    return {messages:messages.slice(-WINDOW_SIZE),hasOlder:skipped || messages.length > WINDOW_SIZE || (page.has_more ?? page.messages.length >= 100),hasNewer:false}
  }
  function receiveHistory(page: Page) {
    generation.current++; inFlight.current = false; setLoading(false); setError('')
    if (!current.current.messages.length || followRef.current) {
      update(latestView(page))
    } else {
      const last = page.messages.at(-1)?.id ?? 0
      update({...current.current,hasNewer:current.current.hasNewer || last > (current.current.messages.at(-1)?.id ?? 0)})
    }
  }
  function receiveMessage(message: LoungeMessage) {
    recentLive.current = unique([...recentLive.current,message]).slice(-100)
    const old = current.current
    if (old.messages.some(m => m.id === message.id)) return
    if (old.hasNewer) return
    if (!followRef.current && old.messages.length >= WINDOW_SIZE) {
      update({...old,hasNewer:true}); return
    }
    if (!followRef.current) preserve()
    const messages = unique([...old.messages,message])
    update({...old,messages:messages.slice(-WINDOW_SIZE),hasOlder:old.hasOlder || messages.length > WINDOW_SIZE})
  }
  async function older() {
    const before = current.current.messages[0]?.id
    if (!before || !current.current.hasOlder || inFlight.current) return
    const version = generation.current
    inFlight.current = true; setLoading(true); setError('')
    try {
      const page = await communityRequest<Page>(`/lounge?before=${before}&limit=50`)
      if (version !== generation.current) return
      if (page.messages.some(m => m.id >= before)) throw new Error('unsupported cursor')
      preserve(); followRef.current = false
      const all = unique([...page.messages,...current.current.messages])
      update({messages:all.slice(0,WINDOW_SIZE),hasOlder:page.has_more ?? page.messages.length === 50,
        hasNewer:current.current.hasNewer || all.length > WINDOW_SIZE})
    } catch { if (version === generation.current) setError('이전 대화를 불러오지 못했어요. 다시 시도해 주세요.') }
    finally { if (version === generation.current) {inFlight.current = false; setLoading(false)} }
  }
  async function latest() {
    if (inFlight.current) return false
    const version = generation.current
    inFlight.current = true; setLoading(true); setError('')
    try {
      const page = await communityRequest<Page>('/lounge?limit=100')
      if (version !== generation.current) return false
      anchor.current = null; followRef.current = true
      update(latestView(page))
      return true
    } catch { if (version === generation.current) setError('최신 대화를 불러오지 못했어요. 다시 시도해 주세요.'); return false }
    finally { if (version === generation.current) {inFlight.current = false; setLoading(false)} }
  }
  return {...view,loading,error,older,latest,receiveHistory,receiveMessage}
}
