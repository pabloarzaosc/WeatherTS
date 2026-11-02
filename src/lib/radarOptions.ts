// Velocity display options, app-wide (Settings > Radar > Velocity):
//
//  - Dealiasing for Level II velocity, SRV, VROT and the debris score, and the
//    storm motion SRV takes out. Both ride on the wire code as the suffixes
//    backend/radar_derived.py reads (_D<alg>, _M<how>), so every cache -- the
//    server's, the browser's, the store's scan cache -- keeps one entry per
//    choice and switching back is instant.
//  - "Show range folded": the RF line of a velocity palette. buildMesh draws
//    range-folded gates (meta.rfCode) in the palette's RF colour when it has
//    one; with the switch off the line is taken out, so the mesh cache (keyed
//    on the palette text) tells the two apart too.
//
// This module reads settings only: the nexrad store imports it, so it must not
// import the store back. The reload on a change is wired in radarKeys.ts.

import { isBrazilSite } from "./brazilRadar";
import { getSetting, useSettingsStore } from "../settings/useSettingsStore";

export type DealiasAlg = "region" | "vad" | "off";
export type MotionMode = "auto" | "sti" | "manual";

const ALG_SUFFIX: Record<DealiasAlg, string> = { region: "R", vad: "V", off: "0" };

/** The Level II codes the options apply to: velocity, SRV, VROT, PTDS at a tilt. */
const TILTED = /^L2(G|S|VROT|PTDS)([0-9A-Z])$/;

/** Where Reset puts a manual storm motion: from 240 deg at 30 kt. */
export const MOTION_RESET = { from: 240, kt: 30 } as const;

export const OPTION_KEYS = [
  "radar.dealias",
  "radar.showRangeFolded",
  "radar.stormMotionMode",
  "radar.stormMotionFrom",
  "radar.stormMotionKt",
] as const;

export function dealiasAlg(): DealiasAlg {
  const v = getSetting<string>("radar.dealias");
  return v === "vad" || v === "off" ? v : "region";
}

export function motionMode(): MotionMode {
  const v = getSetting<string>("radar.stormMotionMode");
  return v === "sti" || v === "manual" ? v : "auto";
}

/** The `_M...` suffix for SRV. */
function motionSuffix(): string {
  const mode = motionMode();
  if (mode === "sti") return "_MS";
  if (mode === "manual") {
    const from = Math.round(getSetting<number>("radar.stormMotionFrom")) % 360;
    const kt = Math.max(0, Math.round(getSetting<number>("radar.stormMotionKt")));
    return `_M${from}-${kt}`;
  }
  return "_MA";
}

/** The code as the backend should get it: plain codes pass through; Level II
 *  velocity-based codes at NEXRAD sites get the dealias (and SRV motion)
 *  suffixes. Brazilian volumes have their own unfolding and no SRV options. */
export function wireOptions(site: string | null | undefined, product: string): string {
  const m = TILTED.exec(product);
  if (!m || isBrazilSite(site)) return product;
  let s = `${product}_D${ALG_SUFFIX[dealiasAlg()]}`;
  if (m[1] === "S") s += motionSuffix();
  return s;
}

/** The storm motion as a request parameter: auto | sti | <from>/<kt>. */
export function motionParam(): string {
  const mode = motionMode();
  if (mode !== "manual") return mode;
  const from = Math.round(getSetting<number>("radar.stormMotionFrom")) % 360;
  const kt = Math.max(0, Math.round(getSetting<number>("radar.stormMotionKt")));
  return `${from}/${kt}`;
}

/** The dealias (and, for SRV, storm-motion) query parameters of a 3D-view or
 *  cross-section request for moment `fam` ("G" velocity, "S" SRV): the same
 *  choices the map's Level II velocity and SRV are drawn with, so the three
 *  agree. None for other moments and for Brazilian radars. */
export function velocityParams(site: string | null | undefined, fam: string): Record<string, string> {
  if (isBrazilSite(site) || (fam !== "G" && fam !== "S")) return {};
  return fam === "S" ? { dealias: dealiasAlg(), motion: motionParam() } : { dealias: dealiasAlg() };
}

/** Is this the derived Level II SRV (the one whose storm motion is ours)? */
export const isLevel2Srv = (product: string | null | undefined) => !!product && /^L2S[0-9A-Z]$/.test(product);

const RF_LINE = /^[ \t]*RF[ \t]*:.*$/gim;
const RF_DEFAULT = "RF: 128 0 208";

/** A velocity palette with the RF colour on or off, following the setting.
 *  Other kinds pass through untouched. */
export function rangeFoldedPal(kind: string, pal: string | null): string | null {
  if (pal === null || (kind !== "vel" && kind !== "srv")) return pal;
  const has = /^[ \t]*RF[ \t]*:/im.test(pal);
  if (getSetting<boolean>("radar.showRangeFolded")) return has ? pal : `${pal.replace(/\s*$/, "")}\n${RF_DEFAULT}\n`;
  return has ? pal.replace(RF_LINE, "") : pal;
}

/** Calls `cb` (debounced) whenever one of the velocity options changes. */
export function onRadarOptionsChange(cb: () => void, waitMs = 250): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pick = (values: Record<string, unknown>) => OPTION_KEYS.map((k) => String(values[k] ?? "")).join("|");
  return useSettingsStore.subscribe(
    (s) => pick(s.values),
    () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        cb();
      }, waitMs);
    },
  );
}
