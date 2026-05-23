# step2_html.py
import requests
from bs4 import BeautifulSoup

res = requests.get(
    "http://165.132.176.173/booking/main_view.php",
    params={"corner_no": 1, "TimeCellSize": 0},
    headers={"User-Agent": "Mozilla/5.0 Edge"},
    timeout=5
)

soup = BeautifulSoup(res.text, "html.parser")

# HTML 구조 파일로 저장 (터미널에서 보기 힘드니까)
with open("structure.html", "w", encoding="utf-8") as f:
    f.write(soup.prettify())

print("structure.html 저장 완료")
print("\n--- 클래스명 목록 ---")

# 페이지 내 모든 클래스명 추출
classes = set()
for tag in soup.find_all(True):
    for cls in tag.get("class", []):
        classes.add(cls)

print("\n".join(sorted(classes)))