/* ============================================================
   WeatherTS — landing · minimal behavior
   ============================================================ */

/* -----------------------------------------------------------
   Email list — powered by MailerLite (embedded form endpoint).

   The site stays 100% static: the browser POSTs the email straight
   to MailerLite's public form endpoint. No backend, no server, no
   secret key. MailerLite stores every signup, and the one message
   goes out as a campaign from its dashboard to everyone on the form.

   The values below come straight from the MailerLite embed code
   (form action: .../jsonp/{ACCOUNT}/forms/{FORM_ID}/subscribe).

   CORS: the endpoint returns `access-control-allow-origin: *` and
   accepts a urlencoded POST (a CORS-safelisted "simple" request, no
   preflight), so a normal fetch can read the JSON response —
   {"success":true} on success.

   Until the IDs below are filled in, the form falls back to opening
   the visitor's email client (mailto) so it's never dead.
   ----------------------------------------------------------- */

const MAILERLITE_ACCOUNT = "2512895";            // MailerLite account ID
const MAILERLITE_FORM_ID = "193117441524499680"; // MailerLite embedded form ID
const WAITLIST_MAILTO    = "hello@weatherts.app"; // fallback, used only if the IDs above are blank

const MAILERLITE_ENDPOINT = MAILERLITE_ACCOUNT && MAILERLITE_FORM_ID
  ? `https://assets.mailerlite.com/jsonp/${MAILERLITE_ACCOUNT}/forms/${MAILERLITE_FORM_ID}/subscribe`
  : "";

const form = document.getElementById("waitlist");
const input = document.getElementById("email");
const msg = document.getElementById("waitlist-msg");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const JOINED = "You're on the list. The one email comes when WeatherTS leaves beta.";

function setMsg(text, kind) {
  msg.textContent = text;
  msg.classList.remove("is-ok", "is-err");
  if (kind) msg.classList.add(kind);
}

if (form) {
  // if the visitor already joined, show the confirmed state
  try {
    if (localStorage.getItem("weatherts_waitlist") === "1") {
      form.querySelector(".btn").textContent = "You're on the list";
      setMsg(JOINED, "is-ok");
    }
  } catch (_) { /* localStorage unavailable — carry on */ }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = input.value.trim();

    if (!EMAIL_RE.test(email)) {
      input.setAttribute("aria-invalid", "true");
      setMsg("Check the email — something looks off.", "is-err");
      input.focus();
      return;
    }
    input.removeAttribute("aria-invalid");

    const btn = form.querySelector(".btn");
    const done = () => {
      try { localStorage.setItem("weatherts_waitlist", "1"); } catch (_) {}
      btn.textContent = "You're on the list";
      input.value = "";
    };

    if (MAILERLITE_ENDPOINT) {
      setMsg("Sending…", null);
      btn.disabled = true;
      try {
        // urlencoded, matching the native MailerLite form's default enctype,
        // so this stays a simple request (no preflight) with a readable reply.
        const data = new URLSearchParams();
        data.append("fields[email]", email);
        data.append("ml-submit", "1");
        data.append("anticsrf", "true");
        const res = await fetch(MAILERLITE_ENDPOINT, { method: "POST", body: data });
        const out = await res.json().catch(() => ({}));
        if (!res.ok || out.success === false) throw new Error("subscribe failed");
        done();
        setMsg(JOINED, "is-ok");
      } catch (_) {
        setMsg("Something went wrong on my end. Try again in a bit?", "is-err");
      } finally {
        btn.disabled = false;
      }
    } else {
      // no-backend fallback: open the email client pre-filled
      const subject = encodeURIComponent("Email list — WeatherTS");
      const body = encodeURIComponent("I'd like the email when WeatherTS leaves beta.\n\nMy email: " + email);
      window.location.href = `mailto:${WAITLIST_MAILTO}?subject=${subject}&body=${body}`;
      done();
      setMsg("Opened your email client with the signup ready — just hit send.", "is-ok");
    }
  });
}

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
    "main .head, main .lede, main .group, main .faq__item, main .person, main .people__label," +
    " main .facts--dl, main .waitlist, main .handle, main .center > .btn, main .center > .note, #credits .narrow > .note",
  );
  document.querySelectorAll(".group__list").forEach((list) => {
    [...list.children].forEach((li, i) => li.style.setProperty("--i", String(i)));
  });
  if (!("IntersectionObserver" in window) || REDUCED_MOTION) return;

  targets.forEach((el) => {
    const siblings = [...el.parentElement.children].filter((c) => c.matches(".group, .faq__item, .person"));
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
