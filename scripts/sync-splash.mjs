// Copies the opening screen from electron/splash.js into index.html, between
// its splash:head and splash:body markers, so the page React mounts over shows
// the same screen the window did. Run by `npm run build`; run it by hand
// (`npm run splash:sync`) after editing splash.js to see the change in dev.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SPLASH_CSS, SPLASH_SCRIPT, splashBody } from "../electron/splash.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = path.join(root, "index.html");
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const indent = (text, pad) => text.split("\n").map((l) => (l ? pad + l : l)).join("\n");

function between(html, name, content) {
  const start = `<!-- splash:${name}:start -->`;
  const end = `<!-- splash:${name}:end -->`;
  const a = html.indexOf(start);
  const b = html.indexOf(end);
  if (a < 0 || b < a) throw new Error(`index.html has no ${start} ... ${end} markers`);
  return html.slice(0, a + start.length) + "\n" + content + "\n" + html.slice(b);
}

let html = readFileSync(indexPath, "utf8");
html = between(html, "head", indent(`<style>html, body { margin: 0; background: #202020; }${SPLASH_CSS}</style>`, "    ") + "\n   ");
html = between(
  html,
  "body",
  indent(splashBody({ version, status: "loading the map…", progress: 0.3 }), "      ") +
    "\n" + indent(`<script>${SPLASH_SCRIPT}</script>`, "      ") + "\n     ",
);
writeFileSync(indexPath, html);
console.log(`index.html splash synced (v${version})`);
