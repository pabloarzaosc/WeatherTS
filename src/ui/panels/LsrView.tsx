import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2 } from "lucide-react";

import { useAppStore } from "../../store/useAppStore";
import { LayerPower } from "../LayerPower";
import {
  LSR_CATEGORIES,
  LSR_LABELS,
  type LsrCategory,
  fetchLsrTypes,
  lsrPlace,
  type LsrTypeInfo,
} from "../../lib/lsr";
import { LSR_WINDOWS, selectVisibleLsr, useLsrStore } from "../../store/useLsrStore";
import { getMap } from "../../map/mapInstance";
import { LsrShape } from "../LsrShape";

const LAYER = "lsr";
/** Rows drawn per opened category before the rest are summarised away. */
const PER_GROUP = 40;

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`sfc-switch${on ? " is-on" : ""}`}
      onClick={onClick}
      role="switch"
      aria-checked={on}
    >
      <span className="sfc-switch__knob" />
    </button>
  );
}

function ago(unix: number): string {
  const m = Math.round(Date.now() / 1000 - unix) / 60;
  if (m < 60) return `${Math.round(m)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

/** Local Storm Reports panel: window length, category filters and the feed. */
export function LsrView() {
  const enabled = useAppStore((s) => s.layers[LAYER]?.visible ?? false);
  const setLayerVisible = useAppStore((s) => s.setLayerVisible);

  const hours = useLsrStore((s) => s.hours);
  const setHours = useLsrStore((s) => s.setHours);
  const cats = useLsrStore((s) => s.cats);
  const toggleCat = useLsrStore((s) => s.toggleCat);
  const setAllCats = useLsrStore((s) => s.setAllCats);
  const showLabels = useLsrStore((s) => s.showLabels);
  const setShowLabels = useLsrStore((s) => s.setShowLabels);
  const busy = useLsrStore((s) => s.busy);
  const error = useLsrStore((s) => s.error);
  const endUnix = useLsrStore((s) => s.endUnix);
  const data = useLsrStore((s) => s.data);
  const select = useLsrStore((s) => s.select);
  // NOT `useLsrStore(selectVisibleLsr)`: zustand v5 compares the selector's
  // result by identity, so a selector that builds a new array every call
  // re-renders forever ("Maximum update depth exceeded"). Filter in a memo off
  // stable store values instead -- the same shape AlertPanel uses for
  // selectVisibleAlerts.
  const visible = useMemo(
    () => selectVisibleLsr({ data, cats }),
    [data, cats],
  );

  useEffect(() => {
    if (enabled && !data) void useLsrStore.getState().load();
  }, [enabled, data]);

  // The full type reference: every LSR code the NWS issues, grouped by the
  // category that colours it, with what each one actually means. Fetched once
  // and only when opened -- it is documentation, not live data.
  const [refOpen, setRefOpen] = useState(false);
  const [types, setTypes] = useState<LsrTypeInfo[] | null>(null);
  useEffect(() => {
    if (!refOpen || types) return;
    const ctrl = new AbortController();
    fetchLsrTypes(ctrl.signal)
      .then((r) => setTypes(r.types))
      .catch(() => setTypes([]));
    return () => ctrl.abort();
  }, [refOpen, types]);

  const typesByCat = useMemo(() => {
    const out = new Map<string, LsrTypeInfo[]>();
    for (const ty of types ?? []) {
      const list = out.get(ty.cat) ?? [];
      list.push(ty);
      out.set(ty.cat, list);
    }
    for (const list of out.values()) list.sort((a, b) => b.rank - a.rank);
    return out;
  }, [types]);

  // The feed, grouped into collapsible categories. A flat list of a hundred
  // reports buries the two tornadoes under ninety wind gusts; grouped, the
  // counts are the summary and the user opens only what they care about.
  const feedGroups = useMemo(() => {
    const by = new Map<LsrCategory, typeof visible>();
    for (const f of visible) {
      const list = by.get(f.properties.cat) ?? [];
      list.push(f);
      by.set(f.properties.cat, list);
    }
    // Most severe category first, and newest first inside each.
    return LSR_CATEGORIES.filter((c) => by.has(c))
      .map((cat) => ({
        cat,
        items: (by.get(cat) ?? []).slice().sort((a, b) => b.properties.unix - a.properties.unix),
      }))
      .sort(
        (a, b) =>
          Math.max(...b.items.map((f) => f.properties.rank)) -
          Math.max(...a.items.map((f) => f.properties.rank)),
      );
  }, [visible]);

  const [openCats, setOpenCats] = useState<Record<string, boolean>>({});
  // Open the most severe group on the first load, so the panel is never a wall
  // of collapsed headers with nothing to read.
  const topCat = feedGroups[0]?.cat;
  useEffect(() => {
    if (topCat) setOpenCats((o) => (topCat in o ? o : { ...o, [topCat]: true }));
  }, [topCat]);

  // Per-category counts over everything fetched, so a filter shows what turning
  // it on would actually add.
  const counts = new Map<string, number>();
  for (const f of data?.features ?? []) {
    counts.set(f.properties.cat, (counts.get(f.properties.cat) ?? 0) + 1);
  }

  return (
    <div className="sfcobs">
      <LayerPower
        label="Local Storm Reports"
        on={enabled}
        error={!!error}
        onToggle={() => setLayerVisible(LAYER, !enabled)}
      />

      {error && (
        <div className="sfcobs__error" role="alert">
          <AlertTriangle size={14} />
          <span>{error}</span>
          <button
            type="button"
            className="sfcobs__retry"
            onClick={() => void useLsrStore.getState().load()}
          >
            Retry
          </button>
        </div>
      )}

      <label className="sfcobs__field">
        <span className="sfcobs__label">
          Window{endUnix != null ? " — following the timeline" : " — ending now"}
        </span>
        <select value={hours} onChange={(e) => setHours(Number(e.target.value) as never)}>
          {LSR_WINDOWS.map((h) => (
            <option key={h} value={h}>
              last {h} h
            </option>
          ))}
        </select>
      </label>

      <div className="sfcobs__section">
        Types
        <span className="lsrv__all">
          <button type="button" onClick={() => setAllCats(true)}>all</button>
          <button type="button" onClick={() => setAllCats(false)}>none</button>
        </span>
      </div>
      <div className="lsrv__cats">
        {LSR_CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            className={`lsrv__cat${cats[c] ? " is-on" : ""}`}
            onClick={() => toggleCat(c)}
            aria-pressed={cats[c]}
          >
            <LsrShape cat={c} size={13} dim={!cats[c]} />
            <span>{LSR_LABELS[c]}</span>
            <b>{counts.get(c) ?? 0}</b>
          </button>
        ))}
      </div>

      <div className="sfcobs__toggle-row">
        <span>Show magnitudes</span>
        <Toggle on={showLabels} onClick={() => setShowLabels(!showLabels)} />
      </div>

      <div className="sfcobs__section">
        Reports{busy && <Loader2 size={12} className="spin" style={{ marginLeft: 6 }} />}
      </div>
      <div className="sfcobs__row">
        <span style={{ color: "var(--text-faint)", fontSize: 11 }}>
          {visible.length} shown of {data?.features.length ?? 0} in the window
        </span>
      </div>

      <div className="sfcobs__section">Report types</div>
      <button
        type="button"
        className="lsrv__refbtn"
        onClick={() => setRefOpen((v) => !v)}
        aria-expanded={refOpen}
      >
        {refOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        What each report type means
        {types && <b>{types.length}</b>}
      </button>
      {refOpen && (
        <div className="lsrv__ref">
          {types === null && (
            <div className="lsrv__none">
              <Loader2 size={13} className="spin" /> Loading the type table…
            </div>
          )}
          {types?.length === 0 && <div className="lsrv__none">Type table unavailable.</div>}
          {LSR_CATEGORIES.filter((c) => typesByCat.has(c)).map((c) => (
            <section key={c}>
              <h5>
                <LsrShape cat={c} size={12} />
                {LSR_LABELS[c]}
              </h5>
              {(typesByCat.get(c) ?? []).map((ty) => (
                <div key={ty.code} className="lsrv__type">
                  <code>{ty.code}</code>
                  <div>
                    <b>{ty.label}</b>
                    <span>{ty.desc}</span>
                  </div>
                </div>
              ))}
            </section>
          ))}
        </div>
      )}

      <div className="sfcobs__section">Feed</div>
      {visible.length === 0 && !busy && (
        <div className="lsrv__none">No reports in this window.</div>
      )}
      {feedGroups.map(({ cat, items }) => {
        const isOpen = openCats[cat] ?? false;
        const shown = isOpen ? items.slice(0, PER_GROUP) : [];
        return (
          <div className="lsrv__group" key={cat}>
            <button
              type="button"
              className={`lsrv__grouphead${isOpen ? " is-open" : ""}`}
              onClick={() => setOpenCats((o) => ({ ...o, [cat]: !isOpen }))}
              aria-expanded={isOpen}
            >
              {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <LsrShape cat={cat} size={13} />
              <span>{LSR_LABELS[cat]}</span>
              <b>{items.length}</b>
            </button>
            {isOpen && (
              <ul className="lsrv__list">
                {shown.map((f) => {
                  const p = f.properties;
                  return (
                    <li key={`${p.unix}-${p.code}-${f.geometry.coordinates[0]}`}>
                      <button
                        type="button"
                        onClick={() => {
                          select(f);
                          getMap()?.flyTo({
                            center: f.geometry.coordinates as [number, number],
                            zoom: Math.max(getMap()?.getZoom() ?? 7, 7),
                            essential: true,
                          });
                        }}
                      >
                        <LsrShape cat={p.cat} size={12} />
                        <span className="lsrv__what" title={p.desc}>
                          {p.typeName || p.label}
                          {p.mag ? ` ${p.mag}` : ""}
                        </span>
                        <span className="lsrv__where">{lsrPlace(p)}</span>
                        <span className="lsrv__age">{ago(p.unix)}</span>
                      </button>
                    </li>
                  );
                })}
                {/* Say what was cut. A silent cap reads as "that is all of them". */}
                {items.length > PER_GROUP && (
                  <li className="lsrv__more">
                    +{items.length - PER_GROUP} older {LSR_LABELS[cat].toLowerCase()} reports
                    not listed
                  </li>
                )}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
