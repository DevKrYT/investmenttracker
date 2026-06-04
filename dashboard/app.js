const REFRESH_INTERVAL_MS = 60_000;

let ASSET_TYPES = [
  { name: "Stocks", color: "#2f80ed", short: "Stocks" },
  { name: "Mutual Funds", color: "#9b51e0", short: "Mutual Funds" },
  { name: "Gold", color: "#ffd700", short: "Gold" },
  { name: "Silver", color: "#c0c0c0", short: "Silver" },
  { name: "Fractional Real Estate", color: "#00b8a9", short: "Real Estate" },
  { name: "Fixed Deposits", color: "#ff8c42", short: "Fixed Deposits" },
];

const state = {
  holdings: [],
  summaries: [],
  activeType: "All",
  query: "",
  loading: false,
  lastUpdated: null,
  liveQuotes: null,
  liveErrors: {},
  backendVersion: "",
};

const $ = (id) => document.getElementById(id);
const elements = {
  syncState: $("sync-state"),
  lastUpdated: $("last-updated"),
  refreshButton: $("refresh-button"),
  totalValue: $("total-value"),
  totalInvested: $("total-invested"),
  totalPnl: $("total-pnl"),
  totalReturn: $("total-return"),
  quoteCount: $("quote-count"),
  quoteTime: $("quote-time"),
  quoteErrors: $("quote-errors"),
  holdingCount: $("holding-count"),
  assetTypeCount: $("asset-type-count"),
  allocationDonut: $("allocation-donut"),
  allocationLegend: $("allocation-legend"),
  categoryCards: $("category-cards"),
  filterRow: $("filter-row"),
  holdingSearch: $("holding-search"),
  holdingsBody: $("holdings-body"),
  moversList: $("movers-list"),
  goldPrice: $("gold-price"),
  silverPrice: $("silver-price"),
  toast: $("toast"),
};

async function fetchPortfolioData() {
  const cacheBust = Date.now();
  try {
    const response = await fetch(`/api/portfolio?_=${cacheBust}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`/api/portfolio returned ${response.status}`);
    const portfolio = await response.json();
    return {
      ...portfolio,
      _dataSource: "Live API",
      _fetchedAt: new Date().toISOString(),
    };
  } catch (apiError) {
    const isLocalStaticPreview = ["", "localhost", "127.0.0.1"].includes(window.location.hostname);
    if (!isLocalStaticPreview) {
      throw new Error(`Live API unavailable: ${apiError.message}`);
    }

    const response = await fetch(`./data/portfolio.json?_=${cacheBust}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Static fallback returned ${response.status}`);
    const portfolio = await response.json();
    return {
      ...portfolio,
      _dataSource: "Static fallback",
      _fetchedAt: new Date().toISOString(),
    };
  }
}

function summarize(holdings) {
  return ASSET_TYPES.map((assetType) => {
    const rows = holdings.filter((holding) => holding.type === assetType.name);
    return {
      ...assetType,
      rows,
      invested: rows.reduce((sum, holding) => sum + holding.invested, 0),
      value: rows.reduce((sum, holding) => sum + holding.value, 0),
      pnl: rows.reduce((sum, holding) => sum + holding.pnl, 0),
    };
  });
}

function formatMoney(value) {
  const safeValue = Number.isFinite(value) ? value : 0;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(safeValue);
}

function formatPercent(value, signed = false) {
  const sign = signed && value > 0 ? "+" : "";
  const percentValue = (Number.isFinite(value) ? value : 0) * 100;
  return `${sign}${new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(percentValue)}%`;
}

function valueClass(value) {
  return value >= 0 ? "positive" : "negative";
}

function updateStatus(kind, title, message) {
  elements.syncState.className = `sync-state ${kind}`;
  elements.syncState.querySelector("strong").textContent = title;
  elements.lastUpdated.textContent = message;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => elements.toast.classList.remove("show"), 2800);
}

function liveSourceLabel(holding) {
  const note = String(holding.notes || "");
  if (/Live Atlas used Yahoo Finance/i.test(note)) return "LIVE Yahoo";
  if (/Live Atlas used AMFI NAV/i.test(note)) return "LIVE AMFI NAV";
  if (/Live Atlas used .*gold/i.test(note)) return "LIVE Gold";
  if (/Live Atlas used .*silver/i.test(note)) return "LIVE Silver";
  if (/Live Atlas used .*AED-INR/i.test(note)) return "LIVE AED-INR";
  return holding.source;
}

function liveSourceClass(holding) {
  return liveSourceLabel(holding).startsWith("LIVE") ? "source-live" : "";
}

function countLiveErrors(errors) {
  const quoteErrors = Object.keys(errors?.quotes || {}).length;
  const referenceErrors = ["gold", "silver", "fx"].filter((key) => errors?.[key]).length;
  return quoteErrors + referenceErrors;
}

function renderLiveMarketStatus() {
  const quoteCount = state.liveQuotes?.updated || 0;
  const quoteTime = state.liveQuotes?.fetchedAt ? new Date(state.liveQuotes.fetchedAt) : state.lastUpdated;
  const errorCount = countLiveErrors(state.liveErrors);
  const versionLabel = state.backendVersion ? ` • ${state.backendVersion}` : "";

  elements.quoteCount.textContent = quoteCount ? `${quoteCount} live quotes applied${versionLabel}` : `No live quotes applied${versionLabel}`;
  elements.quoteTime.textContent = quoteTime
    ? quoteTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "--";
  elements.quoteErrors.textContent = errorCount ? `${errorCount} source issue${errorCount === 1 ? "" : "s"}` : "All sources OK";
  elements.quoteErrors.className = errorCount ? "negative" : "positive";
}

function render() {
  const totalInvested = state.holdings.reduce((sum, holding) => sum + holding.invested, 0);
  const totalValue = state.holdings.reduce((sum, holding) => sum + holding.value, 0);
  const totalPnl = totalValue - totalInvested;
  const returnRate = totalInvested ? totalPnl / totalInvested : 0;

  elements.totalValue.textContent = formatMoney(totalValue);
  elements.totalInvested.textContent = formatMoney(totalInvested);
  elements.totalPnl.textContent = `${totalPnl >= 0 ? "+" : ""}${formatMoney(totalPnl)}`;
  elements.totalPnl.className = valueClass(totalPnl);
  elements.totalReturn.textContent = formatPercent(returnRate, true);
  elements.totalReturn.className = `hero-return ${valueClass(returnRate)}`;
  elements.holdingCount.textContent = state.holdings.length;
  elements.assetTypeCount.textContent = state.summaries.filter((summary) => summary.value > 0).length;

  const physicalGold = state.holdings.find((holding) => holding.type === "Gold" && holding.source === "GOLD_PRICE");
  const physicalGoldPrice = physicalGold ? physicalGold.value / Math.max(1, physicalGold.quantity) : 0;
  elements.goldPrice.textContent = formatMoney(physicalGoldPrice || 0);
  const physicalSilver = state.holdings.find((holding) => holding.type === "Silver" && holding.source === "SILVER_PRICE");
  const physicalSilverPrice = physicalSilver ? physicalSilver.value / Math.max(1, physicalSilver.quantity) : 0;
  elements.silverPrice.textContent = formatMoney(physicalSilverPrice || 0);
  renderLiveMarketStatus();

  renderAllocation(totalValue);
  renderCategoryCards(totalValue);
  renderFilters();
  renderHoldings();
  renderMovers();
}

function renderAllocation(totalValue) {
  let running = 0;
  const segments = state.summaries
    .filter((summary) => summary.value > 0)
    .map((summary) => {
      const start = running;
      running += totalValue ? (summary.value / totalValue) * 100 : 0;
      return `${summary.color} ${start.toFixed(3)}% ${running.toFixed(3)}%`;
    });
  elements.allocationDonut.style.background = `conic-gradient(${segments.join(", ") || "#1f3550 0 100%"})`;
  elements.allocationLegend.innerHTML = state.summaries
    .filter((summary) => summary.value > 0)
    .map((summary) => `
      <div class="legend-row" style="--category:${summary.color}">
        <i></i>
        <span>${summary.name}</span>
        <strong>${formatPercent(totalValue ? summary.value / totalValue : 0)}</strong>
      </div>
    `)
    .join("");
}

function renderCategoryCards(totalValue) {
  elements.categoryCards.innerHTML = state.summaries
    .map((summary) => `
      <article
        class="asset-card ${state.activeType === summary.name ? "active" : ""}"
        data-type="${summary.name}"
        style="--category:${summary.color}"
        tabindex="0"
        role="button"
        aria-label="Filter holdings by ${summary.name}"
      >
        <div class="asset-card-top">
          <span>${summary.short}</span>
          <span>${formatPercent(totalValue ? summary.value / totalValue : 0)}</span>
        </div>
        <h4>${formatMoney(summary.value)}</h4>
        <div class="asset-card-bottom">
          <span>${summary.rows.length} assets</span>
          <strong class="${valueClass(summary.pnl)}">${summary.pnl >= 0 ? "+" : ""}${formatMoney(summary.pnl)}</strong>
        </div>
      </article>
    `)
    .join("");
}

function renderFilters() {
  const filters = ["All", ...ASSET_TYPES.map((type) => type.name)];
  elements.filterRow.innerHTML = filters
    .map((filter) => `
      <button type="button" class="filter-pill ${state.activeType === filter ? "active" : ""}" data-filter="${filter}">
        ${filter}
      </button>
    `)
    .join("");
}

function visibleHoldings() {
  const query = state.query.trim().toLowerCase();
  return state.holdings
    .filter((holding) => state.activeType === "All" || holding.type === state.activeType)
    .filter((holding) => !query || `${holding.asset} ${holding.platform} ${holding.type}`.toLowerCase().includes(query))
    .sort((left, right) => right.value - left.value);
}

function renderHoldings() {
  const rows = visibleHoldings();
  elements.holdingsBody.innerHTML = rows.length
    ? rows.map((holding) => `
      <tr>
        <td>
          <div class="asset-cell" style="--category:${holding.color}">
            <i class="type-dot"></i>
            <div>
              <strong>${escapeHtml(holding.asset)}</strong>
              <small class="${liveSourceClass(holding)}">${escapeHtml(liveSourceLabel(holding))}</small>
            </div>
          </div>
        </td>
        <td>${escapeHtml(holding.platform)}</td>
        <td><span class="type-label" style="--category:${holding.color}">${escapeHtml(holding.typeShort)}</span></td>
        <td class="number">${formatMoney(holding.invested)}</td>
        <td class="number">${formatMoney(holding.value)}</td>
        <td class="number ${valueClass(holding.pnl)}">${holding.pnl >= 0 ? "+" : ""}${formatMoney(holding.pnl)}</td>
        <td class="number ${valueClass(holding.returnRate)}">${formatPercent(holding.returnRate, true)}</td>
      </tr>
    `).join("")
    : `<tr class="empty-row"><td colspan="7">No holdings match this view.</td></tr>`;
}

function renderMovers() {
  const movers = [...state.holdings]
    .filter((holding) => Number.isFinite(holding.returnRate))
    .sort((left, right) => Math.abs(right.returnRate) - Math.abs(left.returnRate))
    .slice(0, 5);

  elements.moversList.innerHTML = movers.length
    ? movers.map((holding) => `
      <div class="mover-row">
        <div>
          <strong>${escapeHtml(holding.asset)}</strong>
          <small>${escapeHtml(holding.typeShort)}</small>
        </div>
        <div class="mover-value ${valueClass(holding.returnRate)}">
          ${formatPercent(holding.returnRate, true)}
        </div>
      </div>
    `).join("")
    : `<div class="mover-row"><small>No performance data yet.</small></div>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function refreshData({ quiet = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  elements.refreshButton.disabled = true;
  elements.refreshButton.classList.add("loading");
  updateStatus("", "Syncing", "Refreshing live portfolio data");

  try {
    const portfolio = await fetchPortfolioData();
    ASSET_TYPES = portfolio.assetTypes || ASSET_TYPES;
    state.holdings = portfolio.holdings || [];
    state.summaries = summarize(state.holdings);
    state.lastUpdated = portfolio._fetchedAt ? new Date(portfolio._fetchedAt) : new Date();
    state.liveQuotes = portfolio.liveQuotes || null;
    state.liveErrors = portfolio.liveErrors || {};
    state.backendVersion = portfolio.backendVersion || "";
    render();
    const sourceLabel = portfolio._dataSource === "Live API" ? "Live" : "Static";
    const quoteText = state.liveQuotes?.updated ? ` • ${state.liveQuotes.updated} quotes` : "";
    updateStatus("online", sourceLabel, `Updated ${state.lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${quoteText}`);
    if (!quiet) showToast("Portfolio refreshed live");
  } catch (error) {
    console.error(error);
    updateStatus("error", "Live API down", error.message);
    showToast(error.message);
  } finally {
    state.loading = false;
    elements.refreshButton.disabled = false;
    elements.refreshButton.classList.remove("loading");
  }
}

elements.refreshButton.addEventListener("click", () => refreshData());
elements.holdingSearch.addEventListener("input", (event) => {
  state.query = event.target.value;
  renderHoldings();
});
elements.filterRow.addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  state.activeType = button.dataset.filter;
  renderCategoryCards(state.holdings.reduce((sum, holding) => sum + holding.value, 0));
  renderFilters();
  renderHoldings();
});
elements.categoryCards.addEventListener("click", (event) => {
  const card = event.target.closest("[data-type]");
  if (!card) return;
  state.activeType = state.activeType === card.dataset.type ? "All" : card.dataset.type;
  renderCategoryCards(state.holdings.reduce((sum, holding) => sum + holding.value, 0));
  renderFilters();
  renderHoldings();
});
elements.categoryCards.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const card = event.target.closest("[data-type]");
  if (!card) return;
  event.preventDefault();
  card.click();
});

refreshData({ quiet: true });
window.setInterval(() => refreshData({ quiet: true }), REFRESH_INTERVAL_MS);
