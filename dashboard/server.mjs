import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const portfolioPath = path.join(__dirname, "data", "portfolio.json");
const metalCacheMs = 5 * 60 * 1000;

let metalCache = {
  fetchedAt: 0,
  gold: null,
  silver: null,
  fx: null,
};

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".ico", "image/x-icon"],
]);

function json(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, no-cache, max-age=0, must-revalidate",
  });
  response.end(JSON.stringify(payload, null, 2));
}

function parseNumber(value) {
  const number = Number(String(value || "").replace(/[\u20b9,\s]/g, ""));
  return Number.isFinite(number) ? number : null;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "accept": "text/html,application/xhtml+xml",
        "accept-language": "en-IN,en;q=0.9",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
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
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) PortfolioAtlas/1.0",
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
    /Gold\s+Rate\s+in\s+Gurgaon[^₹]{0,220}₹\s*([0-9,]+)/i,
    /Gold\s+Rate\s+in\s+Delhi[^₹]{0,220}₹\s*([0-9,]+)/i,
    /₹\s*([0-9,]+)\s*\/?\s*(?:gm|gram)[^0-9]{0,80}24\s*K/i,
    /24\s*K[^0-9₹]{0,120}1\s*(?:gm|gram)?[^₹]{0,120}₹\s*([0-9,]+)/i,
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
    /Silver\s+Rate\s+Today[^₹]{0,220}₹\s*([0-9,]+)\s*(?:\/|\s+per\s+)?(?:gm|gram)/i,
    /Silver\s+Rate\s+in\s+India[^₹]{0,220}₹\s*([0-9,]+)\s*(?:\/|\s+per\s+)?(?:gm|gram)/i,
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

async function getLiveMetals() {
  const now = Date.now();
  if (now - metalCache.fetchedAt < metalCacheMs && (metalCache.gold || metalCache.silver)) {
    return metalCache;
  }

  const [goldResult, silverResult, fxResult] = await Promise.all([
    firstSuccessful([
      { name: "BullionLive 24K gold", url: "https://bullionlive.app/", extract: extractGoldPrice },
      { name: "Goodreturns Gurgaon gold", url: "https://www4.goodreturns.in/gold-rates/gurgaon.html", extract: extractGoldPrice },
      { name: "Goodreturns Delhi gold", url: "https://www4.goodreturns.in/gold-rates/delhi.html", extract: extractGoldPrice },
      { name: "Goodreturns Gurgaon gold", url: "https://www.goodreturns.in/gold-rates/gurgaon.html", extract: extractGoldPrice },
      { name: "Goodreturns Delhi gold", url: "https://www.goodreturns.in/gold-rates/delhi.html", extract: extractGoldPrice },
    ]),
    firstSuccessful([
      { name: "BullionLive 999 silver", url: "https://bullionlive.app/", extract: extractSilverPrice },
      { name: "Goodreturns India silver", url: "https://www.goodreturns.in/silver-rates/", extract: extractSilverPrice },
      { name: "Goodreturns Delhi silver", url: "https://www.goodreturns.in/silver-rates/delhi.html", extract: extractSilverPrice },
    ]),
    fetchAedInrRate(),
  ]);

  metalCache = {
    fetchedAt: now,
    gold: goldResult.price ? goldResult : metalCache.gold,
    silver: silverResult.price ? silverResult : metalCache.silver,
    fx: fxResult.rate ? fxResult : metalCache.fx,
    errors: {
      gold: goldResult.error || null,
      silver: silverResult.error || null,
      fx: fxResult.error || null,
    },
  };

  return metalCache;
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

async function buildPortfolio() {
  const base = JSON.parse(await fs.readFile(portfolioPath, "utf8"));
  const holdings = (base.holdings || []).map((holding) => ({ ...holding }));
  const metals = await getLiveMetals();

  applyMetalPrice(holdings, "Gold", "GOLD_PRICE", metals.gold);
  applyMetalPrice(holdings, "Silver", "SILVER_PRICE", metals.silver);
  applyAedInrRate(holdings, metals.fx);

  return {
    ...base,
    source: "Portfolio Atlas live server",
    exportedAt: new Date().toISOString(),
    liveGold: metals.gold || base.liveGold || null,
    liveSilver: metals.silver || base.liveSilver || null,
    liveFx: metals.fx || base.liveFx || null,
    liveErrors: metals.errors || {},
    holdings,
  };
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const decodedPath = decodeURIComponent(url.pathname);
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const filePath = path.resolve(__dirname, relativePath);

  if (!filePath.startsWith(__dirname)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const body = await fs.readFile(filePath);
    const contentType = mimeTypes.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
    response.writeHead(200, {
      "content-type": contentType,
      "cache-control": relativePath === "index.html" ? "no-store" : "public, max-age=60",
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

if (process.argv.includes("--check-live")) {
  const portfolio = await buildPortfolio();
  console.log(JSON.stringify({
    source: portfolio.source,
    holdings: portfolio.holdings.length,
    liveGold: portfolio.liveGold,
    liveSilver: portfolio.liveSilver,
    liveErrors: portfolio.liveErrors,
  }, null, 2));
  process.exit(0);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === "/api/portfolio") {
      json(response, 200, await buildPortfolio());
      return;
    }
    await serveStatic(request, response);
  } catch (error) {
    console.error(error);
    json(response, 500, { error: error.message });
  }
});

server.listen(port, () => {
  console.log(`Portfolio Atlas live server running at http://localhost:${port}`);
});
