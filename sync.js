name: Sync Airtable content

on:
  schedule:
    - cron: "17 * * * *"
  workflow_dispatch: {}
  push:
    branches: [main]

permissions:
  contents: write

# Runs are queued one-at-a-time (not cancelled) so an hourly sync landing
# right after a manual push can't race it and get its push rejected as
# non-fast-forward. Each queued run still checks out main fresh, so it
# always starts from the latest commit once its turn comes.
concurrency:
  group: sync-airtable
  cancel-in-progress: false

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Run sync
        env:
          AIRTABLE_TOKEN: ${{ secrets.AIRTABLE_TOKEN }}
        run: node scripts/sync.js

      - name: Commit and push if changed
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add data.json assets/synced
          # Intentionally no [skip ci]: the deploy workflow also listens for
          # pushes to main, and needs to pick up the refreshed data.json.
          # A commit here re-triggers this workflow too, but it's a no-op
          # (nothing left to diff), so it doesn't loop.
          git diff --quiet --cached || git commit -m "Sync content from Airtable"
          # Belt-and-suspenders on top of the concurrency group above: if the
          # remote still moved since checkout, rebase onto it and retry once
          # rather than failing the whole run.
          git push || (git pull --rebase origin main && git push)
