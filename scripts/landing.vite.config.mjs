/**
 * The landing page's vite config, used only by scripts/dev-all.mjs.
 *
 * It exists for one setting. The app and the landing page were two vite
 * servers sharing node_modules/.vite, each writing its own config hash into
 * the dependency cache they had in common -- so every start of the stack had
 * one of them announce "Re-optimizing dependencies because vite config has
 * changed" and rewrite the other's cache: the app on one run, the landing page
 * on the next. A cache of its own ends the tug-of-war.
 *
 * Kept out of the landing page's folder so that folder stays a plain static
 * site with no idea it is being served by vite.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export default {
  root: path.join(ROOT, "WeatherTS Landing Page"),
  cacheDir: path.join(ROOT, "node_modules", ".vite-landing"),
  // No host: "localhost", as it always was. dev-all checks both IPv4 and IPv6
  // for exactly this reason.
  server: { port: 4173, strictPort: true },
};
