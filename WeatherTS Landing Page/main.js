/* ============================================================
   WeatherTS — landing · minimal behavior
   ============================================================ */

/* -----------------------------------------------------------
   Waitlist — powered by MailerLite (embedded form endpoint).

   The site stays 100% static: the browser POSTs the email straight
   to MailerLite's public form endpoint. No backend, no server, no
   secret key. MailerLite stores every signup, and when WeatherTS
   launches you send ONE campaign from the dashboard to everyone.

   The values below come straight from the MailerLite embed code
   (form action: .../jsonp/{ACCOUNT}/forms/{FORM_ID}/subscribe).
   To wire a different form, create it in MailerLite → Forms →
   Embedded forms, then copy the account + form IDs from its action
   URL into the constants below.

   TO SEND THE LAUNCH EMAIL (later):
     In MailerLite, go to Campaigns → Create campaign. Write the
     "we're live" message, pick this form's group/subscribers as the
     recipients, send. Everyone who joined gets it in one shot.

   CORS: the endpoint returns `access-control-allow-origin: *` and
   accepts a urlencoded POST (a CORS-safelisted "simple" request, no
   preflight), so a normal fetch can read the JSON response —
   {"success":true} on success. If double opt-in is enabled on the
   form, the visitor also gets a confirmation email before they
   count as confirmed.

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

function setMsg(text, kind) {
  msg.textContent = text;
  msg.classList.remove("is-ok", "is-err");
  if (kind) msg.classLisSt.add(kind);
}

if (form) {
  // if the visitor already joined, show the confirmed state
  try {
    if (localStorage.getItem("weatherts_waitlist") === "1") {
      form.querySelector(".btn").textContent = "You're on the list";
      setMsg("You're on the waitlist. I'll let you know when WeatherTS goes live.", "is-ok");
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
        // urlencoded, matching the native MailerLite form's default enctype.
        // URLSearchParams sets Content-Type: application/x-www-form-urlencoded,
        // a CORS-safelisted type — so this stays a simple request (no preflight)
        // and the JSON response is readable ({"success":true}).
        const data = new URLSearchParams();
        data.append("fields[email]", email);
        data.append("ml-submit", "1");
        data.append("anticsrf", "true");
        const res = await fetch(MAILERLITE_ENDPOINT, { method: "POST", body: data });
        const out = await res.json().catch(() => ({}));
        if (!res.ok || out.success === false) throw new Error("subscribe failed");
        done();
        setMsg("You're on the waitlist. I'll let you know when WeatherTS goes live.", "is-ok");
      } catch (_) {
        setMsg("Something went wrong on my end. Try again in a bit?", "is-err");
      } finally {
        btn.disabled = false;
      }
    } else {
      // no-backend fallback: open the email client pre-filled
      const subject = encodeURIComponent("Waitlist — WeatherTS");
      const body = encodeURIComponent(
        "I'd like to join the WeatherTS waitlist.\n\nMy email: " + email
      );
      window.location.href =
        `mailto:${WAITLIST_MAILTO}?subject=${subject}&body=${body}`;
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
   script runs and stays correct if this script never runs at all --
   a rate-limited API, a blocked request, JS switched off.

   What the fetch adds is the direct file and the label: the API says
   which asset is the installer, so the button can hand over the .exe
   instead of a page to hunt through, and the note underneath can name
   the version and its size. If that call fails, the fallback link is
   still the right link.
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
    setText("dl-meta", `${rel.tag_name} · ${mb} MB · Windows 64-bit`);
    setText("dl-version", rel.tag_name);
    setText("dl-size", `${mb} MB`);
    setText("dl-date", new Date(rel.published_at).toLocaleDateString(undefined, {
      year: "numeric", month: "short", day: "numeric",
    }));

    const notes = document.getElementById("dl-notes");
    if (notes && rel.html_url) notes.href = rel.html_url;
  } catch (_) {
    setText("dl-version", "latest");
    setText("dl-size", "see Github");
    setText("dl-date", "see Github");
  }
}
wireDownload();

/* -----------------------------------------------------------
   Demo window.

   Five days from the date below. Change DEMO_START to reopen it --
   that constant is the only place the window is written down, and
   the pill, the note and the FAQ all read from it.
   ----------------------------------------------------------- */

const DEMO_START = "2026-08-22";  // the day the demo went out
const DEMO_DAYS = 5;

function demoState() {
  const start = new Date(`${DEMO_START}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + DEMO_DAYS);
  // Ceil, so the last partial day still counts as a day left rather than
  // rounding someone's remaining afternoon down to zero.
  const left = Math.ceil((end - new Date()) / 86400000);
  return { end, left, open: left > 0 };
}

function renderDemo() {
  const pill = document.getElementById("demo-pill");
  const note = document.getElementById("demo-note");
  const { end, left, open } = demoState();

  const closes = end.toLocaleDateString(undefined, { month: "short", day: "numeric" });

  if (pill) {
    pill.textContent = !open
      ? "Demo closed"
      : left === 1
        ? "Demo · last day"
        : `Demo · ${left} days left`;
    pill.classList.toggle("pill--over", !open);
  }

  if (note) {
    note.innerHTML = open
      ? `A five-day demo, open until ${closes}. If it lands well it stays up as a public beta — ` +
        `<a href="#lista">the waitlist</a> is where that gets announced.`
      : `The five-day demo has closed. <a href="#lista">Join the waitlist</a> to hear if it comes back as a public beta.`;
  }
}
renderDemo();

/* year in the footer */
const ano = document.getElementById("ano");
if (ano) ano.textContent = new Date().getFullYear();

/* -----------------------------------------------------------
   Theme toggle (light/dark).
   The initial theme is already applied by an inline script in
   the <head> (avoids flash). Here we only handle the button
   click and persistence in localStorage.
   ----------------------------------------------------------- */
const THEME_KEY = "weatherts_theme";
const themeBtn = document.getElementById("theme-toggle");

function syncThemeButton() {
  if (!themeBtn) return;
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  themeBtn.setAttribute("aria-pressed", String(isDark));
}
syncThemeButton();

if (themeBtn) {
  themeBtn.addEventListener("click", () => {
    const next =
      document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
    syncThemeButton();
  });
}
