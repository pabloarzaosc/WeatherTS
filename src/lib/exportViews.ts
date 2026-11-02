/**
 * The analysis views a pane can show instead of its map, as the Export page
 * captures them (src/lib/viewExport.ts). A map canvas keeps its drawing buffer
 * and can be read at any time; the 3D view's WebGL canvas does not, so the
 * view hands over a function that renders its current picture on demand.
 *
 * A leaf module: the views import it, it imports nothing of theirs.
 */

export interface ViewShot {
  /** The view's picture at its canvas size. */
  image: ImageData | HTMLCanvasElement;
  /** Caption lines for it (first line = what it is). */
  lines: string[];
  /** The time it shows (unix s), for the caption's time line. */
  unix: number | null;
}

/** Render the picture at w x h output pixels (the view's own size when left out). */
type Capture = (w?: number, h?: number) => ViewShot | null;

const views = new Map<string, Capture>();

/** A view says how to capture it; the returned function takes that back. */
export function registerExportView(kind: string, fn: Capture): () => void {
  views.set(kind, fn);
  return () => {
    if (views.get(kind) === fn) views.delete(kind);
  };
}

export function captureExportView(kind: string, w?: number, h?: number): ViewShot | null {
  try {
    return views.get(kind)?.(w, h) ?? null;
  } catch {
    return null;
  }
}
