import { useEffect, useState } from "react";
import type { MapMouseEvent } from "maplibre-gl";
import { Activity, Copy, Crosshair, Radar, Square } from "lucide-react";

import { getMap } from "../../map/mapInstance";
import { useSoundingViewerStore } from "../../store/useSoundingViewerStore";
import { useAppStore } from "../../store/useAppStore";
import { useNexradStore } from "../../store/useNexradStore";
import { nearestRadar, switchToNearestRadar } from "../../layers/radarHold";

interface MenuState {
  x: number;
  y: number;
  lng: number;
  lat: number;
}

export function MapContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const openAt = useSoundingViewerStore((s) => s.openAt);
  const setAreaSelecting = useSoundingViewerStore((s) => s.setAreaSelecting);
  // Read so the menu redraws when the radar list arrives.
  useNexradStore((s) => s.sites);

  useEffect(() => {
    let map = getMap();
    let tries = 0;
    let timer: number | undefined;

    const attach = () => {
      map = getMap();
      if (!map) {
        if (tries++ < 40) timer = window.setTimeout(attach, 100);
        return;
      }
      const onContext = (e: MapMouseEvent) => {
        e.preventDefault();
        // The radar list, for "Radar here", if the radar has not been opened yet.
        if (useNexradStore.getState().sites.length === 0) void useNexradStore.getState().loadCatalog();
        setMenu({
          x: e.originalEvent.clientX,
          y: e.originalEvent.clientY,
          lng: e.lngLat.lng,
          lat: e.lngLat.lat,
        });
      };
      const onClear = () => setMenu(null);
      map.on("contextmenu", onContext);
      map.on("movestart", onClear);
      map.on("click", onClear);
      cleanup = () => {
        map?.off("contextmenu", onContext);
        map?.off("movestart", onClear);
        map?.off("click", onClear);
      };
    };

    let cleanup: (() => void) | undefined;
    attach();
    return () => {
      if (timer) window.clearTimeout(timer);
      cleanup?.();
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
  const top = Math.min(menu.y, window.innerHeight - 230);

  const coordText = `${menu.lat.toFixed(4)}, ${menu.lng.toFixed(4)}`;
  // The radar that sees this spot best: the nearest, where its beam is lowest.
  const radar = nearestRadar(menu.lat, menu.lng);
  const radarOn = useNexradStore.getState().site === radar?.site.id && useAppStore.getState().layers.nexrad?.visible;

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
      {radar && radar.km < 460 && (
        <button
          type="button"
          className="mapmenu__item"
          disabled={!!radarOn}
          onClick={() => {
            if (!useAppStore.getState().layers.nexrad?.visible) useAppStore.getState().setLayerVisible("nexrad", true);
            switchToNearestRadar(menu.lat, menu.lng);
            setMenu(null);
          }}
          title="Switch to the radar nearest this spot (or press and hold on the map)"
        >
          <Radar size={15} />
          {radarOn ? `On ${radar.site.icao}` : `Radar here: ${radar.site.icao}`}
          <span className="mapmenu__hint">{Math.round(radar.km)} km</span>
        </button>
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
    </div>
  );
}
