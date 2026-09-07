"""운영자 콘솔에서 잘못 연결한 학번 하나를 해제하는 도구."""
from __future__ import annotations

import re
import sqlite3
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / "campus-deploy" / ".env")

from auth_security import student_key  # noqa: E402
import reservations  # noqa: E402


def main() -> int:
    if len(sys.argv) != 2 or not re.fullmatch(r"20\d{8}", sys.argv[1]):
        print("사용법: python reset_student_binding.py 학번")
        return 2
    with sqlite3.connect(reservations.DB_PATH) as conn:
        deleted = conn.execute(
            "DELETE FROM student_bindings WHERE student_key=?",
            (student_key(sys.argv[1]),),
        ).rowcount
    print("학번 연결 해제 완료" if deleted == 1 else "해당 학번 연결을 찾지 못했습니다")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
