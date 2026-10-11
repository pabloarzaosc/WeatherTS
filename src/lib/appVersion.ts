/**
 * The running version. The desktop asks Electron's main process (the packaged
 * app's real version); the web build has no main process and carries the
 * version it was built from (package.json, through vite's define).
 */
declare const __APP_VERSION__: string;

const desktop = () => (window as unknown as { electronAPI?: { getVersion?: () => Promise<string> } }).electronAPI;

export function appVersion(): Promise<string | null> {
  const get = desktop()?.getVersion;
  if (get) return get().catch(() => null);
  return Promise.resolve(typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : null);
}
