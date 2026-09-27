import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, FileText } from "lucide-react";

import {
  previousIssuance,
  spcDiscussion,
  spcIssuanceOf,
  spcOutlook,
  SPC_CATEGORICAL,
  SPC_ISSUANCES,
  type OutlookWhen,
  type SpcDay,
} from "../../lib/outlooks";
import { useOutlookGroups, useOutlookSelection } from "../OutlookControls";
import { useOutlookStore } from "../../store/useOutlookStore";

function utc(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  const s = t.toISOString();
  return `${s.slice(5, 7)}/${s.slice(8, 10)} ${s.slice(11, 13)}${s.slice(14, 16)}Z`;
}

const toInput = (ymd: string) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
const fromInput = (v: string) => v.replace(/-/g, "");
const todayUtc = () => new Date().toISOString().slice(0, 10);

/** The issuance after this one -- the next that day, or the first of the next. */
function nextIssuance(day: SpcDay, when: OutlookWhen): OutlookWhen {
  const fwd = (date: string) => {
    const t = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8)) + 86_400_000);
    return t.toISOString().slice(0, 10).replace(/-/g, "");
  };
  if (day >= 4 || !when.time) return { date: fwd(when.date), time: null };
  const list = SPC_ISSUANCES[day as 1 | 2 | 3];
  const i = list.findIndex((x) => x.time === when.time);
  if (i >= 0 && i < list.length - 1) return { date: when.date, time: list[i + 1].time };
  return { date: fwd(when.date), time: list[0].time };
}

/** An issuance that exists for `day`: the same time if that day has it, else
 *  the last of the date (days 4-8 have no time). */
function fitTo(day: SpcDay, when: OutlookWhen): OutlookWhen {
  if (day >= 4) return { date: when.date, time: null };
  const list = SPC_ISSUANCES[day as 1 | 2 | 3];
  return list.some((x) => x.time === when.time) ? when : { date: when.date, time: list[list.length - 1].time };
}

/**
 * The highest risk on each SPC day, for the day tabs: the category for days
 * 1-3, the probability for 4-8. Read from the same files the map draws, which
 * the outlook library keeps for two minutes -- so the strip costs nothing
 * beyond the first look.
 */
function useSpcDayRisks(enabled: boolean): Record<number, { text: string; color: string } | null> {
  const [risks, setRisks] = useState<Record<number, { text: string; color: string } | null>>({});
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    for (const day of [1, 2, 3, 4, 5, 6, 7, 8] as SpcDay[]) {
      void spcOutlook(day, day <= 3 ? "categorical" : "probabilistic")
        .then((o) => {
          let best: Record<string, unknown> | null = null;
          for (const f of o.geojson.features) {
            const p = (f.properties ?? {}) as Record<string, unknown>;
            if (p.cig) continue;
            if (!best || Number(p.rank) > Number(best.rank)) best = p;
          }
          if (!alive) return;
          const text = best ? String(best.label) : day <= 3 ? "None" : "—";
          const color = best ? String(best.color) : "transparent";
          setRisks((r) => ({ ...r, [day]: { text, color } }));
        })
        .catch(() => alive && setRisks((r) => ({ ...r, [day]: null })));
    }
    return () => {
      alive = false;
    };
  }, [enabled]);
  return risks;
}

export function OutlooksView() {
  const { active, activeId, pick } = useOutlookSelection();
  const groups = useOutlookGroups();
  const when = useOutlookStore((s) => s.when);
  const setWhen = useOutlookStore((s) => s.setWhen);
  const compare = useOutlookStore((s) => s.compare);
  const setCompare = useOutlookStore((s) => s.setCompare);
  const meta = useOutlookStore((s) => (activeId ? s.metas[activeId] : undefined));

  const isSpc = !!active?.product.history;
  const day = isSpc ? (Number(active?.variant) as SpcDay) : null;
  const risks = useSpcDayRisks(isSpc && when === null);

  // A past issuance picked for one day may not exist for another (day 1 has a
  // 1630Z, day 2 does not): move it to one that does.
  useEffect(() => {
    if (day && when) {
      const fit = fitTo(day, when);
      if (fit.time !== when.time) setWhen(fit);
    }
  }, [day, when, setWhen]);

  const shown = useMemo<OutlookWhen | null>(
    () => (day ? (when ?? spcIssuanceOf(day, meta?.valid ?? null, meta?.issued ?? null)) : null),
    [day, when, meta?.valid, meta?.issued],
  );

  return (
    <div className="sfx olv">
      {active && (
        <div className="sfx__block">
          <div className="sfx__head">
            <span>{active.product.label}</span>
            <b>{active.product.group.split("·").pop()?.trim()}</b>
          </div>
          {active.product.variants.length > 1 && (
            <div className="olv-tabs" role="tablist">
              {active.product.variants.map((v) => {
                const risk = isSpc && when === null ? risks[Number(v.key)] : undefined;
                return (
                  <button
                    key={v.key}
                    type="button"
                    role="tab"
                    aria-selected={v.key === active.variant}
                    className={`olv-tab${v.key === active.variant ? " is-on" : ""}`}
                    onClick={() => pick(active.product, v.key)}
                  >
                    <span>{v.label}</span>
                    {risk && (
                      <em style={{ borderColor: risk.color, color: risk.text === "None" || risk.text === "—" ? undefined : "var(--text)" }}>
                        {risk.text}
                      </em>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {isSpc && when === null && Object.keys(risks).length > 0 && (
            <div className="olv-strip" aria-label="Highest risk each day">
              {([1, 2, 3, 4, 5, 6, 7, 8] as const).map((d) => {
                const r = risks[d];
                const cat = SPC_CATEGORICAL.find((c) => c.label === r?.text);
                return (
                  <span key={d} title={`Day ${d}: ${r?.text ?? "…"}`} style={{ background: r && r.color !== "transparent" ? r.color : undefined }}>
                    {d}
                    <i>{cat ? cat.label : r?.text && r.text !== "None" && r.text !== "—" ? r.text : ""}</i>
                  </span>
                );
              })}
            </div>
          )}
          <dl className="olv-meta">
            <dt>Issued</dt>
            <dd>{utc(meta?.issued)}{meta?.forecaster ? ` · ${meta.forecaster}` : ""}</dd>
            <dt>Valid</dt>
            <dd>
              {utc(meta?.valid)}
              {meta?.expire ? ` – ${utc(meta.expire)}` : ""}
            </dd>
          </dl>
          {meta?.error && <div className="olv-error">{meta.error}</div>}
          {!meta?.error && meta?.note && <div className="olv-note">Nothing drawn: {meta.note}</div>}
        </div>
      )}

      {active && isSpc && day && (
        <div className="sfx__block">
          <div className="sfx__head">
            <span>Issuance</span>
            <b>{when ? "Archive" : "Newest"}</b>
          </div>
          <div className="olv-when">
            <button
              type="button"
              className="olv-step"
              title="The issuance before"
              disabled={!shown}
              onClick={() => shown && setWhen(previousIssuance(day, shown))}
            >
              <ChevronLeft size={14} />
            </button>
            <input
              type="date"
              className="olv-date"
              max={todayUtc()}
              min="2003-01-01"
              value={shown ? toInput(shown.date) : ""}
              onChange={(e) => {
                if (!e.target.value) return setWhen(null);
                setWhen(fitTo(day, { date: fromInput(e.target.value), time: shown?.time ?? null }));
              }}
            />
            <button
              type="button"
              className="olv-step"
              title="The issuance after"
              disabled={!when}
              onClick={() => {
                if (!when) return;
                const next = nextIssuance(day, when);
                // Past today is the newest.
                setWhen(next.date > todayUtc().replace(/-/g, "") ? null : next);
              }}
            >
              <ChevronRight size={14} />
            </button>
            <button type="button" className={`sfx__chip${when === null ? " is-on" : ""}`} onClick={() => setWhen(null)}>
              Newest
            </button>
          </div>
          {day <= 3 && (
            <div className="sfx__chips">
              {SPC_ISSUANCES[day as 1 | 2 | 3].map((x) => {
                const on = shown?.time === x.time;
                return (
                  <button
                    key={x.time}
                    type="button"
                    className={`sfx__chip${on ? " is-on" : ""}`}
                    onClick={() => setWhen({ date: shown?.date ?? todayUtc().replace(/-/g, ""), time: x.time })}
                  >
                    {x.label}
                  </button>
                );
              })}
            </div>
          )}
          <label className="olv-toggle">
            <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
            <span>Outline the issuance before it (dashed): what changed</span>
          </label>
        </div>
      )}

      {active?.product.discussion && (
        <Discussion
          target={active.product.discussion(active.variant)}
          when={isSpc ? when : null}
          key={`${active.product.key}-${active.variant}`}
        />
      )}

      {groups.map(([group, products]) => (
        <div key={group} className="sfx__block">
          <div className="sfx__head">
            <span>{group}</span>
          </div>
          <div className="sfx__chips">
            {products.map((p) => {
              const on = active?.product.key === p.key;
              return (
                <button
                  key={p.key}
                  type="button"
                  className={`sfx__chip${on ? " is-on" : ""}`}
                  aria-pressed={on}
                  title={p.description}
                  onClick={() => pick(on ? null : p)}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      <div className="sfx__ends">
        <span>
          {active
            ? "Click an outlook area on the map for the risk at that point — on the categorical outlook, with its tornado, wind and hail chances."
            : "Pick an outlook. SPC's convective outlooks keep every issuance back to 2003."}
        </span>
      </div>
    </div>
  );
}

function Discussion({ target, when }: { target: SpcDay | "fire1" | "fire2" | "fire38" | null; when: OutlookWhen | null }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || target === null) return;
    let alive = true;
    setText(null);
    setError(null);
    spcDiscussion(target, typeof target === "number" && target <= 3 ? when : null)
      .then((t) => alive && setText(t))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [open, target, when]);

  if (target === null) return null;
  return (
    <div className="sfx__block">
      <button type="button" className={`olv-disc-btn${open ? " is-on" : ""}`} onClick={() => setOpen((v) => !v)}>
        <FileText size={13} />
        <span>{open ? "Hide the forecaster's discussion" : "Read the forecaster's discussion"}</span>
      </button>
      {open && (
        <div className="olv-disc">
          {error ? <div className="olv-error">{error}</div> : text === null ? <div className="olv-dim">Loading…</div> : <pre>{text}</pre>}
        </div>
      )}
    </div>
  );
}
