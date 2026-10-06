import { useMemo, useState } from "react";
import { Film, Image as ImageIcon } from "lucide-react";

import { loadEpam, loadFlares, loadFrames, loadRegions, loadSdoFrames, loadSdoLatest, loadXrays, type Region } from "../../lib/space/data";
import { SWPC } from "../../lib/space/swpc";
import { ImageLoop, ZoomImage } from "./ImageLoop";
import { FlareOddsCard } from "./OverviewTab";
import { useNowDomain } from "./OverviewTab";
import { TimeStack, fmtUtc, type ChartPanel, type XBand } from "./TimeStack";
import { epamPanel, xrayPanel } from "./panels";
import { Card, useSwpc } from "./common";

interface SunSource {
  id: string;
  group: string;
  label: string;
  about: string;
  /** SDO's id for its latest image and movie (0193, HMIB...). */
  sdo?: string;
  /** A SWPC frame list. */
  frames?: string;
  /** A single latest picture. */
  still?: string;
  href?: string;
}

const SDO_PAGE = "https://sdo.gsfc.nasa.gov/data/";
const sdo = (id: string, label: string, about: string): SunSource => ({ id: `sdo-${id}`, group: "SDO, NASA", label, about, sdo: id, href: SDO_PAGE });
const suvi = (ch: string, label: string, about: string): SunSource => ({
  id: `suvi-${ch}`,
  group: "GOES SUVI, NOAA",
  label,
  about,
  frames: `/products/animations/suvi-primary-${ch}.json`,
  href: "https://www.swpc.noaa.gov/products/goes-solar-ultraviolet-imager-suvi",
});

export const SUN_SOURCES: SunSource[] = [
  sdo("0193", "AIA 193 Å", "The corona at 1.2 million K and hot flare plasma; coronal holes show dark."),
  sdo("0171", "AIA 171 Å", "The quiet corona and the loops arching over active regions."),
  sdo("0211", "AIA 211 Å", "Hotter active-region corona, about 2 million K."),
  sdo("0304", "AIA 304 Å", "The chromosphere and transition region: filaments and prominences."),
  sdo("0131", "AIA 131 Å", "Flaring regions, 10 million K and more."),
  sdo("0094", "AIA 094 Å", "Flaring regions, about 6 million K."),
  sdo("0335", "AIA 335 Å", "Active-region corona, about 2.5 million K."),
  sdo("1600", "AIA 1600 Å", "The upper photosphere and transition region."),
  sdo("1700", "AIA 1700 Å", "The temperature minimum, just above the photosphere."),
  sdo("4500", "AIA 4500 Å", "White light: the photosphere and its sunspots, hourly."),
  sdo("211193171", "AIA 211/193/171", "Three coronal channels in one colour picture."),
  sdo("304211171", "AIA 304/211/171", "Chromosphere and corona together."),
  sdo("094335193", "AIA 094/335/193", "The hot corona in three channels."),
  sdo("HMIB", "HMI magnetogram", "Line-of-sight magnetic field: white north, black south."),
  sdo("HMIBC", "HMI colour magnetogram", "The magnetogram coloured by field strength."),
  sdo("HMIIC", "HMI intensitygram", "Visible light: the sunspots themselves."),
  sdo("HMID", "HMI dopplergram", "Line-of-sight motion of the surface."),
  suvi("195", "SUVI 195 Å", "GOES-19's corona at 195 Å, every few minutes."),
  suvi("171", "SUVI 171 Å", "GOES-19's quiet corona and loops."),
  suvi("304", "SUVI 304 Å", "GOES-19's chromosphere and prominences."),
  suvi("284", "SUVI 284 Å", "GOES-19's active-region corona."),
  suvi("131", "SUVI 131 Å", "GOES-19's flare channel."),
  suvi("094", "SUVI 094 Å", "GOES-19's hot flare plasma."),
  {
    id: "suvi-map",
    group: "GOES SUVI, NOAA",
    label: "SUVI thematic map",
    about: "SWPC's map of the disk sorted into coronal holes, active regions, filaments and flares.",
    frames: "/products/animations/suvi-primary-map.json",
    href: "https://www.swpc.noaa.gov/products/goes-solar-ultraviolet-imager-suvi",
  },
  {
    id: "lasco-c2",
    group: "Coronagraphs",
    label: "LASCO C2",
    about: "SOHO's inner coronagraph, 1.5 to 6 solar radii: where CMEs first leave the Sun.",
    frames: "/products/animations/lasco-c2.json",
    href: "https://soho.nascom.nasa.gov/data/realtime-images.html",
  },
  {
    id: "lasco-c3",
    group: "Coronagraphs",
    label: "LASCO C3",
    about: "SOHO's outer coronagraph, out to 30 solar radii: a halo CME is heading at Earth.",
    frames: "/products/animations/lasco-c3.json",
    href: "https://soho.nascom.nasa.gov/data/realtime-images.html",
  },
  {
    id: "ccor1",
    group: "Coronagraphs",
    label: "CCOR-1",
    about: "GOES-19's coronagraph, NOAA's own for CME watch.",
    frames: "/products/animations/ccor1/ccor1.json",
    href: "https://www.swpc.noaa.gov/products/ccor-1-coronagraph",
  },
  {
    id: "ccor1-diff",
    group: "Coronagraphs",
    label: "CCOR-1 difference",
    about: "Each CCOR-1 frame minus the one before: what moved stands out.",
    frames: "/products/animations/ccor1-diff/ccor1-diff.json",
    href: "https://www.swpc.noaa.gov/products/ccor-1-coronagraph",
  },
  {
    id: "eit195",
    group: "Coronagraphs",
    label: "SOHO EIT 195",
    about: "SOHO's own extreme ultraviolet imager.",
    still: "https://soho.nascom.nasa.gov/data/realtime/eit_195/1024/latest.jpg",
    href: "https://soho.nascom.nasa.gov/data/realtime-images.html",
  },
];

const MAG_NAMES: Record<string, string> = {
  A: "Alpha",
  B: "Beta",
  G: "Gamma",
  BG: "Beta-Gamma",
  BD: "Beta-Delta",
  BGD: "Beta-Gamma-Delta",
  GD: "Gamma-Delta",
};
function magColor(m: string): string {
  if (m.includes("D")) return "#ff5a4f";
  if (m.includes("G")) return "#ff9a3c";
  if (m === "B") return "#f6d743";
  return "#4ade80";
}

/** The tilt of the Sun's equator toward us, degrees: it runs ±7.25° over the year. */
function b0(t: number): number {
  const d = t / 86_400_000 + 2440587.5 - 2451545;
  const rad = Math.PI / 180;
  const g = (357.528 + 0.9856003 * d) * rad;
  const lam = (280.46 + 0.9856474 * d + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const om = (75.76 + (1.397 * d) / 36525) * rad;
  return Math.asin(Math.sin(lam - om) * Math.sin(7.25 * rad)) / rad;
}

/** Where on the disk each region sits, seen from Earth with north up and east to the left. */
function RegionDisk({ regions, hot, setHot }: { regions: Region[]; hot: number | null; setHot: (r: number | null) => void }) {
  const B = (b0(Date.now()) * Math.PI) / 180;
  const R = 100;
  const proj = (lat: number, lonEast: number) => {
    const f = (lat * Math.PI) / 180;
    const l = (-lonEast * Math.PI) / 180;
    const x = Math.cos(f) * Math.sin(l);
    const y = Math.sin(f) * Math.cos(B) - Math.cos(f) * Math.cos(l) * Math.sin(B);
    const z = Math.cos(f) * Math.cos(l) * Math.cos(B) + Math.sin(f) * Math.sin(B);
    return { x: x * R, y: -y * R, z };
  };
  const grid: string[] = [];
  for (let lat = -60; lat <= 60; lat += 30) {
    let d = "";
    for (let lon = -90; lon <= 90; lon += 5) {
      const p = proj(lat, lon);
      d += `${d ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    }
    grid.push(d);
  }
  for (let lon = -60; lon <= 60; lon += 30) {
    let d = "";
    for (let lat = -90; lat <= 90; lat += 5) {
      const p = proj(lat, lon);
      d += `${d ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    }
    grid.push(d);
  }
  return (
    <svg className="spc-disk" viewBox="-118 -118 236 236" role="img" aria-label="Active regions on the solar disk">
      <circle r={R} className="spc-disk__sun" />
      {grid.map((d, i) => (
        <path key={i} d={d} className="spc-disk__grid" />
      ))}
      <text x={0} y={-R - 6} className="spc-disk__lbl">N</text>
      <text x={-R - 8} y={3} className="spc-disk__lbl">E</text>
      <text x={R + 8} y={3} className="spc-disk__lbl">W</text>
      {regions.map((r) => {
        const p = proj(r.lat, r.lon);
        if (p.z < 0 || !r.area) return null;
        const rad = Math.max(3.5, Math.sqrt(r.area) * 0.55);
        return (
          <g
            key={r.region}
            transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`}
            className={hot === r.region ? "is-hot" : ""}
            onMouseEnter={() => setHot(r.region)}
            onMouseLeave={() => setHot(null)}
          >
            <circle r={rad} fill={magColor(r.magClass)} fillOpacity={0.85} />
            <text y={-rad - 3}>{String(r.region).slice(-4)}</text>
          </g>
        );
      })}
    </svg>
  );
}

function RegionsCard() {
  const { data, error } = useSwpc("regions", loadRegions, 600);
  const [hot, setHot] = useState<number | null>(null);
  const [sort, setSort] = useState<"region" | "area" | "m">("region");
  const rows = useMemo(() => {
    const r = [...(data ?? [])];
    if (sort === "area") r.sort((a, b) => b.area - a.area);
    if (sort === "m") r.sort((a, b) => (b.m ?? -1) - (a.m ?? -1));
    return r;
  }, [data, sort]);
  return (
    <Card title="Active regions" extra={data?.[0] && <span className="spc-card__meta">SWPC, {data[0].date}</span>} className="spc-card--regions">
      {error && <div className="spc-msg">{error}</div>}
      <div className="spc-regions">
        <RegionDisk regions={data ?? []} hot={hot} setHot={setHot} />
        <div className="spc-regions__table">
          <table className="spc-table">
            <thead>
              <tr>
                <th className="is-sort" onClick={() => setSort("region")}>Region</th>
                <th>Location</th>
                <th title="Carrington longitude">Lo</th>
                <th className="is-sort" onClick={() => setSort("area")} title="Area in millionths of the hemisphere">Area</th>
                <th title="Number of spots">Spots</th>
                <th title="McIntosh class">Class</th>
                <th title="Magnetic class (Mount Wilson)">Mag</th>
                <th>C%</th>
                <th className="is-sort" onClick={() => setSort("m")}>M%</th>
                <th>X%</th>
                <th title="Proton event">P%</th>
                <th title="Flares in the last day: C, M, X">Flares</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.region}
                  className={`${hot === r.region ? "is-hot" : ""}${!r.area ? " is-gone" : ""}`}
                  onMouseEnter={() => setHot(r.region)}
                  onMouseLeave={() => setHot(null)}
                >
                  <td><b>{r.region}</b></td>
                  <td className="mono">{r.location}</td>
                  <td>{r.carrington ?? "--"}</td>
                  <td>{r.area || "--"}</td>
                  <td>{r.spots || "--"}</td>
                  <td>{r.spotClass || "--"}</td>
                  <td>
                    {r.magClass ? (
                      <span className="spc-mag" style={{ background: magColor(r.magClass) }} title={MAG_NAMES[r.magClass] ?? r.magClass}>
                        {MAG_NAMES[r.magClass] ?? r.magClass}
                      </span>
                    ) : (
                      "--"
                    )}
                  </td>
                  <td>{r.c ?? "--"}</td>
                  <td className={r.m != null && r.m >= 20 ? "is-warm" : ""}>{r.m ?? "--"}</td>
                  <td className={r.x != null && r.x >= 5 ? "is-hotv" : ""}>{r.x ?? "--"}</td>
                  <td>{r.proton ?? "--"}</td>
                  <td>{r.events.some((e) => e) ? r.events.join("/") : "--"}</td>
                </tr>
              ))}
              {data && !data.length && (
                <tr>
                  <td colSpan={12}>No numbered regions today.</td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="spc-note">Regions past the west limb stay listed for a day with no area. Delta classes (red) make the big flares.</p>
        </div>
      </div>
    </Card>
  );
}

function SunViewer({ src, syncT }: { src: SunSource; syncT: number | null }) {
  const [loop, setLoop] = useState(false);
  const frames = useSwpc(src.frames ? `frames-${src.frames}` : "none", () => (src.frames ? loadFrames(src.frames) : Promise.resolve(null)), 300);
  const latest = useSwpc(src.sdo ? "sdo-2048" : "none", () => (src.sdo ? loadSdoLatest(2048) : Promise.resolve(null)), 300);
  const sdoLoop = useSwpc(src.sdo && loop ? `sdo-loop-${src.sdo}` : "none", () => (src.sdo && loop ? loadSdoFrames(src.sdo, 1024, 24) : Promise.resolve(null)), 300);
  const bust = Math.floor(Date.now() / 600_000);
  if (src.sdo) {
    const f = latest.data?.[src.sdo];
    return (
      <div className="spc-viewer">
        <div className="spc-viewer__tools">
          <span>{src.about}</span>
          <button type="button" className={!loop ? "is-on" : ""} onClick={() => setLoop(false)}>
            <ImageIcon size={12} /> Latest
          </button>
          <button type="button" className={loop ? "is-on" : ""} onClick={() => setLoop(true)} disabled={latest.data != null && !f}>
            <Film size={12} /> Last 24 h
          </button>
        </div>
        {latest.data && !f ? (
          <div className="spc-loop spc-loop--msg">No {src.label} picture from SDO today or yesterday: this channel is not being published right now.</div>
        ) : loop ? (
          <ImageLoop frames={sdoLoop.data} error={sdoLoop.error} title={`SDO ${src.label}`} href={src.href} count={48} syncT={syncT} />
        ) : f ? (
          <div className="spc-loop">
            <ZoomImage src={f.url} alt={src.label}>
              <div className="spc-loop__stamp">
                <b>SDO {src.label}</b>
                <span>{f.t != null ? fmtUtc(f.t) : "Latest"} · wheel to zoom</span>
              </div>
            </ZoomImage>
          </div>
        ) : (
          <div className="spc-loop spc-loop--msg">{latest.error ? `Could not reach SDO: ${latest.error}` : "Reading SDO…"}</div>
        )}
      </div>
    );
  }
  if (src.still) {
    return (
      <div className="spc-viewer">
        <div className="spc-viewer__tools">
          <span>{src.about}</span>
        </div>
        <div className="spc-loop">
          <ZoomImage src={`${src.still}?${bust}`} alt={src.label}>
            <div className="spc-loop__stamp">
              <b>{src.label}</b>
              <span>Latest</span>
            </div>
          </ZoomImage>
        </div>
      </div>
    );
  }
  return (
    <div className="spc-viewer">
      <div className="spc-viewer__tools">
        <span>{src.about}</span>
      </div>
      <ImageLoop frames={frames.data} error={frames.error} title={src.label} href={src.href} count={src.id.startsWith("suvi") ? 48 : 96} syncT={syncT} />
    </div>
  );
}

export function SunTab() {
  const [id, setId] = useState("sdo-0193");
  const thumbs = useSwpc("sdo-512", () => loadSdoLatest(512), 300);
  const src = SUN_SOURCES.find((s) => s.id === id) ?? SUN_SOURCES[0];
  const groups = [...new Set(SUN_SOURCES.map((s) => s.group))];
  // The flux under the pointer steps whichever loop is up to the same minute:
  // the flare on the chart and the flare on the disk, side by side.
  const [hoverT, setHoverT] = useState<number | null>(null);
  const xr = useSwpc("xr-1d", () => loadXrays("1d"));
  const ep = useSwpc("epam", loadEpam);
  const fl = useSwpc("flares", loadFlares);
  const domain = useNowDomain(86_400_000, xr.at);
  const panels = useMemo<ChartPanel[]>(
    () => [xrayPanel(xr.data?.short ?? null, xr.data?.long ?? null), { ...epamPanel(ep.data ?? null), weight: 0.8 }],
    [xr.data, ep.data],
  );
  const xBands = useMemo<XBand[]>(
    () =>
      (fl.data ?? [])
        .filter((x) => /^[MX]/.test(x.cls))
        .map((x) => ({ from: x.begin, to: x.end ?? x.max + 600_000, color: x.cls.startsWith("X") ? "rgba(255,0,0,0.16)" : "rgba(255,150,0,0.14)", label: x.cls })),
    [fl.data],
  );
  return (
    <div className="spc-grid spc-grid--sun">
      <div className="spc-col spc-col--main">
        <Card className="spc-card--viewer" title={src.label} extra={<span className="spc-card__meta">{src.group}</span>}>
          <SunViewer key={src.id} src={src} syncT={hoverT} />
        </Card>
        <Card className="spc-card--fill spc-card--sunchart" title="Flares and particles, last 24 hours" extra={<span className="spc-card__meta">Hover to step a loop (SUVI, LASCO, CCOR, or SDO's last 24 h) to the same minute</span>}>
          <TimeStack panels={panels} domain={domain} xBands={xBands} onHover={setHoverT} />
        </Card>
      </div>
      <div className="spc-col spc-col--side">
        <Card title="Pick an image">
          {groups.map((g) => (
            <div key={g} className="spc-pick">
              <h4>{g}</h4>
              <div className="spc-pick__grid">
                {SUN_SOURCES.filter((s) => s.group === g).map((s) => (
                  <button key={s.id} type="button" className={s.id === id ? "is-on" : ""} onClick={() => setId(s.id)} title={s.about}>
                    {s.sdo && thumbs.data?.[s.sdo] ? (
                      <img src={thumbs.data[s.sdo].url} alt="" loading="lazy" />
                    ) : (
                      <i className={`spc-pick__ph spc-pick__ph--${s.id.split("-")[0]}${s.sdo && thumbs.data ? " is-off" : ""}`} />
                    )}
                    <span>{s.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
          <p className="spc-note">
            SDO images from NASA's Solar Dynamics Observatory; SUVI, LASCO and CCOR loops from SWPC ({SWPC.replace("https://", "")}).
          </p>
        </Card>
        <FlareOddsCard />
      </div>
      <RegionsCard />
    </div>
  );
}
