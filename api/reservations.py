"""예약 선점과 상태 전이를 단일 SQLite 트랜잭션으로 관리한다.

키오스크 요청은 느리고 재시도될 수 있다. 그러므로 외부 요청 전에 `creating`
행을 먼저 만들며, 같은 학번 또는 같은 방의 열린 예약은 하나만 허용한다.
"""
from __future__ import annotations

import sqlite3
import os
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from clock import now as kst_now, normalize as kst_normalize, parse as parse_kst

# 로컬은 프로젝트 내부의 .data를 쓰고, Fly 배포는 영속 볼륨(/data)을 지정한다.
# 컨테이너 파일시스템 기본 영역은 재시작/배포 때 초기화되므로 배포 환경에서는
# 반드시 RESERVATIONS_DB_PATH=/data/reservations.sqlite3으로 설정한다.
DB_PATH = Path(os.getenv("RESERVATIONS_DB_PATH", str(Path(__file__).parent / ".data" / "reservations.sqlite3")))
OPEN_STATUSES = ("creating", "pending_tag", "active")
# `creating`은 외부 키오스크 요청을 보내는 아주 짧은 구간이다. 프로세스가
# 요청 도중 죽었을 때 이 행이 영구적으로 학생/방을 잠그지 않도록 한다.
# 키오스크 한 번의 요청은 HTTP timeout(10초) 여러 번을 포함할 수 있어, 일반적인
# 네트워크 지연보다 충분히 긴 2분을 기본값으로 잡는다.
CREATING_TTL = timedelta(seconds=max(30, int(os.getenv("RESERVATION_CREATING_TTL_SECONDS", "120"))))
# 태그 마감 직전에 실제 단말기 태그가 이루어진 경우 중앙 키오스크 반영이 조금
# 늦을 수 있다. 이 구간에는 앱의 선점을 유지해 다른 사용자에게 먼저 보이지
# 않도록 한다. 키오스크가 미태그를 취소하면 grace 종료 뒤 정상 해제된다.
PENDING_TAG_GRACE = timedelta(seconds=max(0, int(os.getenv("PENDING_TAG_GRACE_SECONDS", "20"))))


class ReservationConflict(ValueError):
    """같은 학번 또는 방의 열린 예약이 이미 존재한다."""


class StudentBindingConflict(ValueError):
    """Google 계정과 학번의 일대일 연결 규칙을 위반했다."""


@dataclass(frozen=True)
class Reservation:
    id: str
    uid: str
    student_id: str
    student_key: str
    corner_no: int
    room_no: str
    start_at: datetime
    end_at: datetime
    tag_deadline: datetime
    status: str
    kiosk_booking_no: str | None = None
    request_id: str | None = None


@contextmanager
def _connection():
    DB_PATH.parent.mkdir(exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("""CREATE TABLE IF NOT EXISTS reservations (
        id TEXT PRIMARY KEY, uid TEXT NOT NULL, student_id TEXT NOT NULL,
        student_key TEXT NOT NULL DEFAULT '', corner_no INTEGER NOT NULL, room_no TEXT NOT NULL,
        start_at TEXT NOT NULL, end_at TEXT NOT NULL, tag_deadline TEXT NOT NULL,
        status TEXT NOT NULL, kiosk_booking_no TEXT, request_id TEXT, created_at TEXT NOT NULL
    )""")
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(reservations)")}
    if "student_key" not in columns:
        conn.execute("ALTER TABLE reservations ADD COLUMN student_key TEXT NOT NULL DEFAULT ''")
    if "request_id" not in columns:
        conn.execute("ALTER TABLE reservations ADD COLUMN request_id TEXT")
    conn.execute("""CREATE UNIQUE INDEX IF NOT EXISTS reservations_uid_request_id_unique
                    ON reservations(uid, request_id) WHERE request_id IS NOT NULL""")
    # 학번 원문은 저장하지 않는다. BOOKING_TOKEN_SECRET로 만든 HMAC만 보관해
    # Google UID ↔ 학번의 일대일 연결과 중복 차단에 사용한다.
    conn.execute("""CREATE TABLE IF NOT EXISTS student_bindings (
        uid TEXT PRIMARY KEY,
        student_key TEXT NOT NULL UNIQUE,
        bound_at TEXT NOT NULL
    )""")
    try:
        yield conn
    finally:
        conn.close()


def _row(row: sqlite3.Row | None) -> Reservation | None:
    if row is None:
        return None
    return Reservation(
        id=row["id"], uid=row["uid"], student_id=row["student_id"],
        student_key=row["student_key"], corner_no=row["corner_no"], room_no=row["room_no"],
        start_at=parse_kst(row["start_at"]), end_at=parse_kst(row["end_at"]),
        tag_deadline=parse_kst(row["tag_deadline"]), status=row["status"],
        kiosk_booking_no=row["kiosk_booking_no"], request_id=row["request_id"],
    )


def expire_pending(now: datetime | None = None) -> list[Reservation]:
    """이름은 호환성을 위해 유지한다. 모든 열린 고아 상태를 정리한다.

    - creating: 프로세스 종료/네트워크 중단 후 남은 예약 의도
    - pending_tag: 예약 시작 + 10분까지 태그하지 않은 예약
    - active: 이용 종료 시각이 지나 키오스크가 강제 반납했을 수 있는 기록

    active를 여기서만 정리하는 이유는 앱 DB가 학교 키오스크의 실제 반납을
    대신 판단하지 않기 위해서다. 다음 예약은 여전히 키오스크가 최종 거절할
    수 있지만, 끝난 로컬 기록 때문에 영구 차단되지는 않는다.
    """
    now = kst_normalize(now) if now else kst_now()
    with _connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        rows = conn.execute(
            """SELECT * FROM reservations
               WHERE (status='creating' AND created_at < ?)
                  OR (status='pending_tag' AND tag_deadline < ?)
                  OR (status='active' AND end_at <= ?)""",
            ((now - CREATING_TTL).isoformat(), (now - PENDING_TAG_GRACE).isoformat(), now.isoformat()),
        ).fetchall()
        conn.execute(
            "UPDATE reservations SET status='failed' WHERE status='creating' AND created_at < ?",
            ((now - CREATING_TTL).isoformat(),),
        )
        conn.execute("UPDATE reservations SET status='expired' WHERE status='pending_tag' AND tag_deadline < ?", ((now - PENDING_TAG_GRACE).isoformat(),))
        conn.execute("UPDATE reservations SET status='ended' WHERE status='active' AND end_at <= ?", (now.isoformat(),))
        conn.execute("COMMIT")
    return [item for row in rows if (item := _row(row))]


def get(id: str) -> Reservation | None:
    """권한 토큰이 가리키는 과거 예약도 조회한다."""
    with _connection() as conn:
        row = conn.execute("SELECT * FROM reservations WHERE id=?", (id,)).fetchone()
    return _row(row)


def find_by_request(uid: str, request_id: str) -> Reservation | None:
    """같은 브라우저 요청의 재전송은 이전 처리 결과를 돌려준다."""
    with _connection() as conn:
        row = conn.execute(
            "SELECT * FROM reservations WHERE uid=? AND request_id=? ORDER BY created_at DESC LIMIT 1",
            (uid, request_id),
        ).fetchone()
    return _row(row)


def bind_student(uid: str, key: str) -> bool:
    """Google UID에 학번 HMAC을 최초 1회만 연결한다.

    같은 조합의 재확인은 허용해 새 기기/브라우저 데이터 삭제 뒤에도 복원할 수
    있다. 다른 학번으로 변경하거나, 이미 다른 UID에 연결된 학번은 거절한다.
    반환값은 새 연결이면 True, 기존 연결 재확인이면 False다.
    """
    now = kst_now().isoformat()
    with _connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        existing_uid = conn.execute("SELECT student_key FROM student_bindings WHERE uid=?", (uid,)).fetchone()
        if existing_uid:
            conn.execute("ROLLBACK")
            if existing_uid["student_key"] == key:
                return False
            raise StudentBindingConflict("이 Google 계정에는 이미 다른 학번이 등록되어 있어 변경할 수 없습니다.")
        existing_student = conn.execute("SELECT uid FROM student_bindings WHERE student_key=?", (key,)).fetchone()
        if existing_student:
            conn.execute("ROLLBACK")
            raise StudentBindingConflict("이 학번은 이미 다른 Google 계정에 등록되어 있습니다.")
        conn.execute("INSERT INTO student_bindings (uid, student_key, bound_at) VALUES (?, ?, ?)", (uid, key, now))
        conn.execute("COMMIT")
    return True


def binding_for_uid(uid: str) -> str | None:
    """이미 연결된 학번 키를 반환한다. 신규 연결의 학교 검증 생략 방지용이다."""
    with _connection() as conn:
        row = conn.execute("SELECT student_key FROM student_bindings WHERE uid=?", (uid,)).fetchone()
    return row["student_key"] if row else None


def binding_uid_for_key(key: str) -> str | None:
    """해당 학번 키를 이미 사용 중인 Google UID를 반환한다."""
    with _connection() as conn:
        row = conn.execute("SELECT uid FROM student_bindings WHERE student_key=?", (key,)).fetchone()
    return row["uid"] if row else None


def require_bound_student(uid: str, key: str) -> None:
    """예약 요청 학번이 로그인 계정에 고정된 학번인지 확인한다."""
    with _connection() as conn:
        row = conn.execute("SELECT student_key FROM student_bindings WHERE uid=?", (uid,)).fetchone()
    if not row:
        raise StudentBindingConflict("학번을 먼저 등록해 주세요.")
    if row["student_key"] != key:
        raise StudentBindingConflict("등록된 학번과 다른 학번으로 예약하거나 반납할 수 없습니다.")


def open_for_uid(uid: str) -> Reservation | None:
    expire_pending()
    placeholders = ",".join("?" for _ in OPEN_STATUSES)
    with _connection() as conn:
        row = conn.execute(
            f"SELECT * FROM reservations WHERE uid=? AND status IN ({placeholders}) ORDER BY created_at DESC LIMIT 1",
            (uid, *OPEN_STATUSES),
        ).fetchone()
    return _row(row)


def open_reservations() -> list[Reservation]:
    expire_pending()
    placeholders = ",".join("?" for _ in OPEN_STATUSES)
    with _connection() as conn:
        rows = conn.execute(f"SELECT * FROM reservations WHERE status IN ({placeholders})", OPEN_STATUSES).fetchall()
    return [item for row in rows if (item := _row(row))]


def acquire(*, id: str, uid: str, student_id: str, student_key: str, corner_no: int, room_no: str,
            request_id: str | None = None) -> Reservation:
    """키오스크 호출 전에 학번과 방을 함께 선점한다.

    BEGIN IMMEDIATE가 단일 게이트웨이의 동시 요청을 직렬화한다. UID가 아니라
    student_key로 검사하므로 다른 기기/Google 계정도 같은 학생으로 취급한다.
    """
    now = kst_now()
    placeholders = ",".join("?" for _ in OPEN_STATUSES)
    with _connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            "UPDATE reservations SET status='failed' WHERE status='creating' AND created_at < ?",
            ((now - CREATING_TTL).isoformat(),),
        )
        conn.execute("UPDATE reservations SET status='expired' WHERE status='pending_tag' AND tag_deadline < ?", ((now - PENDING_TAG_GRACE).isoformat(),))
        conn.execute("UPDATE reservations SET status='ended' WHERE status='active' AND end_at <= ?", (now.isoformat(),))
        student_open = conn.execute(
            f"SELECT * FROM reservations WHERE student_key=? AND status IN ({placeholders}) LIMIT 1",
            (student_key, *OPEN_STATUSES),
        ).fetchone()
        if student_open:
            conn.execute("ROLLBACK")
            raise ReservationConflict("이미 예약 또는 사용 중인 연습실이 있습니다. 기존 예약을 취소하거나 반납해 주세요.")
        room_open = conn.execute(
            f"SELECT * FROM reservations WHERE corner_no=? AND room_no=? AND status IN ({placeholders}) LIMIT 1",
            (corner_no, room_no, *OPEN_STATUSES),
        ).fetchone()
        if room_open:
            conn.execute("ROLLBACK")
            raise ReservationConflict("방금 다른 사용자가 이 방을 예약했습니다. 다른 방을 선택해 주세요.")
        conn.execute("""INSERT INTO reservations
            (id, uid, student_id, student_key, corner_no, room_no, start_at, end_at, tag_deadline, status, kiosk_booking_no, request_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', NULL, ?, ?)""", (
                id, uid, student_id, student_key, corner_no, room_no,
                now.isoformat(), now.isoformat(), now.isoformat(), request_id, now.isoformat(),
            ))
        conn.execute("COMMIT")
    return Reservation(id, uid, student_id, student_key, corner_no, room_no, now, now, now, "creating", request_id=request_id)


def finalize(id: str, *, start_at: datetime, duration_min: int, kiosk_booking_no: str | None) -> Reservation:
    start_at = kst_normalize(start_at)
    end_at = start_at + timedelta(minutes=duration_min)
    deadline = start_at + timedelta(minutes=10)
    with _connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("""UPDATE reservations SET start_at=?, end_at=?, tag_deadline=?, status='pending_tag', kiosk_booking_no=?
                      WHERE id=? AND status='creating'""",
                     (start_at.isoformat(), end_at.isoformat(), deadline.isoformat(), kiosk_booking_no, id))
        row = conn.execute("SELECT * FROM reservations WHERE id=?", (id,)).fetchone()
        conn.execute("COMMIT")
    result = _row(row)
    if not result or result.status != "pending_tag":
        raise ValueError("예약 선점 상태를 확정하지 못했습니다.")
    return result


def fail(id: str) -> None:
    with _connection() as conn:
        conn.execute("UPDATE reservations SET status='failed' WHERE id=? AND status='creating'", (id,))


def set_status(id: str, status: str) -> Reservation | None:
    with _connection() as conn:
        conn.execute("UPDATE reservations SET status=? WHERE id=?", (status, id))
        row = conn.execute("SELECT * FROM reservations WHERE id=?", (id,)).fetchone()
    return _row(row)


def transition(id: str, *, expected_status: str, status: str) -> Reservation | None:
    """현재 상태가 기대값일 때만 전이한다 (동시 취소/반납과의 경합 방지)."""
    with _connection() as conn:
        updated = conn.execute(
            "UPDATE reservations SET status=? WHERE id=? AND status=?", (status, id, expected_status)
        ).rowcount
        if updated != 1:
            return None
        row = conn.execute("SELECT * FROM reservations WHERE id=?", (id,)).fetchone()
    return _row(row)
