/**
 * Release notes, shared by the update banner and the What's New panel.
 *
 * Both read the same GitHub releases the updater installs from, so there is no
 * changelog kept by hand in the app to drift out of step with what shipped.
 */

export const REPO = "pabloarzaosc/WeatherTS";
export const RELEASES_URL = `https://github.com/${REPO}/releases`;

export interface ReleaseEntry {
  /** Tag with any leading "v" stripped, e.g. "0.3.6". */
  version: string;
  title: string;
  /** Notes as readable plain text, already flattened out of GitHub's HTML. */
  notes: string;
  /** ISO date string, or null when GitHub did not report one. */
  published: string | null;
  url: string;
}

/**
 * GitHub hands release bodies over as rendered HTML -- both in the releases
 * feed electron-updater reads and in the REST API. Dropping that straight into
 * JSX prints the raw tags, so flatten it to text. Deliberately not
 * dangerouslySetInnerHTML: this is remote content and the renderer runs with
 * webSecurity disabled.
 */
export function notesToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/(li|h[1-6]|p|ul|ol|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    // &amp; last, so text that was legitimately escaped is not decoded twice
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Markdown arrives from the REST API; the feed sends HTML. Handle both. */
function toText(body: string): string {
  const looksHtml = /<\/?(p|ul|ol|li|h[1-6]|strong|em|code)\b/i.test(body);
  if (looksHtml) return notesToText(body);
  return body
    .replace(/\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)")
    .replace(/^#{1,6}\s*(.+)$/gm, "\n$1\n")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/^\s*\d+\.\s+/gm, "• ")
    .replace(/```([\s\S]*?)```/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const stripV = (tag: string) => tag.replace(/^v/i, "");

/**
 * Published releases, newest first. Drafts and prereleases are left out: the
 * panel is a record of what users actually received.
 */
export async function fetchReleases(signal?: AbortSignal): Promise<ReleaseEntry[]> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`, {
    headers: { Accept: "application/vnd.github+json" },
    signal,
  });
  if (!res.ok) throw new Error(`GitHub releases ${res.status}`);
  const raw = (await res.json()) as {
    tag_name: string;
    name: string | null;
    body: string | null;
    published_at: string | null;
    html_url: string;
    draft: boolean;
    prerelease: boolean;
  }[];

  return raw
    .filter((r) => !r.draft && !r.prerelease)
    .map((r) => ({
      version: stripV(r.tag_name),
      title: r.name?.trim() || r.tag_name,
      notes: toText(r.body ?? ""),
      published: r.published_at,
      url: r.html_url,
    }));
}

/** Compares dotted numeric versions. Returns >0 when a is newer than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
