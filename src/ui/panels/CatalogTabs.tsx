import { useState } from "react";
import { Star, Trash2, Save, Layers as LayersIcon, RotateCcw } from "lucide-react";

import { useAppStore } from "../../store/useAppStore";
import { useCatalogStore } from "../../store/useCatalogStore";
import { getLayerModules } from "../../layers/registry";
import { layerAllowed, useFeatureStore } from "../../store/useFeatureStore";
import { LAYER_CATEGORIES } from "../../layers/types";

function fmtWhen(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/** One layer as a row: star it, and switch it on or off. */
function LayerRow({ id }: { id: string }) {
  const module = getLayerModules().find((m) => m.id === id);
  const on = useAppStore((s) => s.layers[id]?.visible ?? false);
  const setLayerVisible = useAppStore((s) => s.setLayerVisible);
  const favorites = useCatalogStore((s) => s.favorites);
  const toggleFavorite = useCatalogStore((s) => s.toggleFavorite);
  if (!module) return null;
  const starred = favorites.includes(id);

  return (
    <div className={`catrow${on ? " is-on" : ""}`}>
      <button
        type="button"
        className={`catrow__star${starred ? " is-on" : ""}`}
        onClick={() => toggleFavorite(id)}
        title={starred ? "Remove from favorites" : "Add to favorites"}
        aria-pressed={starred}
      >
        <Star size={13} />
      </button>
      <button type="button" className="catrow__main" onClick={() => setLayerVisible(id, !on)}>
        <b>{module.name}</b>
        <span>{module.description}</span>
      </button>
      <span className="catrow__state">{on ? "ON" : "OFF"}</span>
    </div>
  );
}

/** Starred layers, so a chase day's handful is one click away. */
export function FavoritesTab() {
  const favorites = useCatalogStore((s) => s.favorites);
  const known = new Set(getLayerModules().map((m) => m.id));
  // A favorite whose layer no longer exists would render an empty row forever.
  const live = favorites.filter((id) => known.has(id));

  if (live.length === 0) {
    return (
      <div className="empty">
        <Star size={22} />
        <p>No favorites yet.</p>
        <span>Star a layer in Advanced to pin it here.</span>
      </div>
    );
  }
  return (
    <div className="catrows">
      {live.map((id) => (
        <LayerRow key={id} id={id} />
      ))}
    </div>
  );
}

/**
 * Saved arrangements of the map.
 *
 * A chase day has a handful of setups -- radar plus warnings for nowcasting,
 * soundings plus fronts for the morning read -- and rebuilding one by hand
 * every time is the part that costs time.
 */
export function MineTab() {
  const layers = useAppStore((s) => s.layers);
  const setLayerVisibilityBatch = useAppStore((s) => s.setLayerVisibilityBatch);
  const setLayerOpacity = useAppStore((s) => s.setLayerOpacity);
  const workspaces = useCatalogStore((s) => s.workspaces);
  const saveWorkspace = useCatalogStore((s) => s.saveWorkspace);
  const deleteWorkspace = useCatalogStore((s) => s.deleteWorkspace);
  const [name, setName] = useState("");

  const activeCount = Object.values(layers).filter((l) => l.visible).length;

  const restore = (id: string) => {
    const w = workspaces.find((x) => x.id === id);
    if (!w) return;
    // Every known layer is named, not just the ones that were on: restoring a
    // setup has to switch OFF what is not in it, or it only ever adds.
    const updates: Record<string, boolean> = {};
    for (const m of getLayerModules()) updates[m.id] = w.layers[m.id]?.visible ?? false;
    setLayerVisibilityBatch(updates);
    for (const [layerId, v] of Object.entries(w.layers)) {
      if (v.opacity != null) setLayerOpacity(layerId, v.opacity);
    }
  };

  return (
    <div className="catmine">
      <div className="catmine__save">
        <input
          value={name}
          placeholder={`Name this setup (${activeCount} layer${activeCount === 1 ? "" : "s"} on)`}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim()) {
              saveWorkspace(name, layers);
              setName("");
            }
          }}
        />
        <button
          type="button"
          disabled={!name.trim()}
          onClick={() => {
            saveWorkspace(name, layers);
            setName("");
          }}
        >
          <Save size={13} /> Save
        </button>
      </div>

      {workspaces.length === 0 ? (
        <div className="empty">
          <LayersIcon size={22} />
          <p>No saved setups.</p>
          <span>Arrange the layers you want, then name and save them here.</span>
        </div>
      ) : (
        <div className="catrows">
          {workspaces.map((w) => (
            <div className="catrow" key={w.id}>
              <button type="button" className="catrow__main" onClick={() => restore(w.id)}>
                <b>{w.name}</b>
                <span>
                  {Object.values(w.layers).filter((l) => l.visible).length} layers ·{" "}
                  {fmtWhen(w.savedAt)}
                </span>
              </button>
              <button
                type="button"
                className="catrow__star"
                title="Restore"
                onClick={() => restore(w.id)}
              >
                <RotateCcw size={13} />
              </button>
              <button
                type="button"
                className="catrow__star"
                title="Delete"
                onClick={() => deleteWorkspace(w.id)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Every registered layer, grouped, with nothing curated away. */
export function AdvancedTab() {
  // Settings > Features (ux-shell): a switched-off feature's layers are not listed.
  const featuresOff = useFeatureStore((s) => s.off);
  const modules = getLayerModules().filter((m) => layerAllowed(m.id, m.category, featuresOff));
  return (
    <div className="catrows">
      {LAYER_CATEGORIES.map((cat) => {
        const inCat = modules.filter((m) => m.category === cat.id);
        if (!inCat.length) return null;
        return (
          <div key={cat.id}>
            <div className="catrows__head">{cat.label}</div>
            {inCat.map((m) => (
              <LayerRow key={m.id} id={m.id} />
            ))}
          </div>
        );
      })}
    </div>
  );
}
