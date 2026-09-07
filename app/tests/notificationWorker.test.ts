import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
const code = readFileSync(new URL('../public/firebase-messaging-sw.js', import.meta.url), 'utf8')
function worker() {
  const handlers: Record<string, (event: any) => void> = {}
  const notifications: any[] = []
  const opened: string[] = []
  const received: unknown[] = []
  const clients = { matchAll: async () => [{url:'https://app.test/',postMessage:(v:unknown)=>received.push(v), navigate:async(v:string)=>opened.push(v),focus:async()=>null}],openWindow:async(v:string)=>opened.push(v),claim:async()=>null }
  const self = { location:{origin:'https://app.test'},clients, registration:{showNotification:async(title:string, options:unknown)=>notifications.push({title,options})},skipWaiting:()=>null,addEventListener:(name:string,handler:(event:any)=>void)=>{handlers[name]=handler} }
  runInNewContext(code,{self,URL})
  return {handlers,notifications,opened,received}
}
test('데이터 푸시는 한 번 표시하고 열린 앱에 도착을 알린다',async()=>{
  const w=worker();let wait:Promise<unknown> = Promise.resolve()
  w.handlers.push({data:{json:()=>({data:{title:'119호 공실',body:'방을 확인해 주세요',url:'/?room=1:119',notification_id:'event-1'}})},waitUntil:(p:Promise<unknown>)=>{wait=p}})
  await wait
  assert.equal(w.notifications.length,1)
  assert.equal(w.notifications[0].options.tag,'event-1')
  assert.equal(w.notifications[0].options.data.url,'https://app.test/?room=1:119')
  assert.equal(w.received.length,1)
})
test('알림의 외부 링크는 같은 사이트의 알림 화면으로 제한한다',async()=>{
  const w=worker();let wait:Promise<unknown> = Promise.resolve()
  w.handlers.push({data:{json:()=>({data:{url:'https://evil.test/'}})},waitUntil:(p:Promise<unknown>)=>{wait=p}})
  await wait
  assert.equal(w.notifications[0].options.data.url,'https://app.test/alarm')
})
test('알림 클릭은 기존 창에서 해당 방 화면을 연다',async()=>{
  const w=worker();let wait:Promise<unknown> = Promise.resolve()
  w.handlers.notificationclick({notification:{close:()=>null,data:{url:'https://app.test/?room=1:119'}},waitUntil:(p:Promise<unknown>)=>{wait=p}})
  await wait
  assert.deepEqual(w.opened,['https://app.test/?room=1:119'])
})
test('깨진 푸시 본문은 알림으로 표시하지 않는다',()=>{
  const w=worker()
  w.handlers.push({data:{json:()=>{throw Error('invalid')}}})
  assert.equal(w.notifications.length,0)
})
