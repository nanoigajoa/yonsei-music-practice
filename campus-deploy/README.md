# 교내 예약 게이트웨이 배포

교내 네트워크에 연결된 상시 가동 컴퓨터에서만 실행합니다. 웹 프론트는 포함하지 않습니다.

## 준비물

- Docker Desktop 또는 Docker Engine + Compose
- Cloudflare Tunnel 토큰
- Firebase 서비스 계정 JSON
- 시험용 Vercel 주소

## 설치

1. 이 저장소를 내려받고 `campus-deploy`로 이동합니다.
2. `.env.example`을 `.env`로 복사하고 실제 값을 입력합니다.
3. Cloudflare Dashboard에서 Tunnel의 Public Hostname 서비스를 `http://api:8080`으로 지정합니다.
4. 먼저 `BOOKING_ENABLED=false` 상태로 실행합니다.

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f
```

Tunnel 주소의 `/health`가 열리고 `booking_enabled`가 `false`인지 확인합니다.

## 현장 시험

이용자가 없는 시간에 `.env`의 시험방을 확인한 뒤에만 활성화합니다.

```env
BOOKING_ENABLED=true
ALLOWED_TEST_ROOMS=119
```

설정 변경 후 API 컨테이너를 다시 만듭니다.

```bash
docker compose up -d --force-recreate api
```

시험 순서: 30분 예약 → 본인 카드 태그 → 태그 확인 → 즉시 반납.

시험이 끝나면 `BOOKING_ENABLED=false`로 되돌리고 API를 다시 만듭니다.

## 운영 명령

```bash
docker compose logs --tail=200 api tunnel
docker compose restart
docker compose down
```

`.env`는 저장소에 커밋하거나 메신저로 공유하지 않습니다.
