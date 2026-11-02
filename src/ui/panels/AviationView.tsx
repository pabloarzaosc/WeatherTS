import { useEffect, useState } from "react";
import { Loader2, Search, X } from "lucide-react";

import { HAZARD_COLOR, hazardLabel, INTENSITY_COLOR, INTENSITY_LABEL, searchAirports, type AirportHit } from "../../lib/aviation";
import { CATEGORY_COLOR } from "../../lib/metar";
import { getMap } from "../../map/mapInstance";
import { useAirportStore } from "../../store/useAirportStore";
import { useAppStore } from "../../store/useAppStore";
import {
  ALOFT_HEIGHTS,
  FB_HEIGHTS,
  GAIRMET_HAZARDS,
  SIGMET_KINDS,
  SUA_TYPES,
  useAviationStore,
  type SigmetKind,
} from "../../store/useAviationStore";
import { useObsStore } from "../../store/useObsStore";
import { LayerPower } from "../LayerPower";
import { Select } from "../Select";

const SIGMET_NAMES: Record<SigmetKind, string> = { convective: "Convective", sigmet: "US", intl: "International" };
const SUA_NAMES: Record<string, string> = { R: "Restricted", P: "Prohibited", MOA: "MOA", W: "Warning", A: "Alert", D: "Danger" };
const OBS_LAYER = "observations";
const GUIDE_SOURCE = "gfs-fc";
/** The model products a pilot reads, worldwide on the GFS (the Models panel draws them). */
const GUIDANCE: [string, string][] = [
  ["fltcat", "Flight category"],
  ["ceil", "Ceiling"],
  ["vis", "Visibility"],
  ["slw", "Icing (supercooled water)"],
  ["frz_avn", "Freezing level"],
  ["ellrod", "Turbulence FL300-340"],
  ["ellrod_mid", "Turbulence FL100-180"],
  ["maxw", "Jet: maximum wind"],
  ["trop_fl", "Tropopause"],
];
const heightLabel = (h: number) => (h >= 18000 ? `FL${h / 100}` : `${h.toLocaleString("en-US")} ft`);

function Guidance() {
  const visible = useAppStore((s) => s.layers[OBS_LAYER]?.visible ?? false);
  const source = useObsStore((s) => s.source);
  const field = useObsStore((s) => s.field);
  const show = async (pid: string) => {
    const obs = useObsStore.getState();
    await obs.load();
    if (useObsStore.getState().source !== GUIDE_SOURCE) useObsStore.getState().setSource(GUIDE_SOURCE);
    useObsStore.getState().setField(pid);
    const app = useAppStore.getState();
    if (!app.layers[OBS_LAYER]?.visible) app.setLayerVisible(OBS_LAYER, true);
  };
  return (
    <div className="sfx__block">
      <div className="sfx__head">
        <span>Model guidance, worldwide</span>
        <b>GFS</b>
      </div>
      <div className="sfx__chips">
        {GUIDANCE.map(([pid, label]) => (
          <Chip key={pid} on={visible && source === GUIDE_SOURCE && field === pid} onClick={() => void show(pid)}>
            {label}
          </Chip>
        ))}
      </div>
      <div className="sfx__ends">
        <span>Opens the GFS forecast in the Models layer: the flight category from its ceiling and visibility, icing from its supercooled cloud water, Ellrod turbulence, the jet and the tropopause, anywhere on Earth.</span>
      </div>
    </div>
  );
}

function Toggle({ id, label }: { id: string; label: string }) {
  const on = useAppStore((s) => s.layers[id]?.visible ?? false);
  const setLayerVisible = useAppStore((s) => s.setLayerVisible);
  const error = useAviationStore((s) => s.errors[id]);
  return <LayerPower label={label} on={on} error={on && !!error} onToggle={() => setLayerVisible(id, !on)} />;
}

function Status({ id, unit }: { id: string; unit: string }) {
  const on = useAppStore((s) => s.layers[id]?.visible ?? false);
  const count = useAviationStore((s) => s.counts[id]);
  const error = useAviationStore((s) => s.errors[id]);
  if (!on) return null;
  return (
    <div className="sfx__ends">
      <span>{error ? error : count == null ? "Loading…" : `${count.toLocaleString("en-US")} ${unit}`}</span>
    </div>
  );
}

function Chip({ on, onClick, children, color, title }: { on: boolean; onClick: () => void; children: React.ReactNode; color?: string; title?: string }) {
  return (
    <button type="button" className={`sfx__chip${on ? " is-on" : ""}`} aria-pressed={on} onClick={onClick} title={title}>
      {color && <i className="avn__sw" style={{ background: color }} />}
      {children}
    </button>
  );
}

const toggleIn = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

/** The Aviation panel: airports, flight categories, advisories, pilot reports,
 *  winds aloft and airspace, each with its own switch and filters. */
export function AviationView() {
  const s = useAviationStore();
  const set = s.set;
  const openAirport = useAirportStore((x) => x.open);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<AirportHit[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    const ctrl = new AbortController();
    const t = window.setTimeout(() => {
      setSearching(true);
      searchAirports(q, ctrl.signal)
        .then(setHits)
        .catch(() => undefined)
        .finally(() => setSearching(false));
    }, 250);
    return () => {
      window.clearTimeout(t);
      ctrl.abort();
    };
  }, [query]);

  const open = (h: AirportHit) => {
    openAirport(h.icao);
    if (h.lat != null && h.lon != null) getMap()?.flyTo({ center: [h.lon, h.lat], zoom: Math.max(getMap()?.getZoom() ?? 7, 7) });
  };

  const tafAt = new Date(Date.now() + s.tafHours * 3600_000);
  const heights: readonly number[] = s.windsSource === "gfs" ? ALOFT_HEIGHTS : FB_HEIGHTS;
  const windsAt = new Date(Date.now() + s.windsLead * 3600_000);

  return (
    <div className="sfx avn">
      <div className="sfx__block">
        <div className="sfx__head">
          <span>Airport</span>
        </div>
        <label className="obstree__find">
          <Search size={12} aria-hidden />
          <input
            type="search"
            value={query}
            placeholder="Any airport: SBGR, GRU, Guarulhos, Heathrow"
            aria-label="Find an airport"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && hits[0]) open(hits[0]);
            }}
          />
          {searching ? <Loader2 size={12} className="sfx__status-spin" /> : query && (
            <button type="button" aria-label="Clear" onClick={() => setQuery("")}>
              <X size={12} />
            </button>
          )}
        </label>
        {hits.length > 0 && (
          <div className="avn__hits" role="list">
            {hits.map((h) => (
              <button key={h.icao} type="button" role="listitem" className="avn__hit" onClick={() => open(h)}>
                <i style={{ background: h.cat ? CATEGORY_COLOR[h.cat] : "var(--border-strong)" }} />
                <b>{h.icao}</b>
                <span>{h.name}</span>
                <em>
                  {[h.iata, [h.municipality, h.country].filter(Boolean).join(", "), h.type, h.reporting === false ? "no METARs" : null]
                    .filter(Boolean)
                    .join(" · ")}
                </em>
              </button>
            ))}
          </div>
        )}
        <div className="sfx__ends">
          <span>Any airport in the world: METARs decoded, the TAF, runways to scale with their crosswinds, frequencies and navaids, and the winds, icing and turbulence above it for three days. Or click a station on the map.</span>
        </div>
      </div>

      <div className="sfx__block">
        <Toggle id="avn-metars" label="Flight categories (METAR)" />
        <div className="avn__legend">
          {(["VFR", "MVFR", "IFR", "LIFR"] as const).map((c) => (
            <span key={c}>
              <i style={{ background: CATEGORY_COLOR[c] }} />
              {c}
            </span>
          ))}
        </div>
        <div className="sfx__chips">
          <Chip on={s.metarLabels} onClick={() => set({ metarLabels: !s.metarLabels })}>Station ids</Chip>
        </div>
        <Status id="avn-metars" unit="airports reporting" />
      </div>

      <div className="sfx__block">
        <Toggle id="avn-tafs" label="TAF forecast categories" />
        <div className="sfx__head sfx__head--sub">
          <span>Forecast for</span>
          <b>
            {s.tafHours === 0 ? "now" : `+${s.tafHours} h`} · {tafAt.toISOString().slice(8, 10)} {tafAt.toISOString().slice(11, 13)}Z
          </b>
        </div>
        <input
          type="range"
          className="avn__range"
          min={0}
          max={30}
          step={1}
          value={s.tafHours}
          onChange={(e) => set({ tafHours: Number(e.target.value) })}
          aria-label="Hours ahead"
        />
        <div className="sfx__chips">
          <Chip on={!s.tafWorst} onClick={() => set({ tafWorst: false })}>Prevailing</Chip>
          <Chip on={s.tafWorst} onClick={() => set({ tafWorst: true })} title="The worst a TEMPO or PROB group allows at that hour">
            Worst incl. TEMPO/PROB
          </Chip>
        </div>
        <Status id="avn-tafs" unit="TAFs" />
      </div>

      <div className="sfx__block">
        <Toggle id="avn-sigmets" label="SIGMETs" />
        <div className="sfx__chips">
          {SIGMET_KINDS.map((k) => (
            <Chip key={k} on={s.sigmetKinds.includes(k)} onClick={() => set({ sigmetKinds: toggleIn(s.sigmetKinds, k) })}>
              {SIGMET_NAMES[k]}
            </Chip>
          ))}
        </div>
        <Status id="avn-sigmets" unit="SIGMETs in force" />
      </div>

      <div className="sfx__block">
        <Toggle id="avn-gairmets" label="G-AIRMETs (US)" />
        <div className="sfx__head sfx__head--sub">
          <span>Forecast hour</span>
        </div>
        <div className="sfx__chips">
          {[0, 3, 6, 9, 12].map((h) => (
            <Chip key={h} on={s.gairmetFore === h} onClick={() => set({ gairmetFore: h })}>
              +{h} h
            </Chip>
          ))}
        </div>
        <div className="sfx__chips">
          {GAIRMET_HAZARDS.map((h) => (
            <Chip key={h} color={HAZARD_COLOR[h]} on={s.gairmetHazards.includes(h)} onClick={() => set({ gairmetHazards: toggleIn(s.gairmetHazards, h) })}>
              {hazardLabel(h)}
            </Chip>
          ))}
        </div>
        <Status id="avn-gairmets" unit="G-AIRMET areas, all hours" />
      </div>

      <div className="sfx__block">
        <Toggle id="avn-cwas" label="Center Weather Advisories (US)" />
        <Status id="avn-cwas" unit="CWAs in force" />
        <Toggle id="avn-tcf" label="TFM Convective Forecast (US)" />
        <Status id="avn-tcf" unit="areas" />
        <Toggle id="avn-tfrs" label="TFRs (US)" />
        <div className="sfx__ends">
          <span>These are US products with no open equivalent elsewhere; for the rest of the world the SIGMETs, the PIREPs/AIREPs and the model guidance below cover the same hazards.</span>
        </div>
        <Status id="avn-tfrs" unit="TFRs" />
      </div>

      <div className="sfx__block">
        <Toggle id="avn-pireps" label="PIREPs & AIREPs" />
        <div className="avn__legend">
          {INTENSITY_LABEL.map((l, i) => (
            <span key={l}>
              <i style={{ background: INTENSITY_COLOR[i] }} />
              {l}
            </span>
          ))}
        </div>
        <div className="sfx__chips">
          <Chip on={s.pirepTurb} onClick={() => set({ pirepTurb: !s.pirepTurb })}>Turbulence</Chip>
          <Chip on={s.pirepIce} onClick={() => set({ pirepIce: !s.pirepIce })}>Icing</Chip>
          <Chip on={s.pirepOther} onClick={() => set({ pirepOther: !s.pirepOther })}>Other</Chip>
        </div>
        <div className="sfx__chips">
          {[
            [0, "All"],
            [1, "Light+"],
            [2, "Moderate+"],
            [3, "Severe+"],
          ].map(([v, l]) => (
            <Chip key={v} on={s.pirepMin === v} onClick={() => set({ pirepMin: Number(v) })}>
              {l}
            </Chip>
          ))}
        </div>
        <div className="sfx__chips">
          {[1, 2, 3, 6].map((h) => (
            <Chip key={h} on={s.pirepAge === h} onClick={() => set({ pirepAge: h })}>
              {h} h
            </Chip>
          ))}
          <Chip on={s.pirepLow === 0 && s.pirepHigh === 17999} onClick={() => set({ pirepLow: 0, pirepHigh: 17999 })}>Below FL180</Chip>
          <Chip on={s.pirepLow === 18000} onClick={() => set({ pirepLow: 18000, pirepHigh: 60000 })}>FL180+</Chip>
          <Chip on={s.pirepLow === 0 && s.pirepHigh === 60000} onClick={() => set({ pirepLow: 0, pirepHigh: 60000 })}>All levels</Chip>
        </div>
        <Status id="avn-pireps" unit="reports (before filters)" />
      </div>

      <div className="sfx__block">
        <Toggle id="avn-winds" label="Winds & temperatures aloft" />
        <div className="sfx__chips">
          <Chip on={s.windsSource === "gfs"} onClick={() => set({ windsSource: "gfs" })} title="The GFS on a 2.5° grid, every country and ocean">
            GFS, worldwide
          </Chip>
          <Chip on={s.windsSource === "fb"} onClick={() => set({ windsSource: "fb", windsHeight: FB_HEIGHTS.includes(s.windsHeight as never) ? s.windsHeight : 9000 })}
            title="NOAA's official FB forecast at its US stations">
            FB stations (US)
          </Chip>
        </div>
        <Select
          value={String(s.windsHeight)}
          onChange={(v) => {
            const h = Number(v);
            set({ windsHeight: h, windsLevel: h >= 45000 ? "high" : "low" });
          }}
          aria-label="Altitude"
          options={heights.map((h) => ({ value: String(h), label: heightLabel(h) }))}
        />
        {s.windsSource === "gfs" ? (
          <>
            <div className="sfx__head sfx__head--sub">
              <span>Valid</span>
              <b>
                {s.windsLead === 0 ? "now" : `+${s.windsLead} h`} · {windsAt.toISOString().slice(8, 10)} {windsAt.toISOString().slice(11, 13)}Z
              </b>
            </div>
            <div className="sfx__chips">
              {[0, 3, 6, 12, 24, 36, 48].map((h) => (
                <Chip key={h} on={s.windsLead === h} onClick={() => set({ windsLead: h })}>
                  {h === 0 ? "Now" : `+${h} h`}
                </Chip>
              ))}
            </div>
          </>
        ) : (
          <div className="sfx__chips">
            {(["06", "12", "24"] as const).map((f) => (
              <Chip key={f} on={s.windsFcst === f} onClick={() => set({ windsFcst: f })}>
                {Number(f)} h forecast
              </Chip>
            ))}
          </div>
        )}
        {!heights.includes(s.windsHeight) && <div className="sfx__ends"><span>Pick an altitude of this set.</span></div>}
        <Status id="avn-winds" unit={s.windsSource === "gfs" ? "grid points" : "FB stations"} />
      </div>

      <div className="sfx__block">
        <Toggle id="avn-firs" label="FIR boundaries (world)" />
        <div className="sfx__chips">
          <Chip on={s.firLabels} onClick={() => set({ firLabels: !s.firLabels })}>Names</Chip>
        </div>
        <Status id="avn-firs" unit="FIRs" />
      </div>

      <Guidance />

      <div className="sfx__block">
        <Toggle id="avn-class" label="Class B, C, D airspace (US)" />
        <div className="sfx__chips">
          {(["B", "C", "D"] as const).map((c) => (
            <Chip key={c} on={s.airspaceClasses.includes(c)} onClick={() => set({ airspaceClasses: toggleIn(s.airspaceClasses, c) })}>
              Class {c}
            </Chip>
          ))}
        </div>
        <Status id="avn-class" unit="airspace shelves" />
        <Toggle id="avn-sua" label="Special use airspace (US)" />
        <div className="sfx__chips">
          {SUA_TYPES.map((t) => (
            <Chip key={t} on={s.suaTypes.includes(t)} onClick={() => set({ suaTypes: toggleIn(s.suaTypes, t) })}>
              {SUA_NAMES[t]}
            </Chip>
          ))}
        </div>
        <Status id="avn-sua" unit="areas" />
        <Toggle id="avn-artcc" label="ARTCC boundaries (US)" />
        <div className="sfx__ends">
          <span>Class and special-use airspace are published openly only by the FAA, so they cover the US; the FIRs cover every country. The class outlines take a minute the first time each day.</span>
        </div>
      </div>
    </div>
  );
}
