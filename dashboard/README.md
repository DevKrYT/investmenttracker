# Portfolio Atlas

Static portfolio dashboard.

## Data Store

Portfolio data lives in:

```text
dashboard/data/portfolio.json
```

When you ask me to update holdings from screenshots or market data, this is the file I should update. The Atlas UI reads from it directly.

## Run Locally

Open `dashboard/index.html`, or serve the `dashboard` folder with any static file server.

Open:

```text
http://localhost:4173
```

Portfolio Atlas reads `data/portfolio.json` directly. There is no market-data backend.

## Updating Holdings

When you send new screenshots or say `UPDATE EVERYTHING`, I can update `data/portfolio.json` directly. The Excel file is no longer required for Portfolio Atlas to run.

For `UPDATE EVERYTHING`, update stock/ETF prices, physical gold and silver prices, and mutual fund NAVs. Always use Goodreturns Gurgaon 24K gold for the physical gold row. Leave Stake, Frax, and fixed deposits unchanged unless explicitly requested.

## Netlify

The repo includes a root `netlify.toml` that publishes `dashboard`.

To make updates automatic on your Netlify page, connect this folder to a GitHub repo and connect that repo to Netlify. After that, whenever I update `dashboard/data/portfolio.json` and push the change, Netlify deploys automatically. No manual upload needed.
