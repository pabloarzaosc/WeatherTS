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
  /** Modules whose addTo() is still under way: already subscribed to their
   *  stores, but not yet in `added`. */
  private adding = new Set<string>();
  private destroyed = false;
  private running = false;
  private next: LayerRuntimeState | null = null;

  constructor(private readonly map: MapLibreMap) {}

  /** Forget on-map state after setStyle() wipes custom layers. */
  reset(): void {
    this.added.clear();
  }

  /**
   * Tear every module back off the map. Call before map.remove().
   *
   * Modules subscribe to stores in addTo() and unsubscribe in removeFrom(), so
   * a map that is destroyed without this leaves live listeners holding a dead
   * map: the next store write reaches into a MapLibre instance whose style is
   * gone and throws "Cannot read properties of undefined (reading 'getLayer')".
   * Nothing on screen caused it, which is what made it look random.
   */
  destroy(): void {
    this.destroyed = true;
    this.next = null;
    // The ones still being added too: a pane closed while a slow addTo() waited
    // (the Models catalogue on a backend just started) left that module's
    // store listener on the dead map, throwing on every later store write.
    for (const id of [...this.added, ...this.adding]) {
      try {
        getLayerModule(id)?.removeFrom(this.map);
      } catch {
        // Best effort: one module failing to detach must not strand the rest,
        // and this runs while the map is being thrown away regardless.
      }
    }
    this.added.clear();
    this.adding.clear();
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
      if (this.destroyed) return;
      const ls = state.layers[module.id];
      if (!ls) continue;
      const isAdded = this.added.has(module.id);
      // Pieces of a module on the map that the manager never recorded: an add
      // that threw partway (after some of its layers went in) is never marked
      // added, so switching it off would skip removeFrom and strand whatever it
      // had drawn. Those count as on the map for the purpose of taking it off.
      const stranded = !isAdded && module.getLayerIds().some((layerId) => this.map.getLayer(layerId));
      // Each module is isolated. addTo may be async and may reach the network,
      // and an unhandled rejection here used to abort the whole loop -- so one
      // layer whose feed was down silently took every layer after it in the
      // registry off the map, which reads as "my layer just does not appear".
      try {
        if (ls.visible && !isAdded) {
          this.adding.add(module.id);
          try {
            await module.addTo(this.map);
          } finally {
            this.adding.delete(module.id);
          }
          // The map went while this was being added; destroy() has already
          // taken the module back off.
          if (this.destroyed) return;
          module.setOpacity(this.map, ls.opacity);
          this.added.add(module.id);
        } else if (!ls.visible && (isAdded || stranded)) {
          module.removeFrom(this.map);
          this.added.delete(module.id);
        } else if (ls.visible) {
          module.setOpacity(this.map, ls.opacity);
        }
      } catch (err) {
        // An add cut short by the map going away is not a failure worth a report.
        if (this.destroyed) return;
        console.error(`[layers] ${module.id} failed to reconcile`, err);
      }
    }
    this.applyOrder(state.layerOrder);
  }

  private applyOrder(order: string[]): void {
    const moves: string[] = [];
    // order is bottom -> top; moving each to the top in turn rebuilds the stack.
    for (const id of order) {
      if (!this.added.has(id)) continue;
      const module = getLayerModule(id);
      if (!module) continue;
      for (const layerId of module.getLayerIds()) {
        if (this.map.getLayer(layerId)) moves.push(layerId);
      }
    }
    // Then lift the always-on-top ids. Ordering is per module, so this is the
    // only way a module can keep one layer above another module while leaving
    // its other layers below it.
    //
    // Lifted in ascending topPriority, so a module that has to beat the other
    // top layers says so outright instead of depending on where it happens to
    // sit in the layer order. Ties keep that order, which is what they did
    // before there was a priority at all.
    const lifted = order
      .filter((id) => this.added.has(id))
      .map((id) => getLayerModule(id))
      .filter((module): module is NonNullable<typeof module> => Boolean(module?.topLayerIds));
    lifted.sort((a, b) => (a.topPriority ?? 0) - (b.topPriority ?? 0));
    for (const module of lifted) {
      for (const layerId of module.topLayerIds?.() ?? []) {
        if (this.map.getLayer(layerId)) moves.push(layerId);
      }
    }

    // Only when the stack would actually change.
    //
    // moveLayer marks the style changed even for a layer already where it is
    // asked to go, a changed style fires styledata on the next frame, and the
    // pane re-runs this reconcile on styledata. Moving unconditionally kept the
    // map redrawing every frame with nobody touching it -- a full label
    // placement each time, and every styledata listener run again on top.
    const current = this.map.getLayersOrder();
    const next = current.slice();
    for (const layerId of moves) {
      const at = next.indexOf(layerId);
      if (at < 0) continue;
      next.splice(at, 1);
      next.push(layerId);
    }
    if (next.every((layerId, i) => layerId === current[i])) return;
    for (const layerId of moves) this.map.moveLayer(layerId);
  }
}
