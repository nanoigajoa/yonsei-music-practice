"""
explore.py - corner_no 전수 탐색 (최초 1회 실행)

실행하면 유효한 corner 번호와 방 목록을 rooms.json에 저장합니다.
요청 간 2초 대기로 서버 부하를 최소화합니다.
"""

import json
import re
import time
from typing import Dict, List, Optional

import requests
from bs4 import BeautifulSoup

# ── 설정 ──────────────────────────────────────────────
BASE_URL = "http://165.132.176.173/booking/main_list.php"
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; practice-room-monitor/1.0)"}
CORNER_RANGE = range(1, 30)   # 탐색할 corner_no 범위
REQUEST_DELAY = 2.0           # 요청 간 대기(초) — 서버 부하 방지
TIMEOUT = 5
OUTPUT_FILE = "rooms.json"
# ──────────────────────────────────────────────────────


def fetch_rooms(corner_no: int) -> Optional[List[dict]]:
    """
    corner_no의 방 목록을 반환.
    빈 응답이거나 오류면 None.
    """
    try:
        res = requests.get(
            BASE_URL,
            params={"corner_no": corner_no, "TimeCellSize": 0, "page": ""},
            headers=HEADERS,
            timeout=TIMEOUT,
        )
        if res.status_code != 200:
            return None

        soup = BeautifulSoup(res.text, "html.parser")
        rooms = []

        for seat_div in soup.select("div.Body-List"):
            # 방 이름: title 영역의 두 번째 <td>
            title_td = seat_div.select_one("div.title tr td:nth-child(2)")
            name = title_td.get_text(strip=True) if title_td else ""
            if not name:
                continue

            # pc_id: 주석 처리된 예약 링크에서 추출
            comment = seat_div.find(string=lambda t: t and "pc_id=" in str(t))
            pc_id = None
            if comment:
                m = re.search(r"pc_id=(\d+)", str(comment))
                pc_id = int(m.group(1)) if m else None

            # onclick 시간 셀 링크에서 pc_id 추출 (주석보다 신뢰도 높음)
            onclick_img = seat_div.find("a", onclick=True)
            if onclick_img and pc_id is None:
                m = re.search(r"pc_id\s*,\s*(\d+)", onclick_img["onclick"])
                pc_id = int(m.group(1)) if m else None

            rooms.append({
                "name": name,
                "seat_index": seat_div.get("id", "").replace("seat_", ""),
                "pc_id": pc_id,
            })

        return rooms if rooms else None

    except requests.RequestException as e:
        print(f"    네트워크 오류: {e}")
        return None
    except Exception as e:
        print(f"    파싱 오류: {e}")
        return None


def main() -> None:  # noqa: E302
    print("=" * 55)
    print(" corner_no 전수 탐색")
    print(f" 범위: {CORNER_RANGE.start} ~ {CORNER_RANGE.stop - 1}")
    print(f" 요청 간격: {REQUEST_DELAY}초  (서버 부하 방지)")
    print("=" * 55)

    found: Dict[str, List[dict]] = {}

    for corner_no in CORNER_RANGE:
        print(f"  corner_no={corner_no:2d} ... ", end="", flush=True)
        rooms = fetch_rooms(corner_no)

        if rooms:
            names = [r["name"] for r in rooms]
            print(f"방 {len(rooms)}개: {names}")
            found[str(corner_no)] = rooms
        else:
            print("없음")

        time.sleep(REQUEST_DELAY)

    print("\n" + "=" * 55)
    print(f" 탐색 완료: 유효 corner {len(found)}개")
    for cno, rooms in found.items():
        print(f"   corner_no={cno}: {[r['name'] for r in rooms]}")

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(found, f, ensure_ascii=False, indent=2)
    print(f"\n 결과 저장 → {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
