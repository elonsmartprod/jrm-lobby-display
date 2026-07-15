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

const TOKEN = process.env.AIRTABLE_TOKEN;
if (!TOKEN) {
  console.error("Missing AIRTABLE_TOKEN env var");
  process.exit(1);
}

const REPO_ROOT = path.resolve(__dirname, "..");
const SYNCED_DIR = path.join(REPO_ROOT, "assets", "synced");

async function fetchAllRecords(tableId) {
  const records = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${tableId}`);
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);
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

  const data = {
    generatedAt: new Date().toISOString(),
    callouts,
    team: bios,
  };

  fs.writeFileSync(path.join(REPO_ROOT, "data.json"), JSON.stringify(data, null, 2) + "\n");
  console.log(`Wrote data.json — ${callouts.length} callout(s), ${bios.length} bio(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
