"""Update gateway code in place. Never copy, move, delete or replace the booking DB."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen

root = Path.cwd().resolve()
service = "yonsei-practice-gateway.service"
revision = sys.argv[1] if len(sys.argv) == 2 else ""
if os.geteuid() != 0 or not re.fullmatch(r"[0-9a-f]{40}", revision):
    raise SystemExit("Usage (from the gateway directory): python3 campus-deploy/update.py COMMIT_SHA")
configured = subprocess.check_output(["systemctl", "show", service, "-p", "WorkingDirectory", "--value"], text=True).strip()
if Path(configured).resolve() != root:
    raise SystemExit("Gateway installation path mismatch")
python = root / ".venv/bin/python"
files = ["auth_security.py", "auto_return.py", "booking.py", "clock.py", "collector.py", "community.py", "main.py", "models.py", "reservations.py", "rooms.json"]
base = f"https://raw.githubusercontent.com/nanoigajoa/yonsei-music-practice/{revision}"
with tempfile.TemporaryDirectory(prefix="gateway-code-") as work:
    stage = Path(work)
    for name in files:
        if name != "community.py" and not (root / "api" / name).is_file():
            raise SystemExit(f"Existing source missing: {name}")
        with urlopen(f"{base}/api/{name}", timeout=30) as response:
            (stage / name).write_bytes(response.read())
    with urlopen(f"{base}/api/requirements.txt", timeout=30) as response:
        if response.read() != (root / "api/requirements.txt").read_bytes():
            raise SystemExit("Dependencies changed; update environment before deploying")
    subprocess.run([str(python), "-m", "compileall", "-q", str(stage)], check=True)
    subprocess.run(["systemctl", "stop", service], check=True)
    previous = stage / "previous"
    previous.mkdir()
    changed = []
    try:
        for name in files:
            destination = root / "api" / name
            if destination.exists():
                shutil.copy2(destination, previous / name)
            temporary = destination.with_suffix(destination.suffix + ".new")
            shutil.copy2(stage / name, temporary)
            temporary.replace(destination)
            changed.append(name)
    except BaseException:
        for name in changed:
            if (previous / name).exists():
                shutil.copy2(previous / name, root / "api" / name)
            else:
                (root / "api" / name).unlink(missing_ok=True)
        raise
    finally:
        subprocess.run(["systemctl", "start", service], check=True)
for _ in range(30):
    try:
        with urlopen("http://127.0.0.1:8000/health", timeout=2) as response:
            health = json.load(response)
        if health.get("status") == "ok":
            print(json.dumps({"deployment": "ok", "revision": revision, "db": "unchanged", "health": health}))
            break
    except (OSError, ValueError):
        pass
    time.sleep(1)
else:
    raise SystemExit("Service health check failed. Inspect journalctl -u yonsei-practice-gateway.service")
