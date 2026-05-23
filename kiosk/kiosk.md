# 키오스크 데이터 수집 레이어

음악대학 연습실 예약 현황을 키오스크 서버에서 직접 수집하는 파이썬 모듈.
FastAPI SSE 파이프라인의 데이터 공급원이 됩니다.

---

## 서버 정보

| 항목 | 내용 |
|------|------|
| 서버 IP | `165.132.176.173` |
| 프로토콜 | HTTP (비암호화) |
| 브라우저 | Microsoft Edge (Legacy) |
| 메인 뷰 | `/booking/main_view.php?corner_no=N&TimeCellSize=0` |
| 방 목록 | `/booking/main_list.php?corner_no=N&TimeCellSize=0&page=` |
| 원래 갱신 주기 | 10초 (jQuery setInterval) |
| 접근 조건 | 교내 와이파이 또는 YSVPN 필수 |

---

## corner_no 매핑 (탐색 완료)

| corner_no | 방 목록 |
|-----------|---------|
| 1 | 107~114호 (8개) |
| 2 | 205~209호 (5개) |
| 3 | 302호, 오르간 303~306호, 307호 (6개) |
| 4 | 406~411호 (6개) |
| 6 | 119~126호 (8개) |
| 8 | 310~317호 (8개) |
| 9 | 416~421호 (6개) |

**총 47개 방.** 5, 7, 10~29는 유효하지 않음.

---

## 타임슬롯 구조

- 운영시간: 07:00 ~ 방별 폐쇄 시각 (corner마다 다름)
- 1슬롯 = 10분, 슬롯 인덱스 0 = 07:00
- `time = 07:00 + index × 10분`

### 슬롯 상태 (HTML → 상태)

| `<li>` 특성 | img src | 의미 |
|-------------|---------|------|
| `title="지난 시간..."` | `time_red.gif` | PAST — 지난 시간 |
| `bgcolor="#333333"` | `time_red.gif` | BLOCKED — 운영 외 시간 |
| `title="예약된 좌석"` | `time_blue.gif` | BOOKED — 예약됨 |
| `<a onclick="reserve(...)">` | `time_gray.gif` | **AVAILABLE** — 예약 가능 |

---

## 폴더 구조

```
kiosk/
├── explore.py      최초 1회: corner_no 전수 탐색 → rooms.json 생성
├── scraper.py      반복 실행: 전체 방 예약 현황 폴링 (1~2분 간격)
├── rooms.json      탐색 결과 (explore.py 출력물)
├── kiosk.md        이 문서
└── archive/        탐색 단계 파일 보관
    ├── step1_check.py     서버 연결 확인
    ├── step2_html.py      HTML 덤프
    ├── structure.html     main_view.php 구조 (BeautifulSoup)
    ├── structure_real.html main_view.php 원본
    ├── main_list.html     방 목록 HTML (BeautifulSoup)
    └── main_list_real.html 방 목록 HTML 원본
```

---

## 사용법

```bash
# 최초 1회 — 방 목록 확보
python explore.py

# 현황 조회 (1분 간격)
python scraper.py

# 2분 간격
python scraper.py --interval 120

# 1회만 조회 후 종료
python scraper.py --once
```

---

## 제약사항 및 주의사항

- **개인정보 수집 금지**: 이름·학번·예약자 정보는 파싱하지 않음
- **서버 부하 방지**: 폴링 최소 60초 간격, 코너 간 1초 대기
- 교내 네트워크 또는 YSVPN 연결 필요
- `main_list.php`가 Referer 체크할 수 있음 → 문제 발생 시 헤더 추가 필요

---

## 다음 단계 (FastAPI 파이프라인)

```
scraper.py (폴링)
    ↓ List[RoomStatus]
collector.py (비동기 변환)
    ↓ {room_id, occupied, timestamp}
FastAPI /status  → 전체 현황 JSON
FastAPI /stream  → SSE 실시간 스트림
```
