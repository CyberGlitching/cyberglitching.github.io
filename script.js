const PAGES = ["home", "work", "homelab", "feed", "writing", "about", "contact", "privacy"];
const LEGACY = { "#feed": "feed", "#about": "about", "#projects": "work", "#contact": "contact", "#lab": "homelab" };
const REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ============================================================
   Routing

   Routing happens client-side on the hash, so the server only ever serves one
   document and crawlers index a single URL. Someone who bookmarks or shares
   #/homelab should still get a tab title and link preview describing the page
   they were looking at, so the title and the description and og metadata are
   updated to match the current route.
   ============================================================ */
const META = {
  home: ["Wael Shahadeh — Cybersecurity Portfolio",
    "Wael Shahadeh, cybersecurity senior at Marist University. Malware research, network analysis, secure lab builds, and tooling whose output you can verify yourself."],
  work: ["Work — Wael Shahadeh",
    "Four case studies across research, engineering and community work, each covering the problem, the approach taken and the result."],
  homelab: ["Homelab — Wael Shahadeh",
    "A segmented lab network with three segments, a single firewall between them, and an isolated VLAN that has no route out."],
  feed: ["WaelSocial — a signed feed",
    "Entries signed offline with Ed25519 and verified in your own browser against a public key pinned in the page."],
  writing: ["Writing — Wael Shahadeh",
    "Notes and write-ups on key pinning and macOS detection research."],
  about: ["About — Wael Shahadeh",
    "Cybersecurity senior at Marist University, working on analysis, tooling and the human side of security."],
  contact: ["Contact — Wael Shahadeh",
    "Open to internships, research collaborations and security work."],
  privacy: ["Privacy — wael.sh",
    "No cookies, analytics or third-party requests. A description of what this site collects, written against the actual code."],
};

function setMeta(selector, value) {
  const el = document.head.querySelector(selector);
  if (el) el.setAttribute("content", value);
}

function applyMeta(page) {
  const [title, description] = META[page] || META.home;
  document.title = title;
  setMeta('meta[name="description"]', description);
  setMeta('meta[property="og:title"]', title);
  setMeta('meta[property="og:description"]', description);
  const url = "https://wael.sh/" + (page === "home" ? "" : "#/" + page);
  setMeta('meta[property="og:url"]', url);
  const canonical = document.head.querySelector('link[rel="canonical"]');
  if (canonical) canonical.setAttribute("href", url);
}

// Not every hash is a route. "#main" belongs to the skip link, and an in-page
// anchor should scroll without sending the visitor back to the home page.
function isRouteHash(raw) {
  if (!raw || raw === "#" || raw === "#/") return true;
  if (LEGACY[raw]) return true;
  return PAGES.includes(raw.replace(/^#\/?/, ""));
}

function currentPage() {
  const raw = location.hash;
  if (LEGACY[raw]) return LEGACY[raw];
  const name = raw.replace(/^#\/?/, "");
  return PAGES.includes(name) ? name : "home";
}

function showPage(page) {
  document.querySelectorAll("[data-page]").forEach((s) => {
    s.hidden = s.dataset.page !== page;
  });
  document.querySelectorAll("[data-nav]").forEach((a) => {
    const on = a.dataset.nav === page;
    a.classList.toggle("on", on);
    // aria-current is what tells a screen reader which nav item is the current
    // page. The .on class only affects appearance.
    on ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current");
  });
  applyMeta(page);
  page === "home" ? startNet() : stopNet();
  sweepReveals();
}

// After a route change, keyboard and screen-reader users would otherwise be
// left with focus on a link that no longer exists. Moving focus to the new
// region means the next Tab continues from the right place and the region is
// announced.
function focusPage(page) {
  const el = document.querySelector(`[data-page="${page}"]`);
  if (el) el.focus({ preventScroll: true });
}

// Work to run once the destination page is on screen, such as scrolling to a
// section or opening a case study. It cannot run on a bare requestAnimationFrame,
// because navigation ends with scrollTo(top: 0) and whichever of the two runs
// second takes effect. Queuing it here means it always runs after the router
// has finished.
let afterNav = null;

function runAfterNav() {
  const fn = afterNav;
  afterNav = null;
  if (fn) fn();
}

function go(page, then) {
  closePalette();
  closeMega();
  closeNav();
  afterNav = then || null;
  const hash = page === "home" ? "#/" : "#/" + page;
  if (location.hash === hash) {       // hashchange won't fire; do the work here
    showPage(page);
    focusPage(page);
    window.scrollTo({ top: 0 });
    runAfterNav();
  } else {
    window.scrollTo({ top: 0 });
    location.hash = hash;             // the hashchange handler finishes the job
  }
}

window.addEventListener("hashchange", () => {
  // An in-page anchor such as the skip link's #main is not a navigation.
  // Re-routing on it would send someone reading /#/work back to the home page.
  if (!isRouteHash(location.hash)) return;
  closeNav();
  const page = currentPage();
  showPage(page);
  focusPage(page);
  window.scrollTo({ top: 0 });
  runAfterNav();
});

const yearEl = document.getElementById("year");
if (yearEl) yearEl.textContent = new Date().getFullYear();

const toTop = document.getElementById("toTop");
if (toTop) toTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: REDUCED ? "auto" : "smooth" }));

/* ============================================================
   Mobile nav drawer
   ============================================================ */
const navEl = document.querySelector(".nav");
const navToggle = document.getElementById("navToggle");

function closeNav() {
  if (!navEl) return;
  navEl.classList.remove("nav-open");
  if (navToggle) navToggle.setAttribute("aria-expanded", "false");
}

if (navToggle) {
  navToggle.addEventListener("click", () => {
    const open = navEl.classList.toggle("nav-open");
    navToggle.setAttribute("aria-expanded", String(open));
  });
}
document.querySelectorAll(".nav-link").forEach((a) => a.addEventListener("click", closeNav));

/* ============================================================
   Brand mark, which types through the domains I own
   ============================================================ */
const domains = ["wael.sh", "wael.systems", "shahadeh.dev", "waelshahadeh.com"];
const brandEl = document.getElementById("brandText");

let brandLast = -1;
let brandTarget = "";
let brandLen = 0;
let brandMode = "typing";

function renderBrand(n) {
  const partial = brandTarget.slice(0, n);
  const dot = partial.indexOf(".");
  brandEl.replaceChildren();
  if (dot >= 0) {
    brandEl.append(partial.slice(0, dot));
    const ext = document.createElement("span");
    ext.className = "accent";
    ext.textContent = partial.slice(dot);
    brandEl.append(ext);
  } else {
    brandEl.append(partial);
  }
}

function brandTick() {
  if (!brandTarget) {
    let i;
    do { i = Math.floor(Math.random() * domains.length); } while (i === brandLast);
    brandLast = i; brandTarget = domains[i]; brandLen = 0; brandMode = "typing";
  }
  if (brandMode === "typing") {
    brandLen++; renderBrand(brandLen);
    if (brandLen >= brandTarget.length) {
      setTimeout(() => { brandMode = "erasing"; brandTick(); }, 6000);
      return;
    }
    setTimeout(brandTick, 80);
    return;
  }
  brandLen = Math.max(0, brandLen - 1); renderBrand(brandLen);
  if (brandLen === 0) { brandTarget = ""; setTimeout(brandTick, 450); return; }
  setTimeout(brandTick, 35);
}

if (brandEl) {
  if (REDUCED) { brandTarget = domains[0]; renderBrand(brandTarget.length); }
  else brandTick();
}

/* ============================================================
   Mega menu, a hover preview of each section (pointer devices only)

   Every entry resolves to a distinct destination. These were previously
   buttons whose labels named six different places but whose handler went to
   only one, so "GitHub" and "Resume (PDF)" under About both opened the About
   page. A link that names a destination should go to it.

     to:   the page this entry belongs to
     href: an off-site or off-page URL, used verbatim
     then: work to do once the page is showing, such as scrolling to a section,
           opening a case study or changing a feed filter
   ============================================================ */
const scrollToId = (id) => () => {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "start" });
};
const openCase = (i) => () => {
  const cases = document.querySelectorAll(".case");
  if (cases[i]) setCase(cases[i], true, { scroll: true, exclusive: true });
};
const setFeedFilter = (name) => () => {
  document.querySelector(`[data-ws-filter="${name}"]`)?.click();
};

const MEGA = {
  work: {
    title: "Work",
    blurb: "Research, engineering and community work, each written up as problem, approach and outcome.",
    links: [
      { label: "WaelSocial — signed feed", to: "work", then: openCase(0) },
      { label: "macOS backdoor detection", to: "work", then: openCase(1) },
      { label: "PC repair & OS re-imaging", to: "work", then: openCase(2) },
      { label: "RA programming", to: "work", then: openCase(3) },
    ],
  },
  homelab: {
    title: "Homelab",
    blurb: "A segmented network where malware can run without reaching anything else.",
    links: [
      { label: "Topology", to: "homelab", then: scrollToId("topology") },
      { label: "Isolation policy", to: "homelab", then: scrollToId("lab-zones") },
      { label: "Hardware & hosts", to: "homelab", then: scrollToId("lab-hardware") },
      { label: "What I run it for", to: "homelab", then: scrollToId("lab-uses") },
    ],
  },
  feed: {
    title: "WaelSocial",
    blurb: "A signed feed that your browser verifies, rather than one the server asserts is valid.",
    links: [
      { label: "All entries", to: "feed", then: setFeedFilter("all") },
      { label: "My work", to: "feed", then: setFeedFilter("mine") },
      { label: "Security signal", to: "feed", then: setFeedFilter("signal") },
      { label: "The signing key", to: "feed", then: scrollToId("signing-key") },
    ],
  },
  writing: {
    title: "Writing",
    blurb: "Notes and write-ups from projects I have built and taken apart.",
    links: [
      { label: "Pinning a public key", to: "writing", then: scrollToId("writing-keypinning") },
      { label: "Reading macOS logs", to: "writing", then: scrollToId("writing-macoslogs") },
      { label: "All drafts", to: "writing" },
    ],
  },
  about: {
    title: "About",
    blurb: "Cybersecurity senior at Marist University, working on analysis, tooling and the human side of security.",
    links: [
      { label: "Background", to: "about", then: scrollToId("about-background") },
      { label: "Skills", to: "about", then: scrollToId("about-skills") },
      { label: "Lab setup", to: "about", then: scrollToId("about-lab") },
      { label: "Resume (PDF)", href: "resume/" },
    ],
  },
  contact: {
    title: "Contact",
    blurb: "Open to internships, research collaborations and security work.",
    links: [
      { label: "Email", href: "mailto:shahadehwael@gmail.com" },
      { label: "GitHub", href: "https://github.com/CyberGlitching", external: true },
      { label: "LinkedIn", href: "https://www.linkedin.com/in/wael-shahadeh/", external: true },
      { label: "Resume (PDF)", href: "resume/" },
    ],
  },
};

const mega = document.getElementById("mega");
const megaTitle = document.getElementById("megaTitle");
const megaBlurb = document.getElementById("megaBlurb");
const megaLinks = document.getElementById("megaLinks");
let megaTimer = null;

const hoverCapable = window.matchMedia && window.matchMedia("(hover: hover) and (min-width: 901px)");

function closeMega() {
  clearTimeout(megaTimer);
  if (mega) mega.hidden = true;
}

function openMega(page) {
  const data = MEGA[page];
  if (!mega || !data || !(hoverCapable && hoverCapable.matches)) return;
  clearTimeout(megaTimer);
  megaTitle.textContent = data.title;
  megaBlurb.textContent = data.blurb;
  megaLinks.replaceChildren();
  data.links.slice(0, 6).forEach((item) => {
    // Using real <a> elements means middle-click, command-click and "copy link"
    // all work, and the status bar shows the actual destination.
    const a = document.createElement("a");
    a.className = "mega-link";
    a.href = item.href || (item.to === "home" ? "#/" : "#/" + item.to);
    if (item.external) { a.target = "_blank"; a.rel = "noopener"; }
    const arr = document.createElement("span");
    arr.className = "arr";
    arr.setAttribute("aria-hidden", "true");
    arr.textContent = item.external ? "↗" : "→";
    a.append(arr, item.label);
    if (item.to) {
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        go(item.to, item.then);
      });
    } else {
      a.addEventListener("click", closeMega);
    }
    megaLinks.appendChild(a);
  });
  mega.hidden = false;
}

function closeMegaSoon() {
  clearTimeout(megaTimer);
  megaTimer = setTimeout(closeMega, 220);
}

document.querySelectorAll(".nav-link").forEach((a) => {
  a.addEventListener("mouseenter", () => {
    const page = a.dataset.nav;
    MEGA[page] ? openMega(page) : closeMega();
  });
});
if (navEl) {
  navEl.addEventListener("mouseleave", closeMegaSoon);
  navEl.addEventListener("mouseenter", () => clearTimeout(megaTimer));
}

/* ============================================================
   Hero background: a node and edge network with pulses that propagate across it
   ============================================================ */
const netCanvas = document.getElementById("netCanvas");
let netRaf = null;
let netResize = null;
// Under prefers-reduced-motion the loop paints one frame and stops, which
// leaves netRaf null. Guarding re-entry on netRaf alone therefore allowed every
// later return to the home page to start a second scene, rebuilding the graph
// and adding another resize listener that stopNet() could not remove.
// netRunning records whether a scene is currently mounted.
let netRunning = false;

function stopNet() {
  if (netRaf) cancelAnimationFrame(netRaf);
  netRaf = null;
  if (netResize) window.removeEventListener("resize", netResize);
  netResize = null;
  netRunning = false;
}

function startNet() {
  if (!netCanvas || netRunning) return;
  const ctx = netCanvas.getContext("2d");
  if (!ctx) return;                 // claim the flag only once we can paint
  netRunning = true;

  const LINE = "58,68,78", DOT = "120,132,143", ACC = "110,231,183";
  let W = 0, H = 0, nodes = [], edges = [], pulses = [], nextPulse = 1.2;
  const g = () => (Math.random() + Math.random() + Math.random()) / 3;

  const build = () => {
    const r = netCanvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    netCanvas.width = Math.round(W * dpr);
    netCanvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.max(34, Math.min(96, Math.round(W * H / 15000)));
    nodes = [];
    for (let i = 0; i < n; i++) {
      const bx = Math.min(1, Math.max(0, 0.66 + (g() - 0.5) * 0.9));
      const by = Math.min(1, Math.max(0, 0.5 + (g() - 0.5) * 1.25));
      nodes.push({
        bx: bx * W, by: by * H, x: bx * W, y: by * H,
        ph: Math.random() * 6.28, sp: 0.12 + Math.random() * 0.22, amp: 2 + Math.random() * 4,
        r: 1.2 + Math.random() * 1.1, glow: 0,
      });
    }
    edges = [];
    const seen = new Set();
    nodes.forEach((a, i) => {
      const near = nodes
        .map((b, j) => ({ j, d: (b.x - a.x) ** 2 + (b.y - a.y) ** 2 }))
        .filter((o) => o.j !== i)
        .sort((p, q) => p.d - q.d)
        .slice(0, 2 + (Math.random() < 0.35 ? 1 : 0));
      near.forEach((o) => {
        const k = i < o.j ? i + ":" + o.j : o.j + ":" + i;
        if (seen.has(k)) return;
        seen.add(k);
        edges.push([i, o.j]);
      });
    });
  };

  build();
  netResize = () => build();
  window.addEventListener("resize", netResize);

  const t0 = performance.now();
  const frame = (now) => {
    const t = (now - t0) / 1000;
    if (!REDUCED) {
      for (const nd of nodes) {
        nd.x = nd.bx + Math.sin(t * nd.sp * 1.7 + nd.ph) * nd.amp;
        nd.y = nd.by + Math.cos(t * nd.sp * 1.3 + nd.ph * 1.7) * nd.amp * 0.8;
        nd.glow *= 0.94;
      }
      if (t > nextPulse) {
        const o = nodes[Math.floor(Math.random() * nodes.length)];
        if (o) pulses.push({ x: o.x, y: o.y, t: 0 });
        nextPulse = t + 2.4 + Math.random() * 2.6;
      }
      const span = Math.hypot(W, H);
      pulses = pulses.filter((p) => { p.t += 1 / 60; return p.t * 560 < span * 1.15; });
    }

    ctx.clearRect(0, 0, W, H);
    const band = 110;
    const waveAt = (x, y) => {
      let v = 0;
      for (const p of pulses) {
        const d = Math.abs(Math.hypot(x - p.x, y - p.y) - p.t * 560);
        if (d < band) v = Math.max(v, (1 - d / band) * Math.max(0, 1 - p.t / 2.4));
      }
      return v;
    };

    ctx.lineWidth = 0.8;
    for (const [i, j] of edges) {
      const a = nodes[i], b = nodes[j];
      const v = waveAt((a.x + b.x) / 2, (a.y + b.y) / 2);
      ctx.strokeStyle = v > 0.02
        ? "rgba(" + ACC + "," + (0.1 + v * 0.75).toFixed(3) + ")"
        : "rgba(" + LINE + ",0.55)";
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    for (const nd of nodes) {
      const v = Math.max(nd.glow, waveAt(nd.x, nd.y));
      if (v > nd.glow) nd.glow = v;
      ctx.beginPath();
      ctx.arc(nd.x, nd.y, nd.r + nd.glow * 1.7, 0, 6.2832);
      if (nd.glow > 0.03) {
        ctx.fillStyle = "rgba(" + ACC + "," + (0.35 + nd.glow * 0.65).toFixed(3) + ")";
        ctx.shadowColor = "rgba(" + ACC + ",0.6)";
        ctx.shadowBlur = 10 * nd.glow;
      } else {
        ctx.fillStyle = "rgba(" + DOT + ",0.78)";
        ctx.shadowBlur = 0;
      }
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    if (!REDUCED) netRaf = requestAnimationFrame(frame);
    else netRaf = null;
  };
  netRaf = requestAnimationFrame(frame);
}

/* ============================================================
   Scroll reveals. These are only armed once JavaScript is running, so a
   visitor without JavaScript does not get a page of invisible sections.
   ============================================================ */
const revealed = new WeakSet();
let revealObserver = null;

function armReveals() {
  requestAnimationFrame(() => {
    let i = 0;
    document.querySelectorAll("[data-reveal]").forEach((el) => {
      if (revealed.has(el)) return;
      revealed.add(el);
      el.setAttribute("data-armed", "1");
      el.style.transitionDelay = (i++ % 4) * 70 + "ms";
      if (revealObserver) revealObserver.observe(el);
    });
    sweepReveals();
  });
}

function sweepReveals() {
  const vh = window.innerHeight || 800;
  document.querySelectorAll("[data-reveal][data-armed]:not(.is-in)").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.height > 0 && r.top < vh * 0.94 && r.bottom > 0) el.classList.add("is-in");
  });
}

if ("IntersectionObserver" in window) {
  revealObserver = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        e.target.classList.add("is-in");
        revealObserver.unobserve(e.target);
      }
    });
  }, { rootMargin: "0px 0px -6% 0px" });
}
armReveals();

/* ============================================================
   Featured card. This shows real signed entries and verifies them, and falls
   back to an "unavailable" state rather than displaying a checkmark it has
   not actually checked.
   ============================================================ */
const vfy = {
  pill: document.getElementById("vfyPill"),
  body: document.getElementById("vfyBody"),
  key: document.getElementById("vfyKey"),
  time: document.getElementById("vfyTime"),
  sig: document.getElementById("vfySig"),
  bar: document.getElementById("vfyBar"),
  dots: document.querySelectorAll("[data-vfy-dot]"),
};

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const b64bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function keyFingerprint(b64) {
  try {
    const digest = await crypto.subtle.digest("SHA-256", b64bytes(b64));
    return hex(new Uint8Array(digest).slice(0, 8)).toUpperCase().replace(/(.{4})(?=.)/g, "$1 ");
  } catch {
    return b64.slice(0, 19) + "…";
  }
}

function vfyStamp(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return String(ts ?? "—");
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

function vfySetDots(i) {
  vfy.dots.forEach((d) => d.classList.toggle("on", Number(d.dataset.vfyDot) === i));
}

function vfyProgress(ms) {
  return new Promise((resolve) => {
    if (REDUCED || !vfy.bar) { if (vfy.bar) vfy.bar.style.width = "100%"; return resolve(); }
    const t0 = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / ms);
      vfy.bar.style.width = (p * 100).toFixed(1) + "%";
      p < 1 ? requestAnimationFrame(tick) : resolve();
    };
    requestAnimationFrame(tick);
  });
}

async function initVerifyCard() {
  if (!vfy.body) return;
  const ws = window.WaelSocial;
  const fp = ws ? await keyFingerprint(ws.PINNED_PUBKEY) : "—";
  if (vfy.key) vfy.key.textContent = fp;

  let entries = [], pubKey = null;
  try {
    const feed = await ws.getFeed();
    if (feed.pubkey !== ws.PINNED_PUBKEY) throw new Error("feed pubkey does not match the pinned key");
    entries = feed.entries.filter((e) => e.sig && e.type !== "relay").slice(0, 3);
    pubKey = await ws.importPinnedKey();
  } catch (err) {
    console.warn("[verify-card] live entries unavailable:", err);
  }

  if (!entries.length || !pubKey) {
    vfy.pill.textContent = "Feed offline";
    vfy.body.textContent =
      "Signed entries appear on the feed page. Each one is signed offline with Ed25519 and re-checked here in your " +
      "browser against the pinned key. The live feed cannot be reached at the moment, so nothing is shown as verified.";
    if (vfy.time) vfy.time.textContent = "—";
    if (vfy.sig) vfy.sig.textContent = "—";
    if (vfy.bar) vfy.bar.style.width = "0%";
    return;
  }

  let i = 0;
  const cycle = async () => {
    const e = entries[i % entries.length];
    vfySetDots(i % entries.length);

    vfy.pill.textContent = "Verifying";
    vfy.pill.classList.remove("ok");
    vfy.sig.textContent = "checking…";
    vfy.sig.classList.remove("ok");
    vfy.body.textContent = e.text;
    vfy.time.textContent = vfyStamp(e.ts);
    if (vfy.bar) vfy.bar.style.width = "0%";

    const [ok] = await Promise.all([ws.verifyEntry(e, pubKey), vfyProgress(800)]);
    const raw = hex(b64bytes(e.sig));
    vfy.sig.textContent = ok ? raw.slice(0, 8) + "…" + raw.slice(-6) : "signature failed";
    vfy.pill.textContent = ok ? "✓ Verified" : "✗ Not verified";
    vfy.pill.classList.toggle("ok", !!ok);
    vfy.sig.classList.toggle("ok", !!ok);

    if (REDUCED || entries.length < 2) return;
    setTimeout(() => { i++; cycle(); }, 5200);
  };
  cycle();
}

document.addEventListener("DOMContentLoaded", initVerifyCard);

/* ============================================================
   Terminal
   ============================================================ */
const termBody = document.getElementById("termBody");
const termLines = document.getElementById("termLines");
const termInput = document.getElementById("termInput");
const MAX_LINES = 40;

function termLine(text, cls, isCmd) {
  const div = document.createElement("div");
  div.className = "term-line" + (cls ? " " + cls : "");
  if (isCmd) {
    const p = document.createElement("span");
    p.className = "t-prompt";
    p.textContent = "$ ";
    const c = document.createElement("span");
    c.className = "t-cmd";
    c.textContent = text;
    div.append(p, c);
    return div;
  }
  div.append(text);
  return div;
}

function termPush(nodes) {
  for (const n of nodes) termLines.appendChild(n);
  while (termLines.children.length > MAX_LINES) termLines.firstChild.remove();
  termBody.scrollTop = termBody.scrollHeight;
}

function runCommand(raw) {
  const cmd = raw.trim();
  if (cmd === "clear") { termLines.replaceChildren(); termInput.value = ""; return; }
  const out = [termLine(cmd, "", true)];
  const push = (text, cls) => out.push(termLine(text, cls || ""));

  if (cmd === "") { }
  else if (cmd === "help") push("Commands: whoami, projects, verify, homelab, resume, ls projects/, cat mission.txt, cat goals.txt, open <page>, contact, clear. Pages are work, homelab, feed, writing, about, contact and privacy.", "t-bright");
  else if (cmd === "whoami") push("Wael Shahadeh, cybersecurity senior at Marist University. Malware research, network analysis and secure lab builds.");
  else if (cmd === "ls projects/" || cmd === "ls" || cmd === "ls projects") push("waelsocial-feed/  macos-backdoor-detection/  pc-reimaging/  ra-programming/", "t-accent");
  else if (cmd === "projects") push("waelsocial-feed, macos-backdoor-detection, pc-reimaging, ra-programming. Run `open work` for the write-ups.", "t-accent");
  else if (cmd === "verify") {
    push("Algorithm Ed25519, pinned key /XKGM2r0/oyl47HkuhDK8JiH5pUJvPlRi8btV03S/mE=");
    push("Every feed entry is signed offline and re-checked in your browser. Run `open feed` to see it.", "t-accent");
  }
  else if (cmd === "homelab") push("Three segments with one firewall between them, and an isolated VLAN for malware. Run `open homelab` for the topology.", "t-accent");
  else if (cmd === "resume") push("Run `open about` for the background, or `open contact` for the PDF.");
  else if (cmd === "cat mission.txt") push("Learning by building things and taking them apart.");
  else if (cmd === "cat goals.txt") push("Keep learning, do work that is useful, and keep improving at it.");
  else if (cmd === "meow") push("meow! 🐱", "t-accent");
  else if (cmd === "evil") push("That rather depends on your point of view.", "t-accent");
  else if (cmd === "contact") push("Email shahadehwael@gmail.com, or find me at github.com/CyberGlitching and linkedin.com/in/wael-shahadeh.", "t-bright");
  else if (cmd.startsWith("open ")) {
    const p = cmd.slice(5).trim();
    if (PAGES.includes(p)) {
      push("Opening /" + p, "t-accent");
      termPush(out);
      termInput.value = "";
      setTimeout(() => go(p), 350);
      return;
    }
    push("No such page: " + p + ". Run `help` for the list.", "t-dim");
  }
  else if (cmd === "sudo rm -rf /") push("Permission denied. This terminal runs in your browser and has nothing to remove.", "t-dim");
  else push("Command not found: " + cmd + ". Run `help` for the list.", "t-dim");

  termPush(out);
  termInput.value = "";
}

if (termBody && termInput) {
  termBody.addEventListener("click", () => termInput.focus());
  termInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runCommand(termInput.value);
    else if (e.key === "Escape") {
      e.stopPropagation();
      if (termInput.value) termInput.value = "";
      else termLines.replaceChildren();
    }
  });
  document.querySelectorAll(".term-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      runCommand(chip.dataset.cmd);
      termInput.focus();
    });
  });
}

/* ============================================================
   Case study accordion
   ============================================================ */
function setCase(item, open, opts = {}) {
  if (opts.exclusive) {
    document.querySelectorAll(".case").forEach((c) => { if (c !== item) setCase(c, false); });
  }
  item.classList.toggle("open", open);
  const head = item.querySelector(".case-head");
  head.setAttribute("aria-expanded", String(open));
  const caret = item.querySelector(".case-caret");
  caret.replaceChildren();
  const arr = document.createElement("span");
  arr.className = "arr";
  arr.setAttribute("aria-hidden", "true");
  arr.textContent = open ? "↑" : "→";
  caret.append(open ? "Close " : "Read now ", arr);
  if (open && opts.scroll) {
    item.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "start" });
  }
}

document.querySelectorAll(".case-head").forEach((head) => {
  head.addEventListener("click", () => {
    const item = head.closest(".case");
    const wasOpen = item.classList.contains("open");
    document.querySelectorAll(".case").forEach((c) => setCase(c, false));
    if (!wasOpen) setCase(item, true);
  });
});

/* ============================================================
   Command palette
   ============================================================ */
const palette = document.getElementById("palette");
const paletteBtn = document.getElementById("paletteBtn");
const paletteInput = document.getElementById("paletteInput");
const paletteHost = document.getElementById("paletteItems");
let paletteSel = 0;

const ACTIONS = [
  { icon: "→", label: "Home", hint: "page", run: () => go("home") },
  { icon: "→", label: "Work — case studies", hint: "page", run: () => go("work") },
  { icon: "→", label: "Homelab — network map", hint: "page", run: () => go("homelab") },
  { icon: "→", label: "WaelSocial feed", hint: "page", run: () => go("feed") },
  { icon: "→", label: "Writing", hint: "page", run: () => go("writing") },
  { icon: "→", label: "About & skills", hint: "page", run: () => go("about") },
  { icon: "→", label: "Contact", hint: "page", run: () => go("contact") },
  { icon: "↗", label: "GitHub — CyberGlitching", hint: "external", run: () => { closePalette(); window.open("https://github.com/CyberGlitching", "_blank", "noopener"); } },
  { icon: "↗", label: "LinkedIn", hint: "external", run: () => { closePalette(); window.open("https://www.linkedin.com/in/wael-shahadeh/", "_blank", "noopener"); } },
  { icon: "↗", label: "Resume (PDF)", hint: "file", run: () => { closePalette(); location.href = "resume/"; } },
  { icon: "✉", label: "Email shahadehwael@gmail.com", hint: "mailto", run: () => { closePalette(); location.href = "mailto:shahadehwael@gmail.com"; } },
  { icon: "→", label: "Privacy — what this site collects", hint: "page", run: () => go("privacy") },
];

function paletteMatches() {
  const q = paletteInput.value.trim().toLowerCase();
  return ACTIONS.filter((a) => a.label.toLowerCase().includes(q));
}

function renderPalette() {
  const items = paletteMatches();
  paletteSel = Math.min(paletteSel, Math.max(0, items.length - 1));
  paletteHost.replaceChildren();
  items.forEach((a, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "palette-item" + (i === paletteSel ? " sel" : "");
    const icon = document.createElement("span"); icon.className = "palette-icon"; icon.textContent = a.icon;
    const label = document.createElement("span"); label.className = "palette-label"; label.textContent = a.label;
    const hint = document.createElement("span"); hint.className = "palette-hint"; hint.textContent = a.hint;
    btn.append(icon, label, hint);
    btn.addEventListener("click", a.run);
    paletteHost.appendChild(btn);
  });
}

// Records whatever had focus before the dialog opened, so it can be restored.
let paletteReturn = null;

function openPalette() {
  closeMega();
  closeNav();
  paletteReturn = document.activeElement;
  palette.hidden = false;
  paletteInput.value = "";
  paletteSel = 0;
  renderPalette();
  setTimeout(() => paletteInput.focus(), 30);
}

function closePalette() {
  if (!palette || palette.hidden) return;
  palette.hidden = true;
  // Returning focus to the trigger matters: without it, a keyboard user is
  // left at the top of the document after closing the dialog.
  if (paletteReturn && document.contains(paletteReturn)) paletteReturn.focus();
  paletteReturn = null;
}

if (palette) {
  paletteBtn.addEventListener("click", openPalette);
  palette.addEventListener("click", (e) => { if (e.target === palette) closePalette(); });
  paletteInput.addEventListener("input", () => { paletteSel = 0; renderPalette(); });

  // aria-modal tells assistive technology that the rest of the page is inert,
  // but it has no effect on Tab. Without this handler, tabbing out of the
  // dialog moves into the page behind it.
  palette.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const focusable = [paletteInput, ...paletteHost.querySelectorAll("button")];
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  paletteInput.addEventListener("keydown", (e) => {
    const items = paletteMatches();
    if (e.key === "ArrowDown") { e.preventDefault(); paletteSel = Math.min(paletteSel + 1, items.length - 1); renderPalette(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); paletteSel = Math.max(paletteSel - 1, 0); renderPalette(); }
    else if (e.key === "Enter" && items[paletteSel]) { e.preventDefault(); items[paletteSel].run(); }
  });

  window.addEventListener("keydown", (e) => {
    if (!e.key) return;   // composition and IME events can arrive without one
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      palette.hidden ? openPalette() : closePalette();
    } else if (e.key === "Escape") {
      closePalette();
      closeMega();
      closeNav();
    }
  });
}

showPage(currentPage());
