// One line per radar product for the picker: the tooltip on its button and the
// note under its group once it is picked. Keyed by family id (the picker's
// list, /api/nexrad/meta "grids"), with a fallback by kind for families that
// only some radars have.

const BY_ID: Record<string, string> = {
  // Level III / Level II moments
  B: "How much power the precipitation sends back, in dBZ: heavier rain and hail read higher.",
  TZL: "A TDWR's long-range reflectivity: 300 m gates out to 417 km.",
  G: "Motion along the beam: green toward the radar, red away. Level III comes unfolded by the radar.",
  S: "The radar's own storm-relative velocity (Level III), with the NWS storm motion taken out, at three tilts.",
  R: "Normalized rotation: shear across the beam scaled for range. 1 is significant, 2.5 extreme.",
  L2C: "Correlation coefficient: how alike the targets in a gate are. Rain near 1, hail lower, debris well under 0.8.",
  L2X: "Differential reflectivity: target shape. Big flattened drops read high, tumbling hail near 0.",
  L2W: "Spectrum width: the spread of motion inside a gate. Turbulence and shear widen it.",
  K: "Specific differential phase: liquid water along the beam. Heavy rain cores stand out; hail barely shows.",
  L2P: "Differential phase: the shift built up through liquid water along the beam, in degrees.",
  L2F: "Clutter filter power: how much the radar's ground-clutter filter took out of each gate.",
  H: "Hydrometeor classification: the radar's best guess at what each gate holds.",
  HHC: "Hybrid hydrometeor classification from the lowest clear tilt at each point.",
  EET: "Level III, the radar's own product: the height 18 dBZ reaches, in kft, interpolated between tilts. Loops and archive like any Level III product. The Derived group's Echo Tops reads every tilt of the Level II volume instead.",
  DVL: "Level III, the radar's own product: the water in the column, kg/m². Loops and archive like any Level III product. The Derived group's VIL builds it from every tilt of the Level II volume instead.",
  OHA: "Rain over the last hour, estimated by the radar.",
  DAA: "Rain over the last hour, estimated by the radar (dual-pol, digital).",
  DTA: "Rain since the event began, estimated by the radar.",
  // Derived from the Level II volume (backend/radar_derived.py)
  L2CREF: "The strongest echo at any tilt over each point, from this Level II volume.",
  L2ET: "Level II, every tilt: the highest beam centre with 18 dBZ or more, in kft above sea level. No guessing between tilts (the Level III Enhanced Echo Tops interpolates).",
  L2VIL: "Level II, every tilt: liquid water in the column, kg/m²; reflectivity capped at 56 dBZ so hail does not count as rain. Level III's VIL is the radar's own.",
  L2DVIL: "VIL over the depth of the echo, g/m³. 3.5 and up is the classic severe-hail signal.",
  L2VROT: "Half the velocity difference across about 5 km, kt. 40 kt is strong rotation, 60 kt can mean a tornado.",
  L2PTDS: "Tornado debris score, 0 to 100, from reflectivity, CC, ZDR, rotation and spectrum width. Over 90 is significant, 95 a detection.",
  L2S: "Storm-relative velocity at every tilt: unfolded Level II velocity minus the storm motion set under Velocity.",
};

/** The same products as an airport radar has them (backend/tdwr.py). */
const TDWR_BY_ID: Record<string, string> = {
  B: "How much power the precipitation sends back, in dBZ, in 150 m gates out to 89 km. An airport radar's C-band beam weakens behind heavy rain.",
  G: "Motion along the beam, in 150 m gates out to 89 km: green toward the radar, red away. A TDWR folds often: purple is range folded, and strong winds can alias.",
  TZL: "The TDWR's long-range scan: reflectivity in 300 m gates out to 417 km at its lowest tilt, with no velocity behind it.",
  EET: "Level III, the radar's own product: the height the echo reaches, in kft, in 4 km boxes. The NWS feed keeps about a day of it; older days only until 2023.",
  DVL: "Level III, the radar's own product: the water in the column, kg/m², in 16 levels and 4 km boxes.",
};

const BY_KIND: Record<string, string> = {
  ref: BY_ID.B,
  vel: BY_ID.G,
  srv: "Velocity with the storm's own motion taken out, so rotation stands out.",
  cc: BY_ID.L2C,
  zdr: BY_ID.L2X,
  sw: BY_ID.L2W,
  kdp: BY_ID.K,
  phi: BY_ID.L2P,
  cfp: BY_ID.L2F,
  hca: BY_ID.H,
  tops: "The height the echo reaches, in kft.",
  vil: "The water in the column, kg/m².",
  precip: BY_ID.OHA,
  rate: "Rain rate estimated from dual-pol, per hour.",
  mehs: "The largest hail the column likely holds.",
  posh: "Probability of severe hail.",
};

export function productDescription(id: string, kind: string, tdwr = false): string | null {
  return (tdwr ? TDWR_BY_ID[id] : undefined) ?? BY_ID[id] ?? BY_KIND[kind] ?? null;
}
