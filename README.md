# WeatherTS — Geo Workstation (Phase 1)

A **web** meteorological visualization app, built in phases. This is **Phase 1**:
the technical foundation, a working dark map, and an **extensible layer system**.
No weather data yet (radar/satellite/models arrive in later phases), and no timeline.

Built with **React + TypeScript (strict) · MapLibre GL JS · Zustand**,
on 100% free, keyless services: **OpenFreeMap** basemaps and **Photon** geocoding.

---

## Run it

```bash
npm install
npm run dev            # start the Vite dev server, then open the printed URL
```

Other scripts:

```bash
npm run build          # type-check + build the web frontend
npm run preview        # serve the production build locally
```

### Auto-update

This project already includes a Windows auto-update flow using `electron-updater` and `electron-builder`.

- `electron-builder` publishes releases to GitHub using the `publish.provider: github` config in `electron-builder.yml`.
- The app checks for updates automatically in packaged builds and shows a banner with version and changelog.
- When the user clicks "Download & install", the update is downloaded and the app restarts automatically.

## Como publicar uma atualização

1. Atualize a versão do app em `package.json`.
   - Exemplo: `"version": "0.2.6"`

2. Opcional: escreva o changelog na descrição da nova release do GitHub.
   - O texto da release será usado como notas de atualização no app.

3. Crie o build e publique para GitHub:
   - No Windows PowerShell:
     ```powershell
     $env:GH_TOKEN = "<seu_token_de_acesso_pessoal>"
     npm run electron:publish
     ```
   - No CMD:
     ```cmd
     set GH_TOKEN=<seu_token_de_acesso_pessoal>
     npm run electron:publish
     ```

4. Verifique o GitHub em `https://github.com/pabloarzaosc/WeatherTS/releases`.
   - Deve aparecer a nova release com o instalador `WeatherTS-Setup-x.y.z.exe` e o arquivo `latest.yml`.

5. Quando os usuários abrirem a versão empacotada do app, ele irá checar atualizações e mostrar o banner automaticamente.
   - Se eles clicarem em "Download & install", o app baixa a atualização e reinicia automaticamente.

## Tokens e repositório privado

- Para publicar no GitHub, você precisa de um token de acesso pessoal (`GH_TOKEN`) com permissão `repo`.
- Esse token é usado apenas durante a publicação do instalador, não é enviado aos usuários.
- Se o repositório for privado, o GitHub exige autenticação para baixar assets de release.

Para um fluxo mais simples para seus usuários finais, é melhor hospedar os arquivos de atualização (`latest.yml` e o instalador `.exe`) em um servidor público ou `S3` e usar o provider `generic`.

Se você quiser, posso ajudar a configurar esse fluxo genérico também. Ele evita problemas de autenticação de download para usuários de um repositório privado.

Requirements: Node 18+.

---

## What's included

- **Full-screen dark map** (OpenFreeMap `dark` style) centered on the continental US
  (`-98, 39`, zoom 4). Pan / zoom / rotate enabled.
- **Mercator ⇄ Globe** projection toggle (`map.setProjection`).
- **Live LAT / LNG / Z** readout in the bottom status bar (follows the cursor).
- **Place search** via Photon, with `flyTo` on the chosen result.
- **Zoom in/out + reset-view** controls, and **fullscreen** (browser Fullscreen API).
- **Dark / Light theme**, persisted to `localStorage`; every UI color is a CSS variable.
- **Layer system** with three free demo layers (no weather data):
  1. **Country Boundaries** — bundled Natural Earth GeoJSON (offline).
  2. **Lat/Lon Graticule** — generated in-app at runtime.
  3. **Day/Night Terminator** — computed client-side from the sun's position (optional, off by default).

## Project layout

```
src/
  store/useAppStore.ts     Zustand: theme, projection, map readout, per-layer state + order
  map/
    MapView.tsx            MapLibre lifecycle; drives the map from the store
    mapStyle.ts            OpenFreeMap style URLs + initial view
    mapInstance.ts         shared handle to the live map
  layers/                  -- the heart of Phase 1 --
    types.ts               LayerModule contract + categories
    registry.ts            register / list layer modules
    manager.ts             reconciles store state onto the map (visibility/opacity/order)
    index.ts               <- the SINGLE place you register layers
    geo/                   runtime GeoJSON generators (graticule, terminator)
    modules/               the demo LayerModules (boundaries, graticule, terminator)
  lib/                     photon (search), fullscreen, theme
  ui/                      CommandRail, SearchBar, LayerPanel, StatusBar, ZoomControls, BrandMark
  styles/                  theme.css (tokens) + app.css
public/data/               bundled Natural Earth countries GeoJSON
```

---

## Adding a new layer (the whole point of the architecture)

A layer is a self-contained `LayerModule`. To add one in a future phase you write
the module and register it — **no UI or store changes**. The store, the layer panel
and the map manager all read from the registry.

```ts
// src/layers/modules/radar.ts
import type { LayerModule } from "../types";

const SOURCE = "radar-src";
const LAYER = "radar-raster";

export const radarLayer: LayerModule = {
  id: "radar",
  name: "Reflectivity (Radar)",
  category: "weather",
  source: "Some free radar tiles",
  defaultVisible: false,
  defaultOpacity: 0.8,
  addTo(map) {
    if (!map.getSource(SOURCE)) {
      map.addSource(SOURCE, { type: "raster", tiles: ["https://…/{z}/{x}/{y}.png"], tileSize: 256 });
    }
    if (!map.getLayer(LAYER)) {
      map.addLayer({ id: LAYER, type: "raster", source: SOURCE, paint: { "raster-opacity": 0.8 } });
    }
  },
  removeFrom(map) {
    if (map.getLayer(LAYER)) map.removeLayer(LAYER);
    if (map.getSource(SOURCE)) map.removeSource(SOURCE);
  },
  setOpacity(map, o) {
    if (map.getLayer(LAYER)) map.setPaintProperty(LAYER, "raster-opacity", o);
  },
  getLayerIds() {
    return [LAYER];
  },
};
```

```ts
// src/layers/index.ts  — add two lines:
import { radarLayer } from "./modules/radar";
registerLayer(radarLayer);
```

That's it. The "Weather Products" category appears in the panel with a toggle,
opacity slider and reorder controls, all wired to the map automatically.

---

## Notes

- This project targets **React 19**. To pin React 18 instead: set `react`/`react-dom`
  to `^18` and `@types/react`/`@types/react-dom` to `^18` in `package.json`, then reinstall.
- Layer **visibility/opacity/order are not persisted** — they are always rebuilt
  from the registry so newly registered layers always show up.

_Map data © OpenFreeMap · OpenMapTiles · OpenStreetMap contributors. Boundaries: Natural Earth (public domain)._
