// The full model + variable catalog browsed in the left "Models" panel.
// Ordered arrays (not plain objects) so the UI renders sections/groups in the
// exact order given. Item labels can repeat across groups, so selections are
// keyed by a composite id (section::group::item) built by productId().

export interface CatalogGroup {
  label: string;
  items: string[];
}
export interface CatalogSection {
  label: string;
  groups: CatalogGroup[];
}

export function productId(section: string, group: string, item: string): string {
  return `${section}::${group}::${item}`;
}

export const MODEL_CATALOG: CatalogSection[] = [
  {
    label: "Global",
    groups: [
      { label: "USA", items: ["GFS"] },
      { label: "EUROPEAN", items: ["ARPEGE", "ECMWF"] },
      { label: "CANADIAN", items: ["GDPS"] },
    ],
  },
  {
    label: "Regional",
    groups: [
      { label: "USA", items: ["NAM", "RAP"] },
      { label: "EUROPEAN", items: ["ARPEGE EU", "ICON-EU"] },
      { label: "CANADIAN", items: ["RGEM"] },
    ],
  },
  {
    label: "Mesoscale",
    groups: [
      {
        label: "USA",
        items: [
          "GSL MPAS-RRFSA",
          "HRRR",
          "HRRR CAST",
          "HRW FV3",
          "NAM 3KM CONUS",
          "RRFS A",
          "WRF-ARW",
          "WRF-ARW2",
        ],
      },
      { label: "EUROPEAN", items: ["ARPEGE 1KM", "ARPEGE 2.5KM", "ICON-D2"] },
      { label: "SUB-HOURLY", items: ["HRRR SUB-HOUR", "RRFS SUB-HOUR"] },
      { label: "CANADIAN", items: ["HRDPS"] },
    ],
  },
  {
    label: "AI",
    groups: [
      { label: "ENSEMBLE", items: ["AI GEFS", "HYBRID GEFS"] },
      { label: "GLOBAL", items: ["AI GFS", "ECMWF-AIFS"] },
    ],
  },
  {
    label: "Ensemble",
    groups: [{ label: "USA", items: ["GEFS", "HREF", "NBM", "REFS"] }],
  },
  {
    label: "Hurricane",
    groups: [{ label: "Models", items: ["HAFS-A", "HAFS-B", "HMON", "HWRF"] }],
  },
];

export const VARIABLE_CATALOG: CatalogSection[] = [
  {
    label: "Precipitation",
    groups: [
      {
        label: "QPF",
        items: [
          "3 Hour Precipitation",
          "6 Hour Precipitation",
          "12 Hour Precipitation",
          "24 Hour Precipitation",
          "48 Hour Precipitation",
          "Average Precipitation Rate 6hr",
          "Total Precipitation",
        ],
      },
      {
        label: "RADAR",
        items: [
          "1km Base Reflectivity",
          "Composite Reflectivity",
          "Composite Reflectivity 0-3 km UH Tracks",
          "Precipitation Type Reflectivity",
        ],
      },
      { label: "THERMODYNAMICS", items: ["PWAT", "PWAT Anomaly"] },
    ],
  },
  {
    label: "Surface",
    groups: [
      {
        label: "TEMPERATURE",
        items: [
          "2m Apparent Temperature",
          "2m Temperature",
          "6 Hour 2m Temperature Maximum",
          "6 Hour 2m Temperature Minimum",
          "12 Hour 2m Temperature Change",
          "12 Hour 2m Temperature Maximum",
          "12 Hour 2m Temperature Minimum",
          "24 Hour 2m Temperature Change",
          "24 Hour 2m Temperature Maximum",
          "24 Hour 2m Temperature Minimum",
          "2m Temperature Anomaly",
          "6 Hour 2m Temperature Change",
        ],
      },
      {
        label: "THERMODYNAMICS",
        items: [
          "2m Dewpoint",
          "2m Theta-E",
          "2m Theta-E Advection",
          "2m Wet Bulb Temperature",
          "Surface Mixing Ratio",
        ],
      },
      { label: "WIND", items: ["10m Wind", "10m Wind Gusts", "Accumulated 10m Wind Gusts"] },
      { label: "PRESSURE", items: ["6 Hour Mean Sea Level Pressure Change", "MSLP Anomaly"] },
      { label: "MOISTURE", items: ["2m Relative Humidity", "Visibility"] },
      { label: "FORCING", items: ["Surface Relative Vorticity"] },
    ],
  },
  {
    label: "Upper-Air",
    groups: [
      {
        label: "TEMPERATURE",
        items: [
          "500mb Temperature, Height, Wind",
          "700mb Temperature, Height, Wind",
          "850mb Temperature, Height, Wind",
          "925mb Temperature, Height, Wind",
          "Cloud Top Temperature",
          "Max Sfc-500mb Temperature",
          "Simulated IR-Brightness Temperature",
          "Tropopause Pressure",
          "Tropopause Temperature",
        ],
      },
      {
        label: "WIND",
        items: [
          "200mb Height, Wind",
          "300mb Height, Wind",
          "500mb Height, Wind",
          "700mb Height, Wind",
          "850mb Height, Wind",
          "925mb Height, Wind",
        ],
      },
      {
        label: "DIVERGENCE",
        items: [
          "200mb Divergence",
          "200mb Q-Divergence",
          "500mb Q-Divergence",
          "850mb Divergence",
          "850mb Q-Divergence",
        ],
      },
      {
        label: "VORTICITY",
        items: [
          "200mb Vorticity",
          "300mb Vorticity",
          "500mb absolute vorticity",
          "500mb Vorticity",
          "700mb Vorticity",
          "850mb Vorticity",
        ],
      },
      {
        label: "CLOUDS",
        items: [
          "Cloud Cover Levels",
          "High Cloud Cover",
          "Low Cloud Cover",
          "Middle Cloud Cover",
          "Total Cloud Cover",
        ],
      },
      {
        label: "RELATIVE HUMIDITY",
        items: [
          "500mb Relative Humidity",
          "700mb Relative Humidity",
          "850mb Relative Humidity",
          "925mb Relative Humidity",
          "Mean 700-300mb RH",
        ],
      },
      {
        label: "MOISTURE TRANSPORT",
        items: [
          "500mb Moisture Transport",
          "700mb Moisture Transport",
          "850mb Moisture Transport",
          "925mb Moisture Transport",
          "Integrated Water Vapor Transport",
        ],
      },
      {
        label: "FORCING",
        items: [
          "200mb Okubo-Weiss Axis",
          "400-700mb Differential Positive Vorticity Advection",
          "500mb Okubo-Weiss Axis",
          "850mb Okubo-Weiss Axis",
        ],
      },
      {
        label: "VERTICAL VELOCITY",
        items: [
          "500mb Vertical Velocity",
          "700mb Vertical Velocity",
          "850mb Vertical Velocity",
          "925mb Vertical Velocity",
        ],
      },
      { label: "OMEGA", items: ["500mb Omega", "700mb Omega", "850mb Omega", "925mb Omega"] },
      { label: "2PVU", items: ["2PVU Pressure, Wind", "2PVU Theta, Wind", "2PVU Wind"] },
      { label: "DEWPOINT", items: ["700mb Dewpoint", "850mb Dewpoint", "925mb Dewpoint"] },
      { label: "HEIGHT", items: ["12 Hour 500mb Height Tendency", "500mb Height Anomaly"] },
      {
        label: "TEMPERATURE ADVECTION",
        items: ["700mb Temp Advection, FGEN", "850mb Temp Advection, FGEN"],
      },
      { label: "ADVECTION", items: ["400-700mb Differential Positive Vorticity Advection"] },
    ],
  },
  {
    label: "Severe",
    groups: [
      {
        label: "WIND SHEAR",
        items: [
          "0-3km Bulk Shear",
          "3km Storm Relative Helicity",
          "Sfc-500mb Bulk Shear",
          "Sfc-700mb Bulk Shear",
          "Sfc-850mb Bulk Shear",
          "Sfc-925mb Bulk Shear",
        ],
      },
      {
        label: "COMPOSITE",
        items: ["3km Energy Helicity Index", "Significant Tornado Parameter", "Supercell Composite"],
      },
      { label: "CAPE", items: ["Mixed Layer CAPE", "Most Unstable CAPE", "Surface Based CAPE"] },
      { label: "CIN", items: ["Mixed-Layer CIN", "Most Unstable CIN", "Surface Based CIN"] },
      { label: "LAPSE RATE", items: ["0-3km Lapse Rate", "700-500mb Lapse Rate"] },
      { label: "SEVERE", items: ["Planetary Boundary Layer Height"] },
      { label: "INSTABILITY", items: ["Surface Lifted Index"] },
      { label: "PARCEL", items: ["Surface Based LCL Height"] },
      { label: "STORM MOTION", items: ["Native Storm Motion"] },
    ],
  },
  {
    label: "Winter",
    groups: [
      {
        label: "SNOW [10:1]",
        items: [
          "Snowfall 3 Hour [10:1]",
          "Snowfall 6 Hour [10:1]",
          "Snowfall 12 Hour [10:1]",
          "Snowfall 24 Hour [10:1]",
          "Snowfall 48 Hour [10:1]",
          "Snowfall Total [10:1]",
        ],
      },
      {
        label: "SNOW [KUCHERA]",
        items: [
          "Snowfall 3 Hour [Kuchera]",
          "Snowfall 6 Hour [Kuchera]",
          "Snowfall 12 Hour [Kuchera]",
          "Snowfall 24 Hour [Kuchera]",
          "Snowfall Total [Kuchera]",
        ],
      },
      { label: "TEMPERATURE", items: ["Dendritic Growth Zone Depth", "Highest Freezing Level"] },
      { label: "FREEZING RAIN", items: ["Total Freezing Rain [FRAM]", "Total Freezing Rain [QPF]"] },
      { label: "SNOW DEPTH", items: ["Snow Depth", "Snowfall Total [Depth Change]"] },
      { label: "SLEET", items: ["Total Sleet"] },
    ],
  },
  {
    label: "Fire",
    groups: [
      {
        label: "MOISTURE",
        items: [
          "700mb Vapor Pressure Deficit",
          "850mb Vapor Pressure Deficit",
          "925mb Vapor Pressure Deficit",
          "Surface Vapor Pressure Deficit",
        ],
      },
      {
        label: "FIRE",
        items: [
          "Fosberg Index",
          "Hot, Dry, Windy Index",
          "Hot, Dry, Windy Index Anomaly",
          "Red Flag Threat Index",
        ],
      },
    ],
  },
  {
    label: "Tropical",
    groups: [
      { label: "INTENSITY", items: ["Maximum Potential Intensity", "Sea Surface Temperature"] },
    ],
  },
  {
    label: "Isentropic",
    groups: [
      {
        label: "PRESSURE",
        items: ["290k Pressure", "300k Pressure", "310k Pressure", "320k Pressure", "330k Pressure"],
      },
      {
        label: "ADVECTION",
        items: ["290K Pressure Advection", "310K Pressure Advection", "330K Pressure Advection"],
      },
      {
        label: "RELATIVE HUMIDITY",
        items: ["290k Relative Humidity", "310k Relative Humidity", "330k Relative Humidity"],
      },
      { label: "POTENTIAL VORTICITY", items: ["310K Potential Vorticity", "330K Potential Vorticity"] },
    ],
  },
];
