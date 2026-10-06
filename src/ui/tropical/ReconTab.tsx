import { useEffect, useMemo, useState } from "react";
import { Map as MapIcon, Plane } from "lucide-react";

import { aircraftName, loadRecon, loadReconYears, loadSeason, type ReconMission } from "../../lib/tropical/data";
import { useTropicalStore, type ReconColor } from "../../store/useTropicalStore";
import { TimeStack, fmtUtc, type ChartPanel } from "../space/TimeStack";
import { Card, Loading, Seg, useSwpc } from "../space/common";
import { RECON_LAYER, fitTo, showOnMap } from "./mapActions";

const ser = (obs: ReconMission["obs"], k: keyof ReconMission["obs"][number]) => ({
  t: Float64Array.from(obs.map((o) => o.t)),
  v: Float64Array.from(obs.map((o) => (o[k] == null ? NaN : (o[k] as number)))),
});

const HOURS = [
  { id: 12, label: "12H" },
  { id: 24, label: "24H" },
  { id: 48, label: "48H" },
  { id: 72, label: "3D" },
  { id: 168, label: "7D" },
];

export const RECON_COLORS: { id: ReconColor; label: string }[] = [
  { id: "fl", label: "Flight-level wind" },
  { id: "sfmr", label: "SFMR surface wind" },
  { id: "xsp", label: "Surface pressure" },
  { id: "alt", label: "Altitude" },
];

function MissionChart({ m }: { m: ReconMission }) {
  const domain = useMemo<[number, number]>(() => [m.start, m.end], [m]);
  const panels = useMemo<ChartPanel[]>(
    () => [
      {
        id: "wind",
        title: "Winds",
        units: "kt",
        include: [0],
        weight: 1.5,
        lines: [
          { y: 34, color: "rgba(0,250,244,0.6)", label: "34" },
          { y: 64, color: "rgba(255,193,64,0.7)", label: "64" },
        ],
        series: [
          { label: "Flight level (30 s)", color: "#6c9dff", data: ser(m.obs, "wspd"), width: 1.4 },
          { label: "Peak 10 s", color: "#a879ff", data: ser(m.obs, "peak"), off: true },
          { label: "SFMR surface", color: "#ff7a1a", data: ser(m.obs, "sfmr"), width: 1.6 },
        ],
        fmt: (v) => `${Math.round(v)} kt`,
      },
      {
        id: "xsp",
        title: "Extrapolated surface pressure",
        units: "mb",
        series: [{ label: "Pressure", color: "#38bdf8", data: ser(m.obs, "xsp"), kind: "dots" }],
        fmt: (v) => `${v.toFixed(1)} mb`,
      },
      {
        id: "alt",
        title: "Aircraft",
        units: "m",
        series: [{ label: "Geopotential height", color: "#9aa4b2", data: ser(m.obs, "gph") }],
        fmt: (v) => `${Math.round(v)} m`,
      },
      {
        id: "temp",
        title: "Flight-level temperature",
        units: "°C",
        series: [
          { label: "Temperature", color: "#ff6b5e", data: ser(m.obs, "temp") },
          { label: "Dewpoint", color: "#4ade80", data: ser(m.obs, "dew") },
        ],
        fmt: (v) => `${v.toFixed(1)} °C`,
      },
    ],
    [m],
  );
  return <TimeStack panels={panels} domain={domain} now={false} onHover={(t) => useTropicalStore.getState().set({ hoverT: t })} />;
}

function ArchivePicker() {
  const basin = useTropicalStore((s) => s.reconBasin);
  const span = useTropicalStore((s) => s.reconSpan);
  const years = useSwpc("trp-recon-years", loadReconYears, 86400);
  const [year, setYear] = useState(new Date().getUTCFullYear() - 1);
  const season = useSwpc(`trp-season-${basin}-${year}`, () => loadSeason(basin, year), 3600);
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const setSpan = (start: string, end: string) => useTropicalStore.getState().set({ reconSpan: { start, end }, reconPicked: [] });
  return (
    <div className="trp-archive">
      <label>
        Year
        <select className="trp-select" value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {(years.data ?? [year]).slice().reverse().map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </label>
      <label>
        Storm
        <select
          className="trp-select"
          value=""
          onChange={(e) => {
            const st = season.data?.storms.find((x) => x.id === e.target.value);
            if (st) setSpan(new Date(st.start).toISOString(), new Date(Math.min(st.end, st.start + 20 * 86_400_000)).toISOString());
          }}
        >
          <option value="">{season.data ? "Pick a storm…" : "Reading the season…"}</option>
          {(season.data?.storms ?? [])
            .filter((x) => x.peak >= 34)
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} ({day(x.start)})
              </option>
            ))}
        </select>
      </label>
      <label>
        From
        <input type="date" className="trp-select" value={span ? span.start.slice(0, 10) : ""} onChange={(e) => e.target.value && setSpan(`${e.target.value}T00:00:00Z`, span?.end ?? `${e.target.value}T23:59:59Z`)} />
      </label>
      <label>
        To
        <input type="date" className="trp-select" value={span ? span.end.slice(0, 10) : ""} onChange={(e) => e.target.value && span && setSpan(span.start, `${e.target.value}T23:59:59Z`)} />
      </label>
    </div>
  );
}

export function ReconTab() {
  const basin = useTropicalStore((s) => s.reconBasin);
  const hours = useTropicalStore((s) => s.reconHours);
  const span = useTropicalStore((s) => s.reconSpan);
  const picked = useTropicalStore((s) => s.reconPicked);
  const color = useTropicalStore((s) => s.reconColor);
  const set = useTropicalStore((s) => s.set);
  const [archive, setArchive] = useState(!!span);
  const key = `trp-recon-${basin}-${archive && span ? `${span.start}-${span.end}` : hours}`;
  const { data, error } = useSwpc(key, () => loadRecon(basin, archive && span ? { start: span.start, end: span.end } : { hours }), archive ? 3600 : 120);
  const [sel, setSel] = useState<string | null>(null);
  const missions = data?.missions ?? [];
  const cur = missions.find((m) => m.id === sel) ?? missions[missions.length - 1];
  useEffect(() => {
    setSel(null);
  }, [key]);

  return (
    <div className="spc-grid spc-grid--text trp-recon">
      <Card
        className="spc-card--list"
        title={`Hurricane Hunter flights (${missions.length})`}
        extra={
          <div className="spc-card__tools">
            <Seg value={basin} onChange={(b) => set({ reconBasin: b, reconPicked: [] })} options={[{ id: "al", label: "Atlantic" }, { id: "ep", label: "E Pacific" }, { id: "cp", label: "C Pacific" }]} />
          </div>
        }
      >
        <div className="trp-reconbar">
          <Seg value={archive ? "archive" : "live"} onChange={(v) => setArchive(v === "archive")} options={[{ id: "live", label: "Latest" }, { id: "archive", label: "Archive (1989-)" }]} />
          {!archive && <Seg value={hours} onChange={(h) => set({ reconHours: h })} options={HOURS} />}
        </div>
        {archive && <ArchivePicker />}
        {archive && !span ? (
          <div className="spc-msg">Pick a storm or a span of up to three weeks.</div>
        ) : !data ? (
          <Loading error={error} what="the recon archive" />
        ) : missions.length === 0 ? (
          <div className="spc-msg">No reconnaissance in this span.</div>
        ) : (
          <ul className="trp-missions spc-scroll">
            {missions
              .slice()
              .reverse()
              .map((m) => (
                <li key={m.id} className={`${cur?.id === m.id ? "is-sel" : ""}${m.training ? " is-training" : ""}`}>
                  <input
                    type="checkbox"
                    checked={picked.includes(m.id)}
                    title="Draw this flight on the map"
                    onChange={(e) => set({ reconPicked: e.target.checked ? [...picked, m.id] : picked.filter((x) => x !== m.id) })}
                  />
                  <button type="button" onClick={() => setSel(m.id)}>
                    <Plane size={12} />
                    <span>
                      <b>
                        {m.storm || (m.training ? "Training / test" : "Mission")} · {aircraftName(m.aircraft)}
                      </b>
                      <small>
                        {m.mission} · {fmtUtc(m.start)} to {fmtUtc(m.end, false)}
                      </small>
                      <small>
                        FL {m.maxFl ?? "--"} kt · SFMR {m.maxSfmr ?? "--"} kt · {m.minXsp ? `${m.minXsp.toFixed(1)} mb` : "--"}
                      </small>
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        )}
      </Card>
      <div className="spc-col">
        <Card
          className="spc-card--fill"
          title={cur ? `${cur.storm || "Flight"} · ${aircraftName(cur.aircraft)} · ${cur.mission}` : "Flight data"}
          extra={
            cur && (
              <div className="spc-card__tools">
                <select className="trp-select" value={color} onChange={(e) => set({ reconColor: e.target.value as ReconColor })}>
                  {RECON_COLORS.map((c) => (
                    <option key={c.id} value={c.id}>
                      Colour by {c.label.toLowerCase()}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="spc-mapbtn"
                  onClick={() =>
                    showOnMap(RECON_LAYER, () => {
                      const ids = picked.length ? picked : [cur.id];
                      set({ reconPicked: ids });
                      fitTo(missions.filter((m) => ids.includes(m.id)).flatMap((m) => m.obs.map((o) => [o.lon, o.lat] as [number, number])), 7);
                    })
                  }
                >
                  <MapIcon size={13} /> {picked.length > 1 ? `${picked.length} flights on the map` : "Flight on the map"}
                </button>
              </div>
            )
          }
        >
          {cur ? <MissionChart m={cur} /> : <div className="spc-msg">Pick a flight.</div>}
          <p className="spc-note">
            High-density observations from the Air Force Reserve WC-130Js and NOAA's P-3s and G-IV, every 30 seconds: flight-level wind, the SFMR's surface wind
            below, and the surface pressure extrapolated from flight level. Hover the chart to mark the aircraft on the map.
          </p>
        </Card>
      </div>
    </div>
  );
}
