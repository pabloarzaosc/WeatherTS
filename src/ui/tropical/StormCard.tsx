import { useState } from "react";
import { createRoot } from "react-dom/client";
import maplibregl, { type Map as MapLibreMap } from "maplibre-gl";
import { ChevronDown, ChevronRight, Satellite, Spline, X } from "lucide-react";

import { SAT_VIEWS, cadenceText, showBestSatellite, type SatView } from "../../lib/tropical/bestSatellite";
import { catOf, loadStorms, typeName } from "../../lib/tropical/data";
import { useAppStore } from "../../store/useAppStore";
import { useTropicalStore } from "../../store/useTropicalStore";
import { useSwpc } from "../space/common";
import { motionText } from "./common";
import { GUIDANCE_LAYER } from "./mapActions";

/** What the storm marker carries (see buildStorms in tropicalLayers). */
export interface StormMarker {
  sid: string;
  name: string;
  label: string;
  vmax: number | null;
  mslp: number | null;
  t: number;
  invest: boolean;
  agency: string;
}

const num = (v: unknown): number | null => (v == null || v === "null" || v === "" ? null : Number(v));

/** "Oct 6, 12:00 PM" on this computer's clock, and the same in UTC. */
function when(t: number): string {
  const d = new Date(t);
  const local = d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `${local} · ${d.toISOString().slice(11, 13)}${d.toISOString().slice(14, 16)} UTC`;
}

function Menu<T extends string | boolean>({ items, onPick }: { items: { id: T; label: string }[]; onPick: (id: T) => void }) {
  return (
    <div className="trp-scard__menu" role="menu">
      {items.map((it) => (
        <button key={String(it.id)} type="button" role="menuitem" onClick={() => onPick(it.id)}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

function StormCard({ m, lat, lon, onClose }: { m: StormMarker; lat: number; lon: number; onClose: () => void }) {
  const { data } = useSwpc("trp-storms", loadStorms, 120);
  const s = data?.storms.find((x) => x.id === m.sid);
  const vmax = s?.vmax ?? m.vmax;
  const mslp = s?.mslp ?? m.mslp;
  const cat = catOf(vmax);
  const kind = m.invest ? "Invest (a disturbance being watched)" : cat.startsWith("C") ? cat.slice(1) : typeName(s?.type ?? "", vmax, s?.basin ?? "");
  const [open, setOpen] = useState<"sat" | "models" | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const guidanceVisible = useAppStore((st) => st.layers[GUIDANCE_LAYER]?.visible ?? false);
  const guidedStorm = useTropicalStore((st) => st.storm);
  const modelsOn = guidanceVisible && guidedStorm === m.sid;

  const satellite = async (view: SatView) => {
    setOpen(null);
    setBusy(true);
    setStatus("Finding the best view of it…");
    try {
      // The card hangs above the storm: the storm goes a little under the middle.
      const pick = await showBestSatellite(s?.lat ?? lat, s?.lon ?? lon, view, 130);
      setStatus(pick ? `${pick.label}, ${cadenceText(pick.cadence)}.` : "No satellite has a good view of it right now.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const models = (all: boolean | "off") => {
    setOpen(null);
    if (all === "off") {
      useAppStore.getState().setLayerVisible(GUIDANCE_LAYER, false);
      return;
    }
    useTropicalStore.getState().set({ storm: m.sid, guidanceAll: all });
    useAppStore.getState().setLayerVisible(GUIDANCE_LAYER, true);
  };
  const page = () => {
    onClose();
    useTropicalStore.getState().openTab("storm", m.sid);
  };

  return (
    <div className="trp-scard">
      <header>
        <b>{m.label}</b>
        <button type="button" className="trp-scard__x" onClick={onClose} aria-label="Close">
          <X size={14} />
        </button>
      </header>
      <button type="button" className="trp-scard__facts" onClick={page} title="Open its page">
        <dl>
          <dt>Wind speed</dt>
          <dd>
            {vmax != null ? (
              <>
                {Math.round(vmax * 1.15078)} mph
                <small>
                  {Math.round(vmax)} kt · {Math.round(vmax * 1.852)} km/h
                </small>
              </>
            ) : (
              "--"
            )}
          </dd>
          <dt>Category</dt>
          <dd>{kind}</dd>
          <dt>Min. pressure</dt>
          <dd>{mslp ? `${Math.round(mslp)} mb` : "--"}</dd>
          {s && (
            <>
              <dt>Moving</dt>
              <dd>{motionText(s.dir, s.speed)}</dd>
            </>
          )}
        </dl>
        <ChevronRight size={18} />
      </button>
      <time>{when(s?.t ?? m.t)}</time>
      <div className="trp-scard__split">
        <button type="button" className="trp-scard__main" onClick={() => void satellite("best")} disabled={busy}>
          <Satellite size={14} /> Show on Satellite
        </button>
        <button type="button" className="trp-scard__more" onClick={() => setOpen(open === "sat" ? null : "sat")} aria-label="Other satellite views" aria-expanded={open === "sat"}>
          <ChevronDown size={14} />
        </button>
      </div>
      {open === "sat" && <Menu items={SAT_VIEWS} onPick={(v) => void satellite(v)} />}
      <div className="trp-scard__split">
        <button type="button" className="trp-scard__main" onClick={() => models(useTropicalStore.getState().guidanceAll)}>
          <Spline size={14} /> {modelsOn ? "Spaghetti Models on" : "Show Spaghetti Models"}
        </button>
        <button type="button" className="trp-scard__more" onClick={() => setOpen(open === "models" ? null : "models")} aria-label="Which models" aria-expanded={open === "models"}>
          <ChevronDown size={14} />
        </button>
      </div>
      {open === "models" && (
        <Menu<boolean | "off">
          items={[
            { id: false, label: "Main models" },
            { id: true, label: "Every model and ensemble member" },
            ...(modelsOn ? [{ id: "off" as const, label: "Hide the models" }] : []),
          ]}
          onPick={models}
        />
      )}
      {status && <p className="trp-scard__status">{status}</p>}
    </div>
  );
}

// One card at a time, like a map's info window.
let current: maplibregl.Popup | null = null;

export function closeStormCard(): void {
  current?.remove();
}

/** Open the storm's card at its marker. */
export function openStormCard(map: MapLibreMap, props: Record<string, unknown>, at: [number, number]): void {
  closeStormCard();
  const m: StormMarker = {
    sid: String(props.sid),
    name: String(props.name ?? ""),
    label: String(props.label ?? props.name ?? ""),
    vmax: num(props.vmax),
    mslp: num(props.mslp),
    t: Number(props.t),
    invest: props.invest === true || props.invest === "true",
    agency: String(props.agency ?? ""),
  };
  const el = document.createElement("div");
  const root = createRoot(el);
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: true, className: "trp-cardpop", maxWidth: "300px", offset: 16, focusAfterOpen: false })
    .setLngLat(at)
    .setDOMContent(el);
  let gone = false;
  popup.on("close", () => {
    if (current === popup) current = null;
    if (gone) return;
    gone = true;
    // After the click that closed it has finished with the card.
    window.setTimeout(() => root.unmount(), 0);
  });
  current = popup;
  root.render(<StormCard m={m} lat={at[1]} lon={at[0]} onClose={closeStormCard} />);
  popup.addTo(map);
}
