# 음대 연습실

음악대학 연습실 키오스크 대기 문제를 해결하는 PWA 서비스입니다.

## 주요 기능

- **공실 현황** — 키오스크 실시간 연동으로 층별 공실·사용중 표시
- **태그 알림** — 키오스크 예약 직후 등록, 방 앞 단말기 태그 시간(5분·2분 전)을 푸시 알림으로 안내
- **반납 리마인더** — 종료 40분·10분 전 연장/반납 알림
- **연습 통계** — 알림 기반 자동 기록, 오늘/이번 주/이달 본인 연습 시간 확인
- **시설 신문고** — 방 비품·시설 문제 간편 신고

## 기술 스택

| 영역 | 스택 |
|------|------|
| Frontend | Next.js 16, TailwindCSS, TypeScript |
| Auth / DB | Firebase (익명 인증, Firestore, FCM) |
| API 서버 | FastAPI (Python) — 키오스크 실시간 스크래핑 |
| 배포 | Vercel (웹앱), Fly.io (API 서버) |
| 알림 크론 | cron-job.org → Vercel Functions |

## 아키텍처

```
브라우저(PWA)
  └─ Next.js (Vercel)
       ├─ Firebase Firestore  ← 예약 세션, FCM 토큰, 프로필
       └─ /api/cron/*         ← 매분 실행, FCM 알림 발송

FastAPI (Fly.io)
  └─ 키오스크 서버 폴링 (60초)
       └─ SSE /stream → 웹앱 실시간 방 현황
```

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

## 환경변수

`app/.env.local`에 Firebase 프로젝트 설정값 필요:

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
- **크론**: cron-job.org에서 3개 엔드포인트 매분 실행 설정 필요
