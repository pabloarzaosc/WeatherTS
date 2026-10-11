/**
 * API base URL configuration.
 * 
 * In Vite dev mode, requests go through Vite's proxy (e.g. /sounding-backend -> localhost:8787).
 * In production / Electron, we call the backend directly on the app-owned
 * localhost port supplied by the Electron main process.
 */

const isElectron = typeof window !== 'undefined' && 
  (window as any).electronAPI?.isElectron === true;

// Also detect production builds served from file:// protocol
const isFileProtocol = typeof window !== 'undefined' && 
  window.location.protocol === 'file:';

const isProduction = isElectron || isFileProtocol || import.meta.env.PROD;

let backendPort = '47837';
if (typeof window !== 'undefined') {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has('backendPort')) {
    backendPort = urlParams.get('backendPort') || '47837';
  }
}

/**
 * The web build (weatherts.tech/app, `vite build --mode web`) has no backend
 * of its own on the user's machine: it talks to the hosted one, named in
 * .env.web. The desktop never reads it -- Electron loads from file://.
 */
const HOSTED_BACKEND = import.meta.env.VITE_BACKEND_BASE as string | undefined;
export const IS_WEB = !isElectron && !isFileProtocol && !!HOSTED_BACKEND;

/** Local FastAPI backend base URL (the hosted one on the web) */
export const BACKEND_BASE = IS_WEB
  ? HOSTED_BACKEND!
  : isProduction
    ? `http://127.0.0.1:${backendPort}`
    : '/sounding-backend';

/** Remote sounding analysis API base URL */
export const SOUNDING_API_BASE = 'https://soundinganalysis-752306366750.asia-southeast1.run.app';
