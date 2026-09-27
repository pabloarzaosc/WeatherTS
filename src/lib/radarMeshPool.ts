import MeshWorker from "./radarMeshWorker?worker&inline";

import { buildMesh, type PolarScan, type RadarMesh } from "./radarMesh";

/**
 * Radar meshes built on worker threads, so the map never waits on one: a few
 * workers, each job to the least busy. The scan is copied to the worker (a
 * couple of MB, a millisecond or two) -- the page keeps its own for sampling --
 * and the mesh's arrays come back transferred, not copied.
 *
 * Where workers cannot start, the mesh is built here as it always was.
 */
const SIZE = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 2));

interface Job {
  scan: PolarScan;
  pal: string;
  smooth: boolean;
  threshold: number | null;
  resolve: (m: RadarMesh) => void;
  reject: (e: Error) => void;
  slot: Slot;
}
interface Slot {
  worker: Worker;
  busy: number;
}

let slots: Slot[] | null = null;
let broken = false;
let seq = 0;
const jobs = new Map<number, Job>();

function onBreak(): void {
  // A worker that fails to load fails every job: build the rest here.
  broken = true;
  for (const [id, job] of jobs) {
    jobs.delete(id);
    try {
      job.resolve(buildMesh(job.scan, job.pal, { smooth: job.smooth, threshold: job.threshold }));
    } catch (err) {
      job.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
  for (const s of slots ?? []) s.worker.terminate();
  slots = null;
}

function pool(): Slot[] | null {
  if (slots || broken) return slots;
  try {
    slots = Array.from({ length: SIZE }, () => {
      const worker = new MeshWorker();
      worker.onmessage = (e: MessageEvent<{ id: number; mesh?: RadarMesh; error?: string }>) => {
        const job = jobs.get(e.data.id);
        if (!job) return;
        jobs.delete(e.data.id);
        job.slot.busy--;
        if (e.data.mesh) job.resolve(e.data.mesh);
        else job.reject(new Error(e.data.error ?? "mesh build failed"));
      };
      worker.onerror = () => onBreak();
      return { worker, busy: 0 };
    });
  } catch {
    broken = true;
    slots = null;
  }
  return slots;
}

/** buildMesh, on a worker. */
export function buildMeshOffThread(
  scan: PolarScan,
  pal: string,
  opts: { smooth?: boolean; threshold?: number | null } = {},
): Promise<RadarMesh> {
  const ws = pool();
  if (!ws) return Promise.resolve(buildMesh(scan, pal, opts));
  const slot = ws.reduce((a, b) => (b.busy < a.busy ? b : a));
  const id = ++seq;
  const smooth = !!opts.smooth;
  const threshold = opts.threshold ?? null;
  slot.busy++;
  return new Promise<RadarMesh>((resolve, reject) => {
    jobs.set(id, { scan, pal, smooth, threshold, resolve, reject, slot });
    slot.worker.postMessage({ id, scan: { az: scan.az, lut: scan.lut, codes: scan.codes, meta: scan.meta }, pal, smooth, threshold });
  });
}
