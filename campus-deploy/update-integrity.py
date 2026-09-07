#!/usr/bin/env python3
"""Pinned source update for the existing Linux gateway; preserves its live DB and secrets."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import tempfile
import time
import urllib.request

SERVICE = "yonsei-practice-gateway.service"
REPO = "https://raw.githubusercontent.com/nanoigajoa/yonsei-music-practice"


def command(*args):
    return subprocess.check_output(args, text=True).strip()


def snapshot(source, target):
    with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as src:
        with sqlite3.connect(target) as dst:
            src.backup(dst)
            if dst.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise RuntimeError("SQLite integrity check failed")
    os.chmod(target, 0o600)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--revision", required=True)
    parser.add_argument("--root", required=True, type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0 or not re.fullmatch(r"[0-9a-f]{40}", args.revision):
        raise RuntimeError("Run as root with a full 40-character commit SHA")
    os.umask(0o077)
    root = args.root.resolve()
    if Path(command("systemctl", "show", SERVICE, "-p", "WorkingDirectory", "--value")).resolve() != root:
        raise RuntimeError("Service installation path does not match --root")
    if command("systemctl", "is-active", SERVICE) != "active":
        raise RuntimeError("Expected the existing gateway service to be active")
    python = root / ".venv/bin/python"
    env_file = root / "campus-deploy/.env"
    if not python.is_file() or not env_file.is_file():
        raise RuntimeError("Existing Python environment/configuration not found")
    # Resolve the same dotenv/default path as run-gateway-linux.sh. No secrets are printed.
    resolve_db = (
        "from dotenv import load_dotenv; import os; from pathlib import Path; "
        "load_dotenv(os.environ['DEPLOY_ENV_FILE']); "
        "print(Path(os.getenv('RESERVATIONS_DB_PATH', '.data/reservations.sqlite3')).resolve())"
    )
    deploy_env = {**os.environ, "DEPLOY_ENV_FILE": str(env_file)}
    db = Path(subprocess.check_output([str(python), "-c", resolve_db], cwd=root / "api", env=deploy_env, text=True).strip())
    if not db.is_file():
        raise RuntimeError("Existing reservation DB not found; refusing to create a replacement")
    base = f"{REPO}/{args.revision}"
    def download(path):
        with urllib.request.urlopen(f"{base}/{path}", timeout=30) as response:
            return response.read()
    manifest = json.loads(download("reports/gateway-integrity-2026-09-07.sha256.json"))
    expected = {"auth_security.py", "auto_return.py", "booking.py", "clock.py", "collector.py",
                "main.py", "models.py", "reservations.py", "requirements.txt", "rooms.json"}
    if set(manifest) != {"api/" + name for name in expected}:
        raise RuntimeError("Unexpected release file list")
    work = Path(tempfile.mkdtemp(prefix="integrity-update-", dir=root))
    candidate = work / "candidate"
    candidate.mkdir()
    for path, digest in manifest.items():
        body = download(path)
        if hashlib.sha256(body).hexdigest() != digest:
            raise RuntimeError(f"Source checksum mismatch: {path}")
        (candidate / Path(path).name).write_bytes(body)
    if (candidate / "requirements.txt").read_bytes() != (root / "api/requirements.txt").read_bytes():
        raise RuntimeError("Dependencies differ; review before updating")
    subprocess.run([str(python), "-m", "compileall", "-q", str(candidate)], check=True)
    print("Source verified. Stopping gateway to back up DB and check migration...", flush=True)
    subprocess.run(["systemctl", "stop", SERVICE], check=True)
    original = work / "previous-api"
    original.mkdir()
    changed = []
    started = False
    try:
        if command("systemctl", "show", SERVICE, "-p", "MainPID", "--value") != "0":
            raise RuntimeError("Gateway has not stopped")
        snapshot(db, work / "reservations-before.sqlite3")
        snapshot(db, work / "migration-check.sqlite3")
        check_env = {**deploy_env, "RESERVATIONS_DB_PATH": str(work / "migration-check.sqlite3")}
        # Test all lazy DDL/unique indexes against a copy before touching the live DB.
        subprocess.run([str(python), "-c", "import reservations; c=reservations._connection(); c.__enter__(); c.__exit__(None,None,None); print('Migration preflight OK')"], cwd=candidate, env=check_env, check=True)
        for name in sorted(expected):
            destination = root / "api" / name
            if not destination.is_file():
                raise RuntimeError(f"Existing source missing: {name}")
            shutil.copy2(destination, original / name)
            staged = destination.with_suffix(destination.suffix + ".integrity-new")
            shutil.copy2(candidate / name, staged)
            staged.replace(destination)
            changed.append(name)
        (work / "revision.txt").write_text(args.revision + "\n")
        # Once startup begins, never restore a stale DB or old code automatically:
        # the new service may already have received a booking request.
        started = True
        subprocess.run(["systemctl", "start", SERVICE], check=True)
    except BaseException:
        if not started:
            for name in changed:
                shutil.copy2(original / name, root / "api" / name)
            subprocess.run(["systemctl", "start", SERVICE], check=True)
        print(f"Update did not complete. Backup and diagnostics: {work}", flush=True)
        raise
    for _ in range(30):
        try:
            with urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=2) as response:
                health = json.load(response)
            if health.get("status") == "ok":
                with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as conn:
                    columns = {row[1] for row in conn.execute("PRAGMA table_info(reservations)")}
                    indexes = {row[1] for row in conn.execute("PRAGMA index_list(reservations)")}
                if not {"duration_min", "dispatch_started"} <= columns:
                    raise RuntimeError("New DB columns missing")
                if not {"reservations_open_uid", "reservations_open_student", "reservations_open_room"} <= indexes:
                    raise RuntimeError("Reservation uniqueness indexes missing")
                print(json.dumps({"deployment": "ok", "revision": args.revision, "backup": str(work), "health": health}))
                return
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError(f"Health verification failed. Preserve DB; inspect journalctl -u {SERVICE}. Backup: {work}")


if __name__ == "__main__":
    main()
