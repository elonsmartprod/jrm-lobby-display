# JRM Lobby Display

A full-screen kiosk splash page for JRM Private Security's office lobby. It cycles
between marketing callouts and team bios, hosted free on GitHub Pages, with content
pulled from Airtable so marketing can update the screen without touching code.

**Live URL:** https://elonsmartprod.github.io/jrm-lobby-display/

## How marketing updates content

All content lives in the `JRM Marketing` Airtable base:
https://airtable.com/appzYjL42rxnYTaJy

- **Lobby Callouts** — add a Byline, Text, and Author, then check **Approved**.
  Unapproved callouts never appear on the display.
- **Team Bios** — check **Show on Display** for anyone who should appear (if
  nobody is checked, all bios show by default). Upload a photo to **Headshot**;
  people without a headshot show as a gold monogram instead. **Display Order**
  controls the order bios/callouts appear in on both tables.

Changes show up on the lobby screen automatically within an hour (the sync runs
hourly). To push an update immediately, go to the repo's **Actions** tab →
**Sync Airtable content** → **Run workflow**.

## How it works

- `scripts/sync.js` reads the three Airtable tables, downloads any attachments
  into `assets/synced/` (Airtable's own attachment links expire, so images are
  re-hosted in the repo), and writes `data.json`.
- `.github/workflows/sync.yml` runs that script hourly, on demand, and on every
  push to `main`, committing `data.json`/`assets/synced` only when something
  changed.
- `.github/workflows/deploy.yml` publishes the repo to GitHub Pages on every
  push to `main`.
- `index.html` is a single-file, dependency-free kiosk page that fetches
  `data.json` and crossfades between slides. It re-fetches data every 10
  minutes and does a full reload each night at 4am to pick up any deploy.

## Local setup notes

- The Airtable PAT lives only in the repo secret `AIRTABLE_TOKEN` and is used
  exclusively inside GitHub Actions — it is never present in client-side code.
- The repo and site are public; nothing in `index.html` or `data.json` should
  ever contain the token or unpublished content.
