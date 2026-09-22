#!/usr/bin/env python3
"""waelsocial console: a Tailnet-only operator dashboard. This is not public
and has no login.

The security model is structural, and is inherited from the chapter 5 console:

  * It binds only to CT 102's Tailscale interface address, so reaching this page
    at all requires being on the Tailnet. Network membership is the
    authentication.
  * It runs as `wsdash`, a read-only database role with SELECT on entries and
    feed_meta that cannot traverse /home/claude. The web process holds no
    database write grants.
  * Publishing goes through `sudo -n -u claude sign-post`, using argv arrays and
    stdin. There is no shell anywhere in the invocation path.
  * Cross-site POSTs are refused. Host must match the bind address, and any
    Origin header must match this origin.
  * All external text, such as CVE summaries and titles, is rendered through
    Jinja autoescaping, and the client-side JavaScript only ever assigns through
    textContent.
"""

import base64
import fcntl
import json
import os
import subprocess
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg2
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from flask import Flask, abort, redirect, render_template, request, url_for

PORT = int(os.environ.get("CONSOLE_PORT", "8081"))
QUEUE_PATH = Path("/srv/waelsocial/queue.json")
DSN = "dbname=waelsocial"  # local socket, peer auth as wsdash, a SELECT-only role
SIGN_POST = ["sudo", "-n", "-u", "claude", "--", "/home/claude/bin/sign-post"]
FEED_REMOVE = ["sudo", "-n", "-u", "claude", "--", "/home/claude/bin/feed-remove"]
RELAY_CAP = 2

app = Flask(__name__)


def tailscale_ip() -> str:
    """The Tailscale interface address, which is the only address we bind."""
    out = subprocess.run(["ip", "-j", "addr", "show", "tailscale0"],
                         capture_output=True, text=True, check=True).stdout
    for iface in json.loads(out):
        for a in iface.get("addr_info", []):
            if a.get("family") == "inet":
                return a["local"]
    raise RuntimeError("tailscale0 has no IPv4 address; check that tailscale is up")


BIND_IP = tailscale_ip()


# ── data access (read-only) ─────────────────────────────────────────

def db():
    conn = psycopg2.connect(DSN)
    conn.set_client_encoding("UTF8")  # do not let the ambient locale affect signed bytes
    conn.set_session(readonly=True)
    return conn


def feed_stats() -> dict:
    stats = {"relays_week": 0, "takes": 0, "relays": 0, "mine": 0, "pubkey": ""}
    cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        conn = db()
        try:
            cur = conn.cursor()
            cur.execute("SELECT type, count(*) FROM entries GROUP BY type")
            counts = dict(cur.fetchall())
            cur.execute("SELECT count(*) FROM entries WHERE type = 'relay' AND ts >= %s", (cutoff,))
            relays_week = cur.fetchone()[0]
            cur.execute("SELECT pubkey FROM feed_meta")
            row = cur.fetchone()
            stats.update(relays_week=relays_week, takes=counts.get("take", 0),
                         relays=counts.get("relay", 0), mine=counts.get("mine", 0),
                         pubkey=row[0] if row else "")
        finally:
            conn.close()
    except Exception:
        pass
    return stats


def get_entry(entry_id: str) -> dict | None:
    return next((e for e in published_entries() if e["id"] == entry_id), None)


def published_entries() -> list[dict]:
    cols = ("id", "ts", "type", "text", "tags", "source_title", "source_url",
            "media_url", "media_sha256", "media_alt", "sig", "edited_at")
    conn = db()
    try:
        cur = conn.cursor()
        cur.execute(f"SELECT {', '.join(cols)} FROM entries ORDER BY ts DESC")
        entries = [dict(zip(cols, row)) for row in cur.fetchall()]
        for e in entries:
            e["source_url"] = safe_url(e["source_url"]) or None
        return entries
    finally:
        conn.close()


def canonical(e: dict) -> bytes:
    """A byte-identical twin of canonicalize() in waelsocial.js and sign-post.
    Version 2, which has eight lines with `edited:` after `ts:`, is used if and
    only if the entry carries edited_at."""
    edited = e.get("edited_at")
    lines = ["waelsocial-v2" if edited else "waelsocial-v1",
             f"id:{e['id']}", f"ts:{e['ts']}"]
    if edited:
        lines.append(f"edited:{edited}")
    lines += [f"type:{e['type']}", f"source:{e.get('source_url') or ''}",
              f"media:{e.get('media_sha256') or ''}", f"text:{e['text']}"]
    return "\n".join(lines).encode("utf-8")


def verify_entries(entries: list[dict], pubkey: str) -> None:
    """Server-side Ed25519 check against the pinned public key. This is
    public-key arithmetic only; the console never holds private key material.
    It is done here rather than in the browser because crypto.subtle requires a
    secure context, and the console is served over plain HTTP on Tailscale."""
    try:
        pk = Ed25519PublicKey.from_public_bytes(base64.b64decode(pubkey))
    except Exception:
        for e in entries:
            e["verify"] = "relay" if e["type"] == "relay" else "unavailable"
        return
    for e in entries:
        if e["type"] == "relay":
            e["verify"] = "relay"
            continue
        try:
            pk.verify(base64.b64decode(e.get("sig") or ""), canonical(e))
            e["verify"] = "ok-edited" if e.get("edited_at") else "ok"
        except Exception:
            e["verify"] = "bad"


QUEUE_LOCK = QUEUE_PATH.with_suffix(".json.lock")


@contextmanager
def queue_lock():
    """Serialize read-modify-write cycles on queue.json across the ingester,
    sign-post and this console. Each of them loads the file, changes it and
    renames a new copy over it, so without a lock a dismissal that lands during
    an ingest run is undone, or the ingest run's additions are lost."""
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


def load_queue() -> dict:
    try:
        return json.loads(QUEUE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"candidates": [], "seen": []}


def save_queue(q: dict) -> None:
    """Write to a temporary file and rename it into place, leaving the result
    group-writable as sign-post's writer does. queue.json is shared mutable
    state between claude, which runs the ingester and sign-post, and wsdash,
    which does triage, so whichever process wrote last must leave the mode at
    660 or the other side's next write fails."""
    # The temporary name includes the process id. With a fixed name, two
    # concurrent writers share one scratch file, and the second rename fails
    # with ENOENT after the first has already moved it away.
    tmp = QUEUE_PATH.with_suffix(f".json.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(q, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o660)
    tmp.replace(QUEUE_PATH)


def sev_key(c: dict) -> float:
    try:
        return float(c.get("severity"))
    except (TypeError, ValueError):
        return -1.0


def safe_url(u) -> str:
    """External URLs render as links only if they are plain http or https.
    Jinja escaping prevents HTML injection but not a javascript: scheme."""
    u = str(u or "")
    return u if u.startswith(("https://", "http://")) else ""


def grouped_queue(sort: str) -> tuple[list, list]:
    cands = load_queue().get("candidates", [])
    for c in cands:
        c["url"] = safe_url(c.get("url"))
    kev = [c for c in cands if c.get("source") == "kev"]
    nvd = [c for c in cands if c.get("source") != "kev"]
    kev.sort(key=lambda c: c.get("added", ""), reverse=True)
    if sort == "date":
        nvd.sort(key=lambda c: (c.get("date", ""), sev_key(c)), reverse=True)
    else:
        nvd.sort(key=lambda c: (sev_key(c), c.get("date", "")), reverse=True)
    return kev, nvd


def find_candidate(cve: str):
    cand = next((c for c in load_queue().get("candidates", [])
                 if c.get("cve", "").upper() == cve.upper()), None)
    if cand:
        cand["url"] = safe_url(cand.get("url"))
    return cand


# ── privileged tool invocation, using argv and stdin only, never a shell ───

def _run_tool(base: list[str], args: list[str], stdin_text: str | None = None,
              full_stdout: bool = False) -> tuple[bool, str]:
    try:
        r = subprocess.run(base + args, input=stdin_text, text=True,
                           capture_output=True, timeout=30)
    except subprocess.TimeoutExpired:
        return False, f"{base[-1]} timed out"
    if full_stdout and r.returncode == 0:
        return True, r.stdout
    out = (r.stdout + r.stderr).strip()
    return r.returncode == 0, out[-500:]


def run_sign_post(args: list[str], stdin_text: str | None = None,
                  full_stdout: bool = False) -> tuple[bool, str]:
    return _run_tool(SIGN_POST, args, stdin_text, full_stdout)


def run_feed_remove(args: list[str]) -> tuple[bool, str]:
    return _run_tool(FEED_REMOVE, args)


# ── request guards & headers ────────────────────────────────────────

@app.before_request
def deny_cross_site():
    if request.method != "POST":
        return
    me = f"{BIND_IP}:{PORT}"
    if request.host != me:
        abort(403)
    origin = request.headers.get("Origin")
    if origin and origin != f"http://{me}":
        abort(403)


@app.after_request
def harden(resp):
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Cache-Control"] = "no-store"
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self'; "
        "img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'")
    return resp


@app.context_processor
def inject_shell():
    s = feed_stats()
    return {"stats": s, "relay_left": max(0, RELAY_CAP - s["relays_week"]),
            "relay_cap": RELAY_CAP,
            "queue_count": len(load_queue().get("candidates", [])),
            "flash": request.args.get("m", ""),
            "flash_err": request.args.get("e") == "1"}


def done(view: str, msg: str, ok: bool):
    return redirect(url_for(view, m=msg, e="0" if ok else "1"))


# ── views ───────────────────────────────────────────────────────────

@app.get("/")
def home():
    return redirect(url_for("queue_view"))


@app.get("/queue")
def queue_view():
    sort = request.args.get("sort", "sev")
    kev, nvd = grouped_queue(sort)
    return render_template("queue.html", kev=kev, nvd=nvd, sort=sort, active="queue")


@app.get("/published")
def published_view():
    entries = published_entries()
    verify_entries(entries, feed_stats()["pubkey"])
    return render_template("published.html", entries=entries, active="published")


@app.get("/compose")
def compose_view():
    cve = request.args.get("cve", "").strip()
    cand = find_candidate(cve) if cve else None
    if cve and not cand:
        return done("queue_view", f"{cve} is not in the queue", False)
    return render_template("compose.html", cand=cand, active="compose")


@app.get("/edit")
def edit_view():
    e = get_entry(request.args.get("id", "").strip())
    if e is None:
        return done("published_view", "no such entry", False)
    if e["type"] == "relay":
        return done("published_view", "relays are unsigned and cannot be edited", False)
    return render_template("edit.html", e=e, active="published")


# ── actions ─────────────────────────────────────────────────────────

@app.post("/publish/mine")
def publish_mine():
    text = request.form.get("text", "").strip()
    tags = request.form.get("tags", "").strip()
    if not text:
        return done("compose_view", "empty post text", False)
    args = ["--type", "mine"] + (["--tags", tags] if tags else [])
    ok, out = run_sign_post(args, stdin_text=text)
    return done("published_view" if ok else "compose_view", out, ok)


@app.post("/publish/take")
def publish_take():
    text = request.form.get("text", "").strip()
    cve = request.form.get("cve", "").strip()
    if not text:
        return done("compose_view", "empty take text", False)
    ok, out = run_sign_post(["--take-from", cve], stdin_text=text)
    return done("published_view" if ok else "queue_view", out, ok)


@app.post("/publish/relay")
def publish_relay():
    cve = request.form.get("cve", "").strip()
    ok, out = run_sign_post(["--publish-relay", cve])
    return done("published_view" if ok else "queue_view", out, ok)


@app.post("/preview")
def preview():
    """Dry-run the exact publish path, passing the same argv and stdin into
    sign-post, and return the entry as it would be signed. Nothing is written.
    The returned signature is verified server-side, so the badge reflects a real
    check rather than being decorative."""
    text = request.form.get("text", "")
    kind = request.form.get("kind", "mine")
    if not text.strip():
        return {"ok": False, "error": "type something to preview"}
    if kind == "edit":
        entry_id = request.form.get("id", "").strip()
        tags = request.form.get("tags", "").strip()
        args = ["--edit", entry_id, "--tags", tags, "--dry-run"]
    elif kind == "take":
        cve = request.form.get("cve", "").strip()
        if not find_candidate(cve):
            return {"ok": False, "error": f"{cve} is not in the queue"}
        args = ["--take-from", cve, "--dry-run"]
    else:
        tags = request.form.get("tags", "").strip()
        args = ["--type", "mine"] + (["--tags", tags] if tags else []) + ["--dry-run"]
    ok, out = run_sign_post(args, stdin_text=text, full_stdout=True)
    if not ok:
        return {"ok": False, "error": out}
    marker = "entry JSON (not written):"
    if marker not in out:
        return {"ok": False, "error": "unexpected sign-post output"}
    try:
        entry = json.loads(out.split(marker, 1)[1])
    except (ValueError, KeyError) as exc:
        # A truncated or reshaped dry-run payload is a preview failure rather
        # than a server error, so the operator sees the reason instead of a
        # stack trace.
        return {"ok": False, "error": f"could not parse sign-post output: {exc}"}
    flat = {"id": entry["id"], "ts": entry["ts"], "type": entry["type"],
            "text": entry["text"], "tags": entry.get("tags", []),
            "source_url": (entry.get("source") or {}).get("url"),
            "source_title": (entry.get("source") or {}).get("title"),
            "media_sha256": (entry.get("media") or {}).get("sha256"),
            "sig": entry.get("sig"), "edited_at": entry.get("edited_at")}
    verify_entries([flat], feed_stats()["pubkey"])
    return {"ok": True, "entry": flat,
            "canonical": canonical(flat).decode("utf-8"),
            "verified": flat["verify"] in ("ok", "ok-edited")}


@app.post("/edit")
def edit_entry():
    """Runs sign-post --edit, which changes text and tags only, re-signs the
    entry as waelsocial-v2, and archives the pre-edit row server-side through
    the claude-owned tool. wsdash still writes nothing itself."""
    entry_id = request.form.get("id", "").strip()
    text = request.form.get("text", "").strip()
    tags = request.form.get("tags", "").strip()
    if not entry_id or not text:
        return done("published_view", "missing entry id or text", False)
    ok, out = run_sign_post(["--edit", entry_id, "--tags", tags], stdin_text=text)
    return done("published_view", out, ok)


@app.post("/remove")
def remove_entry():
    """Archive and then delete through feed-remove. The console never deletes
    directly, because wsdash has no database write grants. The claude-owned tool
    performs the archive and delete in one transaction, and the archive table is
    append-only."""
    entry_id = request.form.get("id", "").strip()
    if not entry_id:
        return done("published_view", "no entry id given", False)
    ok, out = run_feed_remove(["--reason", "console", "--", entry_id])
    return done("published_view", out, ok)


@app.post("/queue/dismiss")
def queue_dismiss():
    cves = {c.strip().upper() for c in request.form.getlist("cve") if c.strip()}
    if not cves:
        return done("queue_view", "nothing selected", False)
    with queue_lock():
        q = load_queue()
        q.setdefault("seen", [])
        kept, dropped = [], []
        for c in q.get("candidates", []):
            if c.get("cve", "").upper() in cves:
                dropped.append(c["cve"])
                if c["cve"] not in q["seen"]:
                    q["seen"].append(c["cve"])
            else:
                kept.append(c)
        q["candidates"] = kept
        save_queue(q)
    n = len(dropped)
    return done("queue_view", f"dismissed {n} candidate{'s' if n != 1 else ''}", n > 0)


if __name__ == "__main__":
    print(f"waelsocial console on http://{BIND_IP}:{PORT} (Tailnet only)", flush=True)
    app.run(host=BIND_IP, port=PORT, threaded=True, debug=False)
