// GIF encoding off the main thread, for the animation export (gifExport.ts).
//
// Quantising a frame to 256 colours and compressing it is about half a second
// of plain JavaScript at export sizes -- more than capturing the frame takes.
// Several of these workers run at once, each encoding whole frames on its own
// (gifenc's manual mode: frame 0 also writes the file's header and first
// palette, the others carry their own palette), and the page joins the pieces
// in order and ends the file.

import { GIFEncoder, applyPalette, quantize } from "gifenc";

interface FrameJob {
  seq: number;
  first: boolean;
  data: Uint8ClampedArray;
  width: number;
  height: number;
  delay: number;
}

self.onmessage = (e: MessageEvent<FrameJob>) => {
  const m = e.data;
  const palette = quantize(m.data, 256, { format: "rgb565" });
  const index = applyPalette(m.data, palette, "rgb565");
  const gif = GIFEncoder({ auto: false });
  if (m.first) gif.writeHeader();
  gif.writeFrame(index, m.width, m.height, { palette, delay: m.delay, repeat: 0, first: m.first });
  const bytes = gif.bytes();
  (self as unknown as Worker).postMessage({ seq: m.seq, bytes }, [bytes.buffer]);
};
