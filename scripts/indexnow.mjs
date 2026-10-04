// Tell Bing (and the other IndexNow engines: Yandex, Seznam, Naver, Yep) that
// weatherts.tech changed, so they crawl it again within hours instead of weeks.
// Google does not take IndexNow; it reads the sitemap and Search Console.
//
//   npm run landing:indexnow [-- --dry-run] [-- https://weatherts.tech/other-page]
//
// Run it after a deploy of "WeatherTS Landing Page/" has gone live. With no
// URLs it submits the home page.
//
// The key is not a secret. IndexNow proves the site is ours by reading the key
// back from https://weatherts.tech/<key>.txt, so the file lives in the landing
// folder and is deployed with it. This checks that file is live first: the API
// answers 403 until it is.

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "weatherts.tech";
const SITE = `https://${HOST}/`;
const ENDPOINT = "https://api.indexnow.org/indexnow";
const LANDING = join(dirname(fileURLToPath(import.meta.url)), "..", "WeatherTS Landing Page");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const urls = args.filter((a) => /^https?:\/\//.test(a));
const urlList = urls.length ? urls : [SITE];

const keyFiles = readdirSync(LANDING).filter((f) => /^[0-9a-f]{32}\.txt$/.test(f));
if (keyFiles.length !== 1) throw new Error(`Expected one <key>.txt in ${LANDING}, found ${keyFiles.length}`);
const key = readFileSync(join(LANDING, keyFiles[0]), "utf8").trim();
const keyLocation = `${SITE}${key}.txt`;

for (const u of urlList) {
  if (new URL(u).host !== HOST) throw new Error(`${u} is not on ${HOST}; IndexNow refuses the whole batch`);
}

const live = await fetch(keyLocation, { cache: "no-store" }).then(
  async (r) => (r.ok ? (await r.text()).trim() : `HTTP ${r.status}`),
  (e) => `unreachable (${e.message})`,
);
if (live !== key) {
  console.error(`${keyLocation} answers ${JSON.stringify(live.slice(0, 60))}, not the key.`);
  console.error("Deploy the landing folder (with the key file at its root) first.");
  process.exit(1);
}

const body = { host: HOST, key, keyLocation, urlList };
if (dryRun) {
  console.log("Key file is live. Would POST to", ENDPOINT);
  console.log(JSON.stringify(body, null, 2));
  process.exit(0);
}

const res = await fetch(ENDPOINT, {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify(body),
});
const MEANING = {
  200: "accepted",
  202: "received; the key is still being checked",
  400: "bad request",
  403: "key not valid (the key file is missing or differs)",
  422: "URLs do not belong to the host, or the key does not match",
  429: "too many requests; try again later",
};
console.log(`IndexNow ${res.status}: ${MEANING[res.status] ?? (await res.text()).slice(0, 200)}`);
console.log(urlList.join("\n"));
if (res.status >= 300) process.exit(1);
