import { useMemo, useState } from "react";
import { Check, ChevronDown, Grid3x3, Layers as LayersIcon } from "lucide-react";

import { useAppStore } from "../../store/useAppStore";
import {
  MODEL_CATALOG,
  VARIABLE_CATALOG,
  productId,
  type CatalogSection,
} from "../../lib/weatherCatalog";

type Tab = "models" | "variables";

function sectionOf(sections: CatalogSection[], selectedId: string | null): string | null {
  if (!selectedId) return null;
  for (const s of sections) {
    for (const g of s.groups) {
      for (const it of g.items) {
        if (productId(s.label, g.label, it) === selectedId) return s.label;
      }
    }
  }
  return null;
}

// Last segment of a composite id (section::group::item) -> the display label.
function labelOf(id: string | null): string {
  if (!id) return "—";
  const parts = id.split("::");
  return parts[parts.length - 1] || "—";
}

/** The "Models" panel: browse the full model + variable catalog and pick the
 *  active model and variable. Two accordion trees behind a segmented switch. */
export function ModelsView() {
  const selectedModel = useAppStore((s) => s.selectedModel);
  const selectedVariable = useAppStore((s) => s.selectedVariable);
  const setSelectedModel = useAppStore((s) => s.setSelectedModel);
  const setSelectedVariable = useAppStore((s) => s.setSelectedVariable);

  const [tab, setTab] = useState<Tab>("models");
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const open: Record<string, boolean> = {};
    const mSec = sectionOf(MODEL_CATALOG, selectedModel) ?? MODEL_CATALOG[0].label;
    const vSec = sectionOf(VARIABLE_CATALOG, selectedVariable) ?? VARIABLE_CATALOG[0].label;
    open[mSec] = true;
    open[vSec] = true;
    return open;
  });

  const sections = tab === "models" ? MODEL_CATALOG : VARIABLE_CATALOG;
  const selected = tab === "models" ? selectedModel : selectedVariable;
  const select = tab === "models" ? setSelectedModel : setSelectedVariable;

  const counts = useMemo(() => {
    const count = (secs: CatalogSection[]) =>
      secs.reduce((n, s) => n + s.groups.reduce((m, g) => m + g.items.length, 0), 0);
    return { models: count(MODEL_CATALOG), variables: count(VARIABLE_CATALOG) };
  }, []);

  const toggleSection = (label: string) =>
    setExpanded((e) => ({ ...e, [label]: !e[label] }));

  return (
    <div className="models">
      <div className="models__sel">
        <div className="models__selrow">
          <span className="models__selkey">
            <Grid3x3 size={12} /> MODEL
          </span>
          <span className="models__selval" title={labelOf(selectedModel)}>
            {labelOf(selectedModel)}
          </span>
        </div>
        <div className="models__selrow">
          <span className="models__selkey">
            <LayersIcon size={12} /> VARIABLE
          </span>
          <span className="models__selval" title={labelOf(selectedVariable)}>
            {labelOf(selectedVariable)}
          </span>
        </div>
      </div>

      <div className="subtabs">
        <button
          type="button"
          className={`subtab${tab === "models" ? " is-active" : ""}`}
          onClick={() => setTab("models")}
        >
          Models <em>{counts.models}</em>
        </button>
        <button
          type="button"
          className={`subtab${tab === "variables" ? " is-active" : ""}`}
          onClick={() => setTab("variables")}
        >
          Variables <em>{counts.variables}</em>
        </button>
      </div>

      <div className="models__tree">
        {sections.map((section) => {
          const isOpen = expanded[section.label] ?? false;
          return (
            <section className="models__sec" key={section.label}>
              <button
                type="button"
                className={`models__sechead${isOpen ? " is-open" : ""}`}
                onClick={() => toggleSection(section.label)}
                aria-expanded={isOpen}
              >
                <ChevronDown size={14} className="models__chev" />
                <span>{section.label}</span>
              </button>
              {isOpen && (
                <div className="models__secbody">
                  {section.groups.map((group) => (
                    <div className="models__group" key={group.label}>
                      <div className="models__grouplabel">{group.label}</div>
                      {group.items.map((item) => {
                        const id = productId(section.label, group.label, item);
                        const active = selected === id;
                        return (
                          <button
                            key={id}
                            type="button"
                            className={`models__item${active ? " is-active" : ""}`}
                            onClick={() => select(id)}
                            title={item}
                          >
                            <span className="models__itemname">{item}</span>
                            {active && <Check size={13} className="models__itemcheck" />}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
