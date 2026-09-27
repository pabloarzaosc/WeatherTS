// Radar meshes off the main thread (radarMeshPool.ts).
//
// Building one is a pass over every gate of the scan -- 100-130 ms for a Level
// III reflectivity sweep, 250-600 ms for a super-res one -- and on the main
// thread each froze the map for that long: every step of a loop's first lap,
// until the mesh cache had them all, which read as a play that stutters at the
// start and then smooths out.

import { buildMesh, type PolarScan } from "./radarMesh";

interface MeshJob {
  id: number;
  scan: PolarScan;
  pal: string;
  smooth: boolean;
  threshold: number | null;
}

self.onmessage = (e: MessageEvent<MeshJob>) => {
  const { id, scan, pal, smooth, threshold } = e.data;
  try {
    const mesh = buildMesh(scan, pal, { smooth, threshold });
    const buffers = new Set<ArrayBuffer>([
      mesh.positions.buffer as ArrayBuffer,
      mesh.colors.buffer as ArrayBuffer,
      mesh.values.buffer as ArrayBuffer,
      mesh.lut.buffer as ArrayBuffer,
    ]);
    (self as unknown as Worker).postMessage({ id, mesh }, [...buffers]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
