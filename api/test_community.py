import asyncio
from datetime import datetime, timedelta
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

os.environ.setdefault('BOOKING_TOKEN_SECRET','community-test-secret-at-least-32-characters')
from fastapi import HTTPException
from fastapi.testclient import TestClient
import community as c
import main
from models import Room, Period, StatusResponse
from clock import KST

class CommunityTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        for module in (c, c.reservations):
            p=patch.object(module,'DB_PATH',Path(self.tmp.name)/(module.__name__+'.sqlite3'))
            p.start();self.addCleanup(p.stop)
        self.user={'uid':'user-a','firebase':{'sign_in_provider':'google.com'}}
        c.reservations.bind_student('user-a','student-a')
        p=patch.dict(main.app.dependency_overrides,{c.current_user:lambda:self.user})
        p.start();self.addCleanup(p.stop)
        self.client=TestClient(main.app)
        self.addCleanup(self.client.close)
        self.now=datetime(2026,9,8,13,0,tzinfo=KST)
        self.room=Room(name='음악관A 119호',corner_no=1,floor=1,occupied=True,occupied_until='13:20')
        self.free=self.room.model_copy(update={'occupied':False,'available_periods':[Period(start='13:10',end='22:00')]})
        self.state=self.snapshot(self.room)
        p=patch.object(c.collector,'get_state',lambda:self.state)
        p.start();self.addCleanup(p.stop)
        p=patch.object(c,'kst_now',lambda:self.now)
        p.start();self.addCleanup(p.stop)
        p=patch.object(c.time,'time',lambda:self.now.timestamp())
        p.start();self.addCleanup(p.stop)

    def snapshot(self,room):
        return StatusResponse(updated_at=self.now.isoformat(),total=1,occupied_count=int(room.occupied),available_count=int(not room.occupied),rooms=[room])

    def observe(self,room,seconds=10):
        self.now += timedelta(seconds=seconds)
        self.state=self.snapshot(room)
        c.collect_notices(self.state,[],self.now)

    def watches(self):
        self.assertEqual(self.client.post('/community/watches',json={'corner_no':1,'room_no':'119'}).status_code,200)

    def notices(self):
        with c.database() as conn:return [dict(r) for r in conn.execute('SELECT * FROM notices ORDER BY created')]

    def token(self,value='a'*40):
        return self.client.post('/community/notifications/devices',json={'token':value}).json()['device_id']

    def test_member_requires_google_and_binding(self):
        for user in ({'uid':'user-a'}, {'uid':'unbound','firebase':{'sign_in_provider':'google.com'}}):
            with self.assertRaises(HTTPException): c.member(user)

    def test_unauthenticated_http_cannot_read_messages(self):
        with patch.dict(main.app.dependency_overrides,{},clear=True):
            self.assertEqual(self.client.get('/community/lounge').status_code,401)

    def test_valid_member_can_read_empty_lounge(self):
        result=self.client.get('/community/lounge')
        self.assertEqual(result.status_code,200)
        self.assertEqual(result.json()['messages'],[])
        self.assertEqual(result.json()['nickname'],'익명')
        self.assertNotIn('user-a',result.text)

    def test_text_only_and_idempotent_chat(self):
        text='<script>alert(1)</script>'
        data=c.ChatMessage(client_id='abcdefghijklmnop',text=text)
        first,fresh=c.save_message('user-a',data)
        repeat,fresh2=c.save_message('user-a',data)
        self.assertTrue(fresh);self.assertFalse(fresh2)
        self.assertEqual(first['id'],repeat['id'])
        self.assertEqual(c.history('user-b')[0]['text'],text)
        self.assertFalse(c.history('user-b')[0]['mine'])
        self.assertTrue(c.history('user-a')[0]['mine'])
        self.assertNotIn('uid',c.history('user-a')[0])

    def test_different_authors_are_indistinguishable_in_history_and_live_payloads(self):
        first,_=c.save_message('user-a',c.ChatMessage(client_id='anonymous-first-1',text='first'))
        second,_=c.save_message('user-b',c.ChatMessage(client_id='anonymous-second',text='second'))
        for uid in ('user-a','user-b','other-viewer'):
            rows=c.history(uid)
            self.assertEqual([row['author'] for row in rows],['익명','익명'])
            self.assertEqual([row['mine'] for row in rows],[uid=='user-a',uid=='user-b'])
            for row in (first,second):
                payload=c.message_payload(row,uid)
                self.assertEqual(set(payload),{'id','author','text','created_at','mine'})
                self.assertEqual(payload['author'],'익명')
        result=self.client.get('/community/lounge').json()
        self.assertEqual(result['nickname'],'익명')
        self.assertEqual([m['author'] for m in result['messages']],['익명','익명'])

    def test_empty_control_and_oversized_chat_rejected(self):
        for text in ('   ','hello\x00'):
            with self.assertRaises(HTTPException):c.save_message('user-a',c.ChatMessage(client_id='abcdefghijklmnop',text=text))
        with self.assertRaises(ValueError):c.ChatMessage(client_id='abcdefghijklmnop',text='x'*501)

    def test_rate_limit_and_conflicting_retry(self):
        c.save_message('user-a',c.ChatMessage(client_id='abcdefghijklmnop',text='hi'))
        for ident,body,code in [('differentmessage','hi',429),('abcdefghijklmnop','changed',409)]:
            with self.assertRaises(HTTPException) as ctx:c.save_message('user-a',c.ChatMessage(client_id=ident,text=body))
            self.assertEqual(ctx.exception.status_code,code)

    def test_no_alert_on_initial_snapshot_or_existing_free_room(self):
        self.watches();self.observe(self.free);self.observe(self.free)
        self.assertEqual(self.notices(),[])

    def test_return_emits_once_and_new_occupancy_rearms(self):
        self.watches();self.observe(self.room);self.observe(self.free);self.observe(self.free)
        self.assertEqual(len(self.notices()),1)
        self.observe(self.room);self.observe(self.free)
        self.assertEqual(len(self.notices()),2)

    def test_baseline_survives_reopening_database(self):
        self.watches();self.observe(self.room)
        with c.database() as conn:self.assertEqual(conn.execute('SELECT count(*) FROM room_state').fetchone()[0],1)
        self.observe(self.free)
        self.assertEqual(len(self.notices()),1)

    def test_stale_missing_and_future_slots_do_not_emit(self):
        self.watches();self.observe(self.room)
        self.observe(self.free,seconds=121)
        self.assertEqual(self.notices(),[])
        self.observe(self.room)
        self.observe(self.free.model_copy(update={'available_periods':[Period(start='20:00',end='22:00')]}))
        self.assertEqual(self.notices(),[])

    def test_opt_out_or_unwatch_suppresses_new_event(self):
        self.watches();self.observe(self.room)
        self.client.put('/community/notifications/settings',json={'room_alerts':False})
        self.observe(self.free)
        self.assertEqual(self.notices(),[])
        self.client.put('/community/notifications/settings',json={'room_alerts':True})
        self.client.delete('/community/watches/1:119')
        self.observe(self.room);self.observe(self.free)
        self.assertEqual(self.notices(),[])

    def test_device_reassigned_to_current_account_and_owner_checked(self):
        key=self.token()
        self.user={'uid':'user-b','firebase':{'sign_in_provider':'google.com'}}
        c.reservations.bind_student('user-b','student-b')
        self.assertEqual(self.token(),key)
        self.user={'uid':'user-a','firebase':{'sign_in_provider':'google.com'}}
        self.client.delete('/community/notifications/devices/'+key)
        with c.database() as conn:self.assertEqual(conn.execute('SELECT uid FROM devices').fetchone()[0],'user-b')

    def test_successful_push_not_resent(self):
        self.token();self.watches();self.observe(self.room);self.observe(self.free)
        with patch.object(c,'send_push') as send:
            c.deliver_pending(self.state,self.now);c.deliver_pending(self.state,self.now)
            send.assert_called_once()
        self.assertEqual(self.notices()[0]['status'],'sent')

    def test_failed_push_retries_without_resending_successful_device(self):
        self.token('a'*40);self.token('b'*40);self.watches();self.observe(self.room);self.observe(self.free)
        with patch.object(c,'send_push',side_effect=[None,RuntimeError('offline')]) as send:c.deliver_pending(self.state,self.now)
        self.assertEqual(self.notices()[0]['status'],'pending')
        self.now+=timedelta(seconds=6)
        with patch.object(c,'send_push') as send:
            c.deliver_pending(self.state,self.now)
            send.assert_called_once()
            self.assertEqual(send.call_args.args[0],'b'*40)
        self.assertEqual(self.notices()[0]['status'],'sent')

    def test_rebooked_room_cancels_queued_push(self):
        self.token();self.watches();self.observe(self.room);self.observe(self.free);self.observe(self.room)
        with patch.object(c,'send_push') as send:c.deliver_pending(self.state,self.now);send.assert_not_called()
        self.assertEqual(self.notices()[0]['status'],'skipped')

    def test_unregister_prevents_queued_push(self):
        key=self.token();self.watches();self.observe(self.room);self.observe(self.free)
        self.client.delete('/community/notifications/devices/'+key)
        with patch.object(c,'send_push') as send:c.deliver_pending(self.state,self.now);send.assert_not_called()
        self.assertEqual(self.notices()[0]['status'],'no_device')

    def test_invalid_token_is_pruned(self):
        self.token();self.watches();self.observe(self.room);self.observe(self.free)
        with patch.object(c,'send_push',side_effect=c.messaging.UnregisteredError('gone')):c.deliver_pending(self.state,self.now)
        with c.database() as conn:self.assertEqual(conn.execute('SELECT count(*) FROM devices').fetchone()[0],0)

    def test_test_notification_requires_device_and_limits_frequency(self):
        self.assertEqual(self.client.post('/community/notifications/test',json={'device_id':'0'*64}).status_code,409)
        key=self.token()
        self.assertEqual(self.client.post('/community/notifications/test',json={'device_id':key}).status_code,200)
        self.assertEqual(self.client.post('/community/notifications/test',json={'device_id':key}).status_code,429)

    def test_tag_and_return_reminders_use_actual_reservation(self):
        c.reservations.acquire(id='res',uid='user-a',student_id='2026000001',student_key='student-a',corner_no=1,room_no='119')
        record=c.reservations.finalize('res',start_at=self.now-timedelta(minutes=5),duration_min=120,kiosk_booking_no='777')
        c.collect_notices(self.state,[record],self.now)
        c.collect_notices(self.state,[record],self.now)
        self.assertEqual(len(self.notices()),1)
        c.reservations.set_status(record.id,'cancelled')
        with patch.object(c,'send_push') as send:c.deliver_pending(self.state,self.now);send.assert_not_called()
        self.assertEqual(self.notices()[0]['status'],'skipped')

    def test_watch_requires_real_room(self):
        self.assertEqual(self.client.post('/community/watches',json={'corner_no':99,'room_no':'999'}).status_code,422)

    def test_websocket_auth_and_broadcast(self):
        with patch.object(c,'current_user',return_value=self.user), patch.dict(os.environ,{'ALLOWED_ORIGINS':'https://app.test'}):
            with self.client.websocket_connect('/community/lounge/ws',headers={'origin':'https://app.test'}) as ws:
                ws.send_json({'token':'test-token'})
                self.assertEqual(ws.receive_json()['type'],'history')
                ws.send_json({'client_id':'abcdefghijklmnop','text':'연습 잘 되고 있나요?'})
                message=ws.receive_json()
                self.assertEqual(message['type'],'message')
                self.assertTrue(message['message']['mine'])
                self.assertEqual(message['message']['author'],'익명')
                self.assertEqual(ws.receive_json()['type'],'ack')
        self.assertEqual(c.clients,{})

    def test_websocket_rejects_wrong_origin(self):
        from starlette.websockets import WebSocketDisconnect
        with self.assertRaises(WebSocketDisconnect):
            with self.client.websocket_connect('/community/lounge/ws',headers={'origin':'https://evil.test'}):pass

if __name__=='__main__': unittest.main()
