import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

function parseNumber(value) {
  const number = Number(String(value || "").replace(/[\u20b9,\s]/g, ""));
  return Number.isFinite(number) ? number : null;
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

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en-IN,en;q=0.9",
        "user-agent": "Mozilla/5.0 PortfolioAtlas/1.0",
      },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "accept-language": "en-IN,en;q=0.9",
        "user-agent": "Mozilla/5.0 PortfolioAtlas/1.0",
      },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function extractGoldPrice(text) {
  const normalized = text.replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  const patterns = [
    /gold\s+price[^₹]{0,220}₹\s*([0-9,]+)\s*per\s+gram\s+for\s+24\s+karat/i,
    /24\s*K(?:arat)?\s+Gold[\s\S]{0,320}?₹\s*([0-9,]+)/i,
    /Gold\s+24K[\s\S]{0,220}?₹\s*([0-9,]+)/i,
    /24K\s*\(999\)₹\s*([0-9,]+)/i,
    /Gram\s+24K[^₹]{0,80}1\s+₹\s*([0-9,]+)/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const price = match ? parseNumber(match[1]) : null;
    if (price && price > 1000 && price < 100000) return price;
  }
  return null;
}

function extractSilverPrice(text) {
  const normalized = text.replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  const patterns = [
    /999\s+Silver[^₹]{0,120}₹\s*([0-9,]+)\s*per\s+gram/i,
    /price\s+of\s+silver[^₹]{0,220}₹\s*([0-9,]+)\s*per\s+gram/i,
    /Silver\s*\/g[^₹]{0,80}₹\s*([0-9,]+)/i,
    /Today\s+Silver\s+Price\s+Per\s+Gram\/Kg[^₹]{0,260}1\s+₹\s*([0-9,]+)/i,
    /Silver[^₹]{0,120}₹\s*([0-9,]+)\s*(?:\/|\s+per\s+)?kg/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    let price = match ? parseNumber(match[1]) : null;
    if (!price) continue;
    if (price > 1000) price = price / 1000;
    if (price > 10 && price < 1000) return price;
  }
  return null;
}

async function fetchMetal(source) {
  const text = await fetchText(source.url);
  const price = source.extract(text);
  if (!price) throw new Error(`Could not parse ${source.name}`);
  return {
    name: source.name,
    url: source.url,
    price,
    fetchedAt: new Date().toISOString(),
  };
}

async function firstSuccessful(sources) {
  const errors = [];
  for (const source of sources) {
    try {
      return await fetchMetal(source);
    } catch (error) {
      errors.push(`${source.name}: ${error.message}`);
    }
  }
  return { error: errors.join("; ") };
}

async function fetchAedInrRate() {
  const sources = [
    {
      name: "open.er-api.com AED-INR",
      url: "https://open.er-api.com/v6/latest/AED",
      read: (json) => json?.rates?.INR,
    },
    {
      name: "currency-api AED-INR",
      url: "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/aed.json",
      read: (json) => json?.aed?.inr,
    },
  ];
  const errors = [];
  for (const source of sources) {
    try {
      const rate = Number(source.read(await fetchJson(source.url)));
      if (Number.isFinite(rate) && rate > 10 && rate < 40) {
        return {
          name: source.name,
          url: source.url,
          rate,
          fetchedAt: new Date().toISOString(),
        };
      }
      throw new Error("Could not parse AED-INR rate");
    } catch (error) {
      errors.push(`${source.name}: ${error.message}`);
    }
  }
  return { error: errors.join("; ") };
}

function lookupKey(holding) {
  const match = String(holding.notes || "").match(/Lookup key retained:\s*([A-Z0-9_:.&-]+)/i);
  return (match?.[1] || "").replace(/[.\s]+$/g, "");
}

function yahooSymbolFromLookup(key) {
  const match = key.match(/^NSE:(.+)$/i);
  return match ? `${match[1]}.NS` : "";
}

async function fetchYahooPrice(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  const json = await fetchJson(url);
  const meta = json?.chart?.result?.[0]?.meta;
  const price = Number(meta?.regularMarketPrice ?? meta?.previousClose ?? meta?.chartPreviousClose);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`Could not parse Yahoo price for ${symbol}`);
  return {
    name: `Yahoo Finance ${symbol}`,
    url,
    price,
    fetchedAt: new Date().toISOString(),
  };
}

function compactFundName(name) {
  return String(name || "")
    .replace(/\s*-\s*/g, " ")
    .replace(/\bDIRECT\b/gi, "DIRECT")
    .replace(/\bPLAN\b/gi, "PLAN")
    .replace(/\s+/g, " ")
    .trim();
}

const MF_SCHEME_CODES = new Map([
  ["PARAG PARIKH FLEXI CAP FUND - DIRECT PLAN", "122639"],
  ["KOTAK SMALL CAP FUND - DIRECT PLAN", "120164"],
  ["HDFC MID CAP FUND - DIRECT PLAN", "118989"],
  ["ICICI PRUDENTIAL LARGE CAP FUND - DIRECT PLAN", "120586"],
  ["NIPPON INDIA LARGE CAP FUND - DIRECT PLAN", "118632"],
  ["SBI LARGE & MIDCAP FUND - DIRECT PLAN", "119721"],
  ["NIPPON INDIA SMALL CAP FUND - DIRECT PLAN", "118778"],
  ["DSP NIFTY 50 EQUAL WEIGHT INDEX FUND - DIRECT PLAN", "141877"],
  ["MOTILAL OSWAL LARGE AND MIDCAP FUND - DIRECT PLAN", "147704"],
  ["HDFC SMALL CAP FUND - DIRECT PLAN", "130503"],
  ["ADITYA BIRLA SUN LIFE NIFTY 50 INDEX FUND - DIRECT PLAN", "119648"],
  ["ADITYA BIRLA SUN LIFE DIGITAL INDIA FUND - DIRECT PLAN", "120539"],
  ["ADITYA BIRLA SUN LIFE CRISIL-IBX AAA FINANCIALSERVICESINDEX-SEP2027 FUND-DP", "153030"],
  ["MOTILAL OSWAL NIFTY MIDSMALL FINANCIAL SERVICES INDEX FUND - DIRECT PLAN", "153027"],
  ["MOTILAL OSWAL NIFTY MIDSMALL HEALTHCARE INDEX FUND - DIRECT PLAN", "153023"],
  ["MOTILAL OSWAL NIFTY MIDSMALL INDIA CONSUMPTION INDEX FUND - DIRECT PLAN", "153025"],
  ["MOTILAL OSWAL FLEXI CAP FUND - DIRECT PLAN", "129046"],
]);

function scoreScheme(candidate, fundName) {
  const scheme = String(candidate.schemeName || "").toUpperCase();
  const fund = compactFundName(fundName).toUpperCase();
  const tokens = fund
    .replace(/\b(DIRECT|PLAN|FUND)\b/g, "")
    .split(/[^A-Z0-9]+/)
    .filter((token) => token.length > 1);
  let score = 0;
  for (const token of tokens) if (scheme.includes(token)) score += 5;
  if (scheme.includes("DIRECT")) score += 15;
  if (scheme.includes("GROWTH")) score += 10;
  if (scheme.includes("IDCW") || scheme.includes("DIVIDEND")) score -= 20;
  return score;
}

async function findMfSchemeCode(fundName) {
  const query = compactFundName(fundName);
  const results = await fetchJson(`https://api.mfapi.in/mf/search?q=${encodeURIComponent(query)}`);
  if (!Array.isArray(results) || !results.length) throw new Error(`No MF scheme found for ${fundName}`);
  const [best] = results
    .map((candidate) => ({ ...candidate, score: scoreScheme(candidate, fundName) }))
    .sort((left, right) => right.score - left.score);
  if (!best?.schemeCode || best.score <= 0) throw new Error(`Could not match MF scheme for ${fundName}`);
  return best.schemeCode;
}

async function fetchMfNav(fundName) {
  const schemeCode = MF_SCHEME_CODES.get(fundName) || await findMfSchemeCode(fundName);
  const url = `https://api.mfapi.in/mf/${schemeCode}/latest`;
  const json = await fetchJson(url);
  const nav = Number(json?.data?.[0]?.nav);
  if (!Number.isFinite(nav) || nav <= 0) throw new Error(`Could not parse NAV for ${fundName}`);
  return {
    name: `AMFI NAV ${json?.meta?.scheme_name || fundName}`,
    url,
    price: nav,
    schemeCode,
    navDate: json?.data?.[0]?.date || null,
    fetchedAt: new Date().toISOString(),
  };
}

async function settleTargets(targets, limit = targets.length || 1) {
  const results = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < targets.length) {
      const target = targets[nextIndex++];
      try {
        results.push({ target, status: "fulfilled", value: [target.id, await target.fetch()] });
      } catch (error) {
        results.push({ target, status: "rejected", reason: error });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, targets.length) }, worker));
  return results;
}

async function getLiveSecurityPrices(holdings) {
  const targets = [];
  for (const holding of holdings) {
    if (!holding.quantity) continue;
    const key = lookupKey(holding);
    if (holding.source === "LOCAL_PRICE" && key.startsWith("NSE:")) targets.push({ id: key, holding, type: "NSE", fetch: () => fetchYahooPrice(yahooSymbolFromLookup(key)) });
    if (holding.type === "Mutual Funds") targets.push({ id: holding.asset, holding, type: "MF", fetch: () => fetchMfNav(holding.asset) });
  }

  const uniqueTargets = [...new Map(targets.map((target) => [target.id, target])).values()];
  const nseTargets = uniqueTargets.filter((target) => target.type === "NSE");
  const mfTargets = uniqueTargets.filter((target) => target.type === "MF");
  const settled = [
    ...await settleTargets(nseTargets),
    ...await settleTargets(mfTargets, 3),
  ];
  const prices = {};
  const errors = {};
  settled.forEach((result) => {
    if (result.status === "fulfilled") {
      const [id, price] = result.value;
      prices[id] = price;
    } else {
      errors[result.target?.id || "unknown"] = result.reason?.message || String(result.reason);
    }
  });
  return { fetchedAt: Date.now(), prices, errors };
}

function applyMetalPrice(holdings, type, source, metal) {
  if (!metal?.price) return;
  for (const holding of holdings) {
    if (holding.type !== type || holding.source !== source || !holding.quantity) continue;
    holding.value = metal.price * holding.quantity;
    holding.pnl = holding.value - holding.invested;
    holding.returnRate = holding.invested ? holding.pnl / holding.invested : 0;
    const baseNote = String(holding.notes || "").replace(/Live Atlas used .*$/g, "").trim();
    holding.notes = `${baseNote} Live Atlas used ${metal.name} at INR ${metal.price}/g.`.trim();
  }
}

function applyAedInrRate(holdings, fx) {
  if (!fx?.rate) return;
  for (const holding of holdings) {
    if (holding.type !== "Fractional Real Estate" || holding.platform !== "Stake" || !holding.quantity) continue;
    holding.value = holding.quantity * fx.rate;
    holding.pnl = holding.value - holding.invested;
    holding.returnRate = holding.invested ? holding.pnl / holding.invested : 0;
    const baseNote = String(holding.notes || "").replace(/Live Atlas used .*$/g, "").trim();
    holding.notes = `${baseNote} Live Atlas used ${fx.name} at INR ${fx.rate}/AED.`.trim();
  }
}

function applySecurityPrices(holdings, liveQuotes) {
  if (!liveQuotes?.prices) return;
  for (const holding of holdings) {
    if (!holding.quantity) continue;
    if (holding.source !== "LOCAL_PRICE" && holding.type !== "Mutual Funds") continue;
    const key = holding.type === "Mutual Funds" ? holding.asset : lookupKey(holding);
    const quote = liveQuotes.prices[key];
    if (!quote?.price) continue;
    holding.value = quote.price * holding.quantity;
    holding.pnl = holding.value - holding.invested;
    holding.returnRate = holding.invested ? holding.pnl / holding.invested : 0;
    const baseNote = String(holding.notes || "").replace(/Live Atlas used .*$/g, "").trim();
    holding.notes = `${baseNote} Live Atlas used ${quote.name} at INR ${quote.price}.`.trim();
  }
}

export async function handler() {
  try {
    const base = await readBasePortfolio();
    const holdings = (base.holdings || []).map((holding) => ({ ...holding }));

    const [goldResult, silverResult, fxResult] = await Promise.all([
      firstSuccessful([
        { name: "BullionLive 24K gold", url: "https://bullionlive.app/", extract: extractGoldPrice },
        { name: "Goodreturns Gurgaon gold", url: "https://www4.goodreturns.in/gold-rates/gurgaon.html", extract: extractGoldPrice },
        { name: "Goodreturns Delhi gold", url: "https://www4.goodreturns.in/gold-rates/delhi.html", extract: extractGoldPrice },
      ]),
      firstSuccessful([
        { name: "BullionLive 999 silver", url: "https://bullionlive.app/", extract: extractSilverPrice },
        { name: "Goodreturns India silver", url: "https://www.goodreturns.in/silver-rates/", extract: extractSilverPrice },
        { name: "Goodreturns Delhi silver", url: "https://www.goodreturns.in/silver-rates/delhi.html", extract: extractSilverPrice },
      ]),
      fetchAedInrRate(),
    ]);

    const liveGold = goldResult.price ? goldResult : base.liveGold || null;
    const liveSilver = silverResult.price ? silverResult : base.liveSilver || null;
    const liveFx = fxResult.rate ? fxResult : base.liveFx || null;
    const liveQuotes = await getLiveSecurityPrices(holdings);

    applySecurityPrices(holdings, liveQuotes);
    applyMetalPrice(holdings, "Gold", "GOLD_PRICE", liveGold);
    applyMetalPrice(holdings, "Silver", "SILVER_PRICE", liveSilver);
    applyAedInrRate(holdings, liveFx);

    return response(200, {
      ...base,
      source: "Portfolio Atlas Netlify backend",
      exportedAt: new Date().toISOString(),
      liveGold,
      liveSilver,
      liveFx,
      liveQuotes: {
        fetchedAt: liveQuotes.fetchedAt ? new Date(liveQuotes.fetchedAt).toISOString() : null,
        updated: Object.keys(liveQuotes.prices || {}).length,
      },
      liveErrors: {
        gold: goldResult.error || null,
        silver: silverResult.error || null,
        fx: fxResult.error || null,
        quotes: liveQuotes.errors || {},
      },
      holdings,
    });
  } catch (error) {
    return response(500, { error: error.message });
  }
}
