# Portfolio Atlas

Live local portfolio dashboard.

## Data Store

Portfolio data lives in:

```text
dashboard/data/portfolio.json
```

When you ask me to update holdings from screenshots, this is the file I should update. The Atlas UI and Netlify backend both read from it.

## Run Locally

```powershell
cd C:\Users\Admin\Documents\investments\dashboard
node .\server.mjs
```

Open:

```text
http://localhost:4173
```

Portfolio Atlas now reads `/api/portfolio` from the local Node server. The server uses `data/portfolio.json` as the base holdings store, then refreshes live gold and silver prices before sending data to the browser.

The app refreshes every 60 seconds. The server caches metal prices for 5 minutes so refreshes stay quick and do not hammer the source sites. Gold currently uses BullionLive first, then Goodreturns as backup. Silver uses BullionLive first, then Goodreturns as backup.

## Updating Holdings

When you send new screenshots and I update your holdings, I can update `data/portfolio.json` directly. The Excel file is no longer required for Portfolio Atlas to run.

The old Excel exporter still exists as a migration/helper script, but it is no longer part of the normal Atlas workflow.

## Netlify

The repo includes a root `netlify.toml` that publishes `dashboard` and routes `/api/portfolio` to a Netlify Function.

To make updates automatic on your live Netlify page, connect this folder to a GitHub repo and connect that repo to Netlify. After that, whenever I update `dashboard/data/portfolio.json` and push the change, Netlify deploys automatically. No manual upload needed.

## Check Live Data

```powershell
node .\server.mjs --check-live
```
