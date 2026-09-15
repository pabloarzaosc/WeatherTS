// Announce a published release on Discord, in every channel configured.
//
//   npm run release:announce -- --notes path/to/discord-notes.md [--dry-run]
//
// The notes file holds the sections and bullets (### Radar, - ...). This adds
// each channel's mention, the title, the install line and the release link that
// Discord turns into the GitHub card, and splits the post at section breaks
// when it runs past Discord's 2000 characters a message.
//
// Webhook URLs are secrets and never live in this repository. They are read
// from ~/.weatherts/discord-webhooks.json, a list of
//   { "name": "update", "url": "https://discord.com/api/webhooks/...", "mention": "everyone" }
//   { "name": "Weather Ping", "url": "...", "mention": { "role": "<role id>" } }
// with WEATHERTS_DISCORD_WEBHOOK (one URL, @everyone) or the older
// ~/.weatherts/discord-update-webhook as fallbacks.

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

function targets() {
  if (process.env.WEATHERTS_DISCORD_WEBHOOK) {
    return [{ name: "env", url: process.env.WEATHERTS_DISCORD_WEBHOOK.trim(), mention: "everyone" }];
  }
  const dir = join(homedir(), ".weatherts");
  const list = join(dir, "discord-webhooks.json");
  if (existsSync(list)) {
    const parsed = JSON.parse(readFileSync(list, "utf8"));
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error(`${list} must be a non-empty list`);
    return parsed;
  }
  const single = join(dir, "discord-update-webhook");
  if (existsSync(single)) return [{ name: "update", url: readFileSync(single, "utf8").trim(), mention: "everyone" }];
  throw new Error("No webhook: write ~/.weatherts/discord-webhooks.json or set WEATHERTS_DISCORD_WEBHOOK");
}

/** The ping text and the permission Discord needs to actually ping it. */
function mentionOf(mention) {
  if (mention === "everyone") return { text: "@everyone", allowed: { parse: ["everyone"] } };
  if (mention && typeof mention === "object" && /^\d+$/.test(String(mention.role))) {
    const id = String(mention.role);
    return { text: `<@&${id}>`, allowed: { roles: [id] } };
  }
  return { text: "", allowed: { parse: [] } };
}

function buildMessages(mentionText, version, tag, notes) {
  const head = [
    mentionText,
    `## WeatherTS ${version}`,
    `WeatherTS ${version} is now available. Installed copies update automatically on the next launch. New installs:`,
    // In angle brackets so this one does not get a preview; the release link does.
    `<https://github.com/${REPO}/releases/latest>`,
  ]
    .filter(Boolean)
    .join("\n");
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
  return messages;
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

  for (const target of targets()) {
    const mention = mentionOf(target.mention);
    const messages = buildMessages(mention.text, version, tag, notes);

    if (dryRun) {
      console.log(`===== ${target.name} (${messages.length} message${messages.length === 1 ? "" : "s"})`);
      messages.forEach((m, i) => console.log(`----- message ${i + 1} (${m.length} chars)\n${m}`));
      continue;
    }

    for (const [i, content] of messages.entries()) {
      const res = await fetch(`${target.url}?wait=true`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          // Only the first message pings.
          allowed_mentions: i === 0 ? mention.allowed : { parse: [] },
        }),
      });
      if (!res.ok) throw new Error(`${target.name}: Discord refused message ${i + 1}: ${res.status} ${await res.text()}`);
      const posted = await res.json();
      console.log(`${target.name}: posted message ${i + 1} of ${messages.length} (${content.length} chars), id ${posted.id}`);
    }
  }
}

// No throw or process.exit on the way out: on Windows, Node aborts with a libuv
// assertion when it exits while a fetch socket is still closing.
main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
