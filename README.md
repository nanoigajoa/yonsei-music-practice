# 음대 연습실 — 키오스크 대기 문제 해결 PWA

> 음악대학 연습실 49개 방, 키오스크 3대. 혼잡 시 키오스크 한 대에 6~10명 대기.  
> 학교 보안 시스템에 손댈 수 없다는 제약 안에서, 대기를 줄이는 보조 서비스를 설계했습니다.

<!-- 스크린샷 추가 예정
![앱 메인 화면](./docs/screenshots/main.png)
-->

## 문제 상황

음악대학 연습실은 3대의 키오스크로 49 개 방을 관리합니다. 예약·연장·반납 모두 키오스크를 거쳐야 하고, 방 앞 단말기에 실물 학생증을 태그해야만 문이 열립니다.

<!-- 키오스크 화면 캡처
![키오스크 화면](./docs/screenshots/kiosk.png)
-->

| 문제 | 구체적 상황 |
|------|-------------|
| **키오스크 병목** | 혼잡 시 1대당 6~10명 대기, 예약·연장이 모두 같은 줄 |
| **왕복 이동** | 예약 후 10분 내에 방 앞 단말기 태그 필수 → 키오스크 층과 다른 층 방 예약 시 이동 반복 |
| **태그 지연 분쟁** | 10분 초과 시 예약 자동 취소, 태그 직전 다른 사람이 방 점거하는 상황 발생 |
| **패널티 리스크** | 반납 미실시 2회 → 3일, 3회 → 7주 이용 불가 |

### 핵심 제약: 학교 시스템에 손댈 수 없다

학교 보안 네트워크 정책상 API 연동·모바일 학생증 대체가 불가능합니다. 실물 학생증 태그는 변경할 수 없는 물리적 제약입니다.

이 제약이 설계의 출발점입니다. **기존 흐름을 대체하는 대신, 그 주변의 마찰을 줄이는 방향**으로 설계했습니다.

---

## 솔루션

학교 시스템을 건드리지 않고 풀 수 있는 문제만 골랐습니다.

| 기능 | 해결하는 문제 |
|------|---------------|
| **공실 현황** | 키오스크 폴링으로 층별 사용 가능 방 실시간 표시 → 이동 전 확인 가능 |
| **태그 알림** | 예약 직후 등록 → 5분·2분 전 푸시 알림 → 태그 타이밍 놓침 방지 |
| **반납 리마인더** | 40분·10분 전 알림 → 반납 누락으로 인한 패널티 예방 |
| **연습 통계** | 알림 기반 자동 기록 → 별도 입력 없이 주/월 연습량 확인 |
| **양도·매칭** _(준비 중)_ | 방 사용 안 할 때 다른 사용자와 연결, 연장 카드 교환 상대 모집 |
| **조기 반납 예고** _(준비 중)_ | "30분 뒤 나가요" 사전 공지 → 대기자가 미리 줄 준비 |

<!-- 기능 스크린샷
![태그 알림 등록](./docs/screenshots/alarm.png)
![마이페이지 통계](./docs/screenshots/mypage.png)
-->

---

## 기술적 도전

### 1. 학교 서버 시간대 없이 현재 슬롯 감지

키오스크 서버가 반환하는 HTML에는 타임존 정보가 없습니다. 서버 시간을 믿으면 KST/UTC 혼선으로 현재 슬롯 감지가 틀립니다.

**해결:** 키오스크가 이미 지난 슬롯에 붙이는 "지난 시간(PAST)" 마커를 기준으로 현재 슬롯을 역산. 서버 시계에 의존하지 않고 정확한 사용 여부를 판단합니다.

```python
# 마지막 PAST 마커 다음 슬롯 = 현재 슬롯
past_idxs = [i for i, m in enumerate(markers) if m == 'PAST']
current_idx = past_idxs[-1] + 1 if past_idxs else None
```

### 2. 반납 10분 전 공실 오표시 방지

키오스크는 반납 10분 전부터 해당 슬롯을 예약 가능으로 표시합니다. 이를 그대로 반영하면 아직 사람이 있는 방이 공실로 뜹니다.

**해결:** 직전 슬롯이 예약됐는데 현재 슬롯이 비어 있으면 "인수인계 중"으로 판단해 사용중으로 유지.

```python
# 핸드오버 감지: 이전 슬롯 BOOKED + 현재 슬롯 AVAILABLE = 아직 점유
if current_status == AVAILABLE and any(slots[i] == BOOKED for i in sorted_idxs if i < current_idx):
    occupied = True
```

### 3. FCM 포그라운드 알림

PWA가 포그라운드 상태일 때 FCM은 `onMessage` 이벤트를 발생시키지만 시스템 알림을 자동으로 띄우지 않습니다.

**해결:** `getRegistrations()`로 활성 서비스 워커를 찾아 `showNotification()` 직접 호출. SW가 없는 경우 Notification API 폴백.

### 4. 예약 시간 → 태그 인증 윈도우 계산

키오스크는 10분 단위 슬롯으로 운영됩니다. 14:14에 예약하면 인증 윈도우는 14:20~14:30입니다.

**해결:** `Math.ceil(분 / 10) * 10`으로 다음 슬롯 시작 시간으로 스냅.

---

## 기술 스택

| 영역 | 선택 | 이유 |
|------|------|------|
| Frontend | Next.js 16 App Router + TypeScript | App Router의 서버 컴포넌트로 초기 로딩 최소화 |
| Styling | TailwindCSS | 빠른 반응형 UI 구성 |
| Auth / DB | Firebase (익명 인증 + Firestore + FCM) | 앱 설치 없이 푸시 알림, 익명 로그인으로 가입 마찰 제거 |
| API 서버 | FastAPI (Python) on Fly.io | 키오스크 폴링 + SSE 스트리밍에 적합, 도쿄 리전으로 레이턴시 최소화 |
| 배포 | Vercel | GitHub 연동 자동 배포 |
| 알림 크론 | cron-job.org → Vercel Functions | Vercel Hobby 플랜 제약 우회, 분 단위 실행 |

## 아키텍처

```
브라우저(PWA)
  └─ Next.js (Vercel)
       ├─ Firebase Firestore  ← 예약 세션, FCM 토큰, 프로필, 연습 기록
       └─ /api/cron/*         ← 매분 실행: 태그 마감·반납 리마인더 FCM 발송

FastAPI (Fly.io, Tokyo)
  └─ 키오스크 서버 60초 폴링
       └─ GET /rooms  →  SSE /stream → 웹앱 실시간 방 현황
```

---

## 로컬 실행

```bash
# 웹앱
cd app
npm install
cp .env.example .env.local   # Firebase 환경변수 입력
npm run dev

# API 서버
cd api
pip install -r requirements.txt
uvicorn main:app --reload
```

### 환경변수 (`app/.env.local`)

```
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
NEXT_PUBLIC_FIREBASE_VAPID_KEY=
FIREBASE_SERVICE_ACCOUNT_KEY=
CRON_SECRET=
NEXT_PUBLIC_KIOSK_API_URL=
```

## 배포

- **웹앱**: GitHub 푸시 → Vercel 자동 배포
- **API 서버**: `cd api && fly deploy`
- **크론**: cron-job.org에서 3개 엔드포인트 매분 실행 (`/api/cron/deadline-guard`, `/api/cron/return-reminder`, `/api/cron/ttl-cleanup`)
