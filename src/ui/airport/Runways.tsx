import { bestEnd, windComponents, type Runway, type RunwayEnd } from "../../lib/aviation";

/**
 * The runways and the wind across them, in pieces the airport page lays out
 * where there is room:
 *   RunwayDiagram     the field drawn to scale where the thresholds are placed
 *                     (OurAirports has them for most of the world), a schematic
 *                     where only the headings are known, and the wind arrow
 *   RunwayComponents  every runway end's head- or tailwind and crosswind
 *   RunwayList        each runway's length, width, surface, lighting, ends
 *   RunwayInUse       one line: the best end and what the wind does on it
 */

type Wind = { wdir: number | null; wspd: number | null; wgst: number | null };

function usable(runways: Runway[]): Runway[] {
  const open = runways.filter((r) => !r.closed);
  return open.length ? open : runways;
}

function best(runways: Runway[], { wdir, wspd }: Wind): RunwayEnd | null {
  return wdir != null && wspd != null && wspd > 0 ? bestEnd(usable(runways), wdir, wspd) : null;
}

const windWords = ({ wdir, wspd, wgst }: Wind) =>
  wspd == null ? "" : wspd === 0 ? "Calm" : `Wind ${wdir == null ? "VRB" : `${String(Math.round(wdir)).padStart(3, "0")}°`} ${Math.round(wspd)} kt${wgst ? ` G${Math.round(wgst)}` : ""}`;

export function RunwayDiagram({ runways, size = 236, ...wind }: Wind & { runways: Runway[]; size?: number }) {
  if (!runways.length) return <div className="apt__none">No runway data for this airport.</div>;
  const b = best(runways, wind);
  const placed = runways.every((r) => r.ends.length === 2 && r.ends.every((e) => e.lat != null && e.lon != null));
  return (
    <div className="apt__rwy">
      {placed ? <ToScale runways={runways} best={b} size={size} {...wind} /> : <Schematic runways={runways} best={b} size={size} {...wind} />}
      {wind.wspd != null && (
        <div className="apt__windtxt">
          {windWords(wind)}
          {b && (wind.wspd ?? 0) > 0 ? ` · best runway ${b.name}` : ""}
        </div>
      )}
    </div>
  );
}

/** The best end and its components, for the side column. */
export function RunwayInUse({ runways, ...wind }: Wind & { runways: Runway[] }) {
  const b = best(runways, wind);
  if (!b || wind.wdir == null || wind.wspd == null) return null;
  const c = windComponents(wind.wdir, wind.wspd, b.true);
  const g = wind.wgst != null ? windComponents(wind.wdir, wind.wgst, b.true) : null;
  const cross = Math.abs(c.cross);
  const side = cross >= 0.5 ? (c.cross > 0 ? "R" : "L") : "";
  return (
    <div className="apt__inuse">
      <b>{b.name}</b>
      <span>
        {String(b.mag).padStart(3, "0")}°M · headwind {Math.round(Math.max(c.head, 0))} kt · crosswind{" "}
        <em className={cross >= 20 ? "is-bad" : cross >= 15 ? "is-warn" : undefined}>
          {Math.round(cross)}
          {side} kt
        </em>
        {g && Math.round(Math.abs(g.cross)) > Math.round(cross) ? ` (G${Math.round(Math.abs(g.cross))})` : ""}
      </span>
    </div>
  );
}

export function RunwayComponents({ runways, ...wind }: Wind & { runways: Runway[] }) {
  const { wdir, wspd, wgst } = wind;
  const b = best(runways, wind);
  const rows = runways
    .filter((r) => !r.closed)
    .flatMap((r) => r.ends.map((e) => ({ r, e })))
    .map(({ r, e }) => {
      const c = wdir != null && wspd != null ? windComponents(wdir, wspd, e.true) : null;
      const g = wdir != null && wgst != null ? windComponents(wdir, wgst, e.true) : null;
      return { r, e, c, g };
    })
    .sort((a, b2) => (b2.c?.head ?? 0) - (a.c?.head ?? 0));
  if (!rows.length) return null;
  return (
    <div className="apt__comp">
      <div className="apt__comphead">
        <span>Runway</span>
        <span>Head</span>
        <span>Cross</span>
      </div>
      {rows.map(({ r, e, c, g }) => {
        const head = c?.head ?? null;
        const cross = c ? Math.abs(c.cross) : null;
        const side = c && Math.abs(c.cross) >= 0.5 ? (c.cross > 0 ? "R" : "L") : "";
        const gx = g ? Math.abs(g.cross) : null;
        return (
          <div key={`${r.id}-${e.name}`} className={`apt__comprow${b?.name === e.name ? " is-best" : ""}`}>
            <span>
              <b>{e.name}</b>
              <em>{String(e.mag).padStart(3, "0")}°M</em>
            </span>
            <span className={head != null && head < -0.5 ? "is-tail" : undefined}>
              {head == null ? "—" : head < -0.5 ? `T${Math.round(-head)}` : Math.round(Math.max(head, 0))}
            </span>
            <span className={cross != null && cross >= 20 ? "is-bad" : cross != null && cross >= 15 ? "is-warn" : undefined}>
              {cross == null ? "—" : `${Math.round(cross)}${side}`}
              {gx != null && Math.round(gx) > Math.round(cross ?? 0) ? <em> G{Math.round(gx)}</em> : null}
            </span>
          </div>
        );
      })}
      <div className="apt__compnote">kt · T tailwind · L/R the side the crosswind comes from · G with the gust</div>
    </div>
  );
}

export function RunwayList({ runways }: { runways: Runway[] }) {
  return (
    <div className="apt__rwylist">
      {runways.map((r) => (
        <div key={r.id} className={`apt__rwyitem${r.closed ? " is-closed" : ""}`}>
          <b>{r.id}</b>
          <span>
            {[
              r.length ? `${Math.round(r.length).toLocaleString("en-US")}${r.width ? ` × ${Math.round(r.width)}` : ""} ft` : null,
              r.length ? `${Math.round(r.length * 0.3048).toLocaleString("en-US")} m` : null,
              r.surface,
              r.lighted ? "lighted" : r.lighted === false ? "unlit" : null,
              r.closed ? "CLOSED" : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <em>
            {r.ends
              .map((e) =>
                [
                  `${e.name} ${String(Math.round(e.true)).padStart(3, "0")}°T`,
                  e.elevFt != null ? `elev ${Math.round(e.elevFt).toLocaleString("en-US")} ft` : null,
                  e.displacedFt ? `displaced ${Math.round(e.displacedFt).toLocaleString("en-US")} ft` : null,
                ]
                  .filter(Boolean)
                  .join(", "),
              )
              .join(" · ")}
          </em>
        </div>
      ))}
    </div>
  );
}

function Rose({ size, wdir, wspd }: { size: number; wdir: number | null; wspd: number | null }) {
  const C = size / 2;
  const R = size / 2 - 22;
  return (
    <>
      <circle cx={C} cy={C} r={R + 10} className="apt__rose" />
      {Array.from({ length: 36 }, (_, i) => {
        const a = (i * 10 * Math.PI) / 180;
        const long = i % 9 === 0;
        const r0 = R + 10 - (long ? 6 : 3);
        return (
          <line key={i} x1={C + Math.sin(a) * r0} y1={C - Math.cos(a) * r0} x2={C + Math.sin(a) * (R + 10)} y2={C - Math.cos(a) * (R + 10)}
            className="apt__tick" />
        );
      })}
      {["N", "E", "S", "W"].map((l, i) => {
        const a = (i * 90 * Math.PI) / 180;
        return (
          <text key={l} x={C + Math.sin(a) * (R + 18)} y={C - Math.cos(a) * (R + 18) + 3.5} className="apt__rosel">
            {l}
          </text>
        );
      })}
      {wdir != null && wspd != null && wspd > 0 && (
        <g transform={`translate(${C},${C}) rotate(${wdir})`} className="apt__windarrow">
          <line x1={0} y1={-R - 9} x2={0} y2={-R * 0.8} />
          <path d={`M0,${-R * 0.8 + 3} L-5,${-R * 0.8 - 7} L5,${-R * 0.8 - 7} Z`} />
        </g>
      )}
    </>
  );
}

/** Runway numbers that would print on one another are moved further out along their runway. */
function spread(labels: { x: number; y: number; ux: number; uy: number }[]) {
  for (let i = 0; i < labels.length; i++) {
    for (let j = 0; j < i; j++) {
      let tries = 0;
      while (Math.abs(labels[i].x - labels[j].x) < 18 && Math.abs(labels[i].y - labels[j].y) < 11 && tries++ < 4) {
        labels[i].x += labels[i].ux * 8;
        labels[i].y += labels[i].uy * 8;
      }
    }
  }
}

/** The thresholds where they are: x east and y north in metres around the field's middle. */
function ToScale({ runways, best: b, size, wdir, wspd }: Wind & { runways: Runway[]; best: RunwayEnd | null; size: number }) {
  const C = size / 2;
  const R = size / 2 - 22;
  const ends = runways.flatMap((r) => r.ends);
  const lat0 = ends.reduce((a, e) => a + (e.lat as number), 0) / ends.length;
  const lon0 = ends.reduce((a, e) => a + (e.lon as number), 0) / ends.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110540;
  const xy = (e: RunwayEnd) => [((e.lon as number) - lon0) * kx, ((e.lat as number) - lat0) * ky] as const;
  const far = Math.max(...ends.map((e) => Math.hypot(...xy(e))), 300);
  // The whole field inside the rose, with room for the numbers.
  const k = (R - 16) / far;
  const px = (e: RunwayEnd) => {
    const [x, y] = xy(e);
    return [C + x * k, C - y * k] as const;
  };
  const barM = [250, 500, 1000, 2000, 3000, 5000].find((m) => m * k >= 34) ?? 5000;
  const strips = runways.map((r) => {
    const [x1, y1] = px(r.ends[0]);
    const [x2, y2] = px(r.ends[1]);
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    return { r, x1, y1, x2, y2, ux: (x2 - x1) / len, uy: (y2 - y1) / len };
  });
  // The number stands off the threshold, beyond the runway's end.
  const labels = strips.flatMap((s) =>
    s.r.ends.map((e, i) => {
      const out = i === 0 ? -1 : 1;
      const [ex, ey] = i === 0 ? [s.x1, s.y1] : [s.x2, s.y2];
      return { name: e.name, x: ex + s.ux * 10 * out, y: ey + s.uy * 10 * out, ux: s.ux * out, uy: s.uy * out };
    }),
  );
  spread(labels);
  return (
    <svg width={size} height={size} className="apt__rwysvg" role="img" aria-label="Runways to scale, and the wind">
      <Rose size={size} wdir={wdir} wspd={wspd} />
      {strips.map(({ r, x1, y1, x2, y2, ux, uy }) => {
        const w = Math.min(Math.max(((r.width ?? 100) * 0.3048) * k, 3), size > 260 ? 12 : 9);
        const isBest = !!b && r.ends.some((e) => e.name === b.name);
        const soft = r.surface ? /grass|turf|dirt|gravel|sand|clay|laterite|snow|ice|water/i.test(r.surface) : false;
        return (
          <g key={r.id}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={w}
              className={`apt__strip2${isBest ? " is-best" : ""}${soft ? " is-soft" : ""}${r.closed ? " is-closed" : ""}`} />
            {r.ends.map((e, i) => {
              if (!e.displacedFt) return null;
              const [ex, ey] = i === 0 ? [x1, y1] : [x2, y2];
              const d = e.displacedFt * 0.3048 * k * (i === 0 ? 1 : -1);
              const tx = ex + ux * d;
              const ty = ey + uy * d;
              return <line key={e.name} x1={tx - uy * (w / 2 + 2)} y1={ty + ux * (w / 2 + 2)} x2={tx + uy * (w / 2 + 2)} y2={ty - ux * (w / 2 + 2)} className="apt__disp" />;
            })}
          </g>
        );
      })}
      {labels.map((l) => (
        <text key={l.name} x={l.x} y={l.y + 3.5} className={b?.name === l.name ? "apt__rnum is-best" : "apt__rnum"}>
          {l.name}
        </text>
      ))}
      <g className="apt__scalebar" transform={`translate(${size - 12 - barM * k},${size - 8})`}>
        <line x1={0} x2={barM * k} y1={0} y2={0} />
        <line x1={0} x2={0} y1={-3} y2={0} />
        <line x1={barM * k} x2={barM * k} y1={-3} y2={0} />
        <text x={(barM * k) / 2} y={-4}>{barM >= 1000 ? `${barM / 1000} km` : `${barM} m`}</text>
      </g>
    </svg>
  );
}

/** Headings only: every runway through the middle, parallels side by side. */
function Schematic({ runways, best: b, size, wdir, wspd }: Wind & { runways: Runway[]; best: RunwayEnd | null; size: number }) {
  const C = size / 2;
  const R = size / 2 - 22;
  const byAngle = [...runways].filter((r) => r.ends[0]).sort((a, c) => (a.ends[0].true % 180) - (c.ends[0].true % 180));
  const groups = new Map<number, Runway[]>();
  let key = -1;
  let prev = -999;
  for (const r of byAngle) {
    const h = r.ends[0].true % 180;
    if (h - prev > 15) key = h;
    groups.set(key, [...(groups.get(key) ?? []), r]);
    prev = h;
  }
  const longest = Math.max(...runways.map((r) => r.length ?? 0), 1);
  return (
    <svg width={size} height={size} className="apt__rwysvg" role="img" aria-label="Runways and wind">
      <Rose size={size} wdir={wdir} wspd={wspd} />
      {[...groups.entries()].map(([, list]) =>
        list.map((r, k) => {
          const e = r.ends[0];
          const a = (e.true * Math.PI) / 180;
          const off = (k - (list.length - 1) / 2) * 20;
          const len = (R - 6) * (0.55 + 0.45 * ((r.length ?? longest * 0.6) / longest));
          const dx = Math.sin(a);
          const dy = -Math.cos(a);
          const ox = -dy * off;
          const oy = dx * off;
          const isBest = !!b && r.ends.some((x) => x.name === b.name);
          const near = (end: RunwayEnd) => {
            // The number is painted at the end you land toward it from.
            const toward = end === r.ends[0] ? -1 : 1;
            return { x: C + ox + dx * (len + 9) * toward, y: C + oy + dy * (len + 9) * toward + 3.5 };
          };
          return (
            <g key={r.id}>
              <line x1={C + ox - dx * len} y1={C + oy - dy * len} x2={C + ox + dx * len} y2={C + oy + dy * len}
                className={isBest ? "apt__strip is-best" : "apt__strip"} />
              {r.ends.map((end) => (
                <text key={end.name} {...near(end)} className={b?.name === end.name ? "apt__rnum is-best" : "apt__rnum"}>
                  {end.name}
                </text>
              ))}
            </g>
          );
        }),
      )}
    </svg>
  );
}
