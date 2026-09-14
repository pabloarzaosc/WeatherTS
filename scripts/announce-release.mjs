// Announce a published release in the Discord #update channel.
//
//   npm run release:announce -- --notes path/to/discord-notes.md [--dry-run]
//
// The notes file holds the sections and bullets (### Radar, - ...). This adds
// the @everyone mention, the title, the install line and the release link that
// Discord turns into the GitHub card, and splits the post at section breaks
// when it runs past Discord's 2000 characters a message.
//
// The webhook URL is a secret and never lives in this repository: it is read
// from WEATHERTS_DISCORD_WEBHOOK, or from ~/.weatherts/discord-update-webhook.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO = "pabloarzaosc/WeatherTS";
const LIMIT = 2000;

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function webhook() {
  if (process.env.WEATHERTS_DISCORD_WEBHOOK) return process.env.WEATHERTS_DISCORD_WEBHOOK.trim();
  const file = join(homedir(), ".weatherts", "discord-update-webhook");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  throw new Error("No webhook: set WEATHERTS_DISCORD_WEBHOOK or write it to ~/.weatherts/discord-update-webhook");
}

async function main() {
  const dryRun = args.includes("--dry-run");
  const notesPath = flag("--notes");
  if (!notesPath) throw new Error("usage: npm run release:announce -- --notes <discord-notes.md> [--dry-run]");

  const version = flag("--version") ?? JSON.parse(readFileSync("package.json", "utf8")).version;
  const tag = `v${version}`;
  const notes = readFileSync(notesPath, "utf8").replace(/\r\n/g, "\n").trim();

  // Never announce what people cannot download yet.
  const release = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "weatherts-release" },
  });
  if (!release.ok) throw new Error(`GitHub has no published release ${tag} (${release.status})`);
  const info = await release.json();
  if (info.draft || info.prerelease) throw new Error(`${tag} is a draft or pre-release`);

  const head = [
    "@everyone",
    `## WeatherTS ${version}`,
    `WeatherTS ${version} is now available. Installed copies update automatically on the next launch. New installs:`,
    // In angle brackets so this one does not get a preview; the release link does.
    `<https://github.com/${REPO}/releases/latest>`,
  ].join("\n");
  const tail = `https://github.com/${REPO}/releases/tag/${tag}`;

  // Whole sections per message, so no heading is split from its bullets.
  const blocks = [head, ...notes.split(/\n(?=#{1,3} )/).map((b) => b.trim()), tail];
  const messages = [];
  for (const block of blocks) {
    if (block.length > LIMIT) throw new Error(`A section is longer than ${LIMIT} characters:\n${block.slice(0, 200)}`);
    const last = messages.length - 1;
    if (last >= 0 && messages[last].length + 2 + block.length <= LIMIT) messages[last] += `\n\n${block}`;
    else messages.push(block);
  }

  if (dryRun) {
    messages.forEach((m, i) => console.log(`----- message ${i + 1} (${m.length} chars)\n${m}`));
    return;
  }

  const url = webhook();
  for (const [i, content] of messages.entries()) {
    const res = await fetch(`${url}?wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        // Only the first message pings.
        allowed_mentions: { parse: i === 0 ? ["everyone"] : [] },
      }),
    });
    if (!res.ok) throw new Error(`Discord refused message ${i + 1}: ${res.status} ${await res.text()}`);
    const posted = await res.json();
    console.log(`posted message ${i + 1} of ${messages.length} (${content.length} chars), id ${posted.id}`);
  }
}

// No throw or process.exit on the way out: on Windows, Node aborts with a libuv
// assertion when it exits while a fetch socket is still closing.
main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
