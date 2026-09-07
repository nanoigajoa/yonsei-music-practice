"""Text lounge and opt-in notifications; separate SQLite DB, no school requests."""
from __future__ import annotations
import asyncio
from contextlib import contextmanager
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from firebase_admin import messaging

import collector
import reservations
from auth_security import current_user, _firebase_app, student_key
from clock import now as kst_now, parse as parse_kst

log = logging.getLogger(__name__)
router = APIRouter(prefix="/community")
DB_PATH = Path(os.getenv("COMMUNITY_DB_PATH", str(reservations.DB_PATH.with_name("community.sqlite3"))))
DEFAULT_SETTINGS = {"room_alerts": True, "tag_reminders": True, "return_reminders": True}
clients: dict[WebSocket, tuple[str, asyncio.Queue]] = {}

@contextmanager
def database():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=3)
    DB_PATH.chmod(0o600)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript('''
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL, client_id TEXT NOT NULL, text TEXT NOT NULL, created REAL NOT NULL, UNIQUE(uid,client_id));
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, uid TEXT NOT NULL, token TEXT NOT NULL, updated REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS preferences (uid TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS watches (uid TEXT NOT NULL, room_key TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(uid,room_key));
      CREATE TABLE IF NOT EXISTS room_state (room_key TEXT PRIMARY KEY, occupied INTEGER NOT NULL, available INTEGER NOT NULL, observed REAL NOT NULL, generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notices (id TEXT PRIMARY KEY, uid TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, url TEXT NOT NULL, created REAL NOT NULL, expires REAL NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_try REAL NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS deliveries (notice_id TEXT NOT NULL, device_id TEXT NOT NULL, PRIMARY KEY(notice_id,device_id));
      CREATE INDEX IF NOT EXISTS notice_owner ON notices(uid,created);
      CREATE INDEX IF NOT EXISTS device_owner ON devices(uid);
    ''')
    try:
        yield conn
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def member(user: dict = Depends(current_user)) -> dict:
    if user.get("firebase", {}).get("sign_in_provider") != "google.com":
        raise HTTPException(403, "Google 로그인이 필요합니다.")
    if not reservations.binding_for_uid(user["uid"]):
        raise HTTPException(403, "학번 등록을 먼저 완료해 주세요.")
    return user


def alias(uid: str) -> str:
    # Stable application alias; never expose a Google name, email, student ID or UID.
    return "음대생 " + student_key("lounge:" + uid)[:6]


def message_payload(row, uid: str | None = None):
    return {"id": row["id"], "author": alias(row["uid"]), "text": row["text"],
            "created_at": row["created"], "mine": row["uid"] == uid}


def history(uid: str):
    with database() as conn:
        rows = conn.execute("SELECT * FROM messages WHERE created>? ORDER BY id DESC LIMIT 100", (time.time()-7*86400,)).fetchall()
    return [message_payload(r, uid) for r in reversed(rows)]


class ChatMessage(BaseModel):
    client_id: str = Field(min_length=16, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    text: str = Field(min_length=1, max_length=500)


def save_message(uid: str, data: ChatMessage):
    body = data.text.strip()
    if not body or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", body):
        raise HTTPException(422, "1~500자의 텍스트를 입력해 주세요.")
    now = time.time()
    with database() as conn:
        conn.execute("BEGIN IMMEDIATE")
        old = conn.execute("SELECT * FROM messages WHERE uid=? AND client_id=?", (uid, data.client_id)).fetchone()
        if old:
            if old["text"] != body:
                raise HTTPException(409, "메시지 번호가 중복되었습니다.")
            return dict(old), False
        latest = conn.execute("SELECT created FROM messages WHERE uid=? ORDER BY id DESC LIMIT 1", (uid,)).fetchone()
        if latest and now-latest["created"] < 2:
            raise HTTPException(429, "잠시 후 보내 주세요. 메시지는 2초에 한 번 보낼 수 있습니다.")
        cursor = conn.execute("INSERT INTO messages(uid,client_id,text,created) VALUES(?,?,?,?)", (uid,data.client_id,body,now))
        row = dict(conn.execute("SELECT * FROM messages WHERE id=?", (cursor.lastrowid,)).fetchone())
        conn.execute("DELETE FROM messages WHERE created<? OR id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 1000)", (now-7*86400,))
    return row, True


@router.get("/lounge")
def lounge(user: dict = Depends(member)):
    return {"messages": history(user["uid"]), "nickname": alias(user["uid"])}


@router.websocket("/lounge/ws")
async def lounge_socket(ws: WebSocket):
    allowed = {s.strip() for s in os.getenv("ALLOWED_ORIGINS", "http://localhost:3000").split(",")}
    if ws.headers.get("origin") not in allowed:
        await ws.close(code=1008)
        return
    await ws.accept()
    send_task = None
    try:
        first = await asyncio.wait_for(ws.receive_text(), timeout=10)
        if len(first) > 12000:
            await ws.close(code=1008)
            return
        auth_data = json.loads(first)
        user = await asyncio.to_thread(current_user, "Bearer " + str(auth_data.get("token", "")))
        await asyncio.to_thread(member, user)
        uid = user["uid"]
        if len(clients) >= 200 or sum(owner == uid for owner, _ in clients.values()) >= 3:
            await ws.close(code=1013)
            return
        queue: asyncio.Queue = asyncio.Queue(maxsize=32)
        clients[ws] = (uid, queue)
        async def sender():
            while True:
                await asyncio.wait_for(ws.send_json(await queue.get()), timeout=10)
        queue.put_nowait({"type": "history", "messages": await asyncio.to_thread(history, uid), "nickname": alias(uid)})
        send_task = asyncio.create_task(sender())
        expires = time.monotonic() + 50*60
        while time.monotonic() < expires:
            receive_task = asyncio.create_task(ws.receive_text())
            done, _ = await asyncio.wait([receive_task, send_task], timeout=min(60, expires-time.monotonic()), return_when=asyncio.FIRST_COMPLETED)
            if send_task in done:
                receive_task.cancel()
                await asyncio.gather(receive_task, return_exceptions=True)
                break
            if receive_task not in done:
                receive_task.cancel()
                await asyncio.gather(receive_task, return_exceptions=True)
                queue.put_nowait({"type": "ping"})
                continue
            raw = receive_task.result()
            if len(raw) > 5000:
                await ws.close(code=1009)
                return
            payload = json.loads(raw)
            if payload.get("type") == "pong":
                continue
            try:
                data = ChatMessage.model_validate(payload)
                row, fresh = await asyncio.to_thread(save_message, uid, data)
                # Broadcast only once; sender acknowledgements allow retry with the same client_id.
                if fresh:
                    for socket, (owner, out) in list(clients.items()):
                        if out.full():
                            await socket.close(code=1013)
                            clients.pop(socket, None)
                        else:
                            out.put_nowait({"type": "message", "message": message_payload(row, owner)})
                queue.put_nowait({"type": "ack", "client_id": data.client_id})
            except (HTTPException, ValueError) as exc:
                queue.put_nowait({"type": "error", "message": exc.detail if isinstance(exc, HTTPException) else "메시지 형식을 확인해 주세요."})
        await ws.close(code=1000)
    except (WebSocketDisconnect, RuntimeError, asyncio.TimeoutError, ValueError, HTTPException, asyncio.QueueFull):
        try:
            await ws.close(code=1008)
        except RuntimeError:
            pass
    finally:
        clients.pop(ws, None)
        if send_task:
            send_task.cancel()
            await asyncio.gather(send_task, return_exceptions=True)


class Settings(BaseModel):
    room_alerts: bool = True
    tag_reminders: bool = True
    return_reminders: bool = True


class Device(BaseModel):
    token: str = Field(min_length=20, max_length=4096)


def device_id(token: str):
    return hashlib.sha256(token.encode()).hexdigest()


def preferences(conn, uid):
    row = conn.execute("SELECT value FROM preferences WHERE uid=?", (uid,)).fetchone()
    return {**DEFAULT_SETTINGS, **(json.loads(row[0]) if row else {})}


@router.get("/notifications")
def notification_state(user: dict = Depends(member)):
    with database() as conn:
        return {"settings": preferences(conn, user["uid"]),
                "devices": [r[0] for r in conn.execute("SELECT id FROM devices WHERE uid=?", (user["uid"],))],
                "watches": [dict(r) for r in conn.execute("SELECT room_key,name FROM watches WHERE uid=?", (user["uid"],))],
                "history": [dict(r) for r in conn.execute("SELECT id,title,body,url,created,status FROM notices WHERE uid=? ORDER BY created DESC LIMIT 30", (user["uid"],))]}


@router.put("/notifications/settings")
def save_settings(data: Settings, user: dict = Depends(member)):
    with database() as conn:
        conn.execute("INSERT OR REPLACE INTO preferences VALUES(?,?)", (user["uid"], json.dumps(data.model_dump())))
    return {"success": True}


@router.post("/notifications/devices")
def register_device(data: Device, user: dict = Depends(member)):
    uid, key = user["uid"], device_id(data.token)
    with database() as conn:
        conn.execute("BEGIN IMMEDIATE")
        if conn.execute("SELECT count(*) FROM devices WHERE uid=? AND id!=?", (uid,key)).fetchone()[0] >= 5:
            raise HTTPException(409, "등록된 기기가 5개입니다. 알림을 끌 기기에서 먼저 해제해 주세요.")
        conn.execute("INSERT OR REPLACE INTO devices VALUES(?,?,?,?)", (key,uid,data.token,time.time()))
    return {"success": True, "device_id": key}


@router.delete("/notifications/devices/{key}")
def remove_device(key: str, user: dict = Depends(member)):
    with database() as conn:
        conn.execute("DELETE FROM devices WHERE uid=? AND id=?", (user["uid"],key))
    return {"success": True}


class Watch(BaseModel):
    corner_no: int
    room_no: str = Field(pattern=r"^\d{3}$")


def room_key(room):
    match = re.search(r"(\d{3})호", room.name)
    return f"{room.corner_no}:{match[1]}" if match else ""


@router.post("/watches")
def add_watch(data: Watch, user: dict = Depends(member)):
    state = collector.get_state()
    key = f"{data.corner_no}:{data.room_no}"
    room = next((r for r in state.rooms if room_key(r)==key), None) if state else None
    if room is None:
        raise HTTPException(422, "현황에서 확인할 수 없는 방입니다. 잠시 뒤 다시 시도해 주세요.")
    with database() as conn:
        conn.execute("BEGIN IMMEDIATE")
        if conn.execute("SELECT count(*) FROM watches WHERE uid=?", (user["uid"],)).fetchone()[0] >= 49:
            raise HTTPException(409, "찜할 수 있는 방 수를 초과했습니다.")
        conn.execute("INSERT OR IGNORE INTO watches VALUES(?,?,?)", (user["uid"],key,room.name))
    return {"success": True}


@router.delete("/watches/{key}")
def delete_watch(key: str, user: dict = Depends(member)):
    with database() as conn:
        conn.execute("DELETE FROM watches WHERE uid=? AND room_key=?", (user["uid"],key))
    return {"success": True}


def enqueue(conn, uid, key, kind, subject, title, body, url, now, expires):
    conn.execute("INSERT OR IGNORE INTO notices(id,uid,kind,subject,title,body,url,created,expires) VALUES(?,?,?,?,?,?,?,?,?)",
                 (hashlib.sha256(f"{uid}:{key}".encode()).hexdigest(),uid,kind,subject,title,body,url,now,expires))


def available(room, at):
    if room.occupied or room.reservation_state in {"pending_tag", "uncertain"}:
        return False
    next_slot = (at.hour*60+at.minute)//10*10+10
    for period in room.available_periods:
        try:
            sh,sm = map(int, period.start.split(":")); eh,em = map(int, period.end.split(":"))
            if sh*60+sm <= next_slot < eh*60+em or (period.end=="22:00" and next_slot==22*60 and sh*60+sm<next_slot):
                return True
        except ValueError:
            continue
    return False


def collect_notices(state, records, now):
    timestamp = now.timestamp()
    with database() as conn:
        conn.execute("BEGIN IMMEDIATE")
        if state:
            observed = parse_kst(state.updated_at).timestamp()
            if 0 <= timestamp-observed <= 120:
                for room in state.rooms:
                    key = room_key(room)
                    if not key:
                        continue
                    prior = conn.execute("SELECT * FROM room_state WHERE room_key=?", (key,)).fetchone()
                    if prior and observed <= prior["observed"]:
                        continue
                    free = available(room, now)
                    generation = (prior["generation"] if prior else 0) + int(bool(room.occupied and (not prior or not prior["occupied"])))
                    # Baseline/unknown/old observations never pretend a return happened.
                    if prior and prior["occupied"] and free and observed-prior["observed"] <= 120:
                        for watcher in conn.execute("SELECT uid FROM watches WHERE room_key=?", (key,)).fetchall():
                            uid = watcher["uid"]
                            if preferences(conn,uid)["room_alerts"]:
                                enqueue(conn,uid,f"room:{key}:{generation}","room_alerts",key, f"{room.name} 공실 알림", "찜한 방이 공실로 바뀌었어요. 현재 예약 가능 여부를 확인해 주세요.", f"/?room={key}",timestamp,timestamp+120)
                    conn.execute("INSERT OR REPLACE INTO room_state VALUES(?,?,?,?,?)", (key,int(room.occupied),int(free),observed,generation))
        for record in records:
            uid = record.uid
            prefs = preferences(conn,uid)
            if record.status == "pending_tag" and prefs["tag_reminders"]:
                remaining = (record.tag_deadline-now).total_seconds()
                if record.start_at <= now and 0 < remaining <= 300:
                    stage = 2 if remaining <= 120 else 5
                    enqueue(conn,uid,f"tag:{record.id}:{stage}","tag_reminders",record.id, f"{record.room_no}호 학생증 태그", f"태그 마감 {stage}분 이내입니다. 방 앞 단말기에서 학생증을 태그해 주세요.", "/",timestamp,min(timestamp+90, record.tag_deadline.timestamp()))
            if record.status == "active" and prefs["return_reminders"]:
                remaining = (record.end_at-now).total_seconds()
                if 0 < remaining <= 600:
                    enqueue(conn,uid,f"return:{record.id}","return_reminders",record.id,f"{record.room_no}호 이용 종료 알림", "이용 종료까지 10분 이내입니다. 반납 시간을 확인해 주세요.","/",timestamp,min(timestamp+120,record.end_at.timestamp()))
        conn.execute("DELETE FROM notices WHERE created<?", (timestamp-7*86400,))
        conn.execute("DELETE FROM deliveries WHERE notice_id NOT IN (SELECT id FROM notices)")
        conn.execute("DELETE FROM messages WHERE created<?", (timestamp-7*86400,))
        conn.execute("DELETE FROM devices WHERE updated<?", (timestamp-60*86400,))


def still_relevant(conn, notice, state, now):
    if notice["expires"] <= now.timestamp():
        return False
    if notice["kind"] == "test":
        return True
    if not preferences(conn,notice["uid"])[notice["kind"]]:
        return False
    if notice["kind"] == "room_alerts":
        watched = conn.execute("SELECT 1 FROM watches WHERE uid=? AND room_key=?", (notice["uid"],notice["subject"])).fetchone()
        if not watched or not state or not 0 <= now.timestamp()-parse_kst(state.updated_at).timestamp() <= 120:
            return False
        return any(room_key(r)==notice["subject"] and available(r,now) for r in state.rooms)
    record = reservations.get(notice["subject"])
    if not record:
        return False
    return (record.status=="pending_tag" and now<record.tag_deadline) if notice["kind"]=="tag_reminders" else (record.status=="active" and now<record.end_at)


def send_push(token, notice):
    return messaging.send(messaging.Message(token=token, data={
        "title": notice["title"], "body": notice["body"], "url": notice["url"], "notification_id": notice["id"],
    }, webpush=messaging.WebpushConfig(headers={"TTL":"120", "Urgency":"high"})), app=_firebase_app())


def deliver_pending(state, now):
    # Runs on a worker thread. Network work never holds the SQLite write lock.
    with database() as conn:
        notices = [dict(r) for r in conn.execute("SELECT * FROM notices WHERE status='pending' AND next_try<=? ORDER BY created LIMIT 100", (now.timestamp(),))]
    for notice in notices:
        with database() as conn:
            if not still_relevant(conn,notice,state,now):
                conn.execute("UPDATE notices SET status='skipped' WHERE id=?", (notice["id"],))
                continue
            devices = [dict(r) for r in conn.execute("SELECT * FROM devices WHERE uid=?", (notice["uid"],))]
            if notice["kind"] == "test":
                devices = [d for d in devices if d["id"] == notice["subject"]]
        failed, sent = False, 0
        for device in devices:
            with database() as conn:
                if conn.execute("SELECT 1 FROM deliveries WHERE notice_id=? AND device_id=?", (notice["id"],device["id"])).fetchone():
                    sent += 1
                    continue
                # Recheck opt-out and ownership directly before each send.
                if not conn.execute("SELECT 1 FROM devices WHERE id=? AND uid=?", (device["id"],notice["uid"])).fetchone() or not still_relevant(conn,notice,collector.get_state() or state,kst_now()):
                    continue
            try:
                send_push(device["token"],notice)
                with database() as conn:
                    conn.execute("INSERT OR IGNORE INTO deliveries VALUES(?,?)", (notice["id"],device["id"]))
                sent += 1
            except messaging.UnregisteredError:
                with database() as conn:
                    conn.execute("DELETE FROM devices WHERE id=?", (device["id"],))
            except Exception:
                failed = True
                log.warning("Push delivery failed; will retry (no token logged)")
        status = "pending" if failed else ("sent" if sent else "no_device")
        with database() as conn:
            conn.execute("UPDATE notices SET status=?, attempts=attempts+1, next_try=? WHERE id=?", (status, now.timestamp()+min(60, 5*2**min(notice["attempts"],4)),notice["id"]))


class TestDevice(BaseModel):
    device_id: str = Field(pattern=r"^[0-9a-f]{64}$")


@router.post("/notifications/test")
def test_notification(data: TestDevice, user: dict = Depends(member)):
    now = time.time()
    with database() as conn:
        conn.execute("BEGIN IMMEDIATE")
        if not conn.execute("SELECT 1 FROM devices WHERE uid=? AND id=?", (user["uid"],data.device_id)).fetchone():
            raise HTTPException(409, "이 기기에서 알림을 먼저 켜 주세요.")
        if conn.execute("SELECT 1 FROM notices WHERE uid=? AND kind='test' AND created>?", (user["uid"],now-30)).fetchone():
            raise HTTPException(429, "테스트 알림은 30초 후 다시 보낼 수 있습니다.")
        enqueue(conn,user["uid"],secrets.token_hex(12),"test",data.device_id,"테스트 알림이 도착했어요", "찜한 방 공실·태그·반납 알림을 이 기기에서 받을 수 있습니다.","/alarm",now,now+120)
    return {"success": True, "message": "테스트 알림을 요청했습니다. 기기에 도착하는지 확인해 주세요."}


async def notification_loop():
    while True:
        try:
            state = collector.get_state()
            records = await asyncio.to_thread(reservations.open_reservations)
            now = kst_now()
            await asyncio.to_thread(collect_notices,state,records,now)
            await asyncio.to_thread(deliver_pending,state,now)
        except Exception:
            log.exception("Notification worker failed")
        await asyncio.sleep(2)
