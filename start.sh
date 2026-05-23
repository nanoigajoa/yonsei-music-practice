#!/usr/bin/env bash
# start.sh — FastAPI + Next.js 개발 서버 한 번에 실행
#
# 사용법:
#   ./start.sh           # 기본 (API: 8000, Next: 3000)
#   ./start.sh --stop    # 두 서버 모두 종료

set -euo pipefail

API_PORT=8000
WEB_PORT=3000
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
API_DIR="$ROOT_DIR/api"
WEB_DIR="$ROOT_DIR/app"
PID_FILE="$ROOT_DIR/.dev-pids"

# ── 색상 ───────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'

log()  { echo -e "${BOLD}[start]${RESET} $*"; }
ok()   { echo -e "${GREEN}  ✓${RESET} $*"; }
warn() { echo -e "${YELLOW}  !${RESET} $*"; }
err()  { echo -e "${RED}  ✗${RESET} $*"; }

# ── Python PATH 보강 (conda / pyenv / framework 등) ────
export PATH="\
/Library/Frameworks/Python.framework/Versions/3.12/bin:\
/Library/Frameworks/Python.framework/Versions/3.11/bin:\
/Library/Frameworks/Python.framework/Versions/3.10/bin:\
$HOME/opt/anaconda3/bin:\
$HOME/anaconda3/bin:\
$HOME/.local/bin:\
$PATH"

# ── uvicorn 실행 명령 결정 ─────────────────────────────
find_uvicorn() {
  # 1) PATH에서 찾기
  if command -v uvicorn &>/dev/null; then
    echo "uvicorn"; return
  fi
  # 2) python3 -m uvicorn (모듈로 설치된 경우)
  if python3 -c "import uvicorn" 2>/dev/null; then
    echo "python3 -m uvicorn"; return
  fi
  echo ""
}

UVICORN_CMD=$(find_uvicorn)
if [[ -z "$UVICORN_CMD" ]]; then
  err "uvicorn을 찾을 수 없습니다."
  err "아래 중 하나를 실행하세요:"
  err "  pip install -r api/requirements.txt"
  err "  pip3 install uvicorn fastapi httpx beautifulsoup4"
  exit 1
fi
ok "uvicorn 발견: $UVICORN_CMD"

# ── 종료 처리 ──────────────────────────────────────────
stop_servers() {
  log "서버 종료 중..."
  if [[ -f "$PID_FILE" ]]; then
    while IFS= read -r pid; do
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null && ok "PID $pid 종료" || warn "PID $pid 이미 없음"
      fi
    done < "$PID_FILE"
    rm -f "$PID_FILE"
  fi
  # 포트로도 한 번 더 정리
  lsof -ti :"$API_PORT" | xargs kill -9 2>/dev/null || true
  lsof -ti :"$WEB_PORT" | xargs kill -9 2>/dev/null || true
  ok "완료"
}

if [[ "${1:-}" == "--stop" ]]; then
  stop_servers
  exit 0
fi

# ── 기존 서버 정리 ────────────────────────────────────
log "기존 서버 정리..."
lsof -ti :"$API_PORT" | xargs kill -9 2>/dev/null && warn "포트 $API_PORT 기존 프로세스 종료" || true
lsof -ti :"$WEB_PORT" | xargs kill -9 2>/dev/null && warn "포트 $WEB_PORT 기존 프로세스 종료" || true
sleep 1

# ── FastAPI 서버 ──────────────────────────────────────
log "FastAPI 서버 시작 (포트 $API_PORT)..."
cd "$API_DIR"
$UVICORN_CMD main:app --port "$API_PORT" --log-level warning &
API_PID=$!
echo "$API_PID" > "$PID_FILE"

# 첫 폴링 완료까지 최대 15초 대기
for i in $(seq 1 15); do
  sleep 1
  ready=$(curl -s "http://localhost:$API_PORT/health" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('data_ready',''))" 2>/dev/null || true)
  if [[ "$ready" == "True" ]]; then
    ok "API 서버 준비 완료 (${i}초)"
    break
  fi
  if [[ $i -eq 15 ]]; then
    warn "API 15초 내 데이터 미준비 — 백그라운드 폴링 계속 진행"
  fi
done

# ── Next.js 서버 ──────────────────────────────────────
log "Next.js 서버 시작 (포트 $WEB_PORT)..."
cd "$WEB_DIR"
npx next dev --port "$WEB_PORT" &
WEB_PID=$!
echo "$WEB_PID" >> "$PID_FILE"

# ── Ctrl+C 시 두 서버 모두 종료 ───────────────────────
trap 'echo ""; stop_servers; exit 0' INT TERM

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  ${GREEN}🎵 연습실 서비스 실행 중${RESET}"
echo -e "  ${BLUE}웹${RESET}  → http://localhost:$WEB_PORT"
echo -e "  ${BLUE}API${RESET} → http://localhost:$API_PORT/docs"
echo -e "  종료: ${YELLOW}Ctrl+C${RESET}  또는  ${YELLOW}./start.sh --stop${RESET}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""

# 두 서버 중 하나라도 죽으면 감지
wait "$API_PID" "$WEB_PID"
