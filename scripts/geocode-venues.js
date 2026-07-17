// Weekly backfill: finds VENUES records missing Lat/Long, geocodes them via
// the free US Census Geocoder (no API key, no new dependency — same fetch()
// pattern as sync.js), and writes Lat/Long back to Airtable.
//
// Run with: AIRTABLE_TOKEN=xxx node scripts/geocode-venues.js
// No dependencies beyond Node's built-in fetch (Node 18+).

const BASE_ID = "appYl3aTmmFojcBIK"; // JRM Ops
const VENUES_TABLE_ID = "tblHgKEEwhbsrJlsJ";

const FIELDS = {
  venueName: "fld3eRB2KInc8Cyj4",
  address: "fldlEtscLdf9ojzM0",
  state: "fldAEeYwCvnIKVR6V",
  lat: "fldymPgNBymv7bbbN",
  long: "fldXGcnYbmQbDtwLi",
};

const CENSUS_GEOCODER =
  "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;

async function airtableFetch(path, options = {}) {
  const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Airtable ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Pull every VENUES record with a blank Lat and a non-blank address.
async function fetchGeocodableVenues() {
  const records = [];
  let offset;
  do {
    const params = new URLSearchParams({
      filterByFormula: "AND({Lat} = '', {VenueAddress1} != '')",
      pageSize: "100",
    });
    if (offset) params.set("offset", offset);
    const data = await airtableFetch(`/VENUES?${params.toString()}`);
    records.push(...data.records);
    offset = data.offset;
  } while (offset);
  return records;
}

async function geocodeAddress(address) {
  const url = `${CENSUS_GEOCODER}?address=${encodeURIComponent(
    address
  )}&benchmark=Public_AR_Current&format=json`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const match = data?.result?.addressMatches?.[0];
  if (!match) return null;
  return {
    lat: String(match.coordinates.y),
    long: String(match.coordinates.x),
  };
}

// Skip addresses that are known not to be geocodable street addresses:
// bare city/state ("Las Vegas, NV"), placeholders ("TBD"), or clearly
// non-US locations. These fall back to the office centroid in sync.js
// instead of burning geocoder calls that will never match.
function looksGeocodable(fields) {
  const addr = fields["VenueAddress1"] || "";
  const state = fields["State"] || "";
  if (!/\d/.test(addr)) return false; // no street number at all
  if (/^tbd$/i.test(addr.trim())) return false;
  if (state === "International") return false;
  return true;
}

async function main() {
  if (!AIRTABLE_TOKEN) {
    console.error("AIRTABLE_TOKEN is required (needs write access to JRM Ops base).");
    process.exit(1);
  }

  const venues = await fetchGeocodableVenues();
  console.log(`Found ${venues.length} venues missing Lat/Long with an address on file.`);

  const geocodable = venues.filter((v) => looksGeocodable(v.fields));
  console.log(
    `${geocodable.length} look geocodable; ${
      venues.length - geocodable.length
    } skipped (city-only/placeholder/international — will use office centroid fallback).`
  );

  const updates = [];
  const misses = [];

  for (const record of geocodable) {
    const address = record.fields["VenueAddress1"];
    const result = await geocodeAddress(address);
    if (result) {
      updates.push({ id: record.id, fields: { Lat: result.lat, Long: result.long } });
    } else {
      misses.push({ id: record.id, name: record.fields["VenueName"], address });
    }
    // Be polite to the free Census endpoint — small delay between calls.
    await new Promise((r) => setTimeout(r, 200));
  }

  // Airtable allows up to 10 records per PATCH.
  for (let i = 0; i < updates.length; i += 10) {
    const batch = updates.slice(i, i + 10);
    await airtableFetch("/VENUES", {
      method: "PATCH",
      body: JSON.stringify({ records: batch }),
    });
  }

  console.log(`Wrote coordinates for ${updates.length} venues.`);
  if (misses.length) {
    console.log(`${misses.length} addresses did not match (bad/incomplete address data):`);
    misses.forEach((m) => console.log(`  - ${m.name}: "${m.address}"`));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
