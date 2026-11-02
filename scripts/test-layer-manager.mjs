// Unit tests for src/layers/manager.ts: what a style swap (basemap or theme) and
// a pane closing do to a module's store listeners. Node 22.18+ strips the types:
//   node scripts/test-layer-manager.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// The registry pulls in every layer and MapLibre; the manager only asks it for
// the modules, so the tests hand it their own.
const REGISTRY = `data:text/javascript,
  export const getLayerModules = () => globalThis.__layerModules;
  export const getLayerModule = (id) => globalThis.__layerModules.find((m) => m.id === id);`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "./registry") return { url: REGISTRY, shortCircuit: true };
    return next(specifier, context);
  },
});
const { LayerManager } = await import("../src/layers/manager.ts");

/** A store as zustand has it: one throwing listener aborts the ones after it
 *  and the caller of setState. */
function fakeStore() {
  const listeners = new Set();
  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    write() {
      listeners.forEach((fn) => fn());
    },
    count: () => listeners.size,
  };
}

/** A map whose style can be replaced and which breaks once removed, the way a
 *  MapLibre map does ("Cannot read properties of undefined (reading 'getSource')"). */
function fakeMap() {
  const map = {
    style: { sources: new Set(), layers: new Set() },
    getSource(id) {
      return this.style.sources.has(id) ? {} : undefined;
    },
    addSource(id) {
      this.style.sources.add(id);
    },
    removeSource(id) {
      this.style.sources.delete(id);
    },
    getLayer(id) {
      return this.style.layers.has(id) ? {} : undefined;
    },
    addLayer(id) {
      this.style.layers.add(id);
    },
    removeLayer(id) {
      this.style.layers.delete(id);
    },
    getLayersOrder() {
      return [...this.style.layers];
    },
    moveLayer() {},
    setStyle() {
      this.style = { sources: new Set(), layers: new Set() };
    },
    remove() {
      this.style = undefined;
    },
  };
  return map;
}

/** A module as the real ones are written: addTo subscribes and keeps the unsub
 *  in a per-map entry, overwriting what was there; removeFrom unsubscribes. */
function fakeModule(store, { id = "radar", delay = null } = {}) {
  const state = new WeakMap();
  const swaps = [];
  return {
    id,
    swaps,
    async addTo(map) {
      if (delay) await delay();
      if (!map.getSource(id)) map.addSource(id);
      if (!map.getLayer(id)) map.addLayer(id);
      state.set(map, { unsub: store.subscribe(() => map.getSource(id)) });
    },
    removeFrom(map, styleSwap) {
      swaps.push(!!styleSwap);
      state.get(map)?.unsub();
      state.delete(map);
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    },
    setOpacity() {},
    getLayerIds: () => [id],
  };
}

const on = (id = "radar") => ({ layers: { [id]: { visible: true, opacity: 1 } }, layerOrder: [id] });
const off = (id = "radar") => ({ layers: { [id]: { visible: false, opacity: 1 } }, layerOrder: [id] });

test("two panes, a style swap, a pane closes: a store write still reaches the rest", async () => {
  const store = fakeStore();
  const mod = fakeModule(store);
  globalThis.__layerModules = [mod];
  const a = fakeMap();
  const b = fakeMap();
  const ma = new LayerManager(a);
  const mb = new LayerManager(b);
  await ma.sync(on());
  await mb.sync(on());
  assert.equal(store.count(), 2);

  for (const [map, manager] of [[a, ma], [b, mb]]) {
    map.setStyle();
    manager.reset(on());
    await manager.sync(on());
  }
  assert.equal(store.count(), 2, "one listener per pane after the swap");
  assert.ok(b.getLayer("radar"), "pane B back on the new style");

  mb.destroy();
  b.remove();
  assert.equal(store.count(), 1, "only pane A's listener left");
  assert.doesNotThrow(() => store.write());
});

test("each theme flip on one pane keeps one listener", async () => {
  const store = fakeStore();
  globalThis.__layerModules = [fakeModule(store)];
  const map = fakeMap();
  const manager = new LayerManager(map);
  await manager.sync(on());
  for (let i = 0; i < 5; i++) {
    map.setStyle();
    manager.reset(on());
    await manager.sync(on());
    assert.equal(store.count(), 1);
    assert.ok(map.getLayer("radar"));
  }
});

test("a swap tells the module it goes straight back on; switched off meanwhile, it does not", async () => {
  const store = fakeStore();
  const mod = fakeModule(store);
  globalThis.__layerModules = [mod];
  const map = fakeMap();
  const manager = new LayerManager(map);
  await manager.sync(on());

  map.setStyle();
  manager.reset(on());
  assert.deepEqual(mod.swaps, [true]);
  await manager.sync(on());

  map.setStyle();
  manager.reset(off());
  assert.deepEqual(mod.swaps, [true, false]);
  await manager.sync(off());
  assert.equal(store.count(), 0);
  assert.ok(!map.getLayer("radar"));
});

test("an add under way when the style is replaced ends up whole on the new style", async () => {
  const store = fakeStore();
  let release;
  const gate = new Promise((r) => (release = r));
  let first = true;
  const mod = fakeModule(store, {
    delay: () => {
      if (!first) return null;
      first = false;
      return gate;
    },
  });
  globalThis.__layerModules = [mod];
  const map = fakeMap();
  const manager = new LayerManager(map);
  const running = manager.sync(on());

  // addTo is waiting; the swap lands and the pane asks for a sync, as MapPane does.
  map.setStyle();
  manager.reset(on());
  void manager.sync(on());
  release();
  await running;

  assert.equal(store.count(), 1, "the straddling add took itself off and was added once");
  assert.ok(map.getLayer("radar"));
  map.setStyle();
  manager.reset(on());
  await manager.sync(on());
  assert.equal(store.count(), 1, "and the manager knew it was on");
});

test("closing a pane while an add is under way still detaches the module", async () => {
  const store = fakeStore();
  let release;
  const gate = new Promise((r) => (release = r));
  globalThis.__layerModules = [fakeModule(store, { delay: () => gate })];
  const map = fakeMap();
  const manager = new LayerManager(map);
  const running = manager.sync(on());
  manager.destroy();
  map.remove();
  release();
  await running;
  // The add carried on against a removed map and threw before it subscribed;
  // the manager swallows that (the map is gone) and nothing is left listening.
  assert.equal(store.count(), 0);
});

test("a module that throws while detaching does not strand the others", async () => {
  const store = fakeStore();
  const good = fakeModule(store, { id: "good" });
  const bad = fakeModule(store, { id: "bad" });
  const removeBad = bad.removeFrom;
  bad.removeFrom = () => {
    throw new Error("boom");
  };
  globalThis.__layerModules = [bad, good];
  const state = {
    layers: { bad: { visible: true, opacity: 1 }, good: { visible: true, opacity: 1 } },
    layerOrder: ["bad", "good"],
  };
  const map = fakeMap();
  const manager = new LayerManager(map);
  await manager.sync(state);
  map.setStyle();
  const quiet = console.error;
  console.error = () => {};
  try {
    manager.reset(state);
  } finally {
    console.error = quiet;
  }
  assert.deepEqual(good.swaps, [true], "the second module was still taken off");
  bad.removeFrom = removeBad;
});
