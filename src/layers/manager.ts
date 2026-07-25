import type { Map as MapLibreMap } from "maplibre-gl";
import { getLayerModule, getLayerModules } from "./registry";

export interface LayerRuntimeState {
  layers: Record<string, { visible: boolean; opacity: number }>;
  layerOrder: string[]; // bottom -> top
}

/**
 * Reconciles the desired layer state (from the store) onto the live map:
 * adds/removes modules on visibility changes, pushes opacity, and restacks
 * by z-order. Runs are serialized because addTo() can be async (GeoJSON fetch).
 */
export class LayerManager {
  private added = new Set<string>();
  private running = false;
  private next: LayerRuntimeState | null = null;

  constructor(private readonly map: MapLibreMap) {}

  /** Forget on-map state after setStyle() wipes custom layers. */
  reset(): void {
    this.added.clear();
  }

  /** Reconcile toward `state`. Safe to call rapidly; only the latest wins. */
  async sync(state: LayerRuntimeState): Promise<void> {
    this.next = state;
    if (this.running) return;
    this.running = true;
    try {
      while (this.next) {
        const desired = this.next;
        this.next = null;
        await this.reconcile(desired);
      }
    } finally {
      this.running = false;
    }
  }

  private async reconcile(state: LayerRuntimeState): Promise<void> {
    for (const module of getLayerModules()) {
      const ls = state.layers[module.id];
      if (!ls) continue;
      const isAdded = this.added.has(module.id);
      if (ls.visible && !isAdded) {
        await module.addTo(this.map);
        module.setOpacity(this.map, ls.opacity);
        this.added.add(module.id);
      } else if (!ls.visible && isAdded) {
        module.removeFrom(this.map);
        this.added.delete(module.id);
      } else if (ls.visible) {
        module.setOpacity(this.map, ls.opacity);
      }
    }
    this.applyOrder(state.layerOrder);
  }

  private applyOrder(order: string[]): void {
    // order is bottom -> top; moving each to the top in turn rebuilds the stack.
    for (const id of order) {
      if (!this.added.has(id)) continue;
      const module = getLayerModule(id);
      if (!module) continue;
      for (const layerId of module.getLayerIds()) {
        if (this.map.getLayer(layerId)) this.map.moveLayer(layerId);
      }
    }
    // Then lift the always-on-top ids. Ordering is per module, so this is the
    // only way a module can keep one layer above another module while leaving
    // its other layers below it.
    for (const id of order) {
      if (!this.added.has(id)) continue;
      const module = getLayerModule(id);
      for (const layerId of module?.topLayerIds?.() ?? []) {
        if (this.map.getLayer(layerId)) this.map.moveLayer(layerId);
      }
    }
  }
}
