/**
 * What weatherts.tech/app shows while the web version is switched off
 * (VITE_WEB_OFFLINE=1 in .env.web, then npm run web:build and a deploy). The
 * workspace never mounts, so nothing reaches the hosted backend. The Windows
 * app's Google sign-in page (?desktop-login=1) lives at the same address and
 * keeps working: main.tsx checks for it before this.
 */
export const WEB_OFFLINE = import.meta.env.VITE_WEB_OFFLINE === "1";

const DOWNLOAD = "https://github.com/pabloarzaosc/WeatherTS/releases/latest";

export function WebOffline() {
  return (
    <div className="gate desktop-login">
      <div className="gate__card auth desktop-login__card">
        <img className="desktop-login__logo" src="./logo.png" alt="WeatherTS" />
        <h1>The web version is offline for now</h1>
        <p>WeatherTS for Windows has everything the web version had, and more. It is free and updates itself.</p>
        <a className="auth__provider desktop-login__open" href={DOWNLOAD} target="_blank" rel="noopener">
          Download for Windows
        </a>
        <p className="desktop-login__note">
          <a href="https://weatherts.tech/">weatherts.tech</a>
        </p>
      </div>
    </div>
  );
}
