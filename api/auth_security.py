"""Firebase 로그인 검증과 반납 권한 토큰."""
import base64
import hashlib
import hmac
import json
import os
import secrets
import time

import firebase_admin
from fastapi import Header, HTTPException
from firebase_admin import auth, credentials


def _firebase_app():
    try:
        return firebase_admin.get_app()
    except ValueError:
        raw_key = os.getenv("FIREBASE_SERVICE_ACCOUNT_KEY")
        if raw_key:
            return firebase_admin.initialize_app(credentials.Certificate(json.loads(raw_key)))
        return firebase_admin.initialize_app()


def current_user(authorization: str | None = Header(default=None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Google 로그인이 필요합니다.")
    try:
        decoded = auth.verify_id_token(authorization[7:], app=_firebase_app())
    except Exception as exc:
        raise HTTPException(401, "로그인이 만료되었거나 유효하지 않습니다.") from exc
    if not decoded.get("uid"):
        raise HTTPException(401, "유효하지 않은 사용자입니다.")
    return decoded


def _secret() -> bytes:
    value = os.getenv("BOOKING_TOKEN_SECRET", "")
    if len(value) < 32:
        raise HTTPException(503, "BOOKING_TOKEN_SECRET 설정이 필요합니다.")
    return value.encode()


def _student_digest(student_id: str) -> str:
    return hmac.new(_secret(), student_id.encode(), hashlib.sha256).hexdigest()


def issue_return_token(uid: str, student_id: str, corner_no: int, room_no: str) -> str:
    payload = {
        "uid": uid,
        "student": _student_digest(student_id),
        "corner": corner_no,
        "room": room_no,
        "exp": int(time.time()) + 4 * 60 * 60,
        "nonce": secrets.token_urlsafe(12),
    }
    encoded = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    ).rstrip(b"=")
    signature = hmac.new(_secret(), encoded, hashlib.sha256).digest()
    return f"{encoded.decode()}.{base64.urlsafe_b64encode(signature).rstrip(b'=').decode()}"


def verify_return_token(token: str, uid: str, student_id: str, corner_no: int) -> dict:
    try:
        encoded_text, signature_text = token.split(".", 1)
        encoded = encoded_text.encode()
        supplied = base64.urlsafe_b64decode(signature_text + "=" * (-len(signature_text) % 4))
        expected = hmac.new(_secret(), encoded, hashlib.sha256).digest()
        if not hmac.compare_digest(supplied, expected):
            raise ValueError("signature")
        raw = base64.urlsafe_b64decode(encoded_text + "=" * (-len(encoded_text) % 4))
        payload = json.loads(raw)
        valid = (
            payload.get("uid") == uid
            and payload.get("corner") == corner_no
            and hmac.compare_digest(payload.get("student", ""), _student_digest(student_id))
            and int(payload.get("exp", 0)) >= int(time.time())
        )
        if not valid:
            raise ValueError("claims")
        return payload
    except (ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
        raise HTTPException(403, "이 예약을 반납할 권한이 없습니다.") from exc
