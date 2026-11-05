"""Publish a collection/status atomically, replaying onto current main on contention."""

import argparse
import json
import os
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from progress_history import ROOT, atomic_json, load_departments, rebuild_index


def git(*args, cwd=None, check=True):
    return subprocess.run(["git", *args], cwd=cwd or ROOT, check=check, text=True, capture_output=True)


def publish(collection, success):
    status = {
        "attempted_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "success": success,
        "run_url": f"{os.environ['GITHUB_SERVER_URL']}/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}",
    }
    if success:
        snapshot = json.loads((collection / "sites.json").read_text())
        if not snapshot.get("collection_complete") or not list((collection / "history").glob("*.json.gz")):
            raise ValueError("Cannot publish incomplete collection/history")
    for attempt in range(5):
        git("fetch", "--quiet", "origin", "main")
        with tempfile.TemporaryDirectory(prefix="progress-publication-") as temporary:
            checkout = Path(temporary) / "checkout"
            git("worktree", "add", "--quiet", "--detach", str(checkout), "FETCH_HEAD")
            try:
                data = checkout / "data"
                atomic_json(data / "refresh-status.json", status)
                if success:
                    for name in ("sites.json", "rules.json"):
                        shutil.copyfile(collection / name, data / name)
                    history = data / "history"
                    history.mkdir(exist_ok=True)
                    for path in (collection / "history").glob("*.json.gz"):
                        destination = history / path.name
                        if destination.exists() and destination.read_bytes() != path.read_bytes():
                            raise ValueError(f"History identity conflict: {path.name}")
                        shutil.copyfile(path, destination)
                    rebuild_index(history)
                atomic_json(data / "departments.json", load_departments(data / "site-departments.csv"))
                git("add", "data", cwd=checkout)
                if git("diff", "--cached", "--quiet", cwd=checkout, check=False).returncode == 0:
                    return
                git("-c", "user.name=github-actions[bot]", "-c",
                    "user.email=41898282+github-actions[bot]@users.noreply.github.com",
                    "commit", "--quiet", "-m", "Refresh Siteimprove progress snapshot" if success else "Record failed Siteimprove refresh",
                    cwd=checkout)
                pushed = git("push", "origin", "HEAD:main", cwd=checkout, check=False)
                if pushed.returncode == 0:
                    return
                print(f"Publication attempt {attempt + 1} rejected; replaying onto latest main.\n{pushed.stderr}")
            finally:
                git("worktree", "remove", "--force", str(checkout))
    raise RuntimeError("Publication failed after five attempts; no successful refresh may be claimed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collection", type=Path, required=True)
    parser.add_argument("--success", action="store_true")
    arguments = parser.parse_args()
    publish(arguments.collection, arguments.success)
