import type { SoundingMeta, SoundingParams } from "./soundingApi";

export interface SoundingSummarySection {
  id: string;
  title: string;
  text: string;
  facts: Array<{ label: string; value: string }>;
}

export interface SoundingSummary {
  station: string;
  date: string;
  level: "Quiet" | "Marginal" | "Low" | "Moderate" | "High";
  color: string;
  threats: string[];
  sections: SoundingSummarySection[];
}

function n(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function fmt(value: number | null, digits = 0) {
  return value === null ? "--" : value.toFixed(digits);
}

function fact(label: string, value: number | null, unit = "", digits = 0) {
  return { label, value: `${fmt(value, digits)}${unit ? ` ${unit}` : ""}` };
}

export function generateSoundingSummary(params: SoundingParams, meta?: SoundingMeta): SoundingSummary {
  const sbCape = n(params.sbCape);
  const mlCape = n(params.mlCape);
  const muCape = n(params.muCape);
  const bestCape = Math.max(sbCape ?? 0, mlCape ?? 0, muCape ?? 0);
  const mlCin = n(params.mlCin);
  const mlLcl = n(params.mlLclM);
  const stp = n(params.stp);
  const scp = n(params.scp);
  const ship = n(params.ship);
  const dcp = n(params.dcp);
  const srh1 = n(params.srh1km);
  const bwd6 = n(params.bwd6km);
  const dcape = n(params.dcape);
  const pwat = n(params.pwat);
  const lr03 = n(params.lr03);
  const lr36 = n(params.lr36);

  let level: SoundingSummary["level"] = "Quiet";
  let color = "#6b7480";
  if ((stp ?? 0) >= 4 || ((scp ?? 0) >= 10 && bestCape >= 1500)) {
    level = "High";
    color = "#ef4444";
  } else if ((stp ?? 0) >= 1 || (ship ?? 0) >= 1.5 || (dcp ?? 0) >= 4) {
    level = "Moderate";
    color = "#f59e0b";
  } else if (bestCape >= 500 && (bwd6 ?? 0) >= 25) {
    level = "Low";
    color = "#22c55e";
  } else if (bestCape >= 100) {
    level = "Marginal";
    color = "#60a5fa";
  }

  const threats: string[] = [];
  if ((stp ?? 0) >= 1) threats.push((stp ?? 0) >= 4 ? "Significant tornadoes" : "Tornado potential");
  if ((ship ?? 0) >= 1) threats.push("Large hail");
  if ((dcp ?? 0) >= 2 || ((dcape ?? 0) >= 900 && (bwd6 ?? 0) >= 25)) threats.push("Damaging wind");
  if ((pwat ?? 0) >= 40) threats.push("Flash flooding");
  if (params.precipType && params.precipType !== "N/A" && params.precipType !== "Rain") {
    threats.push(String(params.precipType));
  }
  for (const hazard of params.hazards ?? []) {
    const label = `${hazard.level} ${hazard.type}`.toLowerCase();
    if (!threats.some((item) => item.toLowerCase() === label)) threats.push(`${hazard.level} ${hazard.type}`);
  }

  const sections: SoundingSummarySection[] = [];

  sections.push({
    id: "thermo",
    title: "Thermodynamics",
    text:
      bestCape < 100
        ? "The profile is mostly stable with weak buoyancy."
        : bestCape < 1000
          ? "Instability is present but not extreme; storm intensity depends strongly on forcing and shear."
          : bestCape < 2500
            ? "A substantial buoyancy reservoir can support strong updrafts if storms initiate."
            : "Large buoyancy supports intense updraft acceleration and high-end hail or wind production where storms remain organized.",
    facts: [fact("SBCAPE", sbCape, "J/kg"), fact("MLCAPE", mlCape, "J/kg"), fact("MUCAPE", muCape, "J/kg")],
  });

  sections.push({
    id: "cap",
    title: "Cap And Moisture",
    text:
      mlCin === null
        ? "Convective inhibition data is unavailable."
        : mlCin > -25
          ? "The cap is weak, so convection can initiate with modest lift."
          : mlCin > -125
            ? "A meaningful cap is present; focused lift is favored for discrete initiation."
            : "The cap is strong and may suppress convection unless forcing is robust.",
    facts: [fact("MLCIN", mlCin, "J/kg"), fact("MLLCL", mlLcl, "m"), fact("PWAT", pwat, "mm", 1)],
  });

  sections.push({
    id: "kinematics",
    title: "Kinematics",
    text:
      (bwd6 ?? 0) >= 45
        ? "Deep-layer shear strongly favors organized supercells or persistent line segments."
        : (bwd6 ?? 0) >= 30
          ? "Deep-layer shear is supportive of organized multicells and possible supercells."
          : "Deep-layer shear is limited, so convection is more likely to be pulse or loosely organized.",
    facts: [fact("0-1 km SRH", srh1, "m2/s2"), fact("0-6 km BWD", bwd6, "kt"), fact("STP", stp, "", 1)],
  });

  if (lr03 !== null || lr36 !== null || dcape !== null) {
    sections.push({
      id: "downdraft",
      title: "Lapse Rates And Downdrafts",
      text:
        (dcape ?? 0) >= 1000
          ? "Downdraft energy is strong enough for damaging outflow and microburst potential."
          : "Downdraft potential is more conditional and depends on storm depth, precipitation loading, and dry-air entrainment.",
      facts: [fact("LR 0-3", lr03, "C/km", 1), fact("LR 3-6", lr36, "C/km", 1), fact("DCAPE", dcape, "J/kg")],
    });
  }

  sections.push({
    id: "composites",
    title: "Composite Signals",
    text:
      (stp ?? 0) >= 1 || (scp ?? 0) >= 1 || (ship ?? 0) >= 1 || (dcp ?? 0) >= 1
        ? "Composite indices show at least one organized severe-weather signal."
        : "Composite indices remain below classic significant-severe thresholds.",
    facts: [fact("SCP", scp, "", 1), fact("SHIP", ship, "", 1), fact("DCP", dcp, "", 1)],
  });

  return {
    station: meta?.stationName || meta?.station || "Sounding",
    date: meta?.date || "",
    level,
    color,
    threats,
    sections,
  };
}
