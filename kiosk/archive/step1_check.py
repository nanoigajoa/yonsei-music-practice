# step1_check.py
import requests

res = requests.get(
    "http://165.132.176.173/booking/main_view.php",
    params={"corner_no": 1, "TimeCellSize": 0},
    headers={"User-Agent": "Mozilla/5.0 Edge"},
    allow_redirects=False,
    timeout=5
)

print(f"상태코드: {res.status_code}")
print(f"응답크기: {len(res.text)} bytes")
print(f"리다이렉트: {res.headers.get('Location', '없음')}")