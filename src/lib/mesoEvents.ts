// Days the mesoanalysis archive opens on in one click: outbreaks, landmark
// tornadoes and derechos since the archive begins (January 2005).
//
// `at` is the analysis hour nearest the event's peak (UTC): the hour a
// forecaster would have read the environment from. The archive opens the whole
// convective day around it (12Z to 11Z), so scrubbing reaches the hours either
// side. `radar` is the WSR-88D that saw it, for the days the app's radar
// archive reaches (March 2022 on).

export interface MesoEvent {
  id: string;
  name: string;
  /** Where, for the list's second line. */
  place: string;
  /** The analysis hour to open on, unix seconds (UTC). */
  at: number;
  /** Where to put the map: [lon, lat] and a zoom. */
  center: [number, number];
  zoom: number;
  /** The radar site (three letters, as the app names them) when the radar
   *  archive reaches the date. */
  radar?: string;
}

/** The first day the app's radar archive has (Level III, Unidata). */
export const RADAR_ARCHIVE_FROM = Date.UTC(2022, 2, 1) / 1000;

const utc = (y: number, m: number, d: number, h: number) => Date.UTC(y, m - 1, d, h) / 1000;

export const MESO_EVENTS: MesoEvent[] = [
  { id: "2025-london", name: "London, KY tornado", place: "Southeastern Kentucky", at: utc(2025, 5, 17, 4),
    center: [-84.1, 37.1], zoom: 6.6, radar: "JKL" },
  { id: "2025-stl", name: "St. Louis tornado", place: "Missouri and Illinois", at: utc(2025, 5, 16, 19),
    center: [-90.2, 38.6], zoom: 6.6, radar: "LSX" },
  { id: "2025-mar15", name: "Deep South high risk", place: "Mississippi and Alabama", at: utc(2025, 3, 15, 20),
    center: [-89.2, 32.6], zoom: 6.2, radar: "JAN" },
  { id: "2024-greenfield", name: "Greenfield, IA tornado", place: "Southwest Iowa", at: utc(2024, 5, 21, 20),
    center: [-94.5, 41.3], zoom: 6.6, radar: "DMX" },
  { id: "2024-marietta", name: "Sulphur and Marietta, OK tornadoes", place: "Southern Oklahoma", at: utc(2024, 4, 28, 3),
    center: [-97.0, 34.4], zoom: 6.6, radar: "TLX" },
  { id: "2024-elkhorn", name: "Elkhorn, NE tornado", place: "Omaha area", at: utc(2024, 4, 26, 20),
    center: [-96.2, 41.3], zoom: 6.6, radar: "OAX" },
  { id: "2023-wynne", name: "Little Rock and Wynne, AR tornadoes", place: "Central and eastern Arkansas",
    at: utc(2023, 3, 31, 20), center: [-91.6, 35.0], zoom: 6.4, radar: "LZK" },
  { id: "2023-rollingfork", name: "Rolling Fork, MS tornado", place: "Mississippi Delta", at: utc(2023, 3, 25, 1),
    center: [-90.9, 32.9], zoom: 6.6, radar: "DGX" },
  { id: "2021-mayfield", name: "Mayfield, KY tornado", place: "Western Kentucky", at: utc(2021, 12, 11, 3),
    center: [-88.6, 36.7], zoom: 6.4 },
  { id: "2020-derecho", name: "Iowa derecho", place: "Cedar Rapids, Iowa", at: utc(2020, 8, 10, 17),
    center: [-91.7, 42.0], zoom: 6.0 },
  { id: "2020-easter", name: "Easter outbreak", place: "Mississippi", at: utc(2020, 4, 12, 21),
    center: [-89.6, 31.6], zoom: 6.2 },
  { id: "2019-dayton", name: "Dayton, OH tornado", place: "Southwest Ohio", at: utc(2019, 5, 28, 3),
    center: [-84.2, 39.8], zoom: 6.6 },
  { id: "2016-katie", name: "Katie and Wynnewood, OK tornadoes", place: "South-central Oklahoma",
    at: utc(2016, 5, 9, 21), center: [-97.3, 34.6], zoom: 6.6 },
  { id: "2015-garland", name: "Garland and Rowlett, TX tornado", place: "Dallas area", at: utc(2015, 12, 27, 1),
    center: [-96.6, 32.9], zoom: 6.6 },
  { id: "2014-pilger", name: "Pilger, NE tornadoes", place: "Northeast Nebraska", at: utc(2014, 6, 16, 21),
    center: [-97.1, 42.0], zoom: 6.6 },
  { id: "2014-vilonia", name: "Vilonia, AR tornado", place: "Central Arkansas", at: utc(2014, 4, 28, 0),
    center: [-92.2, 35.1], zoom: 6.6 },
  { id: "2013-washington", name: "Washington, IL tornado", place: "Central Illinois", at: utc(2013, 11, 17, 17),
    center: [-89.4, 40.7], zoom: 6.4 },
  { id: "2013-elreno", name: "El Reno, OK tornado", place: "Central Oklahoma", at: utc(2013, 5, 31, 23),
    center: [-98.0, 35.5], zoom: 6.6 },
  { id: "2013-moore", name: "Moore, OK tornado", place: "Oklahoma City area", at: utc(2013, 5, 20, 20),
    center: [-97.5, 35.3], zoom: 6.6 },
  { id: "2012-derecho", name: "June 2012 derecho", place: "Ohio Valley to the Mid-Atlantic", at: utc(2012, 6, 29, 21),
    center: [-82.5, 39.5], zoom: 5.4 },
  { id: "2012-apr14", name: "Plains high risk", place: "Kansas and Oklahoma", at: utc(2012, 4, 14, 22),
    center: [-98.0, 37.4], zoom: 5.8 },
  { id: "2012-henryville", name: "Henryville, IN tornado", place: "Southern Indiana", at: utc(2012, 3, 2, 19),
    center: [-85.8, 38.5], zoom: 6.4 },
  { id: "2011-may24", name: "May 24 Oklahoma outbreak", place: "Central Oklahoma", at: utc(2011, 5, 24, 21),
    center: [-97.9, 35.5], zoom: 6.4 },
  { id: "2011-joplin", name: "Joplin, MO tornado", place: "Southwest Missouri", at: utc(2011, 5, 22, 22),
    center: [-94.5, 37.1], zoom: 6.6 },
  { id: "2011-apr27", name: "April 27 Super Outbreak", place: "Mississippi, Alabama, Tennessee", at: utc(2011, 4, 27, 21),
    center: [-87.6, 33.9], zoom: 5.8 },
  { id: "2010-yazoo", name: "Yazoo City, MS tornado", place: "Central Mississippi", at: utc(2010, 4, 24, 17),
    center: [-90.4, 32.9], zoom: 6.4 },
  { id: "2008-parkersburg", name: "Parkersburg, IA tornado", place: "Northeast Iowa", at: utc(2008, 5, 25, 22),
    center: [-92.8, 42.6], zoom: 6.6 },
  { id: "2008-supertuesday", name: "Super Tuesday outbreak", place: "Arkansas and Tennessee", at: utc(2008, 2, 6, 0),
    center: [-89.0, 35.6], zoom: 5.8 },
  { id: "2007-greensburg", name: "Greensburg, KS tornado", place: "South-central Kansas", at: utc(2007, 5, 5, 3),
    center: [-99.3, 37.6], zoom: 6.6 },
];
