// Runnable check for the International Deployments region matcher in sync.js.
// Run: node scripts/test_intl.js  (exits non-zero on any failure)
//
// The one thing this guards: single-select fields arrive from Airtable's REST
// API as plain STRINGS ("International"), not {name} objects. Assuming the
// object shape once shipped an always-empty international card to production.
// Every State value below is therefore a bare string on purpose — that's the
// real shape. Cases are the actual live venues (state / resolved city /
// VenueAddress1) pulled from the JRM ops base.

const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "sync.js"), "utf8");
const start = src.indexOf("const COUNTRY_REGIONS");
const end = src.indexOf("// Asset Library records whose Name");
if (start < 0 || end < 0) throw new Error("could not locate matcher block in sync.js");
eval(src.slice(start, end));

// [state, city, address, expectedRegion|null]
const CASES = [
  ["CA", "Los Angeles", "570 W. Avenue 26, Los Angeles, CA 90065", "__DOMESTIC__"],
  ["NV", "Las Vegas", "Las Vegas, NV", "__DOMESTIC__"],
  ["International", "New Delhi", "Sector 25 Dwarka", "India"],
  ["International", "London", "The Mall, London SW1Y 5AH, United Kingdom", "Western Europe"],
  ["International", "San Juan", "San Juan, Puerto Rico", "Caribbean"],
  ["Antioquia", "Medellín", "Cra. 1A #70-01", "Latin America"],
  ["International", "Amsterdam", "Europaplein 24, 1078 GZ Amsterdam, Netherlands", "Western Europe"],
  ["International", "Seoul", "Seoul 97 Saemunan-ro, Dangju-dong", "East Asia"],
  ["International", "", "Mexico", "Latin America"],
  ["International", "", "Europe", "Western Europe"],
  ["International", "Toronto", "100 Front St W, Toronto ON M5J 1E3", "Canada"],
  ["International", "", "India", "India"],
  ["International", "London", "40 Duke St", "Western Europe"],
  ["International", "London", "London, UK", "Western Europe"],
  ["International", "Wien", "Bruno-Kreisky-Platz 1, 1220 Wien, Austria", "Western Europe"],
  ["NZ", "Auckland", "", "Oceania"],
];

let failures = 0;
for (const [state, city, address, expected] of CASES) {
  const intl = isInternational(state);
  if (expected === "__DOMESTIC__") {
    if (intl) { console.log(`FAIL domestic "${state}" flagged international`); failures++; }
    continue;
  }
  if (!intl) { console.log(`FAIL "${state}" (${city}) not flagged international`); failures++; continue; }
  const region = regionForVenue(state, city, address);
  const got = region ? region.region : null;
  if (got !== expected) { console.log(`FAIL ${city || address} -> ${got}, expected ${expected}`); failures++; }
}

// Regression guard for the bare 2-char "uk" keyword: with no city link, an
// address of "40 Duke St" must NOT resolve to Western Europe by "uk" hitting
// inside "Duke". It should be unmatched (null) instead.
{
  const leak = regionForVenue("International", "", "40 Duke St");
  if (leak) { console.log(`FAIL "40 Duke St" false-matched ${leak.region} (bare "uk" keyword is back)`); failures++; }
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log(`All ${CASES.length} international-matcher cases passed.`);
