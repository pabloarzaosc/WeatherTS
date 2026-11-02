import { useEffect, useState } from "react";
import type { MapMouseEvent } from "maplibre-gl";
import { Activity, Box, Check, CloudSun, Columns2, Copy, Crosshair, Link2, LocateFixed, Radar, Square } from "lucide-react";
import { useLocalWeatherStore } from "../../store/useLocalWeatherStore";
import { buildViewLink } from "../../lib/viewLink";

import { allMaps, paneIdOf, subscribeMaps } from "../../map/mapInstance";
import type { Map as MapLibreMap } from "maplibre-gl";
import { PaneMenuItems } from "../PaneWindows";
import { ColorScaleMenuItem } from "../ColorTableHost";
import { ShellMenuItem } from "../ShellChrome";
import { ExportMenuItem } from "../ExportPage";
import { useSoundingViewerStore } from "../../store/useSoundingViewerStore";
import { useAppStore } from "../../store/useAppStore";
import { isTdwrId, useNexradStore } from "../../store/useNexradStore";
import { nearestRadar, switchToNearestRadar } from "../../layers/radarHold";
import { useRadar3DStore } from "../../store/useRadar3DStore";
import { currentFrame, kmBetween, siteSpot, squareAround } from "../../lib/radar3d/selection";

interface MenuState {
  x: number;
  y: number;
  lng: number;
  lat: number;
  /** The pane right-clicked (panes-compare: its Compare / Window items). */
  paneId: string | null;
}

/** 3D Volume Here: the radar on screen when it is close enough to the spot,
 *  else the nearest one (switched to), over a 120 km box around the spot. */
function open3DHere(lat: number, lng: number, quick: boolean) {
  const nx = useNexradStore.getState();
  const app = useAppStore.getState();
  let site = nx.site;
  let frame = currentFrame();
  const cur = siteSpot(site);
  const shown = Boolean(app.layers.nexrad?.visible);
  // The volume tools read a NEXRAD's volume: from an airport radar, the nearest NEXRAD.
  if (!site || isTdwrId(site) || !shown || !cur || kmBetween(cur.lat, cur.lon, lat, lng) > 250) {
    const near = nearestRadar(lat, lng);
    if (!near) return;
    if (!shown) app.setLayerVisible("nexrad", true);
    if (near.site.id !== site) {
      switchToNearestRadar(lat, lng, "nexrad");
      frame = { at: nx.archiveTime ?? null, key: "" };
    }
    site = near.site.id;
  }
  useRadar3DStore.getState().openView({ site, ...frame, sel: { kind: "box", ring: squareAround(lng, lat, 120) }, quick });
}

export function MapContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const openAt = useSoundingViewerStore((s) => s.openAt);
  const setAreaSelecting = useSoundingViewerStore((s) => s.setAreaSelecting);
  // Read so the menu redraws when the radar list arrives.
  useNexradStore((s) => s.sites);

  useEffect(() => {
    // Every pane's map (panes-compare): the menu used to listen on the first
    // map only, so a right-click on any other pane did nothing.
    const attached = new Map<MapLibreMap, () => void>();
    const attach = (map: MapLibreMap) => {
      const onContext = (e: MapMouseEvent) => {
        e.preventDefault();
        // The radar list, for "Radar here", if the radar has not been opened yet.
        if (useNexradStore.getState().sites.length === 0) void useNexradStore.getState().loadCatalog();
        setMenu({
          x: e.originalEvent.clientX,
          y: e.originalEvent.clientY,
          lng: e.lngLat.lng,
          lat: e.lngLat.lat,
          paneId: paneIdOf(map),
        });
      };
      const onClear = () => setMenu(null);
      map.on("contextmenu", onContext);
      map.on("movestart", onClear);
      map.on("click", onClear);
      return () => {
        map.off("contextmenu", onContext);
        map.off("movestart", onClear);
        map.off("click", onClear);
      };
    };
    const sync = () => {
      const maps = allMaps();
      for (const m of maps) if (!attached.has(m)) attached.set(m, attach(m));
      for (const [m, off] of attached) {
        if (!maps.includes(m)) {
          off();
          attached.delete(m);
        }
      }
    };
    sync();
    const unsub = subscribeMaps(sync);
    return () => {
      unsub();
      for (const off of attached.values()) off();
      attached.clear();
    };
  }, []);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    const onDown = () => setMenu(null);
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [menu]);

  if (!menu) return null;

  const width = 236;
  const left = Math.min(menu.x, window.innerWidth - width - 8);
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - 560));

  const coordText = `${menu.lat.toFixed(4)}, ${menu.lng.toFixed(4)}`;
  // The radar that sees this spot best: the nearest, where its beam is lowest.
  const radar = nearestRadar(menu.lat, menu.lng);
  const radarOn = useNexradStore.getState().site === radar?.site.id && useAppStore.getState().layers.nexrad?.visible;
  // The airport radar over this spot, if one reaches it (Doppler range, about 90 km).
  const airport = nearestRadar(menu.lat, menu.lng, "tdwr");
  const airportOn = useNexradStore.getState().site === airport?.site.id && useAppStore.getState().layers.nexrad?.visible;

  return (
    <div
      className="mapmenu"
      style={{ left, top, width }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="mapmenu__coord">
        <Crosshair size={13} />
        <span>{coordText}</span>
      </div>
      <button
        type="button"
        className="mapmenu__item mapmenu__item--primary"
        onClick={() => {
          openAt(menu.lat, menu.lng);
          setMenu(null);
        }}
      >
        <Activity size={15} />
        Sounding
      </button>
      <button
        type="button"
        className="mapmenu__item"
        onClick={() => {
          setAreaSelecting(true);
          setMenu(null);
        }}
        title="Average the model profile over a box you draw, instead of one grid cell"
      >
        <Square size={15} />
        Area sounding
        <span className="mapmenu__hint">drag a box</span>
      </button>
      <button
        type="button"
        className="mapmenu__item"
        onClick={() => {
          useLocalWeatherStore.getState().openAt(menu.lat, menu.lng);
          setMenu(null);
        }}
        title="Alerts, current conditions, the next 24 hours and the 7-day forecast here (api.weather.gov, US only)"
      >
        <CloudSun size={15} />
        Local weather
        <span className="mapmenu__hint">US</span>
      </button>
      <button
        type="button"
        className="mapmenu__item"
        onClick={() => {
          void useLocalWeatherStore.getState().openMine();
          setMenu(null);
        }}
        title="Local weather where you are"
      >
        <LocateFixed size={15} />
        My local weather
      </button>
      {radar && radar.km < 460 && (
        <button
          type="button"
          className="mapmenu__item"
          disabled={!!radarOn}
          onClick={() => {
            if (!useAppStore.getState().layers.nexrad?.visible) useAppStore.getState().setLayerVisible("nexrad", true);
            switchToNearestRadar(menu.lat, menu.lng, "nexrad");
            setMenu(null);
          }}
          title="Switch to the radar nearest this spot (or press and hold on the map)"
        >
          <Radar size={15} />
          {radarOn ? `On ${radar.site.icao}` : `Radar here: ${radar.site.icao}`}
          <span className="mapmenu__hint">{Math.round(radar.km)} km</span>
        </button>
      )}
      {airport && airport.km < 90 && (
        <button
          type="button"
          className="mapmenu__item"
          disabled={!!airportOn}
          onClick={() => {
            if (!useAppStore.getState().layers.nexrad?.visible) useAppStore.getState().setLayerVisible("nexrad", true);
            switchToNearestRadar(menu.lat, menu.lng, "tdwr");
            setMenu(null);
          }}
          title="The FAA airport radar (TDWR) over this spot: sharper close in, about 90 km of range"
        >
          <Radar size={15} />
          {airportOn ? `On ${airport.site.icao}` : `Airport radar: ${airport.site.icao}`}
          <span className="mapmenu__hint">{Math.round(airport.km)} km</span>
        </button>
      )}
      {radar && radar.km < 460 && (
        <>
          <button
            type="button"
            className="mapmenu__item"
            onClick={() => {
              open3DHere(menu.lat, menu.lng, false);
              setMenu(null);
            }}
            title="The radar volume in 3D over a 120 km box around this spot"
          >
            <Box size={15} />
            3D Volume Here
          </button>
          <button
            type="button"
            className="mapmenu__item"
            onClick={() => {
              open3DHere(menu.lat, menu.lng, true);
              setMenu(null);
            }}
            title="Reflectivity and velocity in 3D side by side, one camera"
          >
            <Columns2 size={15} />
            Quick Analysis Here
          </button>
        </>
      )}
      <button
        type="button"
        className="mapmenu__item"
        onClick={() => {
          if (navigator.clipboard) navigator.clipboard.writeText(coordText).catch(() => {});
          setMenu(null);
        }}
      >
        <Copy size={15} />
        Copy coordinates
      </button>
      <ColorScaleMenuItem paneId={menu.paneId} x={menu.x} y={menu.y} onDone={() => setMenu(null)} />
      <CopyLinkItem onDone={() => setMenu(null)} />
      {/* export step: the Export page for the pane right-clicked */}
      <ExportMenuItem paneId={menu.paneId} onDone={() => setMenu(null)} itemClass="mapmenu__item" />
      {/* ux-shell: into / out of broadcast mode and the minimal UI */}
      <ShellMenuItem onDone={() => setMenu(null)} />
      {menu.paneId && (
        <>
          <div className="mapmenu__sep" role="separator" />
          <PaneMenuItems id={menu.paneId} onDone={() => setMenu(null)} itemClass="mapmenu__item" />
        </>
      )}
    </div>
  );
}

/** "Copy link": the radar, live or archive, each pane's product and tilt, and
 *  the frame's time or the event (src/lib/viewLink.ts). */
function CopyLinkItem({ onDone }: { onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const link = buildViewLink();
  return (
    <button
      type="button"
      className="mapmenu__item"
      disabled={!link}
      onClick={() => {
        if (!link || !navigator.clipboard) return;
        navigator.clipboard
          .writeText(link)
          .then(() => {
            setCopied(true);
            window.setTimeout(onDone, 700);
          })
          .catch(() => onDone());
      }}
      title={link ? "A link that opens this radar, its panes and this moment" : "Open a radar first"}
    >
      {copied ? <Check size={15} /> : <Link2 size={15} />}
      {copied ? "Link copied" : "Copy link"}
      <span className="mapmenu__hint">{useNexradStore.getState().archiveTime !== null || useNexradStore.getState().archiveDate !== null ? "archive" : "live"}</span>
    </button>
  );
}
