/* global ethers, TradeHistory, ChartHistory */
const config = window.APP_CONFIG || {};

const NETWORK_NAME = config.name || "Unknown";
const EXPECTED_CHAIN_ID = Number(config.chainId);
const RPC_URL = config.rpcUrl || null;

const CONTRACT_ADDRESS = config.exchangeAddress || "";
const WETC_ADDRESS = config.quoteTokenAddress || "";
const DEFAULT_MARKET_ID = Number(config.defaultMarketId || 1);

const MAX_LEVELS_DEFAULT = config.maxLevels || 5;
const MAX_ORDERS_DEFAULT = config.maxOrders || 50;
const DEMO_MODE =
  new URLSearchParams(window.location.search).get("demo") === "1";

const ABI = [
  TradeHistory.TRADE_EVENT,
  "function marketCount() view returns (uint32)",
  "function marketIdOf(address lotToken) view returns (uint32)",

  "function getMarket(uint32 marketId) view returns (address lotToken,bool active,uint64 historySeq,bytes32 historyHash,int256 bestBuyTick,int256 bestSellTick,int256 lastTradeTick,uint256 lastTradeBlock,uint256 lastTradePrice,bool lastTradeTakerIsBuy,uint256 bookEscrowWETC,uint256 bookEscrowLots,uint256 bookAskLots,uint256 bookAskWETC)",

  "function getBuyBook(uint32 marketId,uint256 depth) view returns (tuple(int256 tick,uint256 price,uint256 totalLots,uint256 totalValue,uint256 orderCount)[] out,uint256 n)",
  "function getSellBook(uint32 marketId,uint256 depth) view returns (tuple(int256 tick,uint256 price,uint256 totalLots,uint256 totalValue,uint256 orderCount)[] out,uint256 n)",

  "function getBuyOrders(uint32 marketId,uint256 maxOrders) view returns (tuple(uint256 id,address owner,int256 tick,uint256 price,uint256 lotsRemaining,uint256 valueRemaining)[] out,uint256 n)",
  "function getSellOrders(uint32 marketId,uint256 maxOrders) view returns (tuple(uint256 id,address owner,int256 tick,uint256 price,uint256 lotsRemaining,uint256 valueRemaining)[] out,uint256 n)",

  "function priceAtTick(int256 tick) view returns (uint256)",

  "function cancel(uint64 id)",

  "function placeBuy(uint32 marketId,int256 tick,uint256 lots) returns (uint64)",
  "function placeSell(uint32 marketId,int256 tick,uint256 lots) returns (uint64)",

  "function takerFeeBps() view returns (uint16)",
  "function feeTreasury() view returns (address)",
];

const ERC20_ABI = [
  "function approve(address spender,uint256 amount) returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const NONE = -(2n ** 31n);

const el = {
  statusPill: document.getElementById("status-pill"),
  chainStatus: document.getElementById("chain-status"),
  connectBtn: document.getElementById("connect-btn"),
  copyBtn: document.getElementById("copy-btn"),
  depthInput: document.getElementById("depth-input"),
  depthToggle: document.getElementById("depth-toggle"),
  refreshBtn: document.getElementById("refresh-btn"),
  seedBtn: document.getElementById("seed-btn"),
  clearBtn: document.getElementById("clear-btn"),
  buyBook: document.getElementById("buy-book"),
  sellBook: document.getElementById("sell-book"),
  lastTaken: document.getElementById("last-taken"),
  lastTakenPrice: document.getElementById("last-taken-price"),
  bestBid: document.getElementById("best-bid"),
  bestAsk: document.getElementById("best-ask"),
  emptyBanner: document.getElementById("empty-banner"),
  lastTradeStat: document.getElementById("last-trade-stat"),
  lastTrade: document.getElementById("last-trade"),
  escrowTotals: document.getElementById("escrow-totals"),
  midPrice: document.getElementById("mid-price"),
  lastBlock: document.getElementById("last-block"),
  liquidity: document.getElementById("liquidity"),
  sparkline: document.getElementById("sparkline"),
  chartStatus: document.getElementById("chart-status"),
  openOrders: document.getElementById("open-orders"),
  recentTrades: document.getElementById("recent-trades"),
  lastUpdate: document.getElementById("last-update"),
  sideToggle: document.getElementById("side-toggle"),
  tickInput: document.getElementById("tick-input"),
  lotsInput: document.getElementById("lots-input"),
  previewPrice: document.getElementById("preview-price"),
  previewValue: document.getElementById("preview-value"),
  previewBtn: document.getElementById("preview-btn"),
  placeBtn: document.getElementById("place-btn"),
  addWetc: document.getElementById("add-wetc"),
  brandSub: document.getElementById("brand-sub"),
  pairTag: document.getElementById("pair-tag"),
  marketMenu: document.getElementById("market-menu"),
  addLotToken: document.getElementById("add-lot-token"),
  ticketStatus: document.getElementById("ticket-status"),
};

const state = {
  readProvider: null,
  walletProvider: null,
  signer: null,
  walletAddress: null,

  readContract: null,
  writeContract: null,

  wetc: null,
  lotToken: null,

  marketId: DEFAULT_MARKET_ID,
  markets: [],
  lotTokenAddress: null,
  lotTokenSymbol: null,
  lotTokenDecimals: null,

  side: "buy",
  demoMode: false,

  lastTradeTick: null,
  lastTradeBlock: null,
  tradeHistory: { status: "loading", trades: [], error: null },

  readSource: "wallet",
  readChainId: null,
};

const chartHistory = ChartHistory.create({ onChange: updateChart });
const recentTrades = TradeHistory.create({
  onSubscribe(options) {
    void chartHistory.start({ ...options, exchangeDeploymentBlock: config.exchangeDeploymentBlock });
  },
  onLive(trade, removed) { void chartHistory.append(trade, removed); },
  onChange(snapshot) {
    state.tradeHistory = snapshot;
    if (snapshot.status === "error") chartHistory.fail(snapshot.error);
    renderTape();
  },
});

function loadRecentTrades() {
  chartHistory.clear();
  return recentTrades.start(state.readContract, state.readProvider, state.marketId);
}

function toNumber(value) {
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value.toNumber === "function") return value.toNumber();
  return Number(value);
}

function formatWetc(value, digits = 4) {
  if (value === null || value === undefined) return "--";
  const formatted = ethers.formatUnits(value, 18);
  const numeric = Number(formatted);
  if (!Number.isFinite(numeric)) return formatted;
  return numeric.toFixed(digits);
}

function formatInt(value) {
  const str = BigInt(value).toString();
  return str.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatLots(value) {
  if (value === null || value === undefined) return "--";
  return formatInt(value);
}

function formatTick(value) {
  if (value === null || value === undefined) return "--";
  return BigInt(value).toString();
}

function shortAddr(addr) {
  if (!addr) return "--";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function setStatus(text, ok) {
  el.statusPill.textContent = text;
  el.statusPill.style.color = ok ? "var(--buy)" : "var(--sell)";
  el.statusPill.style.borderColor = ok
    ? "rgba(74, 211, 155, 0.4)"
    : "rgba(255, 107, 107, 0.4)";
  el.statusPill.style.background = ok
    ? "rgba(74, 211, 155, 0.12)"
    : "rgba(255, 107, 107, 0.12)";
}

function setTicketStatus(text) {
  el.ticketStatus.textContent = text;
}

function pulse(elm) {
  if (!elm) return;
  elm.classList.remove("pulse");
  void elm.offsetWidth;
  elm.classList.add("pulse");
}

function updateDepthToggle(value) {
  if (!el.depthToggle) return;
  el.depthToggle.querySelectorAll(".chip").forEach((chip) => {
    const depth = Number(chip.dataset.depth);
    chip.classList.toggle("active", depth === value);
  });
}

function setDepth(value) {
  el.depthInput.value = String(value);
  updateDepthToggle(value);
  refresh();
}

function setDemoMode(reason) {
  if (!DEMO_MODE) {
    setStatus("RPC error", false);
    el.chainStatus.textContent = reason || "No RPC";
    return;
  }
  state.demoMode = true;
  setStatus("Demo mode", false);
  el.lastUpdate.textContent = "Demo data enabled";
  el.chainStatus.textContent = reason || "No RPC";
  el.emptyBanner.hidden = true;
  renderDemo();
}

function errorMessage(err) {
  if (!err) return "Unknown error";
  return err.shortMessage || err.message || String(err);
}

async function safeCall(name, fn) {
  try {
    const value = await fn();
    return { ok: true, name, value };
  } catch (err) {
    console.warn(`RPC ${name} failed:`, err);
    return { ok: false, name, error: err };
  }
}

function renderDemo() {
  const depth = Number(el.depthInput.value) || MAX_LEVELS_DEFAULT;
  const buy = buildDemoBook("buy").slice(0, depth);
  const sell = buildDemoBook("sell").slice(0, depth);
  renderBook(el.buyBook, buy, "buy");
  renderBook(el.sellBook, sell, "sell");
  updateMidPrice(buy[0], sell[0]);
  renderLastTaken(null);
  renderOrders(buildDemoOrders(), buildDemoOrders(true));

  el.lastUpdate.textContent = `Last update: demo`;
}

async function addTokenToWallet(address, fallbackSymbol, fallbackDecimals) {
  if (!window.ethereum) {
    setTicketStatus("No injected wallet found.");
    return;
  }

  if (!address) {
    setTicketStatus("Token address missing.");
    return;
  }

  let symbol = fallbackSymbol;
  let decimals = fallbackDecimals;

  try {
    let token = null;

    if (WETC_ADDRESS && address.toLowerCase() === WETC_ADDRESS.toLowerCase()) {
      token = state.wetc;
    } else if (
      state.lotTokenAddress &&
      address.toLowerCase() === state.lotTokenAddress.toLowerCase()
    ) {
      token = state.lotToken;
    } else {
      token = new ethers.Contract(address, ERC20_ABI, state.readProvider);
    }

    if (token) {
      const [sym, dec] = await Promise.all([token.symbol(), token.decimals()]);

      symbol = sym || symbol;
      decimals = Number(dec);
    }
  } catch (err) {
    console.warn("Token metadata lookup failed:", err);
  }

  try {
    const added = await window.ethereum.request({
      method: "wallet_watchAsset",
      params: {
        type: "ERC20",
        options: {
          address,
          symbol,
          decimals,
        },
      },
    });

    setTicketStatus(added ? `${symbol} added to wallet.` : "Token not added.");
  } catch (err) {
    setTicketStatus(`Add token failed: ${errorMessage(err)}`);
  }
}

async function copyAddresses() {
  const lines = [
    `Network=${NETWORK_NAME}`,
    `ChainId=${EXPECTED_CHAIN_ID}`,
    `SaturnLotExchange=${CONTRACT_ADDRESS || "-"}`,
    `QuoteToken=${WETC_ADDRESS || "-"}`,
    `MarketId=${state.marketId}`,
    `LotToken=${state.lotTokenAddress || "-"}`,
  ];

  const text = lines.join("\n");

  try {
    await navigator.clipboard.writeText(text);
    setTicketStatus("Addresses copied to clipboard.");
  } catch (err) {
    console.warn("Clipboard failed:", err);
    setTicketStatus("Copy failed. See console for addresses.");
    console.log(text);
  }
}

async function initProvider() {
  chartHistory.clear();
  await recentTrades.stop();
  if (!window.ethereum) {
    throw new Error("No injected wallet provider found");
  }

  if (!CONTRACT_ADDRESS) {
    throw new Error(
      `No SaturnLotExchange address configured for ${NETWORK_NAME}`,
    );
  }

  state.walletProvider = new ethers.BrowserProvider(window.ethereum);
  state.readProvider = state.walletProvider;

  state.readContract = new ethers.Contract(
    CONTRACT_ADDRESS,
    ABI,
    state.readProvider,
  );

  if (WETC_ADDRESS) {
    state.wetc = new ethers.Contract(
      WETC_ADDRESS,
      ERC20_ABI,
      state.readProvider,
    );
  }

  state.readSource = "wallet";
}

async function discoverMarkets() {
  const count = Number(await state.readContract.marketCount());
  const markets = [];

  for (let marketId = 1; marketId <= count; marketId += 1) {
    const market = await state.readContract.getMarket(marketId);

    const token = new ethers.Contract(
      market.lotToken,
      ERC20_ABI,
      state.readProvider,
    );

    let symbol = `Market ${marketId}`;

    try {
      symbol = await token.symbol();
    } catch (err) {
      console.warn(`Could not read symbol for market ${marketId}:`, err);
    }

    markets.push({
      marketId,
      lotTokenAddress: market.lotToken,
      symbol,
      active: market.active,
    });
  }

  state.markets = markets;
  renderMarketMenu();
}

function renderMarketMenu() {
  if (!el.marketMenu) return;

  const quoteSymbol = config.quoteSymbol || "WETC";

  el.marketMenu.innerHTML = state.markets
    .map((market) => {
      const active = market.marketId === state.marketId ? " active" : "";

      const status = market.active ? "" : " · paused";

      return `
        <button
          class="market-option${active}"
          type="button"
          data-market-id="${market.marketId}"
        >
          ${market.symbol} / ${quoteSymbol}${status}
          <span class="market-option-id">#${market.marketId}</span>
        </button>
      `;
    })
    .join("");
}

async function selectMarket(marketId) {
  if (marketId === state.marketId) {
    el.marketMenu.hidden = true;
    return;
  }

  try {
    el.marketMenu.hidden = true;

    setTicketStatus(`Loading market ${marketId}...`);

    state.lastTradeTick = null;
    state.lastTradeBlock = null;
    chartHistory.clear();
    await recentTrades.stop();
    state.tradeHistory = { status: "loading", trades: [], error: null };
    renderTape();
    renderLastTaken(null);

    await loadMarket(marketId);

    renderMarketMenu();
    renderTape();

    setTicketStatus(
      `${state.lotTokenSymbol} / ${config.quoteSymbol || "WETC"} loaded.`,
    );

    await refresh();
  } catch (err) {
    reportTradeHistoryError(err);
    setTicketStatus(`Market load failed: ${errorMessage(err)}`);
  }
}

async function loadMarket(marketId) {
  const market = await state.readContract.getMarket(marketId);

  const lotTokenAddress = market.lotToken;

  state.marketId = Number(marketId);
  state.lotTokenAddress = lotTokenAddress;

  state.lotToken = new ethers.Contract(
    lotTokenAddress,
    ERC20_ABI,
    state.readProvider,
  );

  const [symbol, decimals] = await Promise.all([
    state.lotToken.symbol(),
    state.lotToken.decimals(),
  ]);

  state.lotTokenSymbol = symbol;
  state.lotTokenDecimals = Number(decimals);

  const quoteSymbol = config.quoteSymbol || "WETC";
  const pairLabel = `${state.lotTokenSymbol} / ${quoteSymbol}`;

  if (el.brandSub) {
    el.brandSub.textContent = `${pairLabel} - CLOB`;
  }

  if (el.pairTag) {
    el.pairTag.textContent = `${pairLabel} ▾`;
  }

  if (el.addLotToken) {
    el.addLotToken.textContent = `Add ${state.lotTokenSymbol}`;
  }

  void loadRecentTrades().catch(reportTradeHistoryError);
  return market;
}

async function connectWallet() {
  if (!window.ethereum) {
    setTicketStatus("No injected wallet found.");
    return;
  }
  try {
    if (!state.walletProvider) {
      await initProvider();
      await loadMarket(state.marketId);
    }
    await window.ethereum.request({ method: "eth_requestAccounts" });
    state.signer = await state.walletProvider.getSigner();
    state.writeContract = state.readContract.connect(state.signer);
    state.walletAddress = (await state.signer.getAddress()).toLowerCase();
    el.connectBtn.textContent = shortAddr(state.walletAddress);
    el.placeBtn.disabled = false;
    el.clearBtn.disabled = false;
    el.seedBtn.disabled = false;
    setTicketStatus("Wallet connected. Ready to place orders.");
  } catch (err) {
    setTicketStatus(`Wallet error: ${err.message || err}`);
  }
}

function updateMidPrice(bestBid, bestAsk) {
  if (!bestBid || !bestAsk) {
    el.midPrice.textContent = "--";
    return;
  }
  const mid = (BigInt(bestAsk.price) + BigInt(bestBid.price)) / 2n;
  el.midPrice.textContent = `${formatWetc(mid)} WETC`;
}

function renderLastTaken(price, takerIsBuy = null) {
  const side = price === null || takerIsBuy === null
    ? "neutral"
    : takerIsBuy ? "buy" : "sell";
  el.lastTaken.className = `last-taken ${side}`;
  el.lastTakenPrice.textContent = price === null ? "--" : formatWetc(price);
}

function renderBook(container, levels, side) {
  if (!levels.length) {
    container.innerHTML = '<div class="panel-sub">No levels.</div>';
    return;
  }

  const maxLots = Math.max(
    ...levels.map((lvl) => toNumber(lvl.totalLots)),
    1
  );

  /*
    Contract/view order:
      sells: best ask -> worse asks
      buys:  best bid -> worse bids

    Traditional stacked display:
      sells: worse asks -> best ask
      last executed price
      buys:  best bid -> worse bids
  */
  const displayLevels = levels.map((lvl, index) => ({
    lvl,
    isBest: index === 0
  }));

  if (side === "sell") {
    displayLevels.reverse();
  }

  container.innerHTML = displayLevels
    .map(({ lvl, isBest }) => {
      const depth = Math.round(
        (toNumber(lvl.totalLots) / maxLots) * 100
      );

      const tick = formatTick(lvl.tick);
      const price = formatWetc(lvl.price);
      const lots = formatLots(lvl.totalLots);
      const total = formatWetc(lvl.totalValue);

      return `
        <div class="book-row ${side}${isBest ? " best" : ""}">
          <div
            class="bar"
            style="width:${depth}%;${side === "buy" ? "right:0;" : "left:0;"}"
          ></div>

          <span class="col-tick">${tick}</span>
          <span class="col-sep">·</span>
          <span class="col-price">${price}</span>
          <span class="col-lots">${lots}</span>
          <span class="col-total">${total}</span>
        </div>
      `;
    })
    .join("");

  // Keep the best ask adjacent to LAST when deeper levels need scrolling.
  container.scrollTop = side === "sell" ? container.scrollHeight : 0;
}

function renderOrders(buyOrders, sellOrders) {
  const rows = [];
  buyOrders.forEach((order) => {
    rows.push({
      side: "buy",
      id: order.id,
      owner: order.owner,
      tick: order.tick,
      price: order.price,
      lots: order.lotsRemaining,
    });
  });
  sellOrders.forEach((order) => {
    rows.push({
      side: "sell",
      id: order.id,
      owner: order.owner,
      tick: order.tick,
      price: order.price,
      lots: order.lotsRemaining,
    });
  });
  const limited = rows.slice(0, 12);
  el.openOrders.innerHTML = limited.length
    ? limited
        .map((row) => {
          const isOwner =
            state.walletAddress &&
            row.owner &&
            row.owner.toLowerCase() === state.walletAddress;
          const action = isOwner
            ? `<button class="btn ghost mini" data-cancel="${row.id}">Cancel</button>`
            : `<span class="meta-label">--</span>`;
          return `
        <div class="table-row orders">
          <span class="tag ${row.side}">${row.side.toUpperCase()}</span>
          <span>#${row.id}</span>
          <span>${formatTick(row.tick)} @ ${formatWetc(row.price)}</span>
          <span>${formatLots(row.lots)} lots</span>
          ${action}
        </div>
      `;
        })
        .join("")
    : '<div class="panel-sub">No open orders.</div>';
}

function reportTradeHistoryError(error) {
  chartHistory.fail(error);
  state.tradeHistory = { status: "error", trades: [], error };
  renderTape();
}

function renderTape() {
  el.recentTrades.innerHTML = TradeHistory.render(state.tradeHistory, {
    formatTick, formatWetc, formatLots,
  });
}

function updateChart(snapshot) {
  const ctx = el.sparkline.getContext("2d");
  const width = el.sparkline.width, height = el.sparkline.height;
  ctx.clearRect(0, 0, width, height);
  const trades = snapshot.trades;
  el.chartStatus.textContent = snapshot.status === "error"
    ? `Execution history unavailable: ${errorMessage(snapshot.error)}`
    : snapshot.status === "loading" ? "Loading historical executions…"
    : !trades.length ? "No executions yet. Maker orders are not trades."
    : `Historical executions · ${trades.length} fill${trades.length === 1 ? "" : "s"} · gaps over 1 day shown as breaks`;
  if (!trades.length) return;
  let min = trades[0].price, max = min;
  for (const t of trades) { if (t.price < min) min = t.price; if (t.price > max) max = t.price; }
  const range = max - min;
  const first = trades[0].timestamp, last = trades[trades.length - 1].timestamp;
  const xFor = t => last === first ? width / 2 : 58 + (t.timestamp - first) / (last - first) * (width - 74);
  const yFor = t => range === 0n ? height / 2 : height - 32 - Number(t.price - min) / Number(range) * (height - 56);
  ctx.strokeStyle = "rgba(244, 184, 96, 0.9)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  trades.forEach((t, i) => {
    const x = xFor(t), y = yFor(t);
    // Do not imply continuous activity across long inactive periods.
    if (i === 0 || t.timestamp - trades[i - 1].timestamp > 86400) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  for (const t of trades) {
    ctx.fillStyle = t.takerIsBuy ? "#4ad39b" : "#ff6b6b";
    ctx.beginPath(); ctx.arc(xFor(t), yFor(t), 2.5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = "#a5adba";
  ctx.font = "10px monospace";
  ctx.textAlign = "left";
  ctx.fillText(formatWetc(max), 4, 18);
  if (max !== min) ctx.fillText(formatWetc(min), 4, height - 32);
  const label = seconds => new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  ctx.fillText(label(first), 8, height - 8);
  if (last !== first) { ctx.textAlign = "right"; ctx.fillText(label(last), width - 8, height - 8); }
}

function buildDemoBook(side) {
  const base = side === "buy" ? 120 : 121;
  return Array.from({ length: 10 }, (_, i) => {
    const tick = BigInt(side === "buy" ? base - i : base + i);
    const price = 500000000000000000n + BigInt(i) * 10000000000000000n;
    const lots = BigInt(60 - i * 4);
    const total = lots * price;
    return {
      tick,
      price,
      totalLots: lots,
      totalValue: total,
      orderCount: BigInt(2 + i),
    };
  });
}

function buildDemoOrders(isSell = false) {
  return Array.from({ length: 6 }, (_, i) => ({
    id: BigInt(300 + i),
    owner: "0x0000000000000000000000000000000000000000",
    tick: BigInt(isSell ? 124 + i : 118 - i),
    price: 520000000000000000n + BigInt(i) * 9000000000000000n,
    lotsRemaining: BigInt(12 + i * 3),
    valueRemaining:
      BigInt(12 + i * 3) *
      (520000000000000000n + BigInt(i) * 9000000000000000n),
  }));
}

async function refresh() {
  if (!state.readContract) return;

  const depth = Number(el.depthInput.value) || MAX_LEVELS_DEFAULT;
  const maxOrders = MAX_ORDERS_DEFAULT;
  const marketId = state.marketId;

  try {
    const [buyRes, sellRes, marketRes] = await Promise.all([
      safeCall("getBuyBook", () =>
        state.readContract.getBuyBook(marketId, depth),
      ),

      safeCall("getSellBook", () =>
        state.readContract.getSellBook(marketId, depth),
      ),

      safeCall("getMarket", () => state.readContract.getMarket(marketId)),
    ]);

    if (!buyRes.ok || !sellRes.ok || !marketRes.ok) {
      const firstErr = [buyRes, sellRes, marketRes].find((res) => !res.ok);

      setDemoMode(`${firstErr.name}: ${errorMessage(firstErr.error)}`);
      return;
    }

    const [buyBook, buyN] = buyRes.value;
    const [sellBook, sellN] = sellRes.value;
    const market = marketRes.value;
    if (marketId !== state.marketId) return;

    const [buyOrdersRes, sellOrdersRes] = await Promise.all([
      safeCall("getBuyOrders", () =>
        state.readContract.getBuyOrders(marketId, maxOrders),
      ),

      safeCall("getSellOrders", () =>
        state.readContract.getSellOrders(marketId, maxOrders),
      ),
    ]);

    const buyLevels = Array.from(buyBook).slice(0, toNumber(buyN));

    const sellLevels = Array.from(sellBook).slice(0, toNumber(sellN));

    const buyOrdersList = buyOrdersRes.ok
      ? Array.from(buyOrdersRes.value[0]).slice(
          0,
          toNumber(buyOrdersRes.value[1]),
        )
      : [];

    const sellOrdersList = sellOrdersRes.ok
      ? Array.from(sellOrdersRes.value[0]).slice(
          0,
          toNumber(sellOrdersRes.value[1]),
        )
      : [];

    const bestBuyTick = market.bestBuyTick;
    const bestSellTick = market.bestSellTick;
    const lastTradeTick = market.lastTradeTick;
    const lastTradeBlock = market.lastTradeBlock;
    const lastTradePrice = market.lastTradePrice;
    const buyWETC = market.bookEscrowWETC;
    const sellLots = market.bookEscrowLots;

    setStatus(market.active ? "Live" : "Paused", market.active);

    el.emptyBanner.hidden = !(
      buyLevels.length === 0 && sellLevels.length === 0
    );

    const sourceLabel = state.readSource === "wallet" ? "Wallet" : "RPC";

    const chainLabel = state.readChainId ? ` chain ${state.readChainId}` : "";

    el.chainStatus.textContent = `${sourceLabel}${chainLabel} · Market ${marketId}`;

    renderBook(el.buyBook, buyLevels, "buy");
    renderBook(el.sellBook, sellLevels, "sell");

    updateMidPrice(
      buyLevels.length ? buyLevels[0] : null,
      sellLevels.length ? sellLevels[0] : null,
    );

    renderOrders(buyOrdersList, sellOrdersList);



    el.bestBid.textContent =
      bestBuyTick === NONE || !buyLevels.length
        ? "--"
        : `${formatTick(bestBuyTick)} @ ${formatWetc(buyLevels[0].price)}`;

    el.bestAsk.textContent =
      bestSellTick === NONE || !sellLevels.length
        ? "--"
        : `${formatTick(bestSellTick)} @ ${formatWetc(sellLevels[0].price)}`;

    const hasTrade = lastTradeBlock !== 0n;
    renderLastTaken(hasTrade ? lastTradePrice : null, market.lastTradeTakerIsBuy);

    el.lastTrade.textContent = hasTrade
      ? `${formatTick(lastTradeTick)} @ ${formatWetc(lastTradePrice)}`
      : "--";

    el.lastBlock.textContent = hasTrade ? lastTradeBlock.toString() : "--";

    el.escrowTotals.textContent =
      `${formatWetc(buyWETC)} WETC / ` +
      `${formatLots(sellLots)} ${state.lotTokenSymbol || "lots"}`;

    const totalLots = [...buyLevels, ...sellLevels].reduce(
      (acc, lvl) => acc + BigInt(lvl.totalLots),
      0n,
    );

    el.liquidity.textContent = `${formatLots(totalLots)} lots`;

    const tradeUpdated =
      state.lastTradeBlock !== null &&
      state.lastTradeBlock !== lastTradeBlock &&
      hasTrade;

    if (tradeUpdated) {
      pulse(el.lastTradeStat);
      pulse(el.statusPill);
    }

    state.lastTradeTick = lastTradeTick;
    state.lastTradeBlock = lastTradeBlock;

    renderTape();

    const ordersNote =
      !buyOrdersRes.ok || !sellOrdersRes.ok ? " (orders unavailable)" : "";

    el.lastUpdate.textContent =
      `Last update: ${new Date().toLocaleTimeString()}` + `${ordersNote}`;
  } catch (err) {
    setDemoMode(errorMessage(err));
  }
}

async function previewOrder() {
  const tick = Number(el.tickInput.value);
  const lots = Number(el.lotsInput.value);
  if (!Number.isFinite(tick) || !Number.isFinite(lots) || lots <= 0) {
    setTicketStatus("Enter a valid tick and lots.");
    return;
  }
  try {
    const price = await state.readContract.priceAtTick(tick);
    const total = price * BigInt(lots);
    el.previewPrice.textContent = `${formatWetc(price)} WETC`;
    el.previewValue.textContent = `${formatWetc(total)} WETC`;
  } catch (err) {
    setTicketStatus(`Preview error: ${err.message || err}`);
  }
}

async function placeOrder() {
  if (!state.writeContract) {
    setTicketStatus("Connect a wallet to trade.");
    return;
  }

  const tick = Number(el.tickInput.value);
  const lots = Number(el.lotsInput.value);

  if (!Number.isFinite(tick) || !Number.isFinite(lots) || lots <= 0) {
    setTicketStatus("Enter a valid tick and lots.");
    return;
  }

  try {
    setTicketStatus("Submitting transaction...");

    const tx =
      state.side === "buy"
        ? await state.writeContract.placeBuy(state.marketId, tick, lots)
        : await state.writeContract.placeSell(state.marketId, tick, lots);

    await tx.wait();

    setTicketStatus("Order placed.");
    await refresh();
  } catch (err) {
    setTicketStatus(`Tx failed: ${errorMessage(err)}`);
  }
}

async function cancelOrder(id) {
  if (!state.writeContract) {
    setTicketStatus("Connect a wallet to cancel orders.");
    return;
  }
  try {
    setTicketStatus(`Canceling #${id}...`);
    const tx = await state.writeContract.cancel(id);
    await tx.wait();
    setTicketStatus(`Canceled #${id}.`);
    await refresh();
  } catch (err) {
    setTicketStatus(`Cancel failed: ${err.message || err}`);
  }
}

async function clearMyOrders() {
  if (!state.writeContract || !state.walletAddress) {
    setTicketStatus("Connect a wallet to clear orders.");
    return;
  }

  try {
    setTicketStatus("Canceling your orders...");

    const [buyRes, sellRes] = await Promise.all([
      state.readContract.getBuyOrders(state.marketId, MAX_ORDERS_DEFAULT),
      state.readContract.getSellOrders(state.marketId, MAX_ORDERS_DEFAULT),
    ]);

    const [buyOrders, buyN] = buyRes;
    const [sellOrders, sellN] = sellRes;

    const orders = [
      ...Array.from(buyOrders).slice(0, toNumber(buyN)),
      ...Array.from(sellOrders).slice(0, toNumber(sellN)),
    ].filter(
      (order) =>
        order.owner && order.owner.toLowerCase() === state.walletAddress,
    );

    for (const order of orders) {
      const tx = await state.writeContract.cancel(order.id);
      await tx.wait();
    }

    setTicketStatus(
      orders.length ? "All your orders canceled." : "No orders to cancel.",
    );

    await refresh();
  } catch (err) {
    setTicketStatus(`Cancel failed: ${errorMessage(err)}`);
  }
}

async function seedOrders() {
  if (!state.writeContract || !state.signer) {
    setTicketStatus("Connect a wallet to seed orders.");
    return;
  }

  if (!state.wetc || !state.lotToken) {
    setTicketStatus("Market tokens are not loaded.");
    return;
  }

  try {
    const [buyRes, sellRes] = await Promise.all([
      state.readContract.getBuyBook(state.marketId, 1),
      state.readContract.getSellBook(state.marketId, 1),
    ]);

    if (toNumber(buyRes[1]) > 0 || toNumber(sellRes[1]) > 0) {
      setTicketStatus("Book already has orders.");
      return;
    }

    const sellSeeds = [
      { tick: 121, lots: 60 },
      { tick: 122, lots: 56 },
      { tick: 123, lots: 52 },
      { tick: 124, lots: 48 },
      { tick: 125, lots: 44 },
    ];

    const buySeeds = [
      { tick: 120, lots: 60 },
      { tick: 119, lots: 56 },
      { tick: 118, lots: 52 },
      { tick: 117, lots: 48 },
      { tick: 116, lots: 44 },
    ];

    const owner = await state.signer.getAddress();

    const wetc = state.wetc.connect(state.signer);
    const lotToken = state.lotToken.connect(state.signer);

    let neededWetc = 0n;

    for (const order of buySeeds) {
      const price = await state.readContract.priceAtTick(order.tick);

      neededWetc += price * BigInt(order.lots);
    }

    const neededLots = sellSeeds.reduce(
      (acc, order) => acc + BigInt(order.lots),
      0n,
    );

    const [wetcAllowance, lotAllowance] = await Promise.all([
      wetc.allowance(owner, CONTRACT_ADDRESS),
      lotToken.allowance(owner, CONTRACT_ADDRESS),
    ]);

    if (wetcAllowance < neededWetc) {
      const tx = await wetc.approve(CONTRACT_ADDRESS, ethers.MaxUint256);

      await tx.wait();
    }

    if (lotAllowance < neededLots) {
      const tx = await lotToken.approve(CONTRACT_ADDRESS, ethers.MaxUint256);

      await tx.wait();
    }

    setTicketStatus("Seeding orders...");

    for (const order of sellSeeds) {
      const tx = await state.writeContract.placeSell(
        state.marketId,
        order.tick,
        order.lots,
      );

      await tx.wait();
    }

    for (const order of buySeeds) {
      const tx = await state.writeContract.placeBuy(
        state.marketId,
        order.tick,
        order.lots,
      );

      await tx.wait();
    }

    setTicketStatus(`Seeded ${state.lotTokenSymbol || "market"} book.`);

    await refresh();
  } catch (err) {
    setTicketStatus(`Seed failed: ${errorMessage(err)}`);
  }
}

function bindEvents() {
  if (window.ethereum) {
    const reloadWallet = async () => {
      try { await recentTrades.stop(); }
      finally { window.location.reload(); }
    };
    window.ethereum.on("chainChanged", reloadWallet);
    window.ethereum.on("accountsChanged", reloadWallet);
  }

  el.connectBtn.addEventListener("click", connectWallet);
  if (el.copyBtn) {
    el.copyBtn.addEventListener("click", copyAddresses);
  }
  if (el.addWetc) {
    el.addWetc.addEventListener("click", () =>
      addTokenToWallet(WETC_ADDRESS, config.quoteSymbol || "WETC", 18),
    );
  }
  if (el.addLotToken) {
    el.addLotToken.addEventListener("click", () =>
      addTokenToWallet(
        state.lotTokenAddress,
        state.lotTokenSymbol || "LOT",
        state.lotTokenDecimals ?? 0,
      ),
    );
  }
  el.refreshBtn.addEventListener("click", () => {
    refresh();
    if (state.readContract) {
      void loadRecentTrades().catch(reportTradeHistoryError);
    }
  });
  el.previewBtn.addEventListener("click", previewOrder);
  el.placeBtn.addEventListener("click", placeOrder);
  el.depthInput.addEventListener("change", () => {
    const value = Number(el.depthInput.value);
    if (Number.isFinite(value)) {
      updateDepthToggle(value);
    }
    refresh();
  });
  el.seedBtn.addEventListener("click", seedOrders);
  el.clearBtn.addEventListener("click", clearMyOrders);
  el.openOrders.addEventListener("click", (event) => {
    const target = event.target.closest("[data-cancel]");
    if (!target) return;
    const id = target.getAttribute("data-cancel");
    if (id) cancelOrder(id);
  });

  el.sideToggle.addEventListener("click", (event) => {
    const button = event.target.closest(".seg");
    if (!button) return;
    const side = button.dataset.side;
    state.side = side;
    el.sideToggle.querySelectorAll(".seg").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.side === side);
    });
  });

  if (el.depthToggle) {
    el.depthToggle.addEventListener("click", (event) => {
      const chip = event.target.closest(".chip");
      if (!chip) return;
      const value = Number(chip.dataset.depth);
      if (!Number.isFinite(value)) return;
      setDepth(value);
    });
  }

  if (el.pairTag && el.marketMenu) {
    el.pairTag.addEventListener("click", (event) => {
      event.stopPropagation();
      el.marketMenu.hidden = !el.marketMenu.hidden;
    });

    el.marketMenu.addEventListener("click", (event) => {
      const option = event.target.closest("[data-market-id]");
      if (!option) return;

      const marketId = Number(option.dataset.marketId);

      if (Number.isFinite(marketId)) {
        selectMarket(marketId);
      }
    });

    document.addEventListener("click", () => {
      el.marketMenu.hidden = true;
    });
  }
}

async function waitForExpectedChain(timeoutMs = 5000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const chainHex = await window.ethereum.request({
      method: "eth_chainId",
    });

    const chainId = Number(BigInt(chainHex));

    if (chainId === EXPECTED_CHAIN_ID) {
      return chainId;
    }

    el.chainStatus.textContent = `Waiting for ${NETWORK_NAME} (${EXPECTED_CHAIN_ID})...`;

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const chainHex = await window.ethereum.request({
    method: "eth_chainId",
  });

  return Number(BigInt(chainHex));
}

async function boot() {
  bindEvents();
  renderTape();
  chartHistory.clear();

  el.depthInput.value = MAX_LEVELS_DEFAULT.toString();
  updateDepthToggle(MAX_LEVELS_DEFAULT);

  el.seedBtn.disabled = true;
  el.clearBtn.disabled = true;

  try {
    if (!window.ethereum) {
      throw new Error("No injected wallet provider found");
    }

    const chainId = await waitForExpectedChain();

    if (chainId !== EXPECTED_CHAIN_ID) {
      throw new Error(
        `Wrong chain: ${chainId}. Switch wallet to ${NETWORK_NAME} (${EXPECTED_CHAIN_ID}).`,
      );
    }

    // Only construct ethers BrowserProvider after Enkrypt
    // has settled onto the expected chain.
    await initProvider();

    const network = await state.readProvider.getNetwork();
    state.readChainId = Number(network.chainId);

    await loadMarket(DEFAULT_MARKET_ID);
    await discoverMarkets();
  } catch (err) {
    reportTradeHistoryError(err);
    setDemoMode(err.message || `Unable to connect to ${NETWORK_NAME}`);
    return;
  }

  await refresh();
  setInterval(refresh, 3000);
}

boot();
