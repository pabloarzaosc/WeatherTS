import type { SoundingResult } from "./soundingApi";

const HISTORY_KEY = "weatherts-sounding-history";
const COMPARE_HISTORY_KEY = "weatherts-sounding-compare-history";
const FAVORITES_KEY = "weatherts-sounding-favorites";
const IMAGE_PREFIX = "sounding_img_";
const COMPARE_IMAGE_PREFIX = "sounding_compare_img_";
const MAX_HISTORY = 20;
const MAX_COMPARE_HISTORY = 15;
const DB_NAME = "WeatherTSSoundingHistory";
const DB_VERSION = 1;
const STORE_NAME = "images";

export interface SoundingHistoryEntry {
  id: string;
  timestamp: number;
  requestParams: Record<string, unknown>;
  meta: SoundingResult["meta"];
  params: SoundingResult["params"];
}

export interface LoadedSoundingHistoryEntry extends SoundingHistoryEntry {
  image?: string | null;
}

export interface CompareHistoryEntry {
  id: string;
  timestamp: number;
  slots: Record<string, unknown>[];
  summary: Array<{
    meta?: SoundingResult["meta"];
    params?: SoundingResult["params"];
    error?: string | null;
  }>;
}

export interface LoadedCompareHistoryEntry extends CompareHistoryEntry {
  images: Array<string | null>;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}

function makeId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function openDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function putImage(key: string, value: string) {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Ignore quota failures; metadata still stays useful.
    }
  }
}

async function getImage(key: string) {
  try {
    const db = await openDb();
    const value = await new Promise<string | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve((request.result as string | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return value || localStorage.getItem(key);
  } catch {
    return localStorage.getItem(key);
  }
}

async function deleteImage(key: string) {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Best effort cleanup only.
  }
  localStorage.removeItem(key);
}

export function getSoundingHistory() {
  return readJson<SoundingHistoryEntry[]>(HISTORY_KEY, []);
}

export async function saveSoundingHistory(requestParams: Record<string, unknown>, result: SoundingResult) {
  const id = makeId();
  const entry: SoundingHistoryEntry = {
    id,
    timestamp: Date.now(),
    requestParams,
    meta: result.meta,
    params: result.params,
  };
  if (result.image) await putImage(IMAGE_PREFIX + id, result.image);

  const entries = [entry, ...getSoundingHistory()];
  while (entries.length > MAX_HISTORY) {
    const removed = entries.pop();
    if (removed) void deleteImage(IMAGE_PREFIX + removed.id);
  }
  writeJson(HISTORY_KEY, entries);
  return entry;
}

export async function loadSoundingHistory(id: string): Promise<LoadedSoundingHistoryEntry | null> {
  const entry = getSoundingHistory().find((item) => item.id === id);
  if (!entry) return null;
  return { ...entry, image: await getImage(IMAGE_PREFIX + id) };
}

export function deleteSoundingHistory(id: string) {
  writeJson(
    HISTORY_KEY,
    getSoundingHistory().filter((item) => item.id !== id),
  );
  void deleteImage(IMAGE_PREFIX + id);
}

export function clearSoundingHistory() {
  for (const item of getSoundingHistory()) void deleteImage(IMAGE_PREFIX + item.id);
  localStorage.removeItem(HISTORY_KEY);
}

export function getCompareHistory() {
  return readJson<CompareHistoryEntry[]>(COMPARE_HISTORY_KEY, []);
}

export async function saveCompareHistory(slots: Record<string, unknown>[], results: SoundingResult[]) {
  const id = makeId();
  const entry: CompareHistoryEntry = {
    id,
    timestamp: Date.now(),
    slots,
    summary: results.map((result) => ({
      meta: result.meta,
      params: result.params,
      error: result.error ?? null,
    })),
  };
  await putImage(COMPARE_IMAGE_PREFIX + id, JSON.stringify(results.map((result) => result.image ?? null)));

  const entries = [entry, ...getCompareHistory()];
  while (entries.length > MAX_COMPARE_HISTORY) {
    const removed = entries.pop();
    if (removed) void deleteImage(COMPARE_IMAGE_PREFIX + removed.id);
  }
  writeJson(COMPARE_HISTORY_KEY, entries);
  return entry;
}

export async function loadCompareHistory(id: string): Promise<LoadedCompareHistoryEntry | null> {
  const entry = getCompareHistory().find((item) => item.id === id);
  if (!entry) return null;
  const raw = await getImage(COMPARE_IMAGE_PREFIX + id);
  let images: Array<string | null> = [];
  try {
    images = raw ? (JSON.parse(raw) as Array<string | null>) : [];
  } catch {
    images = [];
  }
  return { ...entry, images };
}

export function getSoundingFavorites() {
  return readJson<string[]>(FAVORITES_KEY, []);
}

export function toggleSoundingFavorite(stationId: string) {
  const id = stationId.toUpperCase();
  const existing = getSoundingFavorites();
  const next = existing.includes(id) ? existing.filter((item) => item !== id) : [id, ...existing];
  writeJson(FAVORITES_KEY, next);
  return next;
}
