const fs = require("node:fs/promises");
const path = require("node:path");

function response(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, no-cache, max-age=0, must-revalidate",
      "netlify-cdn-cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
    body: JSON.stringify(payload),
  };
}

async function readBasePortfolio() {
  const candidates = [
    path.resolve(process.cwd(), "dashboard", "data", "portfolio.json"),
    path.resolve(process.cwd(), "data", "portfolio.json"),
    path.resolve(__dirname, "..", "..", "data", "portfolio.json"),
    path.resolve(__dirname, "..", "..", "..", "data", "portfolio.json"),
  ];

  for (const candidate of candidates) {
    try {
      return JSON.parse(await fs.readFile(candidate, "utf8"));
    } catch {
      // Try the next runtime path.
    }
  }
  throw new Error("Could not find dashboard/data/portfolio.json");
}

async function fetchJson(url, timeoutMs = 2_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "accept-language": "en-IN,en;q=0.9",
        "user-agent": "Mozilla/5.0 PortfolioAtlas/1.0",
      },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function lookupKey(holding) {
  const match = String(holding.notes || "").match(/Lookup key retained:\s*([A-Z0-9_:.&-]+)/i);
  return (match?.[1] || "").replace(/[.\s]+$/g, "");
}

function yahooSymbolFromLookup(key) {
  const match = key.match(/^NSE:(.+)$/i);
  return match ? `${match[1]}.NS` : "";
}

async function fetchYahooPrice(target) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(target.symbol)}?range=1d&interval=1d`;
  const json = await fetchJson(url);
  const meta = json?.chart?.result?.[0]?.meta;
  const price = Number(meta?.regularMarketPrice ?? meta?.previousClose ?? meta?.chartPreviousClose);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`Could not parse Yahoo price for ${target.symbol}`);
  return [target.id, {
    name: `Yahoo Finance ${target.symbol}`,
    url,
    price,
    fetchedAt: new Date().toISOString(),
  }];
}

async function settleTargets(targets, limit = targets.length || 1) {
  const results = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < targets.length) {
      const target = targets[nextIndex++];
      try {
        results.push({ target, status: "fulfilled", value: await fetchYahooPrice(target) });
      } catch (error) {
        results.push({ target, status: "rejected", reason: error });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, targets.length) }, worker));
  return results;
}

async function getLiveStockPrices(holdings) {
  const targets = holdings
    .filter((holding) => holding.source === "LOCAL_PRICE" && holding.quantity)
    .map((holding) => {
      const id = lookupKey(holding);
      return { id, symbol: yahooSymbolFromLookup(id) };
    })
    .filter((target) => target.id.startsWith("NSE:") && target.symbol);

  const uniqueTargets = [...new Map(targets.map((target) => [target.id, target])).values()];
  const settled = await settleTargets(uniqueTargets, 10);
  const prices = {};
  const errors = {};

  for (const result of settled) {
    if (result.status === "fulfilled") {
      const [id, quote] = result.value;
      prices[id] = quote;
    } else {
      errors[result.target?.id || "unknown"] = result.reason?.message || String(result.reason);
    }
  }

  return { fetchedAt: Date.now(), prices, errors };
}

function applySecurityPrices(holdings, liveQuotes) {
  for (const holding of holdings) {
    if (holding.source !== "LOCAL_PRICE" || !holding.quantity) continue;
    const quote = liveQuotes.prices[lookupKey(holding)];
    if (!quote?.price) continue;
    holding.value = quote.price * holding.quantity;
    holding.pnl = holding.value - holding.invested;
    holding.returnRate = holding.invested ? holding.pnl / holding.invested : 0;
    const baseNote = String(holding.notes || "").replace(/Live Atlas used .*$/g, "").trim();
    holding.notes = `${baseNote} Live Atlas used ${quote.name} at INR ${quote.price}.`.trim();
  }
}

exports.handler = async function handler() {
  try {
    const base = await readBasePortfolio();
    const holdings = (base.holdings || []).map((holding) => ({ ...holding }));
    const liveQuotes = await getLiveStockPrices(holdings);

    applySecurityPrices(holdings, liveQuotes);

    return response(200, {
      ...base,
      source: "Portfolio Atlas Netlify CommonJS backend",
      backendVersion: "netlify-cjs-live-stocks-2026-06-04",
      exportedAt: new Date().toISOString(),
      liveGold: base.liveGold || null,
      liveSilver: base.liveSilver || null,
      liveFx: base.liveFx || null,
      liveQuotes: {
        fetchedAt: liveQuotes.fetchedAt ? new Date(liveQuotes.fetchedAt).toISOString() : null,
        updated: Object.keys(liveQuotes.prices || {}).length,
      },
      liveErrors: {
        gold: null,
        silver: null,
        fx: null,
        quotes: liveQuotes.errors || {},
      },
      holdings,
    });
  } catch (error) {
    return response(500, {
      error: error.message,
      backendVersion: "netlify-cjs-live-stocks-2026-06-04",
    });
  }
};
