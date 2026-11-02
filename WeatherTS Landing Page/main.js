/* ============================================================
   WeatherTS — landing · minimal behavior
   ============================================================ */

/* -----------------------------------------------------------
   Download — always whatever the newest release is.

   No version is written down anywhere on this page. The links start
   pointing at /releases/latest, which GitHub redirects to the newest
   release on its own, so the button is already correct before any
   script runs and stays correct if this script never runs at all.

   What the fetch adds is the direct file and the label: the API says
   which asset is the installer, so the button can hand over the .exe
   instead of a page to hunt through, and the facts can name the
   version, its size and its date.
   ----------------------------------------------------------- */

const REPO = "pabloarzaosc/WeatherTS";

const setText = (id, text) => {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
};

async function wireDownload() {
  const links = document.querySelectorAll(".js-dl");
  if (!links.length) return;

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rel = await res.json();
    const asset = (rel.assets || []).find((a) => a.name && a.name.endsWith(".exe"));
    if (!asset) throw new Error("no installer on the latest release");

    links.forEach((a) => { a.href = asset.browser_download_url; });

    const mb = Math.round(asset.size / 1048576);
    const date = new Date(rel.published_at);
    setText("dl-meta", `${rel.tag_name} · ${mb} MB · Windows 10 and 11, 64-bit`);
    setText("hero-version", `${rel.tag_name} · ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`);
    setText("dl-version", rel.tag_name);
    setText("dl-size", `${mb} MB`);
    setText("dl-date", date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }));

    const notes = document.getElementById("dl-notes");
    if (notes && rel.html_url) notes.href = rel.html_url;
  } catch (_) {
    setText("dl-version", "latest");
    setText("dl-size", "see GitHub");
    setText("dl-date", "see GitHub");
  }
}
wireDownload();

/* -----------------------------------------------------------
   Discord: the server's name and how many people are in it and
   online, from the public invite endpoint (it answers any origin,
   no key). The card is complete without it, just without numbers.
   ----------------------------------------------------------- */

const DISCORD_INVITE = "fSbaW7jKW5";

async function wireDiscord() {
  if (!document.getElementById("discord-card")) return;
  try {
    const res = await fetch(`https://discord.com/api/v10/invites/${DISCORD_INVITE}?with_counts=true`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const invite = await res.json();
    const guild = invite.guild || {};

    if (guild.name) setText("discord-name", guild.name);

    const online = invite.approximate_presence_count;
    const members = invite.approximate_member_count;
    if (typeof online === "number" && typeof members === "number") {
      const n = new Intl.NumberFormat();
      setText("discord-online", `${n.format(online)} online`);
      setText("discord-members", `${n.format(members)} ${members === 1 ? "member" : "members"}`);
      document.getElementById("discord-stats").hidden = false;
    }
  } catch (_) {
    // The card and its link stand on their own.
  }
}
wireDiscord();

/* year in the footer */
const ano = document.getElementById("ano");
if (ano) ano.textContent = new Date().getFullYear();

/* -----------------------------------------------------------
   Theme: auto, light or dark, as in the app's settings.

   The page opens dark, the app's own look. "auto" follows the
   visitor's clock with the app's rule, light from 6am to 7pm. The
   inline script in <head> applies it before first paint; here the
   bar's button cycles the mode, and auto is re-checked every minute
   so a page left open crosses dusk on its own.
   ----------------------------------------------------------- */

const THEME_KEY = "weatherts_theme";
const MODES = ["auto", "light", "dark"];
const MODE_NAME = { auto: "Auto", light: "Light", dark: "Dark" };
const themeBtn = document.getElementById("theme-btn");
const themeLabel = document.getElementById("theme-label");

function readMode() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return MODES.includes(saved) ? saved : "dark";
  } catch (_) {
    return "dark";
  }
}

function applyTheme(mode) {
  const h = new Date().getHours();
  const theme = mode === "auto" ? (h >= 6 && h < 19 ? "light" : "dark") : mode;
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  root.setAttribute("data-theme-mode", mode);
  if (themeBtn) themeBtn.setAttribute("aria-label", `Theme: ${MODE_NAME[mode]}`);
  if (themeLabel) themeLabel.textContent = MODE_NAME[mode];
}

applyTheme(readMode());

if (themeBtn) {
  themeBtn.addEventListener("click", () => {
    const next = MODES[(MODES.indexOf(readMode()) + 1) % MODES.length];
    try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
    applyTheme(next);
  });
}
setInterval(() => { if (readMode() === "auto") applyTheme("auto"); }, 60_000);

/* -----------------------------------------------------------
   Top bar: the lit bar under a section's name marks the one on
   screen.
   ----------------------------------------------------------- */

const spyButtons = new Map(
  [...document.querySelectorAll(".topbar__link[data-spy]")].map((b) => [b.dataset.spy, b]),
);

if ("IntersectionObserver" in window && spyButtons.size) {
  const visible = new Map();
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) visible.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0);
    let best = null;
    let bestRatio = 0;
    for (const [id, ratio] of visible) {
      if (ratio > bestRatio) { best = id; bestRatio = ratio; }
    }
    spyButtons.forEach((btn, id) => btn.classList.toggle("is-open", id === best));
  }, { threshold: [0, 0.15, 0.35, 0.6] });

  // The hero is watched too, with no link of its own: at the top of the page
  // nothing is lit rather than the first section peeking in underneath.
  ["top", ...spyButtons.keys()].forEach((id) => {
    const section = document.getElementById(id);
    if (section) observer.observe(section);
  });
}

const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* -----------------------------------------------------------
   Reveal on scroll. Siblings come in a beat apart, and a feature
   group's lamps switch on one row after another (styles.css).
   ----------------------------------------------------------- */

(function reveal() {
  const targets = document.querySelectorAll(
    "main .head, main .lede, main .group, main .feat, main .flow, main .cov, main .faq__item, main .person, main .people__label," +
    " main .facts--dl, main .handle, main .invite, main .center > .btn, main .center > .note, #credits .narrow > .note",
  );
  document.querySelectorAll(".group__list, .flow__steps").forEach((list) => {
    [...list.children].forEach((li, i) => li.style.setProperty("--i", String(i)));
  });
  if (!("IntersectionObserver" in window) || REDUCED_MOTION) return;

  targets.forEach((el) => {
    const siblings = [...el.parentElement.children].filter((c) => c.matches(".group, .flow, .faq__item, .person"));
    const i = siblings.indexOf(el);
    el.style.setProperty("--d", `${Math.min(Math.max(i, 0) * 80, 400)}ms`);
    el.classList.add("reveal");
  });

  let heard = false;
  const io = new IntersectionObserver((entries) => {
    heard = true;
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("is-in");
      io.unobserve(e.target);
    }
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
  targets.forEach((el) => io.observe(el));
  // The observer reports every target once as soon as it starts. If it has
  // said nothing at all, something is wrong with it: show the page as it is
  // rather than leave it hidden.
  setTimeout(() => { if (!heard) targets.forEach((el) => el.classList.add("is-in")); }, 3000);
})();

/* -----------------------------------------------------------
   The demos: each frame's tabs switch between its captures, and
   the line under it says what the one on screen shows.

   A video downloads only when its frame first comes into view
   (preload="none", the file on data-src) and plays only while
   the frame is on screen, so the page costs its pictures, not
   its ~10 MB of loops, until someone scrolls to them. With
   reduced motion nothing plays by itself; the play button does.

   "View full size", or a click on the picture, opens it in one
   shared dialog -- the app's text is small at the page's width.
   ----------------------------------------------------------- */

(function shots() {
  const figs = [...document.querySelectorAll(".shot")];
  if (!figs.length) return;
  const box = document.getElementById("lightbox");
  const canEnlarge = Boolean(box && typeof box.showModal === "function");
  const stage = box && box.querySelector(".lightbox__stage");
  let owner = null;
  const state = new Map();
  const items = (fig) => [...fig.querySelectorAll(".shot__item")];
  const current = (fig) => items(fig)[state.get(fig).index];

  function sync(fig) {
    const st = state.get(fig);
    items(fig).forEach((el, i) => {
      const on = i === st.index;
      el.hidden = !on;
      if (el.tagName !== "VIDEO") return;
      if (on && st.visible && !st.paused) {
        if (!el.getAttribute("src") && el.dataset.src) el.src = el.dataset.src;
        el.play().catch(() => {});
      } else {
        el.pause();
      }
    });
    const cur = current(fig);
    const video = cur.tagName === "VIDEO";
    fig.classList.toggle("shot--video", video);
    fig.classList.toggle("is-playing", video && !st.paused);
    const cap = fig.querySelector(".shot__cap");
    if (cap && cur.dataset.cap) cap.textContent = cur.dataset.cap;
    fig.querySelectorAll(".shot__tab").forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === st.index));
      tab.tabIndex = i === st.index ? 0 : -1;
    });
    const play = fig.querySelector(".shot__play");
    if (play) play.setAttribute("aria-label", st.paused ? "Play" : "Pause");
  }

  /* Every capture exists twice, taken in the app's dark and light themes
     (data-dark / data-light), and the page shows the one of its own theme.
     A loop already playing carries on from the same moment in the other
     file: the two were stepped over the very same frames. */
  const themeOf = () => (document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");

  function themeMedia() {
    const theme = themeOf();
    document.querySelectorAll(".shot__item").forEach((el) => {
      const want = el.dataset[theme];
      if (!want) return;
      if (el.tagName !== "VIDEO") {
        if (el.getAttribute("src") !== want) el.src = want;
        return;
      }
      const poster = el.dataset[theme === "light" ? "posterLight" : "posterDark"];
      if (poster && el.getAttribute("poster") !== poster) el.poster = poster;
      el.dataset.src = want;
      const loaded = el.getAttribute("src");
      if (!loaded || loaded === want) return;
      const at = el.currentTime;
      const playing = !el.paused;
      el.src = want;
      // preload="none": nothing loads until play() asks for it.
      el.addEventListener("loadedmetadata", () => {
        if (el.duration) el.currentTime = at % el.duration;
      }, { once: true });
      if (playing) el.play().catch(() => {});
    });
  }
  themeMedia();
  new MutationObserver(themeMedia).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  figs.forEach((fig) => {
    state.set(fig, { index: 0, paused: REDUCED_MOTION, visible: false });
    const tabs = [...fig.querySelectorAll(".shot__tab")];
    const pick = (i) => { state.get(fig).index = i; sync(fig); };
    tabs.forEach((tab, i) => tab.addEventListener("click", () => pick(i)));
    // Arrow keys move along the tabs, as in any tab list.
    fig.querySelector(".shot__tabs")?.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const n = tabs.length;
      const i = (state.get(fig).index + (e.key === "ArrowRight" ? 1 : n - 1)) % n;
      pick(i);
      tabs[i].focus();
      e.preventDefault();
    });
    fig.querySelector(".shot__play")?.addEventListener("click", () => {
      const st = state.get(fig);
      st.paused = !st.paused;
      sync(fig);
    });
    fig.querySelector(".shot__zoom")?.addEventListener("click", () => enlarge(fig));
    fig.querySelector(".shot__stage")?.addEventListener("click", () => enlarge(fig));
    sync(fig);
  });

  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        state.get(e.target).visible = e.isIntersecting;
        sync(e.target);
      }
    }, { threshold: 0.25 });
    figs.forEach((fig) => io.observe(fig));
  } else {
    figs.forEach((fig) => { state.get(fig).visible = true; sync(fig); });
  }

  function enlarge(fig) {
    if (!canEnlarge) return;
    const cur = current(fig);
    let el;
    if (cur.tagName === "VIDEO") {
      el = document.createElement("video");
      el.src = cur.dataset.src;
      el.poster = cur.poster;
      el.muted = true;
      el.loop = true;
      el.playsInline = true;
      el.controls = true;
      el.autoplay = !REDUCED_MOTION;
      el.setAttribute("aria-label", cur.getAttribute("aria-label") || "");
    } else {
      el = document.createElement("img");
      el.src = cur.currentSrc || cur.src;
      el.alt = cur.alt;
    }
    stage.replaceChildren(el);
    box.querySelector(".lightbox__cap").textContent = cur.dataset.cap || "";
    // The small copy rests while the big one is open.
    owner = fig;
    state.get(fig).visible = false;
    sync(fig);
    box.showModal();
  }

  if (!canEnlarge) return;
  box.addEventListener("close", () => {
    stage.replaceChildren();
    if (!owner) return;
    const rect = owner.getBoundingClientRect();
    state.get(owner).visible = rect.bottom > 0 && rect.top < window.innerHeight;
    sync(owner);
    owner = null;
  });
  // A click on the dimmed page around it closes it, like the close button.
  box.addEventListener("click", (e) => { if (e.target === box) box.close(); });
  box.querySelector(".lightbox__close")?.addEventListener("click", () => box.close());
})();

/* -----------------------------------------------------------
   The hero figures count up once, as the page opens.
   ----------------------------------------------------------- */

(function countUp() {
  const cells = document.querySelectorAll(".hero [data-count]");
  if (REDUCED_MOTION || !cells.length) return;
  const DURATION = 1300;
  const DELAY = 1000;
  const start = performance.now() + DELAY;
  cells.forEach((dd) => { dd.textContent = "0" + (dd.dataset.suffix || ""); });
  function frame(now) {
    const t = Math.min(1, Math.max(0, (now - start) / DURATION));
    const eased = 1 - Math.pow(1 - t, 3);
    cells.forEach((dd) => {
      dd.textContent = Math.round(Number(dd.dataset.count) * eased) + (dd.dataset.suffix || "");
    });
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();

/* -----------------------------------------------------------
   Isobars behind the hero: a low's rings, 4 hPa apart, stretched
   east-west and a little uneven, the way a real one draws. Each
   ring draws itself in from the centre out (styles.css), and the
   system drifts slowly. Decoration only -- no real chart.
   ----------------------------------------------------------- */

(function isobars() {
  const host = document.querySelector(".isobars");
  if (!host) return;
  const NS = "http://www.w3.org/2000/svg";
  const W = 1200;
  const H = 720;
  const CX = 930;
  const CY = 320;
  const RINGS = 12;
  const CENTRE_HPA = 992;

  const el = (name, attrs) => {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  };

  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "xMaxYMid slice" });
  const system = el("g", { class: "isobars__system" });

  for (let i = 0; i < RINGS; i++) {
    const base = 46 + i * 58;
    const points = [];
    const N = 120;
    for (let k = 0; k <= N; k++) {
      const th = (k / N) * Math.PI * 2;
      const r = base * (1 + 0.08 * Math.sin(2 * th + 0.4 + i * 0.22) + 0.04 * Math.sin(3 * th + 1.3 - i * 0.15));
      points.push(`${(CX + r * Math.cos(th) * 1.3).toFixed(1)} ${(CY + r * Math.sin(th) * 0.92).toFixed(1)}`);
    }
    const path = el("path", {
      d: `M${points.join("L")}Z`,
      pathLength: 1,
      class: i % 2 === 1 ? "is-major" : "",
      style: `--i:${i}`,
    });
    system.appendChild(path);

    // A value on every other ring, where the ring crosses below the centre.
    if (i % 2 === 1) {
      const th = Math.PI / 2;
      const r = base * (1 + 0.08 * Math.sin(2 * th + 0.4 + i * 0.22) + 0.04 * Math.sin(3 * th + 1.3 - i * 0.15));
      const y = CY + r * 0.92;
      if (y < H - 10) {
        const label = el("text", { x: CX, y: y + 4, "text-anchor": "middle", style: `--i:${i}` });
        label.textContent = String(CENTRE_HPA + 4 * (i + 1));
        system.appendChild(label);
      }
    }
  }

  const low = el("text", { x: CX, y: CY + 8, "text-anchor": "middle", class: "isobars__low", style: "--i:0" });
  low.textContent = "L";
  const centre = el("text", { x: CX, y: CY + 30, "text-anchor": "middle", class: "isobars__centre", style: "--i:0" });
  centre.textContent = String(CENTRE_HPA);
  system.append(low, centre);

  svg.appendChild(system);
  host.appendChild(svg);
})();
