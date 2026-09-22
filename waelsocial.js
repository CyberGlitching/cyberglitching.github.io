const API_BASE = "https://api.wael.sh";

// The pinned signing key. The checkmark indicates authorship by this key
// specifically, not by whatever key the response happens to carry. If a served
// feed presents a different public key, which would be the case after an origin,
// DNS or CDN compromise, nothing is shown as verified.
const PINNED_PUBKEY = "/XKGM2r0/oyl47HkuhDK8JiH5pUJvPlRi8btV03S/mE=";

// waelsocial-v1 is seven lines joined with LF. waelsocial-v2, used only for
// edited posts, is eight lines, with `edited:<ts>` inserted after `ts:`. A post
// is v2 if and only if it carries edited_at. ts remains the original publish
// time, and both timestamps are covered by the signature, so an edit cannot be
// backdated or concealed.
function canonicalize(entry) {
    const sourceUrl = entry.source?.url ?? "";
    const mediaHash = entry.media?.sha256 ?? "";
    const lines = [
        entry.edited_at ? "waelsocial-v2" : "waelsocial-v1",
        `id:${entry.id}`,
        `ts:${entry.ts}`,
    ];
    if (entry.edited_at) lines.push(`edited:${entry.edited_at}`);
    lines.push(
        `type:${entry.type}`,
        `source:${sourceUrl}`,
        `media:${mediaHash}`,
        `text:${entry.text}`,
    );
    return lines.join("\n");
}

async function verifyEntry(entry, pubKey) {
    if (entry.type === "relay" || !entry.sig) return null;
    const msg = new TextEncoder().encode(canonicalize(entry));
    const sig = Uint8Array.from(atob(entry.sig), (c) => c.charCodeAt(0));
    try { return await crypto.subtle.verify({ name: "Ed25519" }, pubKey, sig, msg); }
    catch { return false; }
}

// This always uses the pinned key, never a key read out of the response.
async function importPinnedKey() {
    return await crypto.subtle.importKey(
        "raw", Uint8Array.from(atob(PINNED_PUBKEY), (c) => c.charCodeAt(0)),
        { name: "Ed25519" }, false, ["verify"]);
}

function elt(tag, className, text) {
    const n = document.createElement(tag);
    n.className = className;
    n.textContent = text;
    return n;
}

const KNOWN_TYPES = ["mine", "take", "relay"];
let renderSeq = 0;

async function renderFeed(feed, filter, host) {
    let pubKey = null;
    try {
        pubKey = await importPinnedKey();
    } catch {
        console.warn("[waelsocial] this browser cannot verify Ed25519, so entries are shown unverified");
    }

    const inFilter = (e) =>
        filter === "mine" ? (e.type === "mine" || e.type === "take") :
            filter === "signal" ? (e.type === "take" || e.type === "relay") : true;

    const token = ++renderSeq;
    host.replaceChildren();
    const shown = feed.entries.filter(inFilter);
    if (shown.length === 0) { host.replaceChildren(elt("p", "ws-empty", "Nothing here yet.")); return; }

    for (const e of shown) {
        if (token !== renderSeq) return;   // a newer render, from a filter click, took over

        // Feed data is untrusted, because relay titles come from external feeds.
        // Everything here is built with DOM APIs; there is no innerHTML in this loop.
        const el = elt("article", "ws-post", "");
        const meta = elt("div", "ws-meta", "");
        const type = KNOWN_TYPES.includes(e.type) ? e.type : "relay";
        const badge = elt("span", "ws-badge checking", "checking…");
        meta.append(elt("span", `ws-kind ${type}`, type),
            elt("span", "ws-date", String(e.ts ?? "").slice(0, 10)),
            badge);
        el.append(meta, elt("div", "ws-body", e.text));

        if (typeof e.source?.url === "string" && /^https:\/\//i.test(e.source.url)) {
            const a = elt("a", "ws-src", `↗ ${e.source.title ?? e.source.url}`);
            a.href = e.source.url;
            a.target = "_blank";
            a.rel = "noopener";
            el.append(a);
        }
        host.appendChild(el);

        const ok = pubKey ? await verifyEntry(e, pubKey)
            : (e.type === "relay" || !e.sig) ? null : undefined;
        if (ok === null) { badge.className = "ws-badge relay"; badge.textContent = "relayed, not signed"; }
        else if (ok === undefined) { badge.className = "ws-badge unknown"; badge.textContent = "unverified, this browser lacks Ed25519"; }
        else if (ok) {
            badge.className = "ws-badge ok";
            badge.textContent = e.edited_at
                ? `✓ verified, edited ${String(e.edited_at).slice(0, 10)}`
                : "✓ verified";
        }
        else { badge.className = "ws-badge bad"; badge.textContent = "✗ signature check failed"; }
    }
}

const FEED_TIMEOUT_MS = 8000;

async function loadFeed() {
    // There is no fallback here. If the API is down, the caller displays its
    // error state instead. The case that matters is a host that accepts the
    // connection and then stalls: without a deadline, the feed page stays on
    // "Loading feed…" and the card on the home page stays on "Verifying"
    // indefinitely, which looks like a bug rather than an outage. Both already
    // have failure messages written, and the timeout lets them be shown.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FEED_TIMEOUT_MS);
    try {
        const r = await fetch(`${API_BASE}/api/feed`, { cache: "no-store", signal: ctl.signal });
        if (!r.ok) throw new Error(`feed HTTP ${r.status}`);
        return await r.json();
    } catch (err) {
        if (err.name === "AbortError") throw new Error(`feed timed out after ${FEED_TIMEOUT_MS} ms`);
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

// One fetch per page load, shared by the feed page and the homepage card.
let feedPromise = null;
function getFeed() {
    if (!feedPromise) feedPromise = loadFeed();
    return feedPromise;
}

// The verify card on the home page reuses this logic rather than
// reimplementing it, so there is a single canonicalize and verify path.
window.WaelSocial = { getFeed, verifyEntry, importPinnedKey, PINNED_PUBKEY };

// There is nothing to filter until a feed loads. A control that responds to a
// click by doing nothing is more confusing than one that is visibly disabled.
function setFiltersEnabled(on) {
    document.querySelectorAll("[data-ws-filter]").forEach((b) => {
        b.disabled = !on;
        b.title = on ? "" : "Filtering requires the feed, which could not be loaded.";
    });
}

async function initWaelSocial() {
    const host = document.getElementById("ws-feed");
    if (!host) return;
    let feed;
    try {
        feed = await getFeed();
        if (feed?.v !== 1 || typeof feed.pubkey !== "string" || !Array.isArray(feed.entries)) {
            throw new Error("unexpected feed shape");
        }
    } catch (err) {
        console.warn("[waelsocial] feed unusable:", err);
        setFiltersEnabled(false);
        host.replaceChildren(elt("p", "ws-error", "The feed is unavailable at the moment. Please check back later."));
        return;
    }
    if (feed.pubkey !== PINNED_PUBKEY) {
        console.error("[waelsocial] feed pubkey does not match the pinned key, so verification is refused");
        setFiltersEnabled(false);
        host.replaceChildren(elt("p", "ws-error",
            "This feed was not signed by the key pinned for wael.sh, so it will not be displayed as verified."));
        return;
    }
    setFiltersEnabled(true);
    let filter = "mine";  // the default view is authored work rather than relayed CVEs
    await renderFeed(feed, filter, host);
    document.querySelectorAll("[data-ws-filter]").forEach((b) =>
        b.addEventListener("click", () => {
            document.querySelectorAll("[data-ws-filter]").forEach((x) => {
                x.classList.remove("on");
                // The class only affects appearance. aria-pressed is what a
                // screen reader uses to determine which filter is active.
                x.setAttribute("aria-pressed", "false");
            });
            b.classList.add("on");
            b.setAttribute("aria-pressed", "true");
            filter = b.dataset.wsFilter;
            renderFeed(feed, filter, host);
        }));
}

document.addEventListener("DOMContentLoaded", initWaelSocial);
