/* ============================================================
   The swarm

   Six named cursors assemble each page: they pick pieces up, haul them into
   place and snap them to their guides, while connector arrows stay attached
   and stretch with whatever is moving.

   Everything here is presentation on top of a finished page. Pieces are moved
   with CSS custom properties and are never hidden, so a visitor without
   JavaScript sees the same page already assembled, and under
   prefers-reduced-motion nothing moves at all. Nothing is stored between
   visits; the privacy page promises that, so "which pages have been assembled"
   is a variable that dies with the tab.
   ============================================================ */
(() => {
  const REDUCED = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const SVG = "http://www.w3.org/2000/svg";

  const AGENTS = [
    { name: "recon", color: "#FF2340", verb: "placing findings" },
    { name: "sigcheck", color: "#00F0FF", verb: "checking the seal" },
    { name: "netmap", color: "#FF6A3D", verb: "routing" },
    { name: "scribe", color: "#FFA3B1", verb: "setting copy" },
    { name: "typesetter", color: "#FFFFFF", verb: "fitting type" },
    { name: "linter", color: "#FFB300", verb: "snapping to grid" },
  ];

  // Connector arrows per page: [from, to, label, width]. Names are data-piece
  // values, and the route is worked out from wherever the two pieces are. On a
  // single column the pieces stack, so a fan of arrows would run straight over
  // the text. "wide" and "narrow" pick which arrows belong to which layout.
  const WIRES = {
    home: [
      ["w-for", "hero-note"],
      ["hero-note", "entry-copy"],
      ["w-yourself", "entry-slip", "check it here", "wide"],
      ["hero-hint", "entry-slip", "", "wide"],
      ["entry-copy", "entry-slip", "signed offline"],
      ["entry-copy", "area-analysis", "", "wide"],
      ["entry-slip", "area-analysis", "", "narrow"],
      ["entry-slip", "area-build", "verified in your browser", "wide"],
      ["entry-slip", "area-lab", "", "wide"],
      ["area-analysis", "area-build"],
      ["area-build", "area-lab"],
      ["area-lab", "area-people"],
      ["area-build", "console-note", "", "wide"],
      ["area-people", "console", "", "wide"],
      ["area-people", "console-note", "", "narrow"],
      ["console-note", "console", "type here"],
      ["console", "t-signed", "", "wide"],
      ["console", "teasers-head", "", "narrow"],
      ["console-note", "teasers-head", "", "wide"],
      ["teasers-head", "t-signed"],
      ["teasers-head", "t-macos", "", "wide"],
      ["teasers-head", "t-repair", "", "wide"],
      ["teasers-head", "t-ra", "", "wide"],
      ["t-signed", "t-macos", "", "narrow"],
      ["t-macos", "t-repair", "", "narrow"],
      ["t-repair", "t-ra", "", "narrow"],
      ["t-ra", "x-writing", "", "wide"],
      ["t-ra", "x-contact", "", "wide"],
      ["x-writing", "x-feed", "", "wide"],
      ["x-feed", "x-work", "", "wide"],
      ["x-work", "x-feed", "", "narrow"],
      ["x-feed", "x-writing", "", "narrow"],
      ["x-writing", "x-contact", "", "narrow"],
    ],
    work: [["head", "cases"]],
    homelab: [
      ["head", "lab-note"],
      ["head", "lab-stats", "", "wide"],
      ["lab-note", "lab-stats"],
      ["lab-stats", "topo-head"],
      ["topo-head", "topo-map"],
      ["topo-map", "z-edge"],
      ["z-edge", "z-10"],
      ["z-10", "z-20"],
      ["z-20", "z-66"],
      ["z-66", "topo-foot"],
      ["topo-foot", "lab-hw"],
      ["z-66", "lab-uses", "", "wide"],
      ["lab-hw", "lab-uses", "", "narrow"],
    ],
    feed: [
      ["head", "feed-blurb"],
      ["feed-blurb", "feed-key"],
      ["feed-key", "feed-main", "checks every entry"],
    ],
    writing: [
      ["head", "wr-key"],
      ["wr-key", "wr-mac"],
    ],
    about: [
      ["head", "ab-bio"],
      ["ab-bio", "ab-skills"],
      ["ab-skills", "ab-lab"],
    ],
    contact: [
      ["head", "ct-mail"],
      ["head", "ct-gh", "", "wide"],
      ["ct-mail", "ct-li", "", "wide"],
      ["ct-gh", "ct-cv", "", "wide"],
      ["ct-mail", "ct-gh", "", "narrow"],
      ["ct-gh", "ct-li", "", "narrow"],
      ["ct-li", "ct-cv", "", "narrow"],
    ],
    privacy: [["head", "priv-list"]],
  };

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const smooth = (p) => p * p * (3 - 2 * p);
  const settle = (p) => 1 - Math.pow(1 - p, 3);

  /* ---------- A small tween loop, shared by everything that moves ---------- */
  let tweens = [];
  let raf = 0;
  let wiresDirty = false;

  function kick() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function frame(now) {
    raf = 0;
    tweens = tweens.filter((t) => {
      if (t.t0 === null) t.t0 = now;
      const p = Math.min(1, (now - t.t0) / t.ms);
      t.step(t.ease(p));
      if (p >= 1) { t.done(); return false; }
      return true;
    });
    if (wiresDirty) { wiresDirty = false; drawWires(); }
    if (tweens.length) kick();
  }

  function tween(ms, step, ease = smooth) {
    return new Promise((done) => {
      tweens.push({ t0: null, ms, step, ease, done });
      kick();
    });
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- Pieces ---------- */
  const poses = new WeakMap();

  function pose(el) {
    if (!poses.has(el)) poses.set(el, { x: 0, y: 0, r: 0 });
    return poses.get(el);
  }

  function setPose(el, x, y, r) {
    const s = pose(el);
    s.x = x; s.y = y; s.r = r;
    el.style.setProperty("--x", x.toFixed(1) + "px");
    el.style.setProperty("--y", y.toFixed(1) + "px");
    el.style.setProperty("--r", r.toFixed(2) + "deg");
    wiresDirty = true;
    kick();
  }

  // Where a piece sits in the layout, in document coordinates, leaving out
  // wherever it has currently been dragged to.
  function homeBox(el) {
    const r = el.getBoundingClientRect();
    const s = pose(el);
    const left = r.left + window.scrollX - s.x;
    const top = r.top + window.scrollY - s.y;
    return { left, top, width: r.width, height: r.height, right: left + r.width, bottom: top + r.height };
  }

  const activePage = () => document.querySelector("[data-page]:not([hidden])");
  const piecesOf = (page) => (page ? [...page.querySelectorAll("[data-piece]")] : []);

  /* ---------- The cursors ---------- */
  const layer = document.createElement("div");
  layer.className = "swarm";
  layer.setAttribute("aria-hidden", "true");

  class Agent {
    constructor(def) {
      Object.assign(this, def);
      this.x = -100; this.y = -100;
      this.goal = [-100, -100];
      this.busy = false;
      this.parked = null;
      this.el = document.createElement("div");
      this.el.className = "agent";
      this.el.style.setProperty("--agent", def.color);
      const svg = document.createElementNS(SVG, "svg");
      svg.setAttribute("viewBox", "0 0 22 28");
      svg.setAttribute("class", "agent-arrow");
      const path = document.createElementNS(SVG, "path");
      path.setAttribute("d", "M2 2 L2 23 L7.6 17.6 L11.6 26.4 L16 24.4 L12 15.8 L19.8 15.4 Z");
      svg.append(path);
      this.tag = document.createElement("span");
      this.tag.className = "agent-tag";
      this.tag.textContent = def.name;
      this.el.append(svg, this.tag);
      layer.append(this.el);
    }

    place(x, y) {
      this.x = x; this.y = y;
      this.el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
      this.el.classList.toggle("flip", x - window.scrollX > window.innerWidth - 190);
    }

    say(text) {
      this.tag.textContent = text ? `${this.name}: ${text}` : this.name;
      this.el.classList.remove("quiet");
    }

    moveTo(x, y, ms) {
      this.goal = [x, y];
      const fx = this.x, fy = this.y;
      const bow = rand(-40, 40);
      return tween(ms, (p) => {
        const lift = Math.sin(p * Math.PI) * bow;
        this.place(fx + (x - fx) * p + lift, fy + (y - fy) * p - lift * 0.5);
      });
    }

    unpark() {
      if (this.parked) this.parked.classList.remove("sel");
      this.parked = null;
    }
  }

  const crew = window.matchMedia && window.matchMedia("(max-width: 640px)").matches ? 4 : AGENTS.length;
  const agents = AGENTS.slice(0, crew).map((a) => new Agent(a));
  // The linter comes last in the list and is the one a visitor needs on a phone.
  if (crew < AGENTS.length) agents.push(new Agent(AGENTS[AGENTS.length - 1]));
  const byName = (name) => agents.find((a) => a.name === name);

  /* ---------- Hauling ---------- */
  let pending = [];
  let runId = 0;
  let onDrained = null;
  const heldBy = new Map();     // piece -> colour, read by the connector arrows
  const inHand = new Set();     // pieces the visitor is holding right now

  function grab(el, color) {
    el.style.setProperty("--held", color);
    el.classList.add("held", "sel");
    heldBy.set(el, color);
    wiresDirty = true;
  }

  function release(el) {
    el.classList.remove("held", "sel");
    heldBy.delete(el);
    wiresDirty = true;
  }

  function flashGuides(box) {
    const add = (cls, left, top, size) => {
      const g = document.createElement("i");
      g.className = "guide " + cls;
      g.style.left = left + "px";
      g.style.top = top + "px";
      g.style[cls === "guide--v" ? "height" : "width"] = size + "px";
      layer.append(g);
      setTimeout(() => g.remove(), 560);
    };
    add("guide--v", box.left, box.top - 70, box.height + 140);
    add("guide--h", Math.max(0, box.left - 90), box.top, box.width + 180);
  }

  async function haul(agent, el, quick) {
    const run = runId;
    const box = homeBox(el);
    const s = pose(el);
    const gx = box.left + box.width * rand(0.22, 0.7);
    const gy = box.top + Math.min(box.height * 0.5, 26);
    agent.unpark();
    agent.say(agent.verb);
    await agent.moveTo(gx + s.x, gy + s.y, quick ? rand(220, 320) : rand(300, 460));
    if (run !== runId || inHand.has(el)) return;

    grab(el, agent.color);
    const { x, y, r } = s;
    const bow = rand(-50, 50);
    await tween(quick ? rand(380, 480) : rand(520, 720), (p) => {
      const q = 1 - p;
      const arc = Math.sin(p * Math.PI) * bow;
      setPose(el, x * q + arc, y * q - arc * 0.4, r * q);
      agent.place(gx + x * q + arc, gy + y * q - arc * 0.4);
    }, settle);
    release(el);
    if (run === runId) {
      flashGuides(box);
      el.classList.add("glitch");
      setTimeout(() => el.classList.remove("glitch"), 320);
    }
  }

  function pump(prefer) {
    const free = agents.filter((a) => !a.busy);
    if (prefer) free.sort((a) => (a === prefer ? -1 : 0));
    free.forEach((agent, i) => {
      if (i >= pending.length) return;
      agent.busy = true;
      work(agent, i * 110);
    });
  }

  async function work(agent, delay) {
    const run = runId;
    if (delay) await wait(delay);
    while (pending.length && run === runId) {
      const el = pending.shift();
      await haul(agent, el, pending.length > 4);
    }
    agent.busy = false;
    agent.say("");
    if (run !== runId) return;
    if (!agents.some((a) => a.busy) && !pending.length && onDrained) {
      const fn = onDrained;
      onDrained = null;
      fn();
    }
    if (!agent.busy && !agent.parked) rest(agent, 800);
  }

  /* ---------- Where the cursors wait ---------- */
  function restSpot(agent) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const sx = window.scrollX, sy = window.scrollY;
    const clear = (x, y) => agents.every((a) => a === agent || Math.hypot(a.goal[0] - x, a.goal[1] - y) > 170);
    const seen = piecesOf(activePage()).filter((el) => {
      if (el.classList.contains("word")) return false;
      const r = el.getBoundingClientRect();
      return r.width && r.bottom > 96 && r.bottom < vh - 56 && r.left < vw && r.right > 0;
    });
    // Bottom corners only, tucked just outside the piece, so a waiting cursor
    // and its name tag never sit on something a visitor is reading.
    for (let tries = 0; tries < 8 && seen.length; tries++) {
      const r = pick(seen).getBoundingClientRect();
      const x = sx + clamp(pick([r.left - 8, r.right - 12]), 8, vw - 40);
      const y = sy + r.bottom + 4;
      if (clear(x, y)) return { x, y };
    }
    // A sheet taller than the window leaves no free corner. The cursor waits in
    // the margin instead, without its tag, which would cover the sheet.
    for (let tries = 0; tries < 8; tries++) {
      const x = sx + pick([4, vw - 26]);
      const y = sy + rand(110, vh - 60);
      if (clear(x, y)) return { x, y, quiet: true };
    }
    return { x: sx + 4, y: sy + 110, quiet: true };
  }

  function rest(agent, ms) {
    const { x, y, quiet } = restSpot(agent);
    agent.el.classList.toggle("quiet", !!quiet);
    if (REDUCED) { agent.goal = [x, y]; return agent.place(x, y); }
    return agent.moveTo(x, y, ms);
  }

  function park(agent, el, atRight) {
    const r = el.getBoundingClientRect();
    agent.unpark();
    agent.parked = el;
    agent.el.classList.remove("quiet");
    el.style.setProperty("--held", agent.color);
    el.classList.add("sel");
    const x = window.scrollX + (atRight ? r.right : r.left + r.width * 0.72);
    const y = window.scrollY + r.bottom - 4;
    return REDUCED ? agent.place(x, y) : agent.moveTo(x, y, 520);
  }

  // A cursor moves now and then so the room stays occupied. It stops while the
  // tab is in the background.
  function wander() {
    if (REDUCED || document.hidden || pending.length) return;
    const free = agents.filter((a) => !a.busy && !a.parked);
    if (free.length) rest(pick(free), rand(1100, 1700));
  }

  /* ---------- Connector arrows ---------- */
  const wireSets = new Map();

  function buildWires(page) {
    const name = page.dataset.page;
    if (wireSets.has(page)) return;
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("class", "wires");
    svg.setAttribute("aria-hidden", "true");
    const find = (id) => page.querySelector(`[data-piece="${id}"]`);
    const items = (WIRES[name] || []).map(([from, to, label, width], i) => {
      const a = find(from), b = find(to);
      if (!a || !b) return null;
      const g = document.createElementNS(SVG, "g");
      g.setAttribute("class", "wire");
      const mkPath = (cls) => {
        const path = document.createElementNS(SVG, "path");
        path.setAttribute("class", cls);
        return path;
      };
      const glow = mkPath("wire-glow"), line = mkPath("wire-line"), pulse = mkPath("wire-pulse"), head = mkPath("wire-head");
      // Offset so the packets do not all leave at the same moment.
      pulse.style.animationDelay = (-(i * 0.73) % 2.6).toFixed(2) + "s";
      g.append(glow, line, pulse, head);
      let text = null;
      if (label) {
        text = document.createElementNS(SVG, "text");
        text.setAttribute("class", "wire-label");
        text.setAttribute("text-anchor", "middle");
        text.textContent = label;
        g.append(text);
      }
      svg.append(g);
      return { a, b, g, curves: [glow, line, pulse], head, text, width, nudge: ((i * 37) % 5 - 2) * 13 };
    }).filter(Boolean);
    page.prepend(svg);
    wireSets.set(page, { svg, items });
  }

  function route(a, b, nudge) {
    const edge = (lo, hi, want) => clamp(want, lo + 18, Math.max(lo + 18, hi - 18));
    const ac = { x: (a.left + a.right) / 2, y: (a.top + a.bottom) / 2 };
    const bc = { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 };
    let p0, p3, c1, c2;
    if (b.top >= a.bottom - 6) {
      p0 = { x: edge(a.left, a.right, ac.x + (bc.x - ac.x) * 0.4 + nudge), y: a.bottom };
      p3 = { x: edge(b.left, b.right, bc.x + (ac.x - bc.x) * 0.4 - nudge), y: b.top - 6 };
      const k = Math.max(26, (p3.y - p0.y) * 0.55);
      c1 = { x: p0.x, y: p0.y + k }; c2 = { x: p3.x, y: p3.y - k };
    } else if (a.top >= b.bottom - 6) {
      p0 = { x: edge(a.left, a.right, ac.x + nudge), y: a.top };
      p3 = { x: edge(b.left, b.right, bc.x - nudge), y: b.bottom + 6 };
      const k = Math.max(26, (p0.y - p3.y) * 0.55);
      c1 = { x: p0.x, y: p0.y - k }; c2 = { x: p3.x, y: p3.y + k };
    } else {
      const dir = bc.x >= ac.x ? 1 : -1;
      p0 = { x: dir > 0 ? a.right : a.left, y: edge(a.top, a.bottom, ac.y + nudge) };
      p3 = { x: (dir > 0 ? b.left : b.right) - dir * 6, y: edge(b.top, b.bottom, bc.y - nudge) };
      const k = Math.max(26, Math.abs(p3.x - p0.x) * 0.55);
      c1 = { x: p0.x + dir * k, y: p0.y }; c2 = { x: p3.x - dir * k, y: p3.y };
    }
    return { p0, c1, c2, p3 };
  }

  function drawWires() {
    const page = activePage();
    const set = page && wireSets.get(page);
    if (!set) return;
    const base = page.getBoundingClientRect();
    set.svg.setAttribute("height", page.scrollHeight);
    const local = (el) => {
      const r = el.getBoundingClientRect();
      return {
        left: r.left - base.left, right: r.right - base.left,
        top: r.top - base.top, bottom: r.bottom - base.top,
        width: r.width,
      };
    };
    const layout = window.innerWidth > 900 ? "wide" : "narrow";
    for (const w of set.items) {
      const a = local(w.a), b = local(w.b);
      const show = (!w.width || w.width === layout) && a.width && b.width;
      w.g.style.display = show ? "" : "none";
      if (!show) continue;
      const { p0, c1, c2, p3 } = route(a, b, w.nudge);
      const d = `M${p0.x.toFixed(1)} ${p0.y.toFixed(1)} C${c1.x.toFixed(1)} ${c1.y.toFixed(1)} ${c2.x.toFixed(1)} ${c2.y.toFixed(1)} ${p3.x.toFixed(1)} ${p3.y.toFixed(1)}`;
      w.curves.forEach((c) => c.setAttribute("d", d));

      // The head is drawn rather than a marker so it can take the colour of
      // whoever is holding the piece on browsers without context-stroke.
      const ang = Math.atan2(p3.y - c2.y, p3.x - c2.x);
      const tip = { x: p3.x + Math.cos(ang) * 6, y: p3.y + Math.sin(ang) * 6 };
      const wing = (d) => `${(tip.x - Math.cos(ang + d) * 14).toFixed(1)} ${(tip.y - Math.sin(ang + d) * 14).toFixed(1)}`;
      w.head.setAttribute("d", `M${tip.x.toFixed(1)} ${tip.y.toFixed(1)} L${wing(0.42)} L${wing(-0.42)} Z`);

      if (w.text) {
        w.text.setAttribute("x", ((p0.x + 3 * c1.x + 3 * c2.x + p3.x) / 8).toFixed(1));
        w.text.setAttribute("y", ((p0.y + 3 * c1.y + 3 * c2.y + p3.y) / 8 + 5).toFixed(1));
      }
      const hot = heldBy.get(w.a) || heldBy.get(w.b) || "";
      w.g.style.color = hot;
      w.g.classList.toggle("hot", !!hot);
    }
  }

  /* ---------- The headline, stretched line by line to the full measure ---------- */
  const lines = () => [...document.querySelectorAll(".poster-line")];
  const MIN_W = 50, MAX_W = 125;

  function fitPoster() {
    lines().forEach((line) => {
      const words = [...line.querySelectorAll(".word")];
      const room = line.clientWidth;
      if (!room) return;
      const gap = parseFloat(getComputedStyle(line).fontSize) * 0.2 * (words.length - 1);
      const needs = () => words.reduce((sum, w) => sum + w.offsetWidth, gap);
      let lo = MIN_W, hi = MAX_W;
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2;
        line.style.fontStretch = mid + "%";
        if (needs() > room) hi = mid; else lo = mid;
      }
      line.style.fontStretch = lo + "%";
      line.dataset.fit = lo;
    });
    wiresDirty = true;
    kick();
  }

  // The last move of the opening: the typesetter takes the corner of "yourself."
  // and pulls it out until the line fills the measure.
  async function stretchFinale() {
    const agent = byName("typesetter");
    const word = document.querySelector('[data-piece="w-yourself"]');
    // Scrolling away mid-assembly means nobody would see it.
    if (!agent || !word || agent.busy || word.getBoundingClientRect().top < 0) return;
    const line = word.closest(".poster-line");
    const run = runId;
    const to = parseFloat(line.dataset.fit);
    agent.busy = true;
    agent.unpark();
    agent.say(agent.verb);
    const edge = () => {
      const r = word.getBoundingClientRect();
      return [window.scrollX + r.right, window.scrollY + r.bottom - 6];
    };
    line.classList.add("stretching");
    line.style.fontStretch = MIN_W + "%";
    const [ex, ey] = edge();
    await agent.moveTo(ex, ey, 380);
    if (run === runId) {
      grab(word, agent.color);
      await tween(820, (p) => {
        line.style.fontStretch = MIN_W + (to - MIN_W) * p + "%";
        agent.place(...edge());
        wiresDirty = true;
      }, settle);
      release(word);
    }
    line.style.fontStretch = to + "%";
    line.classList.remove("stretching");
    agent.busy = false;
    agent.say("");
    if (run === runId) {
      park(agent, word, true);
      const seal = byName("sigcheck");
      const check = document.querySelector('[data-piece="w-check"]');
      if (seal && !seal.busy && check) park(seal, check, false);
    }
  }

  /* ---------- Assembly ---------- */
  const seenPages = new Set();
  let observer = null;

  function jumble(el) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const box = homeBox(el);
    const cx = box.left + box.width / 2 - window.scrollX;
    const cy = box.top + box.height / 2 - window.scrollY;
    const tx = rand(vw * 0.12, vw * 0.88);
    const ty = rand(vh * 0.18, vh * 0.84);
    setPose(el, (tx - cx) * 0.8, (ty - cy) * 0.8, rand(-11, 11));
  }

  function nudgeAway(el) {
    const reach = Math.min(1, window.innerWidth / 900);
    setPose(el, rand(70, 170) * pick([-1, 1]) * reach, rand(30, 110), rand(-5, 5));
  }

  function drift(el) {
    const { x, y, r } = pose(el);
    tween(420, (p) => setPose(el, x * (1 - p), y * (1 - p), r * (1 - p)), settle);
  }

  function enqueue(el) {
    if (inHand.has(el)) return;
    // Scrolling fast can outrun six cursors. Pieces beyond what they can reach
    // simply slide home, so nobody reads a crooked page for long.
    if (pending.length > 5) drift(el);
    else { pending.push(el); pump(); }
  }

  function watchBelowFold(list) {
    if (!("IntersectionObserver" in window)) return list.forEach((el) => setPose(el, 0, 0, 0));
    if (!observer) {
      observer = new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          observer.unobserve(e.target);
          enqueue(e.target);
        });
      }, { threshold: 0.18 });
    }
    list.forEach((el) => observer.observe(el));
  }

  function flush() {
    runId++;
    tweens.forEach((t) => { t.step(1); t.done(); });
    tweens = [];
    pending = [];
    onDrained = null;
    if (observer) { observer.disconnect(); observer = null; }
    [...heldBy.keys()].forEach(release);
    document.querySelectorAll("[data-piece]").forEach((el) => {
      if (!inHand.has(el)) setPose(el, 0, 0, 0);
    });
    document.querySelectorAll(".poster-line.stretching").forEach((l) => {
      l.classList.remove("stretching");
      l.style.fontStretch = l.dataset.fit + "%";
    });
    agents.forEach((a) => { a.busy = false; a.say(""); });
  }

  function assemble(page) {
    const list = piecesOf(page);
    const vh = window.innerHeight;
    const near = [], far = [];
    list.forEach((el) => {
      (el.offsetParent !== null && homeBox(el).top < vh * 0.9 ? near : far).push(el);
    });
    near.forEach(jumble);
    far.forEach(nudgeAway);
    watchBelowFold(far);

    const start = () => {
      pending = near.sort(() => Math.random() - 0.5);
      if (page.dataset.page === "home") {
        onDrained = stretchFinale;
        pending.sort((a, b) => a.classList.contains("word") === b.classList.contains("word") ? 0 : a.classList.contains("word") ? -1 : 1);
      }
      pump();
      // A short page has fewer pieces than cursors. The rest still come in.
      agents.filter((a) => !a.busy).forEach((a) => rest(a, 800));
    };
    // The opening waits for the fonts, because the headline's width depends on
    // them, but a slow connection does not get to hold the page crooked.
    const fonts = document.fonts ? document.fonts.ready : Promise.resolve();
    Promise.race([fonts, wait(500)]).then(start);
  }

  function enter(name) {
    const page = document.querySelector(`[data-page="${name}"]`);
    if (!page) return;
    flush();
    agents.forEach((a) => a.unpark());
    if (!layer.isConnected) document.body.append(layer);
    buildWires(page);
    if (name === "home") fitPoster();
    // On a phone the diagram is wider than the screen and scrolls sideways, so
    // it opens on the firewall in the middle rather than on its left edge.
    const map = page.querySelector(".topo-frame");
    if (map) map.scrollLeft = (map.scrollWidth - map.clientWidth) / 2;
    wiresDirty = true;
    kick();

    const first = !seenPages.has(name);
    seenPages.add(name);
    if (REDUCED) {
      agents.forEach((a) => rest(a));
      return;
    }
    if (agents[0].x < 0) agents.forEach((a) => a.place(window.scrollX + rand(0, window.innerWidth), window.scrollY - 40));
    if (first) assemble(page);
    else agents.forEach((a) => rest(a, 500));
  }

  function scatter() {
    const page = activePage();
    if (!page || REDUCED) return;
    flush();
    agents.forEach((a) => a.unpark());
    const vh = window.innerHeight;
    const list = piecesOf(page).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < vh;
    });
    const run = runId;
    Promise.all(list.map((el) => {
      const from = { ...pose(el) };
      const held = { x: from.x, y: from.y, r: from.r };
      jumble(el);
      const to = { ...pose(el) };
      setPose(el, held.x, held.y, held.r);
      return tween(rand(320, 460), (p) => setPose(el, to.x * p, to.y * p, to.r * p), settle);
    })).then(() => {
      if (run !== runId) return;
      pending = list.sort(() => Math.random() - 0.5);
      if (page.dataset.page === "home") onDrained = stretchFinale;
      pump();
    });
  }

  /* ---------- Visitors can move things too ---------- */
  document.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const grip = e.target.closest && e.target.closest(".tab, .word");
    if (!grip) return;
    if (grip.classList.contains("word") && e.pointerType === "touch") return;
    const el = grip.closest("[data-piece]");
    if (!el) return;
    if (pending.includes(el)) pending = pending.filter((p) => p !== el);
    const s = pose(el);
    const start = { px: e.clientX, py: e.clientY, x: s.x, y: s.y, r: s.r };
    let moved = false;
    inHand.add(el);
    grip.setPointerCapture(e.pointerId);

    const move = (ev) => {
      const dx = ev.clientX - start.px, dy = ev.clientY - start.py;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      if (!moved) { moved = true; grab(el, "#FF2340"); document.body.classList.add("dragging"); }
      setPose(el, start.x + dx, start.y + dy, clamp(dx * 0.02, -5, 5));
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      inHand.delete(el);
      document.body.classList.remove("dragging");
      if (!moved) return;
      // Some title bars sit inside a link, and letting go of a drag there is
      // not a request to follow it.
      const swallow = (ev) => { ev.preventDefault(); ev.stopPropagation(); };
      document.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => document.removeEventListener("click", swallow, true), 60);
      release(el);
      setTimeout(() => {
        if (inHand.has(el)) return;
        if (REDUCED) return setPose(el, 0, 0, 0);
        pending.unshift(el);
        pump(byName("linter"));
      }, 700);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });

  // A window that is also a link would otherwise start the browser's own link
  // drag, which cancels the pointer and drops the window a few pixels along.
  document.addEventListener("dragstart", (e) => { if (inHand.size) e.preventDefault(); });

  // Anyone starting to use the keyboard should not have to wait for the show.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && (pending.length || agents.some((a) => a.busy))) flush();
  });

  let scrollTimer = 0;
  window.addEventListener("scroll", () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      if (REDUCED) return;
      const top = window.scrollY, bottom = top + window.innerHeight;
      agents.forEach((a) => {
        if (a.busy || (a.y > top + 80 && a.y < bottom - 30)) return;
        a.unpark();
        rest(a, 620);
      });
    }, 160);
  }, { passive: true });

  let sizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(() => {
      if (activePage()?.dataset.page === "home") fitPoster();
      wiresDirty = true;
      kick();
    }, 80);
  });

  if (document.fonts) document.fonts.ready.then(() => {
    fitPoster();
    wiresDirty = true;
    kick();
  });

  if ("ResizeObserver" in window) {
    const watch = () => { wiresDirty = true; kick(); };
    new ResizeObserver(watch).observe(document.getElementById("main"));
  }

  /* ---------- The skyline behind the headline ---------- */
  // Generated rather than shipped as an image, and seeded, so it is the same
  // city on every visit.
  function buildSkyline() {
    const hero = document.querySelector(".hero");
    if (!hero) return;
    let seed = 2077;
    const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const rect = (parent, cls, x, y, w, h) => {
      const r = document.createElementNS(SVG, "rect");
      r.setAttribute("class", cls);
      r.setAttribute("x", x.toFixed(1));
      r.setAttribute("y", y.toFixed(1));
      r.setAttribute("width", w.toFixed(1));
      r.setAttribute("height", h.toFixed(1));
      parent.append(r);
    };
    const wrap = document.createElement("div");
    wrap.className = "skyline";
    wrap.setAttribute("aria-hidden", "true");
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 1600 600");
    svg.setAttribute("preserveAspectRatio", "xMidYMax slice");
    const row = (cls, low, high, litChance) => {
      for (let x = -20; x < 1620;) {
        const w = 44 + next() * 90;
        const h = low + next() * (high - low);
        const top = 600 - h;
        rect(svg, cls, x, top, w, h);
        for (let wy = top + 12; wy < 590; wy += 13) {
          for (let wx = x + 8; wx < x + w - 8; wx += 11) {
            if (next() < litChance) rect(svg, next() < 0.72 ? "sky-c" : "sky-m", wx, wy, 4, 3);
          }
        }
        x += w + next() * 10;
      }
    };
    row("sky-far", 260, 560, 0.05);
    row("sky-near", 110, 340, 0.1);
    // Datamosh: bands of the picture that have slipped out of register.
    for (let i = 0; i < 16; i++) {
      rect(svg, next() < 0.75 ? "sky-band" : "sky-band sky-band--split", next() * 1500, 60 + next() * 520, 90 + next() * 620, 2 + next() * 13);
    }
    wrap.append(svg);
    hero.prepend(wrap);
  }

  /* ---------- Signal loss ---------- */
  // Every few seconds one word tears and a thin strip of the screen slips. The
  // strip is kept small and brief on purpose: nothing here flashes the whole
  // screen, and none of it runs under prefers-reduced-motion.
  function signalLoss() {
    setTimeout(signalLoss, rand(3600, 7400));
    if (document.hidden) return;
    const words = [...document.querySelectorAll("[data-page]:not([hidden]) .word")];
    if (words.length) {
      const word = pick(words);
      word.classList.add("glitch");
      setTimeout(() => word.classList.remove("glitch"), 340);
    }
    const strip = document.createElement("i");
    strip.className = "tear";
    strip.style.top = rand(8, 88) + "vh";
    strip.style.height = rand(5, 34) + "px";
    strip.style.backgroundPositionX = rand(0, 233) + "px";
    layer.append(strip);
    setTimeout(() => strip.remove(), 170);
  }

  /* ---------- Who's here ---------- */
  document.addEventListener("DOMContentLoaded", () => {
    buildSkyline();
    document.querySelectorAll(".word").forEach((w) => { w.dataset.text = w.textContent; });
    if (!REDUCED) signalLoss();
    const bar = document.querySelector(".nav-bar");
    if (bar) {
      const list = document.createElement("div");
      list.className = "presence";
      list.setAttribute("aria-hidden", "true");
      AGENTS.forEach((a) => {
        const dot = document.createElement("span");
        dot.textContent = a.name[0];
        dot.title = a.name;
        dot.style.setProperty("--agent", a.color);
        list.append(dot);
      });
      bar.append(list);
    }
    const btn = document.getElementById("scatterBtn");
    if (btn && !REDUCED) {
      btn.hidden = false;
      btn.addEventListener("click", scatter);
    }
  });

  if (!REDUCED) setInterval(wander, 3800);

  window.Swarm = { enter, fitPoster };
})();
