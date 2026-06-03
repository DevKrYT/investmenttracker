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

export async function handler() {
  try {
    const base = await readBasePortfolio();
    const holdings = (base.holdings || []).map((holding) => ({ ...holding }));

    const [goldResult, silverResult] = await Promise.all([
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
    ]);

    const liveGold = goldResult.price ? goldResult : base.liveGold || null;
    const liveSilver = silverResult.price ? silverResult : base.liveSilver || null;

    applyMetalPrice(holdings, "Gold", "GOLD_PRICE", liveGold);
    applyMetalPrice(holdings, "Silver", "SILVER_PRICE", liveSilver);

    return response(200, {
      ...base,
      source: "Portfolio Atlas Netlify backend",
      exportedAt: new Date().toISOString(),
      liveGold,
      liveSilver,
      liveErrors: {
        gold: goldResult.error || null,
        silver: silverResult.error || null,
      },
      holdings,
    });
  } catch (error) {
    return response(500, { error: error.message });
  }
}
