#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=/root/yoneum-lxc-20260904/campus-deploy-private-transfer
SOURCE_BASE=https://raw.githubusercontent.com/nanoigajoa/yonsei-music-practice/staging-booking/api
FILES=(booking.py main.py reservations.py reset_student_binding.py)

cd "$ROOT_DIR"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

for file in "${FILES[@]}"; do
  wget -qO "$TEMP_DIR/$file" "$SOURCE_BASE/$file"
  .venv/bin/python -m py_compile "$TEMP_DIR/$file"
done

BACKUP_DIR="api/.update-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
for file in "${FILES[@]}"; do
  if [[ -f "api/$file" ]]; then
    cp "api/$file" "$BACKUP_DIR/$file"
  fi
  install -m 0644 "$TEMP_DIR/$file" "api/$file"
done

if [[ -n "${1:-}" ]]; then
  .venv/bin/python api/reset_student_binding.py "$1"
fi

systemctl restart yonsei-practice-gateway.service
systemctl is-active --quiet yonsei-practice-gateway.service
echo "최종 업데이트 완료: 서버 active"
