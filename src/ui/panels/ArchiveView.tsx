import { useEffect, useMemo } from "react";
import { AlertTriangle, Loader2, Radio } from "lucide-react";

import { useAppStore } from "../../store/useAppStore";
import { ARCHIVE_SOURCE, useArchiveStore } from "../../store/useArchiveStore";
import { useNexradStore } from "../../store/useNexradStore";
import { selectObsFrame, selectObsProduct, selectObsProducts, useObsStore } from "../../store/useObsStore";
import { LayerPower } from "../LayerPower";
import { Select } from "../Select";
import { archiveWhen } from "./MesoArchive";
import { NotableEvents } from "./NotableEvents";
import { RadarArchiveSection } from "../RadarArchiveSection";

/** The first moment the archive opens on: the mesoanalysis begins in January 2005. */
const FIRST = Date.UTC(2005, 0, 1) / 1000;
/** Level III's archive begins here; before it the radar is Level II's. */
const LEVEL3_FROM = Date.UTC(2022, 2, 1) / 1000;

function isoDay(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, "0")}Z` }));
const MINUTES = Array.from({ length: 12 }, (_, i) => ({ value: String(i * 5), label: `:${String(i * 5).padStart(2, "0")}` }));

/**
 * The Archive panel: pick a moment in the past -- or a notable day -- and the
 * mesoanalysis and the radar open there together. Each section switches its
 * layer on at the moment; moving the moment moves both.
 */
export function ArchiveView() {
  const at = useArchiveStore((s) => s.at);
  const site = useArchiveStore((s) => s.site);
  const setMoment = useArchiveStore((s) => s.setMoment);
  const setSite = useArchiveStore((s) => s.setSite);
  const setMeso = useArchiveStore((s) => s.setMeso);
  const setRadar = useArchiveStore((s) => s.setRadar);
  const backToLive = useArchiveStore((s) => s.backToLive);

  const obsVisible = useAppStore((s) => s.layers.observations?.visible ?? false);
  const radarVisible = useAppStore((s) => s.layers.nexrad?.visible ?? false);
  const obsSource = useObsStore((s) => s.source);
  const obsBusy = useObsStore((s) => s.busy);
  const obsError = useObsStore((s) => s.error);
  const frames = useObsStore((s) => s.frames);
  const index = useObsStore((s) => s.index);
  const frame = useObsStore(selectObsFrame);
  const product = useObsStore(selectObsProduct);
  const products = useObsStore(selectObsProducts);
  const setField = useObsStore((s) => s.setField);
  const catalog = useObsStore((s) => s.catalog);
  const radarArchive = useNexradStore((s) => s.archiveTime);
  const radarSite = useNexradStore((s) => s.site);
  const radarError = useNexradStore((s) => s.error);
  const radarScans = useNexradStore((s) => s.scans.length);
  const sites = useNexradStore((s) => s.sites);
  const radarDay = useNexradStore((s) => s.archiveDate !== null);

  const mesoOn = obsVisible && obsSource === ARCHIVE_SOURCE;
  const radarOn = radarVisible && radarArchive != null;
  const latest = catalog?.sources.find((s) => s.id === ARCHIVE_SOURCE)?.archive?.to ?? Math.floor(Date.now() / 1000);

  // The radar list and the analysis catalogue, for the pickers.
  useEffect(() => {
    void useNexradStore.getState().loadCatalog();
    void useObsStore.getState().load();
  }, []);

  // Only what the archive draws: anything else would move the map off its day.
  const offered = catalog?.sources.find((s) => s.id === ARCHIVE_SOURCE)?.products;
  const productOptions = useMemo(
    () =>
      products
        .filter((p) => offered?.includes(p.id))
        .map((p) => ({ value: p.id, label: p.label, group: p.sub ? `${p.group} · ${p.sub}` : p.group })),
    [products, offered],
  );

  const siteOptions = useMemo(
    () =>
      [...sites]
        .sort((a, b) => a.icao.localeCompare(b.icao))
        .map((s) => ({ value: s.id, label: `${s.icao} ${s.name}`, hint: s.online ? undefined : "off now" })),
    [sites],
  );

  const moment = new Date(at * 1000);
  const pick = (day: string, hour: number, minute: number) => {
    if (!day) return;
    const [y, m, d] = day.split("-").map(Number);
    const unix = Date.UTC(y, m - 1, d, hour, minute) / 1000;
    setMoment(Math.min(Math.max(unix, FIRST), latest));
  };

  // An airport radar's archive is Level III whatever the day.
  const pickedTdwr = sites.some((s) => s.id === (radarSite ?? "") && s.type === "TDWR");
  const beforeLevel3 = at < LEVEL3_FROM && !pickedTdwr;
  const radarFrom = beforeLevel3 ? "Level II" : "Level III";

  return (
    <div className="sfx">
      <div className={`sfx__status${obsError && mesoOn ? " is-error" : ""}`}>
        {mesoOn && obsBusy ? (
          <>
            <Loader2 size={13} className="sfx__status-spin" /> Reading {archiveWhen(at)} from the archive…
          </>
        ) : mesoOn && obsError ? (
          <>
            <AlertTriangle size={13} /> {obsError}
          </>
        ) : mesoOn || radarOn ? (
          <>Showing {archiveWhen(frame?.unix ?? at)}</>
        ) : (
          <>Pick a moment, or a notable day</>
        )}
      </div>

      <div className="sfx__block">
        <div className="sfx__head">
          <span>When (UTC)</span>
          <b>{archiveWhen(at, true)}</b>
        </div>
        <div className="archv__when">
          <label className="sfcobs__field">
            <input
              type="date"
              value={isoDay(at)}
              min={isoDay(FIRST)}
              max={isoDay(latest)}
              onChange={(e) => pick(e.target.value, moment.getUTCHours(), moment.getUTCMinutes())}
              aria-label="Day (UTC)"
            />
          </label>
          <Select
            value={String(moment.getUTCHours())}
            onChange={(v) => pick(isoDay(at), Number(v), moment.getUTCMinutes())}
            aria-label="Hour (UTC)"
            options={HOURS}
          />
          <Select
            value={String(moment.getUTCMinutes() - (moment.getUTCMinutes() % 5))}
            onChange={(v) => pick(isoDay(at), moment.getUTCHours(), Number(v))}
            aria-label="Minute"
            options={MINUTES}
          />
        </div>
        <div className="sfx__ends">
          <span>Any moment since January 2005. Both sections below open on it, and follow it when it moves.</span>
        </div>
      </div>

      <div className="sfx__block">
        <LayerPower label="Mesoanalysis" on={mesoOn} onText="ON" onToggle={() => void setMeso(!mesoOn)} />
        {mesoOn ? (
          <>
            <div className="sfx__head">
              <span>Product</span>
            </div>
            <Select
              value={product?.id ?? ""}
              onChange={setField}
              aria-label="Mesoanalysis product"
              options={productOptions}
              placeholder={product?.label ?? "—"}
            />
            {product?.note && <div className="sfx__ends"><span>{product.note}</span></div>}
            <div className="sfx__ends">
              <span>{frames.length ? `${frames[0].label} → ${frames[frames.length - 1].label}` : "—"}</span>
              <span>{frames.length ? `${index + 1} / ${frames.length}` : ""}</span>
            </div>
          </>
        ) : (
          <div className="sfx__ends">
            <span>
              SPC-style severe parameters for any hour since 2005, worked out from the RAP's analysis (the RUC's before
              May 2012): CAPE, shear, helicity, the effective layer, STP and SCP. Its day (12Z to 11Z) is the timeline.
            </span>
          </div>
        )}
      </div>

      <div className="sfx__block">
        <LayerPower
          label="Radar"
          on={radarOn}
          onText="ON"
          error={radarOn && !!radarError}
          onToggle={() => void setRadar(!radarOn)}
        />
        <div className="sfx__head">
          <span>Radar site</span>
          {radarOn && radarSite && <b>K{radarSite} · {radarScans} scans</b>}
        </div>
        <Select
          value={site ?? ""}
          onChange={(v) => {
            setSite(v);
            if (!radarOn) void setRadar(true);
          }}
          aria-label="Radar site"
          options={siteOptions}
          placeholder="Nearest to the map"
        />
        {radarOn && radarError ? (
          <div className="sfx__ends">
            <span>{radarError}</span>
          </div>
        ) : (
          <div className="sfx__ends">
            <span>
              Picking a radar or a moment switches the radar on there, its loop starting 20 minutes before. This moment
              comes from {radarFrom}
              {beforeLevel3
                ? ": reflectivity and velocity at every tilt, dual-pol once the radar had it (2011-2013), coarser before 2008."
                : "."}
            </span>
          </div>
        )}
      </div>

      <RadarArchiveSection />

      <NotableEvents />

      {(mesoOn || radarOn || radarDay) && (
        <div className="sfx__block">
          <div className="sfx__chips">
            <button type="button" className="sfx__chip sfx__chip--wide" onClick={backToLive}>
              <Radio size={11} /> Back to live
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
