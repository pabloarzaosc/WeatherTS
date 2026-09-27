import { AlertCircle, Clock3 } from "lucide-react";

import { useAppStore } from "../store/useAppStore";
import { useOutlookStore, type OutlookLegendItem, type OutlookMeta } from "../store/useOutlookStore";

function formatStamp(value?: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.replace(/\.png$/i, "");
  // UTC, as the outlooks are issued and as the panel and popup show them.
  const iso = date.toISOString();
  return `${iso.slice(5, 7)}/${iso.slice(8, 10)} ${iso.slice(11, 13)}${iso.slice(14, 16)}Z`;
}

function timing(meta: OutlookMeta): string | null {
  const run = meta.run ? `run ${meta.run}` : null;
  const valid = formatStamp(meta.valid);
  const expire = formatStamp(meta.expire);
  const issued = formatStamp(meta.issued);
  if (run && valid) return `${run} / ${valid}`;
  if (run) return run;
  const span = valid && expire ? `${valid} – ${expire}` : expire ? `until ${expire}` : valid;
  if (issued && span) return `issued ${issued} · ${span}`;
  return span ?? (issued ? `issued ${issued}` : null);
}

function groupedLegend(items: OutlookLegendItem[]): Array<[string, OutlookLegendItem[]]> {
  const groups = new Map<string, OutlookLegendItem[]>();
  for (const item of items) {
    const group = item.section ?? "Legend";
    groups.set(group, [...(groups.get(group) ?? []), item]);
  }
  return Array.from(groups.entries());
}

export function OutlookLegend() {
  const layers = useAppStore((s) => s.layers);
  const metas = useOutlookStore((s) => s.metas);
  const visible = Object.values(metas).filter((meta) => layers[meta.id]?.visible);

  if (visible.length === 0) return null;

  return (
    <aside className="outlook-legend" aria-label="Outlook legend">
      {visible.map((meta) => {
        const t = timing(meta);
        return (
          <section key={meta.id} className="ol-card">
            <header className="ol-card__head">
              <div className="ol-card__title">
                <span>{meta.name}</span>
                <small>{meta.source}</small>
              </div>
              {(meta.stale || meta.error) && (
                <span className="ol-card__warn" title={meta.error ?? "Showing cached data"}>
                  <AlertCircle size={13} />
                  {meta.stale ? "stale" : "error"}
                </span>
              )}
            </header>

            {t && (
              <div className="ol-card__time">
                <Clock3 size={12} />
                <span>{t}</span>
              </div>
            )}

            {meta.note && !meta.error && <div className="ol-card__note">{meta.note}</div>}

            {groupedLegend(meta.legend).map(([section, items]) => (
              <div key={`${meta.id}-${section}`} className="ol-table">
                <div className="ol-table__title">{section}</div>
                {items.map((item) => (
                  <div key={`${section}-${item.label}-${item.color}`} className="ol-row">
                    <span className="ol-swatch" style={{ background: item.color }} />
                    <span className="ol-label">{item.label}</span>
                  </div>
                ))}
              </div>
            ))}
          </section>
        );
      })}
    </aside>
  );
}
