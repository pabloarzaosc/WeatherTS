// Notable radar events: one click opens the event's window on the radar that
// saw it, at its peak scan (src/store/useRadarEventStore.ts).
//
// Every window below was checked against the Level II archive on AWS
// (unidata-nexrad-level2): `volumes` is how many whole volume scans that radar
// has between `start` and `end`. Peak times were set from the NWS storm
// reports (IEM's archive of them) where those exist, else from the published
// landfall or touchdown time. `dvKt`, where present, is the strongest velocity
// couplet within 30 km of the place that WeatherTS's own detector
// (backend/radar_detect.py) finds in the peak volume or the one either side.
//
// Times are UTC. `site` is the app's three-letter radar id.

export type RadarEventCategory = "tornado" | "outbreak" | "hurricane" | "derecho" | "hail";

export interface RadarEvent {
  id: string;
  title: string;
  /** Where, for the list's second line and the search. */
  place: string;
  category: RadarEventCategory;
  site: string;
  /** The window, unix seconds (UTC). */
  start: number;
  end: number;
  /** The scan to open on. */
  peak: number;
  lat: number;
  lon: number;
  text: string;
  /** Level II volumes in the window, as listed in the archive. */
  volumes: number;
  /** Their size, MB. */
  mb: number;
  /** Strongest couplet near the place, knots (gate-to-gate dV). */
  dvKt?: number;
  /** When that couplet was scanned. */
  dvAt?: number;
}

const t = (s: string) => Date.parse(s) / 1000;

export const RADAR_EVENTS: RadarEvent[] = [
  { id: "1999-bridge-creek-moore", title: "Bridge Creek-Moore F5", place: "Bridge Creek and Moore, OK", category: "tornado",
    site: "TLX", start: t("1999-05-03T22:45Z"), end: t("1999-05-04T00:45Z"), peak: t("1999-05-03T23:55Z"),
    lat: 35.3, lon: -97.62, volumes: 21, mb: 48, dvKt: 107, dvAt: 925776147,
    text: "The worst of the May 3 outbreak: an F5 that crossed Bridge Creek and south Oklahoma City into Moore. A truck-mounted Doppler radar measured some of the fastest winds ever recorded near the ground inside it." },
  { id: "2003-moore", title: "Moore F4", place: "Moore and Midwest City, OK", category: "tornado",
    site: "TLX", start: t("2003-05-08T21:30Z"), end: t("2003-05-08T23:00Z"), peak: t("2003-05-08T22:15Z"),
    lat: 35.32, lon: -97.45, volumes: 18, mb: 29, dvKt: 109, dvAt: 1052432138,
    text: "Four years after 1999, another violent tornado tracked across Moore and the south side of the metro into Midwest City." },
  { id: "2004-hallam", title: "Hallam F4", place: "Hallam, NE", category: "tornado",
    site: "OAX", start: t("2004-05-23T00:30Z"), end: t("2004-05-23T02:30Z"), peak: t("2004-05-23T01:30Z"),
    lat: 40.54, lon: -96.79, volumes: 28, mb: 118, dvKt: 173, dvAt: 1085275484,
    text: "A tornado that grew to about 2.5 miles wide south of Lincoln and levelled most of the village of Hallam." },
  { id: "2005-evansville", title: "Evansville F3", place: "Evansville, IN", category: "tornado",
    site: "VWX", start: t("2005-11-06T07:00Z"), end: t("2005-11-06T08:30Z"), peak: t("2005-11-06T07:50Z"),
    lat: 37.95, lon: -87.5, volumes: 14, mb: 23,
    text: "A November tornado in the middle of the night that crossed the Ohio River from Kentucky and struck a mobile home park near Evansville." },
  { id: "2007-enterprise", title: "Enterprise EF4", place: "Enterprise, AL", category: "tornado",
    site: "EVX", start: t("2007-03-01T18:30Z"), end: t("2007-03-01T20:00Z"), peak: t("2007-03-01T19:08Z"),
    lat: 31.32, lon: -85.85, volumes: 18, mb: 35, dvKt: 94, dvAt: 1172775919,
    text: "A March tornado that struck Enterprise High School in southeast Alabama during the school day." },
  { id: "2007-greensburg", title: "Greensburg EF5", place: "Greensburg, KS", category: "tornado",
    site: "DDC", start: t("2007-05-05T01:30Z"), end: t("2007-05-05T03:30Z"), peak: t("2007-05-05T02:45Z"),
    lat: 37.6, lon: -99.29, volumes: 29, mb: 58, dvKt: 199, dvAt: 1178332911,
    text: "The first tornado rated EF5 on the then-new Enhanced Fujita scale. About 1.7 miles wide, it destroyed most of Greensburg late at night." },
  { id: "2008-picher", title: "Picher EF4", place: "Picher, OK", category: "tornado",
    site: "INX", start: t("2008-05-10T21:30Z"), end: t("2008-05-10T23:30Z"), peak: t("2008-05-10T22:40Z"),
    lat: 36.99, lon: -94.83, volumes: 29, mb: 49, dvKt: 148, dvAt: 1210459346,
    text: "An EF4 that tore through the old mining town of Picher in the far northeast corner of Oklahoma, then went on into southwest Missouri." },
  { id: "2008-parkersburg", title: "Parkersburg EF5", place: "Parkersburg, IA", category: "tornado",
    site: "DVN", start: t("2008-05-25T21:15Z"), end: t("2008-05-25T23:15Z"), peak: t("2008-05-25T21:56Z"),
    lat: 42.58, lon: -92.79, volumes: 27, mb: 38,
    text: "An EF5 that crossed Parkersburg and New Hartford in northeast Iowa, the state's first since 1976." },
  { id: "2009-lone-grove", title: "Lone Grove EF4", place: "Lone Grove, OK", category: "tornado",
    site: "TLX", start: t("2009-02-11T00:45Z"), end: t("2009-02-11T02:30Z"), peak: t("2009-02-11T01:28Z"),
    lat: 34.18, lon: -97.26, volumes: 26, mb: 129, dvKt: 96, dvAt: 1234315348,
    text: "A rare February EF4 that hit Lone Grove, west of Ardmore, after dark." },
  { id: "2010-yazoo-city", title: "Yazoo City EF4", place: "Yazoo City, MS", category: "tornado",
    site: "DGX", start: t("2010-04-24T16:00Z"), end: t("2010-04-24T18:00Z"), peak: t("2010-04-24T17:15Z"),
    lat: 32.86, lon: -90.41, volumes: 26, mb: 132, dvKt: 173, dvAt: 1272129270,
    text: "A long-tracked EF4 that ran on the ground across central Mississippi for well over a hundred miles, Yazoo City among the towns in its path." },
  { id: "2010-little-axe", title: "Norman-Little Axe EF4", place: "East of Norman, OK", category: "tornado",
    site: "TLX", start: t("2010-05-10T21:45Z"), end: t("2010-05-10T23:45Z"), peak: t("2010-05-10T22:40Z"),
    lat: 35.25, lon: -97.2, volumes: 28, mb: 121, dvKt: 141, dvAt: 1273531198,
    text: "One of two EF4s of a May afternoon outbreak in central Oklahoma, this one crossing Lake Thunderbird and Little Axe east of Norman." },
  { id: "2011-sanford", title: "Sanford EF3", place: "Sanford and Raleigh, NC", category: "tornado",
    site: "RAX", start: t("2011-04-16T18:30Z"), end: t("2011-04-16T20:30Z"), peak: t("2011-04-16T19:05Z"),
    lat: 35.48, lon: -79.18, volumes: 26, mb: 126, dvKt: 102, dvAt: 1302980639,
    text: "North Carolina's biggest tornado day in decades: this EF3 hit a home-improvement store in Sanford and went on into Raleigh." },
  { id: "2011-hackleburg", title: "Hackleburg-Phil Campbell EF5", place: "Northwest Alabama", category: "tornado",
    site: "HTX", start: t("2011-04-27T19:45Z"), end: t("2011-04-27T21:45Z"), peak: t("2011-04-27T20:25Z"),
    lat: 34.27, lon: -87.83, volumes: 26, mb: 179, dvKt: 114, dvAt: 1303936157,
    text: "The deadliest tornado of the April 27 Super Outbreak, an EF5 that tracked through Hackleburg and Phil Campbell and on across north Alabama." },
  { id: "2011-smithville", title: "Smithville EF5", place: "Smithville, MS", category: "tornado",
    site: "GWX", start: t("2011-04-27T20:00Z"), end: t("2011-04-27T21:30Z"), peak: t("2011-04-27T20:44Z"),
    lat: 34.07, lon: -88.39, volumes: 20, mb: 54, dvKt: 137, dvAt: 1303936963,
    text: "An EF5 on April 27 that destroyed much of the small town of Smithville in northeast Mississippi." },
  { id: "2011-tuscaloosa", title: "Tuscaloosa-Birmingham EF4", place: "Tuscaloosa, AL", category: "tornado",
    site: "BMX", start: t("2011-04-27T21:30Z"), end: t("2011-04-27T23:30Z"), peak: t("2011-04-27T22:12Z"),
    lat: 33.21, lon: -87.53, volumes: 24, mb: 122, dvKt: 125, dvAt: 1303941959,
    text: "A wide EF4 seen live on television as it crossed Tuscaloosa, then the western suburbs of Birmingham." },
  { id: "2011-joplin", title: "Joplin EF5", place: "Joplin, MO", category: "tornado",
    site: "SGF", start: t("2011-05-22T22:00Z"), end: t("2011-05-22T23:30Z"), peak: t("2011-05-22T22:42Z"),
    lat: 37.08, lon: -94.51, volumes: 19, mb: 75, dvKt: 132, dvAt: 1306104228,
    text: "A rain-wrapped EF5 that crossed the middle of Joplin on a Sunday evening, among the deadliest US tornadoes since modern records began." },
  { id: "2011-el-reno-piedmont", title: "El Reno-Piedmont EF5", place: "Canadian County, OK", category: "tornado",
    site: "TLX", start: t("2011-05-24T20:45Z"), end: t("2011-05-24T22:45Z"), peak: t("2011-05-24T21:40Z"),
    lat: 35.6, lon: -97.85, volumes: 28, mb: 152, dvKt: 198, dvAt: 1306273459,
    text: "One of several violent tornadoes around Oklahoma City on May 24: an EF5 that tracked from west of El Reno past Piedmont." },
  { id: "2011-springfield-ma", title: "Springfield EF3", place: "Springfield, MA", category: "tornado",
    site: "BOX", start: t("2011-06-01T19:45Z"), end: t("2011-06-01T21:45Z"), peak: t("2011-06-01T20:35Z"),
    lat: 42.1, lon: -72.59, volumes: 26, mb: 91, dvKt: 104, dvAt: 1306960847,
    text: "A New England tornado that crossed the Connecticut River into downtown Springfield and stayed on the ground for nearly 40 miles." },
  { id: "2012-harrisburg", title: "Harrisburg EF4", place: "Harrisburg, IL", category: "tornado",
    site: "PAH", start: t("2012-02-29T10:00Z"), end: t("2012-02-29T12:00Z"), peak: t("2012-02-29T10:55Z"),
    lat: 37.74, lon: -88.54, volumes: 26, mb: 117, dvKt: 100, dvAt: 1330512732,
    text: "A leap-day EF4 before dawn that struck the south side of Harrisburg in southern Illinois." },
  { id: "2012-henryville", title: "Henryville EF4", place: "Henryville, IN", category: "tornado",
    site: "LVX", start: t("2012-03-02T19:00Z"), end: t("2012-03-02T21:00Z"), peak: t("2012-03-02T20:05Z"),
    lat: 38.54, lon: -85.77, volumes: 26, mb: 131, dvKt: 153, dvAt: 1330718710,
    text: "An EF4 of the March 2 outbreak that crossed Henryville and Marysville north of Louisville." },
  { id: "2012-dfw", title: "Dallas-Fort Worth tornadoes", place: "Arlington and Lancaster, TX", category: "tornado",
    site: "FWS", start: t("2012-04-03T17:45Z"), end: t("2012-04-03T19:45Z"), peak: t("2012-04-03T18:20Z"),
    lat: 32.65, lon: -96.95, volumes: 27, mb: 157, dvKt: 111, dvAt: 1333477330,
    text: "An afternoon of tornadoes across the Dallas-Fort Worth metroplex, the video of tractor-trailers tossed in Lancaster seen around the world." },
  { id: "2012-woodward", title: "Woodward EF3", place: "Woodward, OK", category: "tornado",
    site: "VNX", start: t("2012-04-15T04:30Z"), end: t("2012-04-15T06:30Z"), peak: t("2012-04-15T05:20Z"),
    lat: 36.43, lon: -99.39, volumes: 26, mb: 354, dvKt: 99, dvAt: 1334466828,
    text: "A tornado after midnight at the end of the April 14 high-risk day that struck Woodward in northwest Oklahoma." },
  { id: "2013-shawnee", title: "Shawnee EF4", place: "Bethel Acres and Shawnee, OK", category: "tornado",
    site: "TLX", start: t("2013-05-19T22:30Z"), end: t("2013-05-20T00:00Z"), peak: t("2013-05-19T23:15Z"),
    lat: 35.31, lon: -97.05, volumes: 21, mb: 175, dvKt: 135, dvAt: 1369005274,
    text: "The day before Moore: an EF4 that touched down near Lake Thunderbird and crossed Bethel Acres to the north side of Shawnee." },
  { id: "2013-moore", title: "Moore EF5", place: "Moore, OK", category: "tornado",
    site: "TLX", start: t("2013-05-20T19:30Z"), end: t("2013-05-20T21:00Z"), peak: t("2013-05-20T20:16Z"),
    lat: 35.33, lon: -97.48, volumes: 21, mb: 196, dvKt: 165, dvAt: 1369081003,
    text: "An EF5 that crossed Newcastle and Moore close to the Oklahoma City radar, destroying two elementary schools." },
  { id: "2013-el-reno", title: "El Reno EF3", place: "El Reno, OK", category: "tornado",
    site: "TLX", start: t("2013-05-31T22:30Z"), end: t("2013-06-01T00:30Z"), peak: t("2013-05-31T23:10Z"),
    lat: 35.5, lon: -98.0, volumes: 26, mb: 275, dvKt: 150, dvAt: 1370042074,
    text: "The widest tornado on record, 2.6 miles across, with mobile-radar winds near 300 mph in its subvortices; storm researchers were among those it killed." },
  { id: "2013-washington", title: "Washington EF4", place: "Washington, IL", category: "tornado",
    site: "ILX", start: t("2013-11-17T16:15Z"), end: t("2013-11-17T17:45Z"), peak: t("2013-11-17T17:00Z"),
    lat: 40.7, lon: -89.41, volumes: 19, mb: 193, dvKt: 112, dvAt: 1384707794,
    text: "A November EF4 on a Sunday morning that crossed the town of Washington near Peoria." },
  { id: "2014-vilonia", title: "Mayflower-Vilonia EF4", place: "Vilonia, AR", category: "tornado",
    site: "LZK", start: t("2014-04-27T23:30Z"), end: t("2014-04-28T01:30Z"), peak: t("2014-04-28T00:50Z"),
    lat: 35.08, lon: -92.21, volumes: 25, mb: 304, dvKt: 174, dvAt: 1398645814,
    text: "An EF4 that crossed Mayflower and Vilonia north of Little Rock, three years after another tornado hit Vilonia." },
  { id: "2014-louisville-ms", title: "Louisville EF4", place: "Louisville, MS", category: "tornado",
    site: "GWX", start: t("2014-04-28T20:45Z"), end: t("2014-04-28T22:45Z"), peak: t("2014-04-28T21:36Z"),
    lat: 33.12, lon: -89.05, volumes: 24, mb: 261, dvKt: 107, dvAt: 1398720538,
    text: "The strongest tornado of the second day of the outbreak, an EF4 that crossed Louisville in east-central Mississippi." },
  { id: "2014-pilger", title: "Pilger twin tornadoes", place: "Pilger, NE", category: "tornado",
    site: "OAX", start: t("2014-06-16T20:00Z"), end: t("2014-06-16T22:00Z"), peak: t("2014-06-16T20:55Z"),
    lat: 41.99, lon: -97.06, volumes: 23, mb: 267, dvKt: 106, dvAt: 1402951985,
    text: "Two EF4 tornadoes side by side from one supercell, the first of them destroying much of Pilger." },
  { id: "2015-fairdale", title: "Rochelle-Fairdale EF4", place: "Fairdale, IL", category: "tornado",
    site: "LOT", start: t("2015-04-09T23:00Z"), end: t("2015-04-10T01:00Z"), peak: t("2015-04-09T23:45Z"),
    lat: 42.11, lon: -88.9, volumes: 25, mb: 268, dvKt: 127, dvAt: 1428623395,
    text: "An EF4 west of Chicago that crossed Interstate 39 near Rochelle and destroyed most of tiny Fairdale." },
  { id: "2015-garland", title: "Garland-Rowlett EF4", place: "Garland, TX", category: "tornado",
    site: "FWS", start: t("2015-12-27T00:00Z"), end: t("2015-12-27T02:00Z"), peak: t("2015-12-27T00:46Z"),
    lat: 32.91, lon: -96.64, volumes: 23, mb: 255, dvKt: 90, dvAt: 1451177634,
    text: "A December tornado after dark that crossed Interstate 30 in Garland, where most of the deaths were in vehicles." },
  { id: "2016-katie", title: "Katie-Wynnewood EF4", place: "South-central OK", category: "tornado",
    site: "TLX", start: t("2016-05-09T20:30Z"), end: t("2016-05-09T22:30Z"), peak: t("2016-05-09T21:05Z"),
    lat: 34.62, lon: -97.33, volumes: 19, mb: 253, dvKt: 118, dvAt: 1462828302,
    text: "One of several tornadoes of May 9 in south-central Oklahoma, an EF4 north of Katie." },
  { id: "2017-albany", title: "Albany EF3", place: "Albany, GA", category: "tornado",
    site: "TLH", start: t("2017-01-22T19:45Z"), end: t("2017-01-22T21:45Z"), peak: t("2017-01-22T20:22Z"),
    lat: 31.58, lon: -84.15, volumes: 19, mb: 220, dvKt: 104, dvAt: 1485116004,
    text: "A January wedge that crossed south Albany, part of a two-day winter outbreak across the Southeast." },
  { id: "2019-beauregard", title: "Beauregard EF4", place: "Lee County, AL", category: "tornado",
    site: "MXX", start: t("2019-03-03T19:30Z"), end: t("2019-03-03T21:00Z"), peak: t("2019-03-03T20:05Z"),
    lat: 32.55, lon: -85.38, volumes: 14, mb: 251, dvKt: 115, dvAt: 1551643676,
    text: "A March EF4 through rural Lee County southeast of Auburn, Alabama's deadliest tornado since 2011." },
  { id: "2019-dayton", title: "Dayton EF4", place: "Trotwood and Dayton, OH", category: "tornado",
    site: "ILN", start: t("2019-05-28T02:00Z"), end: t("2019-05-28T04:00Z"), peak: t("2019-05-28T02:55Z"),
    lat: 39.83, lon: -84.27, volumes: 20, mb: 348, dvKt: 146, dvAt: 1559011917,
    text: "One of many tornadoes around Dayton that night; this EF4 crossed Trotwood and the north side of the city before midnight local time." },
  { id: "2020-nashville", title: "Nashville EF3", place: "Nashville, TN", category: "tornado",
    site: "OHX", start: t("2020-03-03T05:30Z"), end: t("2020-03-03T07:30Z"), peak: t("2020-03-03T06:40Z"),
    lat: 36.17, lon: -86.75, volumes: 19, mb: 287, dvKt: 206, dvAt: 1583217782,
    text: "A tornado after midnight across North Nashville, Germantown and East Nashville; its storm went on to produce an EF4 near Cookeville." },
  { id: "2020-bassfield", title: "Bassfield-Soso EF4", place: "South Mississippi", category: "tornado",
    site: "DGX", start: t("2020-04-12T20:30Z"), end: t("2020-04-12T22:30Z"), peak: t("2020-04-12T21:15Z"),
    lat: 31.5, lon: -89.75, volumes: 17, mb: 344, dvKt: 158, dvAt: 1586726282,
    text: "The Easter Sunday outbreak's widest tornado, about 2.25 miles across, crossing three counties of south Mississippi." },
  { id: "2021-newnan", title: "Newnan EF4", place: "Newnan, GA", category: "tornado",
    site: "FFC", start: t("2021-03-26T03:30Z"), end: t("2021-03-26T05:00Z"), peak: t("2021-03-26T04:12Z"),
    lat: 33.38, lon: -84.8, volumes: 14, mb: 208, dvKt: 92, dvAt: 1616731692,
    text: "A nighttime EF4 that crossed Newnan southwest of Atlanta just after midnight local time." },
  { id: "2021-mayfield", title: "Mayfield EF4", place: "Mayfield, KY", category: "tornado",
    site: "PAH", start: t("2021-12-11T02:30Z"), end: t("2021-12-11T04:30Z"), peak: t("2021-12-11T03:26Z"),
    lat: 36.74, lon: -88.64, volumes: 15, mb: 205, dvKt: 159, dvAt: 1639193379,
    text: "A December tornado on the ground for about 165 miles across Tennessee and western Kentucky, destroying downtown Mayfield." },
  { id: "2021-edwardsville", title: "Edwardsville EF3", place: "Edwardsville, IL", category: "tornado",
    site: "LSX", start: t("2021-12-11T01:45Z"), end: t("2021-12-11T03:15Z"), peak: t("2021-12-11T02:28Z"),
    lat: 38.8, lon: -89.96, volumes: 16, mb: 211, dvKt: 83, dvAt: 1639189634,
    text: "Part of the December 10 outbreak: an EF3 that collapsed a warehouse near Edwardsville, east of St. Louis." },
  { id: "2023-rolling-fork", title: "Rolling Fork EF4", place: "Rolling Fork, MS", category: "tornado",
    site: "DGX", start: t("2023-03-25T00:30Z"), end: t("2023-03-25T02:30Z"), peak: t("2023-03-25T01:05Z"),
    lat: 32.91, lon: -90.88, volumes: 19, mb: 278, dvKt: 150, dvAt: 1679706411,
    text: "A nighttime EF4 in the Mississippi Delta that destroyed much of Rolling Fork and went on to Silver City." },
  { id: "2023-little-rock", title: "Little Rock EF3", place: "Little Rock, AR", category: "tornado",
    site: "LZK", start: t("2023-03-31T18:45Z"), end: t("2023-03-31T20:45Z"), peak: t("2023-03-31T19:15Z"),
    lat: 34.76, lon: -92.35, volumes: 23, mb: 267, dvKt: 94, dvAt: 1680290535,
    text: "An afternoon tornado that crossed west and north Little Rock into North Little Rock and Jacksonville." },
  { id: "2024-elkhorn", title: "Elkhorn EF3", place: "Lincoln to Elkhorn, NE", category: "tornado",
    site: "OAX", start: t("2024-04-26T19:30Z"), end: t("2024-04-26T21:30Z"), peak: t("2024-04-26T20:45Z"),
    lat: 41.29, lon: -96.24, volumes: 20, mb: 283, dvKt: 132, dvAt: 1714164339,
    text: "An Arbor Day tornado that ran from Lincoln's northeast side to Elkhorn on Omaha's west edge." },
  { id: "2024-marietta", title: "Sulphur and Marietta tornadoes", place: "Southern Oklahoma", category: "tornado",
    site: "TLX", start: t("2024-04-28T02:00Z"), end: t("2024-04-28T04:00Z"), peak: t("2024-04-28T03:05Z"),
    lat: 34.3, lon: -97.0, volumes: 19, mb: 413,
    text: "A night of tornadoes in southern Oklahoma: one through downtown Sulphur and an EF4 near Marietta." },
  { id: "2024-barnsdall", title: "Barnsdall EF4", place: "Barnsdall, OK", category: "tornado",
    site: "INX", start: t("2024-05-07T02:00Z"), end: t("2024-05-07T04:00Z"), peak: t("2024-05-07T02:40Z"),
    lat: 36.56, lon: -96.16, volumes: 19, mb: 418, dvKt: 134, dvAt: 1715049222,
    text: "A nighttime EF4 that crossed Barnsdall, northwest of Tulsa, and went on toward Bartlesville." },
  { id: "2024-greenfield", title: "Greenfield EF4", place: "Greenfield, IA", category: "tornado",
    site: "DMX", start: t("2024-05-21T19:30Z"), end: t("2024-05-21T21:00Z"), peak: t("2024-05-21T20:45Z"),
    lat: 41.3, lon: -94.46, volumes: 13, mb: 252, dvKt: 90, dvAt: 1716324278,
    text: "An EF4 that crossed Greenfield in southwest Iowa, where a mobile radar measured winds of about 300 mph above the ground." },
  { id: "2025-st-louis", title: "St. Louis EF3", place: "St. Louis, MO", category: "tornado",
    site: "LSX", start: t("2025-05-16T18:30Z"), end: t("2025-05-16T20:30Z"), peak: t("2025-05-16T19:45Z"),
    lat: 38.65, lon: -90.25, volumes: 21, mb: 234, dvKt: 104, dvAt: 1747424607,
    text: "A mid-afternoon tornado across Forest Park and the north side of St. Louis, then into Illinois." },
  { id: "2025-london", title: "London EF4", place: "London, KY", category: "tornado",
    site: "JKL", start: t("2025-05-17T03:00Z"), end: t("2025-05-17T05:00Z"), peak: t("2025-05-17T03:50Z"),
    lat: 37.13, lon: -84.08, volumes: 21, mb: 396, dvKt: 91, dvAt: 1747453398,
    text: "Late the same night as St. Louis, a long-tracked EF4 crossed the London area of southeast Kentucky." },
  { id: "2008-super-tuesday", title: "Super Tuesday outbreak", place: "West Tennessee", category: "outbreak",
    site: "NQA", start: t("2008-02-05T23:00Z"), end: t("2008-02-06T03:00Z"), peak: t("2008-02-06T01:00Z"),
    lat: 35.55, lon: -89.2, volumes: 53, mb: 112, dvKt: 93, dvAt: 1202259306,
    text: "A winter outbreak across the Mid-South on the night of the presidential primaries; the Memphis radar watched long-lived supercells cross west Tennessee." },
  { id: "2012-apr14", title: "April 14 outbreak: Wichita", place: "Wichita, KS", category: "outbreak",
    site: "ICT", start: t("2012-04-15T02:30Z"), end: t("2012-04-15T04:30Z"), peak: t("2012-04-15T03:25Z"),
    lat: 37.6, lon: -97.35, volumes: 25, mb: 306, dvKt: 103, dvAt: 1334460398,
    text: "The night end of a rare day-ahead high-risk outlook: after supercells crossed central Kansas all afternoon, a tornado crossed the south side of Wichita near McConnell Air Force Base." },
  { id: "2025-mar15", title: "March 15 Deep South outbreak", place: "Mississippi", category: "outbreak",
    site: "DGX", start: t("2025-03-15T18:00Z"), end: t("2025-03-15T22:00Z"), peak: t("2025-03-15T19:00Z"),
    lat: 31.6, lon: -89.75, volumes: 32, mb: 715, dvKt: 105, dvAt: 1742065544,
    text: "Discrete supercells across south and central Mississippi under a high-risk outlook." },
  { id: "2004-charley", title: "Hurricane Charley", place: "Punta Gorda, FL", category: "hurricane",
    site: "TBW", start: t("2004-08-13T19:00Z"), end: t("2004-08-13T22:00Z"), peak: t("2004-08-13T20:45Z"),
    lat: 26.93, lon: -82.06, volumes: 35, mb: 81,
    text: "A small, fast-strengthening Category 4 whose tight eye came ashore at Cayo Costa and crossed Punta Gorda." },
  { id: "2004-ivan", title: "Hurricane Ivan", place: "Gulf Shores, AL", category: "hurricane",
    site: "MOB", start: t("2004-09-16T05:00Z"), end: t("2004-09-16T09:00Z"), peak: t("2004-09-16T06:50Z"),
    lat: 30.22, lon: -87.9, volumes: 57, mb: 200,
    text: "Ivan's landfall near Gulf Shores as a Category 3, its eyewall over Pensacola Bay and the I-10 bridge." },
  { id: "2005-dennis", title: "Hurricane Dennis", place: "Santa Rosa Island, FL", category: "hurricane",
    site: "EVX", start: t("2005-07-10T17:30Z"), end: t("2005-07-10T21:30Z"), peak: t("2005-07-10T19:25Z"),
    lat: 30.4, lon: -86.95, volumes: 54, mb: 131,
    text: "An early-season Category 3 landfall on Santa Rosa Island, close to the Eglin radar." },
  { id: "2005-katrina", title: "Hurricane Katrina", place: "Southeast Louisiana", category: "hurricane",
    site: "LIX", start: t("2005-08-29T08:00Z"), end: t("2005-08-29T12:00Z"), peak: t("2005-08-29T11:10Z"),
    lat: 29.3, lon: -89.6, volumes: 41, mb: 185,
    text: "Katrina's landfall near Buras as a large Category 3, seen from the Slidell radar east of New Orleans." },
  { id: "2005-wilma", title: "Hurricane Wilma", place: "Southwest Florida", category: "hurricane",
    site: "AMX", start: t("2005-10-24T09:00Z"), end: t("2005-10-24T13:00Z"), peak: t("2005-10-24T10:30Z"),
    lat: 25.9, lon: -81.7, volumes: 54, mb: 161,
    text: "Wilma's landfall near Cape Romano and its run across the Everglades toward Miami and Fort Lauderdale." },
  { id: "2008-ike", title: "Hurricane Ike", place: "Galveston, TX", category: "hurricane",
    site: "HGX", start: t("2008-09-13T05:00Z"), end: t("2008-09-13T09:00Z"), peak: t("2008-09-13T07:10Z"),
    lat: 29.3, lon: -94.8, volumes: 51, mb: 348,
    text: "A huge Category 2 whose eye came ashore over Galveston, with a surge far beyond its category." },
  { id: "2012-sandy", title: "Hurricane Sandy", place: "Brigantine, NJ", category: "hurricane",
    site: "DIX", start: t("2012-10-29T21:30Z"), end: t("2012-10-30T01:30Z"), peak: t("2012-10-29T23:30Z"),
    lat: 39.4, lon: -74.4, volumes: 46, mb: 405,
    text: "Sandy turned west into the New Jersey coast near Brigantine as it lost its tropical structure." },
  { id: "2017-harvey", title: "Hurricane Harvey", place: "Rockport, TX", category: "hurricane",
    site: "CRP", start: t("2017-08-26T01:00Z"), end: t("2017-08-26T05:00Z"), peak: t("2017-08-26T03:00Z"),
    lat: 28.02, lon: -97.05, volumes: 44, mb: 605,
    text: "Category 4 landfall near Rockport; the storm then stalled over southeast Texas for days." },
  { id: "2017-irma", title: "Hurricane Irma", place: "Florida Keys", category: "hurricane",
    site: "BYX", start: t("2017-09-10T11:00Z"), end: t("2017-09-10T15:00Z"), peak: t("2017-09-10T13:10Z"),
    lat: 24.66, lon: -81.48, volumes: 36, mb: 602,
    text: "Irma's eye over Cudjoe Key as a Category 4, within sight of the Key West radar." },
  { id: "2018-florence", title: "Hurricane Florence", place: "Wrightsville Beach, NC", category: "hurricane",
    site: "LTX", start: t("2018-09-14T09:00Z"), end: t("2018-09-14T13:00Z"), peak: t("2018-09-14T11:15Z"),
    lat: 34.21, lon: -77.8, volumes: 44, mb: 563,
    text: "A slow Category 1 landfall at Wrightsville Beach, the start of days of flooding rain in the Carolinas." },
  { id: "2018-michael", title: "Hurricane Michael", place: "Mexico Beach, FL", category: "hurricane",
    site: "EVX", start: t("2018-10-10T15:30Z"), end: t("2018-10-10T19:30Z"), peak: t("2018-10-10T17:30Z"),
    lat: 29.95, lon: -85.42, volumes: 46, mb: 687,
    text: "A Category 5 landfall at Mexico Beach, its eyewall crossing Tyndall Air Force Base and Panama City's east side." },
  { id: "2020-laura", title: "Hurricane Laura", place: "Cameron, LA", category: "hurricane",
    site: "LCH", start: t("2020-08-27T03:00Z"), end: t("2020-08-27T07:00Z"), peak: t("2020-08-27T05:50Z"),
    lat: 29.8, lon: -93.33, volumes: 25, mb: 354,
    text: "A Category 4 that came ashore near Cameron and drove north over Lake Charles, where its winds wrecked the radar itself." },
  { id: "2020-sally", title: "Hurricane Sally", place: "Gulf Shores, AL", category: "hurricane",
    site: "MOB", start: t("2020-09-16T07:30Z"), end: t("2020-09-16T11:30Z"), peak: t("2020-09-16T09:45Z"),
    lat: 30.25, lon: -87.68, volumes: 44, mb: 441,
    text: "A crawling Category 2 landfall at Gulf Shores, with more than 20 inches of rain along the coast." },
  { id: "2021-ida", title: "Hurricane Ida", place: "Port Fourchon, LA", category: "hurricane",
    site: "LIX", start: t("2021-08-29T14:00Z"), end: t("2021-08-29T18:00Z"), peak: t("2021-08-29T16:55Z"),
    lat: 29.1, lon: -90.2, volumes: 37, mb: 654,
    text: "Ida came ashore at Port Fourchon as a Category 4 sixteen years to the day after Katrina, its eye passing west of New Orleans." },
  { id: "2022-ian", title: "Hurricane Ian", place: "Southwest Florida", category: "hurricane",
    site: "TBW", start: t("2022-09-28T17:00Z"), end: t("2022-09-28T21:00Z"), peak: t("2022-09-28T19:05Z"),
    lat: 26.7, lon: -82.25, volumes: 36, mb: 676,
    text: "A Category 4 landfall at Cayo Costa, its eyewall over Fort Myers Beach and Cape Coral." },
  { id: "2023-idalia", title: "Hurricane Idalia", place: "Big Bend, FL", category: "hurricane",
    site: "TLH", start: t("2023-08-30T09:45Z"), end: t("2023-08-30T13:45Z"), peak: t("2023-08-30T11:45Z"),
    lat: 29.92, lon: -83.6, volumes: 37, mb: 713,
    text: "A Category 3 landfall near Keaton Beach in Florida's Big Bend." },
  { id: "2024-beryl", title: "Hurricane Beryl", place: "Matagorda, TX", category: "hurricane",
    site: "HGX", start: t("2024-07-08T07:00Z"), end: t("2024-07-08T11:00Z"), peak: t("2024-07-08T09:00Z"),
    lat: 28.7, lon: -95.95, volumes: 37, mb: 685,
    text: "A Category 1 landfall at Matagorda that went on to cut power to millions in Houston." },
  { id: "2024-helene", title: "Hurricane Helene", place: "Perry, FL", category: "hurricane",
    site: "TLH", start: t("2024-09-27T01:00Z"), end: t("2024-09-27T05:00Z"), peak: t("2024-09-27T03:10Z"),
    lat: 30.05, lon: -83.6, volumes: 36, mb: 818,
    text: "A very large Category 4 landfall in the Big Bend near Perry, before catastrophic flooding in the southern Appalachians." },
  { id: "2024-milton", title: "Hurricane Milton", place: "Siesta Key, FL", category: "hurricane",
    site: "TBW", start: t("2024-10-09T22:30Z"), end: t("2024-10-10T02:30Z"), peak: t("2024-10-10T00:30Z"),
    lat: 27.25, lon: -82.55, volumes: 35, mb: 723,
    text: "A Category 3 landfall at Siesta Key at night, after a day of tornadoes across the Florida peninsula." },
  { id: "2009-super-derecho", title: "May 2009 derecho", place: "Southern Missouri", category: "derecho",
    site: "SGF", start: t("2009-05-08T12:00Z"), end: t("2009-05-08T16:00Z"), peak: t("2009-05-08T13:15Z"),
    lat: 37.2, lon: -93.3, volumes: 51, mb: 305,
    text: "A derecho with a warm-core vortex that swept from Kansas across southern Missouri, past Springfield and on into Kentucky." },
  { id: "2011-chicago-derecho", title: "Chicago derecho", place: "Chicago, IL", category: "derecho",
    site: "LOT", start: t("2011-07-11T12:00Z"), end: t("2011-07-11T14:00Z"), peak: t("2011-07-11T12:50Z"),
    lat: 41.85, lon: -87.9, volumes: 26, mb: 141,
    text: "A morning derecho through the Chicago area that left hundreds of thousands without power." },
  { id: "2012-derecho", title: "June 2012 derecho", place: "Washington, DC area", category: "derecho",
    site: "LWX", start: t("2012-06-30T01:30Z"), end: t("2012-06-30T03:30Z"), peak: t("2012-06-30T02:30Z"),
    lat: 38.9, lon: -77.2, volumes: 28, mb: 423,
    text: "The end of a 700-mile run from Iowa: the derecho reached Washington and Baltimore late on a 100-degree evening." },
  { id: "2020-iowa-derecho", title: "Iowa derecho", place: "Cedar Rapids, IA", category: "derecho",
    site: "DVN", start: t("2020-08-10T16:00Z"), end: t("2020-08-10T20:00Z"), peak: t("2020-08-10T17:30Z"),
    lat: 41.98, lon: -91.67, volumes: 39, mb: 578,
    text: "The costliest thunderstorm event in US history: winds well over 100 mph across Cedar Rapids and millions of acres of crops." },
  { id: "2022-sioux-falls-derecho", title: "May 2022 derecho", place: "Sioux Falls, SD", category: "derecho",
    site: "FSD", start: t("2022-05-12T21:00Z"), end: t("2022-05-12T23:00Z"), peak: t("2022-05-12T22:10Z"),
    lat: 43.55, lon: -96.73, volumes: 17, mb: 295,
    text: "A fast derecho across eastern South Dakota that turned the sky green over Sioux Falls." },
  { id: "2024-houston-derecho", title: "Houston derecho", place: "Houston, TX", category: "derecho",
    site: "HGX", start: t("2024-05-16T23:00Z"), end: t("2024-05-17T01:00Z"), peak: t("2024-05-16T23:35Z"),
    lat: 29.76, lon: -95.37, volumes: 20, mb: 325,
    text: "A bow echo that blew out downtown Houston's high-rise windows on a Thursday evening." },
  { id: "2003-aurora-hail", title: "Aurora hailstone", place: "Aurora, NE", category: "hail",
    site: "UEX", start: t("2003-06-22T23:00Z"), end: t("2003-06-23T01:00Z"), peak: t("2003-06-23T00:15Z"),
    lat: 40.87, lon: -98.0, volumes: 24, mb: 50,
    text: "A supercell that dropped a hailstone 7 inches across at Aurora, for seven years the largest by diameter in the US." },
  { id: "2010-vivian-hail", title: "Vivian hailstone", place: "Vivian, SD", category: "hail",
    site: "ABR", start: t("2010-07-23T22:00Z"), end: t("2010-07-24T00:00Z"), peak: t("2010-07-23T23:10Z"),
    lat: 43.93, lon: -100.3, volumes: 27, mb: 131,
    text: "The US record hailstone, 8 inches across and nearly 2 pounds, fell at Vivian from a supercell over central South Dakota." },
  { id: "2016-wylie-hail", title: "Wylie hailstorm", place: "Wylie, TX", category: "hail",
    site: "FWS", start: t("2016-04-11T22:00Z"), end: t("2016-04-12T00:00Z"), peak: t("2016-04-11T23:07Z"),
    lat: 33.02, lon: -96.54, volumes: 23, mb: 269,
    text: "A supercell northeast of Dallas whose hail, up to baseball size and larger, damaged the roofs of thousands of homes in Wylie." },
  { id: "2017-denver-hail", title: "Denver hailstorm", place: "Lakewood, CO", category: "hail",
    site: "FTG", start: t("2017-05-08T19:30Z"), end: t("2017-05-08T21:30Z"), peak: t("2017-05-08T20:40Z"),
    lat: 39.7, lon: -105.1, volumes: 27, mb: 203,
    text: "The costliest hailstorm in Colorado history, crossing Lakewood and Wheat Ridge on a weekday afternoon." },
];

export const EVENT_CATEGORIES: Array<{ id: RadarEventCategory; label: string; plural: string }> = [
  { id: "tornado", label: "Tornado", plural: "Tornadoes" },
  { id: "outbreak", label: "Outbreak", plural: "Outbreaks" },
  { id: "hurricane", label: "Hurricane", plural: "Hurricanes" },
  { id: "derecho", label: "Derecho", plural: "Derechos" },
  { id: "hail", label: "Hail", plural: "Hailstorms" },
];

/** Map dot colours by category (map data, not chrome). */
export const EVENT_COLORS: Record<RadarEventCategory, string> = {
  tornado: "#e5484d",
  outbreak: "#c2298a",
  hurricane: "#5b8def",
  derecho: "#e8a33d",
  hail: "#2fb3a3",
};

/** How close the map comes when an event opens. */
export const EVENT_ZOOM: Record<RadarEventCategory, number> = {
  tornado: 8.4,
  outbreak: 7.4,
  hurricane: 7.0,
  derecho: 7.2,
  hail: 8.2,
};

/** Radars in the events that are retired, so missing from the live site list. */
export const RETIRED_SITES: Record<string, { icao: string; name: string; lat: number; lon: number }> = {
  LIX: { icao: "KLIX", name: "New Orleans/Slidell (retired 2024)", lat: 30.3367, lon: -89.8256 },
};

export function eventById(id: string | null | undefined): RadarEvent | null {
  if (!id) return null;
  return RADAR_EVENTS.find((e) => e.id === id) ?? null;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
  "november", "december"];

function haystack(e: RadarEvent): string {
  const d = new Date(e.peak * 1000);
  return [e.title, e.place, e.id, e.category, `k${e.site}`, e.site, String(d.getUTCFullYear()),
          MONTHS[d.getUTCMonth()]].join(" ").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** "couplets" = the tornado events with a measured couplet, strongest first. */
export type EventFilter = RadarEventCategory | "all" | "couplets";

/** Events matching a free-text query (place, radar, year, name, month; every
 *  word must match) and a category, in list order. */
export function searchEvents(query: string, filter: EventFilter): RadarEvent[] {
  const words = query.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[\s,]+/).filter(Boolean);
  let out = RADAR_EVENTS.filter((e) => {
    if (filter === "couplets" ? e.dvKt == null : filter !== "all" && e.category !== filter) return false;
    const hay = haystack(e);
    return words.every((w) => hay.includes(w));
  });
  if (filter === "couplets") out = [...out].sort((a, b) => (b.dvKt ?? 0) - (a.dvKt ?? 0));
  else out = [...out].sort((a, b) => b.peak - a.peak);
  return out;
}

/** "19:30-21:00Z" (with the date of the end when it is another day). */
export function eventWindowText(e: RadarEvent): string {
  const hm = (u: number) => new Date(u * 1000).toISOString().slice(11, 16);
  const day = (u: number) => new Date(u * 1000).toISOString().slice(0, 10);
  return day(e.start) === day(e.end) ? `${hm(e.start)}-${hm(e.end)}Z` : `${hm(e.start)}Z-${day(e.end).slice(5)} ${hm(e.end)}Z`;
}

/** The event's date, UTC: "2013-05-20". */
export function eventDay(e: RadarEvent): string {
  return new Date(e.peak * 1000).toISOString().slice(0, 10);
}
