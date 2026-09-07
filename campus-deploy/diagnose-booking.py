"""Read-only diagnosis of one blocked booking, without printing account identifiers."""
import asyncio
import json
import os
from pathlib import Path
import re
import sqlite3
import sys

root = Path.cwd()
sys.path.insert(0, str(root / "api"))
from dotenv import load_dotenv
load_dotenv(root / "campus-deploy/.env")
os.chdir(root / "api")
import booking
import reservations
from bs4 import BeautifulSoup
import httpx


async def main():
    with sqlite3.connect(f"file:{reservations.DB_PATH}?mode=ro", uri=True) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT * FROM reservations WHERE room_no='411' AND status IN ('creating','submitting','uncertain','pending_tag','active')").fetchall()
    print("open_records", len(rows))
    for row in rows:
        record = reservations._row(row)
        print("local", json.dumps({key: row[key] for key in ("room_no", "corner_no", "status", "start_at", "end_at", "duration_min", "dispatch_started")}, ensure_ascii=False))
        async with httpx.AsyncClient(headers=booking.HEADERS, timeout=booking.TIMEOUT) as client:
            login = await booking._login(client, record.student_id, record.corner_no)
            print("login", login.status_code, "recognized", "window.opener.location" in login.text and "/booking/index.php" in login.text)
            page = await client.get(f"{booking.BASE}/booking/booking_info.php", params={"corner_no": record.corner_no}, headers={**booking.HEADERS, "Referer": f"{booking.BASE}/booking/index.php"})
            print("info_http", page.status_code)
            page.raise_for_status()
            soup = BeautifulSoup(page.text, "html.parser")
            target_rows = [r for r in soup.select("tr") if not r.find("tr") and "411" in r.get_text()]
            print("target_rows", len(target_rows))
            for target in target_rows:
                # Only reservation-specific structure/time data, no names/student IDs.
                text = target.get_text(" ", strip=True)
                print("school_row", json.dumps({
                    "rooms": re.findall(r"(?<!\d)\d{3}호", text),
                    "times": re.findall(r"\d{1,2}:\d{2}(?::\d{2})?", text),
                    "dates": re.findall(r"\d{4}[-./]\d{1,2}[-./]\d{1,2}", text),
                    "active": "이용중" in text or "사용중" in text,
                    "time_separator": bool(re.search(r"\d{2}\s*~\s*\d{1,2}:", text)),
                    "cancel_link_count": len(re.findall(r"booking_del\(['\"](\d+)", str(target))),
                    "return_link_count": len(re.findall(r"return\.php\?booking_no=(\d+)", str(target))),
                }, ensure_ascii=False))
            active = await booking._active_booking_no(client, record.corner_no)
            print("active_id_present", bool(active))
            if record.duration_min:
                evidence = booking._submission_evidence(page.text, record.room_no, record.start_at, record.duration_min, active)
                print("evidence_matches", bool(evidence))


try:
    asyncio.run(main())
except Exception as exc:
    print("diagnostic_error", type(exc).__name__)
    raise SystemExit(1)
