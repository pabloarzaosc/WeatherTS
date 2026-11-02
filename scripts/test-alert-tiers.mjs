// Unit tests for src/lib/alertTiers.ts (alert intensity tiers, storm motion,
// hazard groups, states / office / VTEC). Node 22.18+ strips the types:
//   node scripts/test-alert-tiers.mjs
import test from "node:test";
import assert from "node:assert/strict";

import {
  alertTier,
  alertUrgency,
  alertStates,
  alertVtec,
  alertWfo,
  compassName,
  destination,
  hazardOf,
  motionText,
  parseCodeList,
  parseStormMotion,
  ALERT_TIERS,
  NWS_EVENTS,
} from "../src/lib/alertTiers.ts";

const alert = (event, parameters = {}, description = "", headline = null) => ({ event, parameters, description, headline });
const tierId = (a) => alertTier(a)?.id ?? null;

test("tornado warning tiers come from the tags, highest wins", () => {
  assert.equal(tierId(alert("Tornado Warning", { tornadoDetection: ["RADAR INDICATED"] })), null);
  assert.equal(tierId(alert("Tornado Warning", { tornadoDetection: ["OBSERVED"] })), "tor-observed");
  assert.equal(tierId(alert("Tornado Warning", { tornadoDetection: ["OBSERVED"], tornadoDamageThreat: ["CONSIDERABLE"] })), "tor-pds");
  assert.equal(
    tierId(alert("Tornado Warning", { tornadoDetection: ["OBSERVED"], tornadoDamageThreat: ["CATASTROPHIC"] })),
    "tor-emergency",
  );
});

test("tornado wording stands in only for a missing tag", () => {
  assert.equal(tierId(alert("Tornado Warning", {}, "...TORNADO EMERGENCY FOR ROLLING FORK...")), "tor-emergency");
  assert.equal(tierId(alert("Tornado Warning", {}, "THIS IS A PARTICULARLY DANGEROUS SITUATION.")), "tor-pds");
  assert.equal(tierId(alert("Tornado Warning", {}, "TORNADO...OBSERVED\nHAIL...1.00 IN")), "tor-observed");
  // the tag says considerable: a mention of an earlier emergency does not lift it
  assert.equal(
    tierId(alert("Tornado Warning", { tornadoDamageThreat: ["CONSIDERABLE"] }, "the tornado emergency has ended")),
    "tor-pds",
  );
  // a radar-indicated tag beats "confirmed tornado" wording
  assert.equal(tierId(alert("Tornado Warning", { tornadoDetection: ["RADAR INDICATED"] }, "A CONFIRMED TORNADO")), null);
});

test("severe thunderstorm tiers", () => {
  assert.equal(tierId(alert("Severe Thunderstorm Warning", { maxWindGust: ["60 MPH"] })), null);
  assert.equal(tierId(alert("Severe Thunderstorm Warning", { thunderstormDamageThreat: ["CONSIDERABLE"] })), "svr-considerable");
  assert.equal(tierId(alert("Severe Thunderstorm Warning", { thunderstormDamageThreat: ["DESTRUCTIVE"], maxWindGust: ["80 MPH"] })), "svr-destructive");
  assert.equal(tierId(alert("Severe Thunderstorm Warning", { thunderstormDamageThreat: ["DESTRUCTIVE"], maxWindGust: ["100 MPH"] })), "svr-eds");
  assert.equal(tierId(alert("Severe Thunderstorm Warning", {}, "THIS IS AN EXTREMELY DANGEROUS SITUATION")), "svr-eds");
  assert.equal(tierId(alert("Severe Thunderstorm Warning", {}, "THUNDERSTORM DAMAGE THREAT...DESTRUCTIVE")), "svr-destructive");
});

test("flash flood tiers", () => {
  assert.equal(tierId(alert("Flash Flood Warning", { flashFloodDetection: ["RADAR INDICATED"] })), null);
  assert.equal(tierId(alert("Flash Flood Warning", { flashFloodDetection: ["OBSERVED"] })), "ffw-observed");
  assert.equal(
    tierId(alert("Flash Flood Warning", { flashFloodDetection: ["OBSERVED"], flashFloodDamageThreat: ["CONSIDERABLE"] })),
    "ffw-considerable",
  );
  assert.equal(tierId(alert("Flash Flood Warning", { flashFloodDamageThreat: ["CATASTROPHIC"] })), "ffw-emergency");
  assert.equal(tierId(alert("Flash Flood Warning", {}, "...FLASH FLOOD EMERGENCY FOR...")), "ffw-emergency");
});

test("snow squall tiers", () => {
  assert.equal(tierId(alert("Snow Squall Warning", { snowSquallDetection: ["RADAR INDICATED"] })), null);
  assert.equal(tierId(alert("Snow Squall Warning", { snowSquallDetection: ["OBSERVED"] })), "sqw-observed");
  assert.equal(tierId(alert("Snow Squall Warning", { snowSquallDetection: ["OBSERVED"], snowSquallImpact: ["SIGNIFICANT"] })), "sqw-significant");
  assert.equal(tierId(alert("Snow Squall Warning", { snowSquallImpact: ["SIGNIFICANT"] }, "PARTICULARLY DANGEROUS SITUATION")), "sqw-pds");
});

test("PDS watches and other PDS products", () => {
  assert.equal(tierId(alert("Tornado Watch", {}, "THIS IS A PARTICULARLY DANGEROUS SITUATION")), "watch-pds");
  assert.equal(tierId(alert("Tornado Watch")), null);
  assert.equal(tierId(alert("Red Flag Warning", {}, "particularly  dangerous\nsituation")), "pds");
  assert.equal(tierId(alert("Wind Advisory", {}, "PARTICULARLY DANGEROUS SITUATION")), null);
  assert.equal(tierId(alert("Special Weather Statement")), null);
});

test("urgency orders a batch: emergency > PDS > plain tornado > severe", () => {
  const emergency = alert("Tornado Warning", { tornadoDamageThreat: ["CATASTROPHIC"] });
  const pds = alert("Tornado Warning", { tornadoDamageThreat: ["CONSIDERABLE"] });
  const tor = alert("Tornado Warning");
  const svr = alert("Severe Thunderstorm Warning");
  const adv = alert("Wind Advisory");
  const sorted = [adv, svr, tor, emergency, pds].sort((a, b) => alertUrgency(b) - alertUrgency(a));
  assert.deepEqual(sorted, [emergency, pds, tor, svr, adv]);
});

test("every tier has a distinct colour and a known family", () => {
  const colours = ALERT_TIERS.map((t) => t.color.toLowerCase());
  assert.equal(new Set(colours).size, colours.length);
  for (const t of ALERT_TIERS) assert.match(t.color, /^#[0-9a-f]{6}$/i);
});

test("storm motion: parse, heading, text", () => {
  const m = parseStormMotion("2026-10-25T04:48:00-00:00...storm...228DEG...30KT...31.71,-105.37");
  assert.ok(m);
  assert.equal(m.fromDeg, 228);
  assert.equal(m.towardDeg, 48);
  assert.equal(m.kt, 30);
  assert.deepEqual(m.points, [[-105.37, 31.71]]);
  assert.equal(m.time, Date.parse("2026-10-25T04:48:00Z") / 1000);
  assert.equal(motionText(m), "Northeast (48°) at 30 kt");
  const line = parseStormMotion("2024-05-06T23:21:00-00:00...storm...310DEG...6KT...35.24,-97.57 35.40,-97.30 35.60,-97.10");
  assert.equal(line.points.length, 3);
  assert.equal(motionText(line), "Southeast (130°) at 6 kt");
  assert.equal(motionText(parseStormMotion("2024-05-06T23:21:00-00:00...storm...000DEG...0KT...35.2,-97.5")), "Stationary");
  assert.equal(parseStormMotion("garbage"), null);
  assert.equal(parseStormMotion(undefined), null);
  assert.equal(compassName(359), "North");
  assert.equal(compassName(-90), "West");
});

test("destination: 111 km north is one degree of latitude", () => {
  const [lon, lat] = destination([-97, 35], 0, 111.195);
  assert.ok(Math.abs(lat - 36) < 1e-3);
  assert.ok(Math.abs(lon + 97) < 1e-9);
  const [lon2] = destination([-97, 0], 90, 111.195);
  assert.ok(Math.abs(lon2 + 96) < 1e-3);
});

test("hazard groups", () => {
  const cases = {
    "Tornado Warning": "severe",
    "Special Weather Statement": "severe",
    "Extreme Wind Warning": "severe",
    "Winter Storm Warning": "winter",
    "Snow Squall Warning": "winter",
    "Extreme Cold Warning": "winter",
    "Flash Flood Warning": "hydro",
    "Coastal Flood Advisory": "hydro",
    "High Wind Warning": "wind",
    "Dense Fog Advisory": "wind",
    "Freezing Fog Advisory": "wind",
    "Red Flag Warning": "fire",
    "Heat Advisory": "fire",
    "Hurricane Warning": "tropical",
    "Storm Surge Watch": "tropical",
    "Hurricane Force Wind Warning": "marine",
    "Small Craft Advisory": "marine",
    "Storm Warning": "marine",
    "Heavy Freezing Spray Warning": "marine",
    "Child Abduction Emergency": "other",
  };
  for (const [ev, g] of Object.entries(cases)) assert.equal(hazardOf(ev), g, ev);
  assert.equal(NWS_EVENTS.length, 110);
});

test("states, office, VTEC", () => {
  assert.deepEqual(
    alertStates({
      affectedZones: ["https://api.weather.gov/zones/county/OKC109", "https://api.weather.gov/zones/forecast/TXZ025", "https://api.weather.gov/zones/forecast/GMZ250"],
      areaDesc: "",
    }),
    ["OK", "TX"],
  );
  assert.deepEqual(alertStates({ affectedZones: [], areaDesc: "Crittenden [AR], Mississippi [AR], Lauderdale [TN]" }), ["AR", "TN"]);
  assert.deepEqual(alertStates({ affectedZones: [], areaDesc: "Tulsa, OK; Creek, OK; Nowata, OK" }), ["OK"]);
  const p = { VTEC: ["/O.NEW.KEPZ.SV.W.0217.261025T0448Z-261025T0530Z/"], AWIPSidentifier: ["SVREPZ"] };
  assert.deepEqual(alertVtec({ parameters: p }), { action: "NEW", office: "KEPZ", phen: "SV", sig: "W", etn: "0217", key: "KEPZ.SV.W.0217" });
  assert.equal(alertWfo({ parameters: p, senderName: "NWS El Paso Tx/Santa Teresa NM" }), "EPZ");
  assert.equal(alertWfo({ parameters: { VTEC: p.VTEC }, senderName: "" }), "EPZ");
  assert.equal(alertWfo({ parameters: {}, senderName: "NWS MEG" }), "MEG");
  assert.equal(alertWfo({ parameters: {}, senderName: "NWS Memphis TN" }), "");
  assert.deepEqual(parseCodeList(" ok, tx;KS  texas", 2), ["OK", "TX", "KS"]);
  assert.deepEqual(parseCodeList("oun, FWD tsa", 3), ["OUN", "FWD", "TSA"]);
});
