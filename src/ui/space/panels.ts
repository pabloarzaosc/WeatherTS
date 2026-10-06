/**
 * The charts more than one tab draws, built the same way everywhere: the
 * X-ray flux with its flare classes, protons with the S scale, Kp with the G
 * scale, the solar wind.
 */
import type { KpBar, Series, SolarWind } from "../../lib/space/data";
import { flareClass } from "../../lib/space/data";
import type { ChartPanel, ChartSeries } from "./TimeStack";
import { C, RAMP, SCALE_COLORS, kpColor, kpText } from "./common";

const tint = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

export function xrayPanel(short: Series | null, long: Series | null, extra?: ChartSeries[]): ChartPanel {
  return {
    id: "xray",
    title: "GOES X-ray flux",
    units: "W/m²",
    log: true,
    y: [1e-9, 1e-2],
    weight: 1.4,
    fmt: (v) => `${v.toExponential(1)} ${flareClass(v)}`,
    bands: [
      { from: 1e-8, to: 1e-7, color: "rgba(127,127,127,0.03)", label: "A" },
      { from: 1e-7, to: 1e-6, color: "rgba(127,127,127,0.06)", label: "B" },
      { from: 1e-6, to: 1e-5, color: tint("#f6eb14", 0.05), label: "C" },
      { from: 1e-5, to: 1e-4, color: tint("#ff9600", 0.07), label: "M" },
      { from: 1e-4, to: 1e-2, color: tint("#ff0000", 0.07), label: "X" },
    ],
    lines: [
      { y: 1e-5, color: SCALE_COLORS[1], label: "R1" },
      { y: 5e-5, color: SCALE_COLORS[2], label: "R2" },
      { y: 1e-4, color: SCALE_COLORS[3], label: "R3" },
      { y: 1e-3, color: SCALE_COLORS[4], label: "R4" },
    ],
    series: [
      ...(long ? [{ label: "0.1-0.8 nm", color: C.xlong, data: long, width: 1.6 }] : []),
      ...(short ? [{ label: "0.05-0.4 nm", color: C.xshort, data: short }] : []),
      ...(extra ?? []),
    ],
    empty: "No X-ray data",
  };
}

const PROTON_ORDER = [">=1 MeV", ">=5 MeV", ">=10 MeV", ">=30 MeV", ">=50 MeV", ">=60 MeV", ">=100 MeV", ">=500 MeV"];

export function protonPanel(chans: Map<string, Series> | null, kind: "integral" | "differential" = "integral"): ChartPanel {
  const keys = chans ? [...chans.keys()] : [];
  const ordered =
    kind === "integral"
      ? PROTON_ORDER.filter((k) => keys.includes(k))
      : keys.sort((a, b) => Number(a.split(" ")[1].split("-")[0]) - Number(b.split(" ")[1].split("-")[0]));
  return {
    id: `protons-${kind}`,
    title: kind === "integral" ? "GOES integral protons" : "GOES differential protons",
    units: kind === "integral" ? "pfu" : "p/(cm² s sr keV)",
    log: true,
    weight: 1.2,
    include: kind === "integral" ? [1e-1, 1e2] : undefined,
    lines:
      kind === "integral"
        ? [
            { y: 10, color: SCALE_COLORS[1], label: "S1" },
            { y: 100, color: SCALE_COLORS[2], label: "S2" },
            { y: 1e3, color: SCALE_COLORS[3], label: "S3" },
            { y: 1e4, color: SCALE_COLORS[4], label: "S4" },
            { y: 1e5, color: SCALE_COLORS[5], label: "S5" },
          ]
        : [],
    series: ordered.map((k, i) => ({
      label: kind === "integral" ? k.replace(">=", "≥") : k.replace(/ (\d+)-(\d+) keV/, (_, a, b) => ` ${(+a / 1000).toFixed(1)}-${(+b / 1000).toFixed(0)} MeV`),
      color: kind === "integral" && k === ">=10 MeV" ? C.p10 : RAMP[(i * 3 + 1) % RAMP.length],
      data: chans!.get(k)!,
      width: k === ">=10 MeV" ? 1.8 : 1.1,
      off: kind === "integral" ? ![">=10 MeV", ">=50 MeV", ">=100 MeV"].includes(k) : i % 3 !== 0,
    })),
    fmt: (v) => (v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toExponential(1)),
    empty: "No proton data",
  };
}

export function electronPanel(chans: Map<string, Series> | null): ChartPanel {
  const s = chans?.get(">=2 MeV");
  return {
    id: "electrons",
    title: "GOES integral electrons",
    units: "pfu",
    log: true,
    include: [1, 1e4],
    lines: [{ y: 1000, color: SCALE_COLORS[2], label: "Alert" }],
    series: s ? [{ label: "≥2 MeV", color: "#36c5a0", data: s }] : [],
    fmt: (v) => (v >= 100 ? v.toFixed(0) : v.toFixed(1)),
    empty: "No electron data",
  };
}

export function epamPanel(chans: Map<string, Series> | null): ChartPanel {
  const keys = chans ? [...chans.keys()] : [];
  return {
    id: "epam",
    title: "ACE EPAM low-energy particles",
    units: "p/(cm² s sr MeV)",
    log: true,
    series: keys.map((k, i) => ({ label: k, color: RAMP[(i * 2) % RAMP.length], data: chans!.get(k)!, width: 1.1 })),
    fmt: (v) => v.toExponential(1),
    empty: "No EPAM data",
  };
}

export function kpPanel(bars: KpBar[] | null, lines: ChartSeries[] = [], weight = 1.2): ChartPanel {
  const pick = (kind: KpBar["kind"]): Series => {
    const b = (bars ?? []).filter((x) => x.kind === kind);
    return { t: Float64Array.from(b.map((x) => x.t)), v: Float64Array.from(b.map((x) => x.kp)) };
  };
  return {
    id: "kp",
    title: "Planetary K index",
    units: "Kp",
    y: [0, 9],
    step: 1,
    weight,
    tickFmt: (v) => String(v),
    bands: [
      { from: 5, to: 6, color: tint(SCALE_COLORS[1], 0.06), label: "G1" },
      { from: 6, to: 7, color: tint(SCALE_COLORS[2], 0.06), label: "G2" },
      { from: 7, to: 8, color: tint(SCALE_COLORS[3], 0.07), label: "G3" },
      { from: 8, to: 9, color: tint(SCALE_COLORS[4], 0.07), label: "G4" },
    ],
    series: [
      { label: "Observed", color: "#4caf50", kind: "bars", barMs: 3 * 3_600_000, data: pick("observed"), colorOf: (v) => kpColor(v), fmt: kpText },
      { label: "Estimated", color: "#9aa4b2", kind: "bars", barMs: 3 * 3_600_000, data: pick("estimated"), colorOf: (v) => tint(kpColor(v), 0.65), fmt: kpText },
      { label: "Predicted", color: "#6c7686", kind: "bars", barMs: 3 * 3_600_000, data: pick("predicted"), colorOf: (v) => tint(kpColor(v), 0.35), fmt: kpText },
      ...lines,
    ],
  };
}

/** The interplanetary field, the angle it points, density, speed, temperature. */
export function windPanels(sw: SolarWind | null, compact = false): ChartPanel[] {
  const e: Series = { t: new Float64Array(), v: new Float64Array() };
  const field: ChartPanel = {
    id: "imf",
    title: "Interplanetary magnetic field (GSM)",
    units: "nT",
    symmetric: true,
    weight: 1.4,
    lines: [{ y: 0, color: "rgba(150,150,150,0.6)", dash: [2, 3] }],
    series: [
      { label: "Bt", color: C.bt, data: sw?.bt ?? e, width: 1.5 },
      { label: "Bz", color: C.bz, data: sw?.bz ?? e, width: 1.5 },
      { label: "By", color: C.by, data: sw?.by ?? e, off: true },
      { label: "Bx", color: C.bx, data: sw?.bx ?? e, off: true },
    ],
    fmt: (v) => v.toFixed(1),
  };
  const phi: ChartPanel = {
    id: "phi",
    title: "Field angle phi (GSM)",
    units: "deg",
    y: [0, 360],
    weight: 0.6,
    tickFmt: (v) => String(v),
    series: [{ label: "Phi", color: C.phi, data: sw?.phi ?? e, kind: "dots" }],
    fmt: (v) => `${v.toFixed(0)}°`,
  };
  const dens: ChartPanel = {
    id: "density",
    title: "Density",
    units: "p/cm³",
    include: [0],
    series: [{ label: "Density", color: C.density, data: sw?.density ?? e }],
    fmt: (v) => v.toFixed(2),
  };
  const speed: ChartPanel = {
    id: "speed",
    title: "Speed",
    units: "km/s",
    include: [300, 500],
    lines: [
      { y: 500, color: "rgba(255,150,0,0.55)", label: "500" },
      { y: 700, color: "rgba(255,0,0,0.55)", label: "700" },
    ],
    series: [{ label: "Speed", color: C.speed, data: sw?.speed ?? e }],
    fmt: (v) => v.toFixed(0),
  };
  const temp: ChartPanel = {
    id: "temp",
    title: "Temperature",
    units: "K",
    log: true,
    series: [{ label: "Temperature", color: C.temp, data: sw?.temp ?? e }],
    fmt: (v) => `${(v / 1000).toFixed(0)}k`,
  };
  return compact ? [field, speed] : [field, phi, dens, speed, temp];
}
