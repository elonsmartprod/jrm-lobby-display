// Syncs Airtable content (Lobby Callouts, Team Bios, Asset Library) into
// data.json + assets/synced/, so the static lobby page never has to touch
// Airtable directly (and never sees Airtable's short-lived attachment URLs).
//
// Run with: AIRTABLE_TOKEN=xxx node scripts/sync.js
// No dependencies beyond Node's built-in fetch (Node 18+).

const fs = require("fs");
const path = require("path");

const BASE_ID = "appzYjL42rxnYTaJy";
const TABLES = {
  callouts: "tblWwh1MzQvsv8UX3",
  bios: "tblzpJhxoc5Q0SfAn",
  assets: "tblB3BuwqxHM4mKMR",
};

// JRM's internal ops base (job log, offices, REMs). Read-only, and only ever
// touched for the specific non-sensitive fields listed in OPS_FIELDS below —
// this base also contains Employee Directory, DNF LIST, Invoices, Payroll,
// and AP/AR data that must never be queried, downloaded, or surfaced here.
const OPS_BASE_ID = "appYl3aTmmFojcBIK";
const OPS_TABLES = {
  jobLog: "tblIqTqZvNwAhlKBA",
  offices: "tbl0EEPJZ08X6oedl",
  rems: "tblODdyjhYoGBNFde",
};
const OPS_FIELDS = {
  jobLog: [
    "START DATE",
    "END DATE",
    "REM *",
    "JOB NAME",
    "JRM Office",
    "JOB STATUS",
    "# of Guards Requested",
    "VENUE NAME",
    "CLIENT NAME",
    "CATEGORY **",
    "EVENT TYPE **",
    "City",
    "Flag Job as Cancelled",
  ],
  offices: ["Office", "Region"],
  rems: ["REMS", "Colors", "Branch", "Count Events"],
};

// Static geo anchors for JRM's real offices (Airtable has no lat/lon of its
// own — these are metro-center approximations, same approach as the mockup).
const OFFICE_GEO = {
  "Los Angeles": [-118.24, 34.05],
  "National Ops": [-118.24, 34.05],
  "New York": [-74.0, 40.71],
  "Northern California": [-122.42, 37.77],
  Tennessee: [-86.78, 36.16],
  Utah: [-111.89, 40.76],
  Texas: [-96.8, 32.78],
  "JRM-Nevada": [-115.14, 36.17],
  Arizona: [-112.07, 33.45],
  Washington: [-122.33, 47.61],
};

// Asset Library records whose Name should never end up in the on-screen photo
// gallery (personal/staff photos used elsewhere, not brand/event imagery).
const GALLERY_EXCLUDE_NAMES = new Set(["Elon 2025", "EZ Portrait", "SC Portrait", "JRM Logo Full"]);

const TOKEN = process.env.AIRTABLE_TOKEN;
if (!TOKEN) {
  console.error("Missing AIRTABLE_TOKEN env var");
  process.exit(1);
}

const REPO_ROOT = path.resolve(__dirname, "..");
const SYNCED_DIR = path.join(REPO_ROOT, "assets", "synced");

async function fetchAllRecords(tableId, baseId = BASE_ID, opts = {}) {
  const records = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${baseId}/${tableId}`);
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);
    if (opts.fields) opts.fields.forEach((f) => url.searchParams.append("fields[]", f));
    if (opts.filterByFormula) url.searchParams.set("filterByFormula", opts.filterByFormula);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!res.ok) {
      throw new Error(`Airtable fetch failed for ${tableId}: ${res.status} ${await res.text()}`);
    }
    const json = await res.json();
    records.push(...json.records);
    offset = json.offset;
  } while (offset);
  return records;
}

function linkName(val) {
  if (Array.isArray(val) && val[0]) return val[0].name || "";
  return "";
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function fetchOpsMetrics() {
  const now = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 1);

  // All windows we need (YTD, last 30d, next 30d) fall inside the current
  // calendar year, so one filtered fetch covers every metric below.
  const jobs = await fetchAllRecords(OPS_TABLES.jobLog, OPS_BASE_ID, {
    fields: OPS_FIELDS.jobLog,
    filterByFormula: `AND(IS_AFTER({START DATE}, '${isoDate(new Date(yearStart.getTime() - 86400000))}'), NOT({Flag Job as Cancelled}))`,
  });

  const parsed = jobs
    .map((r) => r.fields)
    .map((f) => ({
      name: f["JOB NAME"] || "",
      start: f["START DATE"] ? new Date(f["START DATE"]) : null,
      office: linkName(f["JRM Office"]),
      rem: linkName(f["REM *"]),
      guards: typeof f["# of Guards Requested"] === "number" ? f["# of Guards Requested"] : 0,
      venue: linkName(f["VENUE NAME"]),
      client: linkName(f["CLIENT NAME"]),
      city: f.City || "",
      badges: [f["EVENT TYPE **"], f["CATEGORY **"]].filter(Boolean),
    }))
    .filter((j) => j.start);

  const last30 = daysAgo(30);
  const next30 = new Date(now.getTime() + 30 * 86400000);

  const ytd = parsed.filter((j) => j.start >= yearStart && j.start <= now);
  const recent30 = parsed.filter((j) => j.start >= last30 && j.start <= now);
  const upcoming30 = parsed.filter((j) => j.start > now && j.start <= next30);

  const daysElapsed = Math.max(1, Math.round((now - yearStart) / 86400000));
  const metrics = {
    eventsYTD: ytd.length,
    events30: recent30.length,
    guards30: recent30.reduce((sum, j) => sum + j.guards, 0),
    citiesYTD: new Set(ytd.map((j) => j.city).filter(Boolean)).size,
    upcoming30: upcoming30.length,
    perDay: ytd.length / daysElapsed,
  };

  // Heatmap: last-30-day event count per office, mapped onto static geo.
  const officeCounts = {};
  for (const j of recent30) {
    if (!j.office) continue;
    officeCounts[j.office] = (officeCounts[j.office] || 0) + 1;
  }
  const maxCount = Math.max(1, ...Object.values(officeCounts));
  const heatPoints = Object.entries(officeCounts)
    .filter(([name]) => OFFICE_GEO[name])
    .map(([name, ev]) => ({
      name,
      lon: OFFICE_GEO[name][0],
      lat: OFFICE_GEO[name][1],
      ev,
      w: ev / maxCount,
      hq: name === "Los Angeles" || name === "National Ops",
    }));

  // REM leaderboard: top 5 by last-30-day event count, enriched with the
  // career total + assigned color already rolled up on REMS/Accounts.
  const remCounts = {};
  const remRecent = {};
  for (const j of recent30) {
    if (!j.rem) continue;
    remCounts[j.rem] = (remCounts[j.rem] || 0) + 1;
    (remRecent[j.rem] = remRecent[j.rem] || []).push(j);
  }
  const remRecords = await fetchAllRecords(OPS_TABLES.rems, OPS_BASE_ID, { fields: OPS_FIELDS.rems });
  const remInfo = {};
  for (const r of remRecords) {
    const f = r.fields;
    const name = f.REMS || "";
    if (!name) continue;
    remInfo[name] = {
      color: f.Colors && f.Colors.name === name ? colorHex(f.Colors.color) : null,
      career: typeof f["Count Events"] === "number" ? f["Count Events"] : 0,
      office: linkName(f.Branch),
    };
  }
  const rems = Object.entries(remCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, events30]) => ({
      name,
      office: (remInfo[name] && remInfo[name].office) || "",
      color: (remInfo[name] && remInfo[name].color) || "#E8B44A",
      events30,
      career: (remInfo[name] && remInfo[name].career) || events30,
      recent: (remRecent[name] || [])
        .sort((a, b) => b.start - a.start)
        .slice(0, 3)
        .map((j) => ({ name: j.name, meta: j.start.toLocaleDateString("en-US", { month: "short", day: "2-digit" }).toUpperCase() })),
    }));

  // Event highlight cards: mix of the most recent completed + soonest upcoming.
  const events = [
    ...recent30.slice().sort((a, b) => b.start - a.start).slice(0, 5).map((j) => ({ ...j, upcoming: false })),
    ...upcoming30.slice().sort((a, b) => a.start - b.start).slice(0, 3).map((j) => ({ ...j, upcoming: true })),
  ].map((j) => ({
    client: j.client,
    title: j.name,
    venue: [j.venue, j.city].filter(Boolean).join(" · "),
    badges: j.badges.slice(0, 1),
    upcoming: j.upcoming,
  }));

  // Ticker: everything else from the last 30 days not already in the grid.
  const highlighted = new Set(events.map((e) => e.title));
  const ticker = recent30
    .filter((j) => !highlighted.has(j.name))
    .slice(0, 20)
    .map((j) => `<b>${escapeHtml(j.name)}</b>${j.venue ? " · " + escapeHtml(j.venue) : ""}`);

  return { metrics, heatPoints, rems, events, ticker };
}

// Airtable single-select "color" tokens (e.g. "orangeBright") -> hex, close
// enough to the mockup's REM palette for a lobby TV, not pixel-matched.
const COLOR_HEX = {
  blueBright: "#2D7FF9", blueDark1: "#1A5DC7", blueLight1: "#9CC7FF", blueLight2: "#C4E0FF",
  cyanBright: "#00BFEF", cyanDark1: "#0A8FA8", cyanLight1: "#6FD4EE", cyanLight2: "#B4EAF7",
  tealBright: "#00CFCF", tealDark1: "#00908F", tealLight1: "#6FE0DE", tealLight2: "#B2F0EE",
  greenBright: "#20C933", greenDark1: "#148A22", greenLight1: "#8AE39B", greenLight2: "#C2F0CA",
  yellowBright: "#FCB400", yellowDark1: "#B87D00", yellowLight1: "#FFDD8A", yellowLight2: "#FFEFC2",
  orangeBright: "#FF8A3D", orangeDark1: "#C4600F", orangeLight1: "#FFC08A", orangeLight2: "#FFE0C2",
  redBright: "#F82B60", redDark1: "#B8123D", redLight1: "#FF8FA8", redLight2: "#FFC7D3",
  pinkBright: "#FF08C2", pinkDark1: "#B8058C", pinkLight1: "#FF8AE0", pinkLight2: "#FFC7F0",
  purpleBright: "#8B46FF", purpleDark1: "#5E1FCC", purpleLight1: "#C6A8FF", purpleLight2: "#E0D2FF",
  grayBright: "#8C97A8", grayDark1: "#4A5568", grayLight1: "#B8C2D0", grayLight2: "#DDE3EA",
};
function colorHex(token) {
  return COLOR_HEX[token] || "#E8B44A";
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function slugify(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

async function downloadAttachment(recordId, attachment) {
  const ext = path.extname(attachment.filename || "") || guessExt(attachment.type);
  const filename = `${recordId}-${attachment.id}${ext}`;
  const dest = path.join(SYNCED_DIR, filename);

  const res = await fetch(attachment.url);
  if (!res.ok) {
    console.warn(`  ! failed to download attachment ${attachment.filename}: ${res.status}`);
    return null;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return `assets/synced/${filename}`;
}

function guessExt(mime) {
  if (!mime) return "";
  if (mime.includes("png")) return ".png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return ".jpg";
  if (mime.includes("gif")) return ".gif";
  if (mime.includes("webp")) return ".webp";
  return "";
}

async function main() {
  fs.mkdirSync(SYNCED_DIR, { recursive: true });

  console.log("Fetching Lobby Callouts...");
  const calloutRecords = await fetchAllRecords(TABLES.callouts);
  console.log("Fetching Team Bios...");
  const bioRecords = await fetchAllRecords(TABLES.bios);
  console.log("Fetching Asset Library...");
  const assetRecords = await fetchAllRecords(TABLES.assets);

  // Callouts: only Approved === true, sorted by Display Order then Byline.
  let callouts = calloutRecords
    .map((r) => r.fields)
    .filter((f) => f.Approved === true && (f.Byline || f.Text))
    .map((f) => ({
      byline: f.Byline || "",
      text: f.Text || "",
      author: f.Author || "",
      _order: typeof f["Display Order"] === "number" ? f["Display Order"] : Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => a._order - b._order || a.byline.localeCompare(b.byline))
    .map(({ _order, ...rest }) => rest);

  // Bios: prefer Show on Display === true; fail open to all bios if none are checked.
  const shown = bioRecords.filter((r) => r.fields["Show on Display"] === true);
  const bioSource = shown.length > 0 ? shown : bioRecords;

  const bios = [];
  for (const r of bioSource.sort(
    (a, b) =>
      (typeof a.fields["Display Order"] === "number" ? a.fields["Display Order"] : Number.MAX_SAFE_INTEGER) -
        (typeof b.fields["Display Order"] === "number" ? b.fields["Display Order"] : Number.MAX_SAFE_INTEGER) ||
      String(a.fields.Name || "").localeCompare(String(b.fields.Name || ""))
  )) {
    const f = r.fields;
    let photo = null;
    const headshots = f.Headshot;
    if (Array.isArray(headshots) && headshots.length > 0) {
      photo = await downloadAttachment(r.id, headshots[0]);
    }
    bios.push({
      name: f.Name || "",
      title: f.Title || "",
      bio: f.Notes || "",
      photo,
    });
  }

  // Asset Library -> brand logos (matched by name) + a general photo gallery
  // (everything else with an attachment, minus personal/staff portraits).
  const brand = { headerLogo: null, fullLogoLight: null, fullLogoDark: null };
  const gallery = [];

  for (const r of assetRecords) {
    const name = r.fields.Name || "";
    const atts = r.fields.Attachments;
    if (!Array.isArray(atts) || atts.length === 0) continue;

    const path = await downloadAttachment(r.id, atts[0]);
    if (!path) continue;

    const lower = name.toLowerCase();
    if (lower.includes("logo")) {
      if (lower.includes("header")) brand.headerLogo = path;
      else if (lower.includes("light")) brand.fullLogoLight = path;
      else if (lower.includes("dark")) brand.fullLogoDark = path;
      continue;
    }
    if (GALLERY_EXCLUDE_NAMES.has(name)) continue;
    gallery.push({ name, photo: path });
  }

  console.log("Fetching ops metrics (job log, offices, REMs)...");
  const ops = await fetchOpsMetrics();

  // "On the record" quote cards reuse the same approved Lobby Callouts —
  // byline becomes the quote, author stays the author.
  const linkedin = callouts.map((c) => ({
    quote: c.text || c.byline,
    author: c.author || "JRM Security",
    role: "Company Page · LinkedIn",
    date: "",
  }));

  const data = {
    generatedAt: new Date().toISOString(),
    callouts,
    team: bios,
    brand,
    gallery,
    metrics: ops.metrics,
    heatPoints: ops.heatPoints,
    rems: ops.rems,
    events: ops.events,
    ticker: ops.ticker,
    linkedin,
    photos: gallery.map((g) => ({ title: g.name, meta: "", path: g.photo })),
  };

  fs.writeFileSync(path.join(REPO_ROOT, "data.json"), JSON.stringify(data, null, 2) + "\n");
  console.log(
    `Wrote data.json — ${callouts.length} callout(s), ${bios.length} bio(s), ${gallery.length} gallery photo(s), ` +
      `${ops.metrics.eventsYTD} events YTD, ${ops.rems.length} REM(s).`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
