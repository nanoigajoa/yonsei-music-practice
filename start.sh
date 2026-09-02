#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PIDS=()

cleanup() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

cd "$ROOT_DIR/api"
"$ROOT_DIR/.venv/bin/python" -m uvicorn main:app --port 8000 &
PIDS+=("$!")

cd "$ROOT_DIR/app"
npm run dev -- --port 3000 &
PIDS+=("$!")

echo "웹: http://localhost:3000"
echo "API: http://localhost:8000"
wait
