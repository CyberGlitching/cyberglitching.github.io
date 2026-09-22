#!/usr/bin/env python3
"""waelsocial advisory ingester, which pulls CISA KEV and NVD into a candidate
queue.

This program never writes the feed. It writes /srv/waelsocial/queue.json only.
Publication is always a deliberate human action, going through the queue CLI or
the console and then sign-post. The sources are US government public-domain data
by design; vendor blogs and news outlets should not be added.

It runs from cron as `claude`. If a source is unreachable, the run logs that and
changes nothing: the queue is written atomically, and per-source state advances
only after a successful pull, so the next run retries the missed window.
"""

import fcntl
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE = Path(os.environ.get("WAELSOCIAL_DATA", "/srv/waelsocial"))
QUEUE_PATH = BASE / "queue.json"
STATE_PATH = BASE / "ingest-state.json"
CONFIG_PATH = BASE / "ingest-config.json"
LOG_PATH = BASE / "ingest.log"
FEED_PATH = Path(os.environ.get("WAELSOCIAL_FEED", str(BASE / "feed.json")))


QUEUE_LOCK = QUEUE_PATH.with_suffix(".json.lock")


@contextmanager
def queue_lock():
    """Serialize read-modify-write cycles on queue.json across the ingester,
    the console and sign-post. Each of them loads the file, changes it and
    renames a new copy over it, so two overlapping runs would each write a
    document built from its own stale read, and the later rename would drop
    the other's edits."""
    QUEUE_LOCK.touch(exist_ok=True)
    try:
        os.chmod(QUEUE_LOCK, 0o660)   # both claude and wsdash take this lock
    except OSError:
        pass
    with open(QUEUE_LOCK, "r+", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


USER_AGENT = "waelsocial-ingest/1.0 (+https://wael.sh; shahadehwael@gmail.com)"
LOG_MAX_LINES = 2000

DEFAULT_CONFIG = {
    "kev_url": "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json",
    "nvd_url": "https://services.nvd.nist.gov/rest/json/cves/2.0",
    # A candidate is kept if its score is at least min_score_keyword and the
    # description matches a keyword on a word boundary. The no-keyword network
    # arm, min_score_network, produced roughly 87 low-value CVEs a week when
    # measured, so it is disabled by setting it to null. Put a number here to
    # re-enable it.
    "nvd_min_score_keyword": 8.0,
    "nvd_min_score_network": None,
    "keywords": [
        "proxmox", "cloudflare", "cloudflared", "postgres", "postgresql",
        "rust", "wazuh", "debian", "lxc", "container escape", "openssh",
        "sshd", "linux kernel", "macos", "xnu", "tailscale", "wireguard",
        "ed25519", "sudo", "systemd",
    ],
    "backfill_days": 14,   # how far back the first run looks, and no further
    "max_queue": 50,       # beyond this size, additions are logged and skipped
}


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def log(msg: str) -> None:
    line = f"{now_utc().strftime('%Y-%m-%dT%H:%M:%SZ')} {msg}"
    print(line, flush=True)
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def trim_log() -> None:
    if not LOG_PATH.exists():
        return
    lines = LOG_PATH.read_text(encoding="utf-8").splitlines()
    if len(lines) > LOG_MAX_LINES:
        LOG_PATH.write_text("\n".join(lines[-LOG_MAX_LINES:]) + "\n", encoding="utf-8")


def load_json(path: Path, default):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return default


def save_json_atomic(path: Path, obj, mode: int = 0o660) -> None:
    # The temporary name includes the process id. With a fixed name, two
    # concurrent writers share one scratch file, and the second rename fails
    # with ENOENT after the first has already moved it away.
    tmp = path.with_suffix(f"{path.suffix}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
    try:
        os.chmod(path, mode)
    except OSError:
        pass


def fetch_json(url: str, timeout: int = 30):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def pull_kev(cfg: dict, state: dict) -> tuple[list, dict]:
    """Everything in KEV is worth queuing, since the catalogue is already
    filtered down to vulnerabilities known to be actively exploited."""
    since = state.get("kev_last_added") or (
        (now_utc() - timedelta(days=cfg["backfill_days"])).strftime("%Y-%m-%d"))
    data = fetch_json(cfg["kev_url"])
    out, newest = [], since
    for v in data.get("vulnerabilities", []):
        added = v.get("dateAdded", "")
        if added < since:
            continue
        cve = v.get("cveID", "").upper()
        if not cve:
            continue
        summary = (f"{v.get('vulnerabilityName', cve)}. "
                   f"{v.get('shortDescription', '').strip()} "
                   f"(CISA KEV: known to be actively exploited.)")
        out.append({
            "cve": cve,
            "source": "kev",
            "title": f"CISA KEV — {cve}",
            "summary": summary[:500],
            "severity": "KEV",
            "vector": "",
            "url": f"https://nvd.nist.gov/vuln/detail/{cve}",
            "date": added,
            "added": now_utc().strftime("%Y-%m-%dT%H:%M:%SZ"),
        })
        newest = max(newest, added)
    return out, {"kev_last_added": newest}


def cvss_of(cve_obj: dict) -> tuple[float, str]:
    metrics = cve_obj.get("metrics", {})
    for key in ("cvssMetricV40", "cvssMetricV31", "cvssMetricV30", "cvssMetricV2"):
        for m in metrics.get(key, []):
            data = m.get("cvssData", {})
            score = data.get("baseScore")
            if score is not None:
                return float(score), data.get("attackVector", "")
    return 0.0, ""


def pull_nvd(cfg: dict, state: dict) -> tuple[list, dict]:
    # The window is based on the published date. Using lastMod would bring back
    # years-old CVEs every time NVD re-analyzes them in bulk. Vulnerabilities
    # that are old but newly exploited still arrive through KEV, which is the
    # appropriate channel for them.
    start = state.get("nvd_last_pub") or (
        (now_utc() - timedelta(days=cfg["backfill_days"])).strftime("%Y-%m-%dT%H:%M:%S.000+00:00"))
    end = now_utc().strftime("%Y-%m-%dT%H:%M:%S.000+00:00")
    # Word boundaries matter here, so that "rust" does not match "trust" or
    # "untrusted".
    patterns = [re.compile(r"\b" + re.escape(k.lower()) + r"\b") for k in cfg["keywords"]]
    net_min = cfg.get("nvd_min_score_network")

    out, start_index, total, pages = [], 0, None, 0
    checked = 0
    while total is None or start_index < total:
        pages += 1
        if pages > 5:  # a guard against crawling the entire NVD dataset
            log("nvd: page cap hit, stopping early")
            break
        params = urllib.parse.urlencode({
            "pubStartDate": start,
            "pubEndDate": end,
            "resultsPerPage": 2000,
            "startIndex": start_index,
        })
        data = fetch_json(f"{cfg['nvd_url']}?{params}", timeout=60)
        total = data.get("totalResults", 0)
        batch = data.get("vulnerabilities", [])
        start_index += len(batch) or 2000
        for item in batch:
            c = item.get("cve", {})
            checked += 1
            if c.get("vulnStatus") in ("Rejected", "Withdrawn"):
                continue
            desc = next((d["value"] for d in c.get("descriptions", [])
                         if d.get("lang") == "en"), "")
            score, vector = cvss_of(c)
            keyword_hit = any(p.search(desc.lower()) for p in patterns)
            if not ((score >= cfg["nvd_min_score_keyword"] and keyword_hit) or
                    (net_min is not None and score >= net_min and vector == "NETWORK")):
                continue
            cve = c.get("id", "").upper()
            out.append({
                "cve": cve,
                "source": "nvd",
                "title": f"NVD — {cve}",
                "summary": desc.strip()[:500],
                "severity": score,
                "vector": vector,
                "url": f"https://nvd.nist.gov/vuln/detail/{cve}",
                "date": (c.get("published") or "")[:10],
                "added": now_utc().strftime("%Y-%m-%dT%H:%M:%SZ"),
            })
        if not batch:
            break
    return out, {"nvd_last_pub": end, "_checked": checked}


def main() -> None:
    cfg = {**DEFAULT_CONFIG, **load_json(CONFIG_PATH, {})}
    if not CONFIG_PATH.exists():
        save_json_atomic(CONFIG_PATH, DEFAULT_CONFIG)
    state = load_json(STATE_PATH, {})

    # The deduplication set comes from a read taken before the fetch. It is only
    # used to skip candidates, and it is recomputed under the lock before the
    # merge, so a stale read here can cost a wasted fetch but cannot lose a
    # write.
    pre = load_json(QUEUE_PATH, {"candidates": [], "seen": []})
    seen = set(pre.get("seen", [])) | {c["cve"] for c in pre.get("candidates", [])}
    try:  # anything already in the feed as r-<cve> counts as seen permanently
        feed = load_json(FEED_PATH, {"entries": []})
        seen |= {e["id"][2:].upper() for e in feed["entries"] if e["id"].startswith("r-")}
    except Exception as e:
        log(f"warn: could not read feed for dedup: {e}")

    # The network work happens first and the lock is taken afterwards. Pulling
    # KEV and up to five NVD pages can take minutes, and holding the queue lock
    # for that long would block the console's dismiss button for the whole run.
    pulled, summary = [], []
    for name, puller in (("kev", pull_kev), ("nvd", pull_nvd)):
        try:
            cands, new_state = puller(cfg, state)
            checked = new_state.pop("_checked", len(cands))
            fresh = [c for c in cands if c["cve"] not in seen]
            pulled.extend(fresh)
            seen |= {c["cve"] for c in fresh}
            state.update(new_state)  # this advances only after a successful pull
            summary.append(f"{name}: +{len(fresh)} (matched {len(cands)}, checked {checked})")
        except Exception as e:
            summary.append(f"{name}: failed ({type(e).__name__}: {e}), and will retry on the next run")

    with queue_lock():
        queue = load_json(QUEUE_PATH, {"candidates": [], "seen": []})
        queue.setdefault("candidates", [])
        queue.setdefault("seen", [])
        # Re-check against the queue as it stands now. An operator may have
        # dismissed or published something while the fetch was running, and this
        # merge should not undo a dismissal.
        current = set(queue["seen"]) | {c["cve"] for c in queue["candidates"]}
        for c in pulled:
            if c["cve"] in current:
                continue
            if len(queue["candidates"]) >= cfg["max_queue"]:
                log(f"warn: queue at max_queue={cfg['max_queue']}, skipping {c['cve']}")
                continue
            queue["candidates"].append(c)
            current.add(c["cve"])
        queue["candidates"].sort(key=lambda c: c["date"], reverse=True)
        save_json_atomic(QUEUE_PATH, queue)

    save_json_atomic(STATE_PATH, state, mode=0o640)
    log(f"run done: {'; '.join(summary)}; queue={len(queue['candidates'])}")
    trim_log()


if __name__ == "__main__":
    main()
