import type { LayerModule } from "./types";

/**
 * Central layer registry. Modules register themselves at import time (see
 * layers/index.ts); everything else reads from here.
 */
const registry = new Map<string, LayerModule>();

export function registerLayer(module: LayerModule): void {
  if (registry.has(module.id)) {
    console.warn(`[layerRegistry] duplicate layer id "${module.id}" ignored`);
    return;
  }
  registry.set(module.id, module);
}

export function getLayerModules(): LayerModule[] {
  return Array.from(registry.values());
}

export function getLayerModule(id: string): LayerModule | undefined {
  return registry.get(id);
}
