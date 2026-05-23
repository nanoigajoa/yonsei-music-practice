# check_main_list.py
import requests
from bs4 import BeautifulSoup

BASE = "http://165.132.176.173"

# main_view가 아니라 main_list가 실제 데이터
res = requests.get(
    f"{BASE}/booking/main_list.php",
    params={
        "corner_no": 1,
        "TimeCellSize": 0,
        "page": ""
    },
    headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0) Edge",
        "Referer": f"{BASE}/booking/main_view.php",  # 부모 페이지 Referer
        "X-Requested-With": "XMLHttpRequest"          # jQuery AJAX 요청 흉내
    },
    timeout=5
)

print(f"상태코드: {res.status_code}")
print(f"응답크기: {len(res.text)} bytes")

# HTML 저장
with open("main_list.html", "w", encoding="utf-8") as f:
    soup = BeautifulSoup(res.text, "html.parser")
    f.write(soup.prettify())

print("main_list.html 저장 완료 → open main_list.html 로 확인")