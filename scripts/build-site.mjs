/**
 * Put weatherts.tech together for Cloudflare Pages: the landing page at the
 * root and the web build of the app (dist-web, `vite build --mode web`) at
 * /app. Writes dist-site/, which `npm run web:deploy` uploads.
 *
 * The landing folder stays a plain static site; this only copies it.
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANDING = path.join(ROOT, "WeatherTS Landing Page");
const APP = path.join(ROOT, "dist-web");
const OUT = path.join(ROOT, "dist-site");

if (!existsSync(path.join(APP, "index.html"))) {
  console.error("dist-web/index.html is missing: run vite build --mode web first.");
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
cpSync(LANDING, OUT, { recursive: true });
cpSync(APP, path.join(OUT, "app"), { recursive: true });

// The app's hashed chunks never change under one name: keep them a year. The
// page itself is checked every time, so a release reaches everyone at once.
writeFileSync(
  path.join(OUT, "_headers"),
  [
    "/app/assets/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "",
    "/app/",
    "  Cache-Control: no-cache",
    "",
    "/app/index.html",
    "  Cache-Control: no-cache",
    "",
  ].join("\n"),
);
writeFileSync(path.join(OUT, "_redirects"), "/app /app/ 301\n");

// A private test copy (`--noindex`): nothing in it may reach a search engine,
// so the real site's listing is never shadowed by a stray pages.dev address.
if (process.argv.includes("--noindex")) {
  writeFileSync(path.join(OUT, "robots.txt"), "User-agent: *\nDisallow: /\n");
  rmSync(path.join(OUT, "sitemap.xml"), { force: true });
  const headers = path.join(OUT, "_headers");
  writeFileSync(headers, `/*\n  X-Robots-Tag: noindex, nofollow\n\n` + readFileSync(headers, "utf8"));
}
console.log(`dist-site ready: the landing page at /, the app at /app/${process.argv.includes("--noindex") ? " (noindex test copy)" : ""}`);
