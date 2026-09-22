/* global ethers */
const config = window.APP_CONFIG || {};

const NETWORK_NAME = config.name || "Unknown";
const EXPECTED_CHAIN_ID = Number(config.chainId);
const RPC_URL = config.rpcUrl || null;

const CONTRACT_ADDRESS = config.exchangeAddress || "";
const WETC_ADDRESS = config.quoteTokenAddress || "";
const DEFAULT_MARKET_ID = Number(config.defaultMarketId || 1);

const MAX_LEVELS_DEFAULT = config.maxLevels || 25;
const MAX_ORDERS_DEFAULT = config.maxOrders || 50;
const DEMO_MODE =
  new URLSearchParams(window.location.search).get("demo") === "1";

const ABI = [
  "function marketCount() view returns (uint32)",
  "function marketIdOf(address lotToken) view returns (uint32)",

  "function getMarket(uint32 marketId) view returns (address lotToken,bool exists,bool active,uint64 historySeq,bytes32 historyHash,int256 bestBuyTick,int256 bestSellTick,int256 lastTradeTick,uint256 lastTradeBlock,uint256 lastTradePrice,uint256 buyWETC,uint256 sellLots)",

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
  spreadValue: document.getElementById("spread-value"),
  midTick: document.getElementById("mid-tick"),
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
  addLotToken: document.getElementById("add-lot-token"),  ticketStatus: document.getElementById("ticket-status"),
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
  lotTokenAddress: null,
  lotTokenSymbol: null,
  lotTokenDecimals: null,

  side: "buy",
  demoMode: false,

  lastTradeTick: null,
  lastTradeBlock: null,
  tape: [],

  readSource: "wallet",
  readChainId: null,
};

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
  const buy = buildDemoBook("buy");
  const sell = buildDemoBook("sell");
  renderBook(el.buyBook, buy, "buy");
  renderBook(el.sellBook, sell, "sell");
  updateSpread(buy[0], sell[0]);
  renderOrders(buildDemoOrders(), buildDemoOrders(true));
  updateChart(buy, sell);
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

async function loadMarket(marketId) {
  const market = await state.readContract.getMarket(marketId);

  const lotTokenAddress = market.lotToken;

  if (!market.exists) {
    throw new Error(`Market ${marketId} does not exist`);
  }

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
    el.pairTag.textContent = pairLabel;
  }
  
  if (el.addLotToken) {
    el.addLotToken.textContent = `Add ${state.lotTokenSymbol}`;
  }

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

function updateSpread(bestBid, bestAsk) {
  if (!bestBid || !bestAsk) {
    el.spreadValue.textContent = "--";
    el.midTick.textContent = "--";
    return;
  }
  const bidPrice = BigInt(bestBid.price);
  const askPrice = BigInt(bestAsk.price);
  const bidTick = BigInt(bestBid.tick);
  const askTick = BigInt(bestAsk.tick);
  const spread = askPrice - bidPrice;
  const mid = (askPrice + bidPrice) / 2n;
  el.spreadValue.textContent = `${formatWetc(spread)} WETC`;
  el.midTick.textContent = formatTick((askTick + bidTick) / 2n);
  el.midPrice.textContent = `${formatWetc(mid)} WETC`;
}

function renderBook(container, levels, side) {
  if (!levels.length) {
    container.innerHTML = '<div class="panel-sub">No levels.</div>';
    return;
  }
  const maxLots = Math.max(...levels.map((lvl) => toNumber(lvl.totalLots)), 1);
  container.innerHTML = levels
    .map((lvl, idx) => {
      const depth = Math.round((toNumber(lvl.totalLots) / maxLots) * 100);
      const price = formatWetc(lvl.price);
      const lots = formatLots(lvl.totalLots);
      const total = formatWetc(lvl.totalValue);
      return `
        <div class="book-row ${side}${idx === 0 ? " best" : ""}">
          <div class="bar" style="width:${depth}%;${
        side === "buy" ? "right:0;" : "left:0;"
      }"></div>
          <span>${price}</span>
          <span>${lots}</span>
          <span>${total}</span>
        </div>
      `;
    })
    .join("");
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

function renderTape() {
  const entries = state.tape.slice(0, 10);
  el.recentTrades.innerHTML = entries.length
    ? entries
        .map(
          (trade) => `
        <div class="table-row">
          <span>${trade.side.toUpperCase()}</span>
          <span>${formatTick(trade.tick)} @ ${formatWetc(trade.price)}</span>
          <span>${formatLots(trade.lots)} lots</span>
        </div>
      `,
        )
        .join("")
    : '<div class="panel-sub">No trades yet.</div>';
}

function updateChart(buy, sell) {
  const ctx = el.sparkline.getContext("2d");
  const width = el.sparkline.width;
  const height = el.sparkline.height;
  ctx.clearRect(0, 0, width, height);

  const points = [...sell.slice(0, 8), ...buy.slice(0, 8)]
    .map((lvl) => Number(ethers.formatUnits(lvl.price, 18)))
    .filter((val) => Number.isFinite(val));

  if (!points.length) return;

  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;

  ctx.strokeStyle = "rgba(244, 184, 96, 0.9)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((val, idx) => {
    const x = (idx / (points.length - 1 || 1)) * (width - 20) + 10;
    const y = height - ((val - min) / range) * (height - 40) - 20;
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
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
    const buyWETC = market.buyWETC;
    const sellLots = market.sellLots;

    setStatus(market.active ? "Live" : "Paused", market.active);

    el.emptyBanner.hidden = !(
      buyLevels.length === 0 && sellLevels.length === 0
    );

    const sourceLabel = state.readSource === "wallet" ? "Wallet" : "RPC";

    const chainLabel = state.readChainId ? ` chain ${state.readChainId}` : "";

    el.chainStatus.textContent = `${sourceLabel}${chainLabel} · Market ${marketId}`;

    renderBook(el.buyBook, buyLevels, "buy");
    renderBook(el.sellBook, sellLevels, "sell");

    updateSpread(
      buyLevels.length ? buyLevels[0] : null,
      sellLevels.length ? sellLevels[0] : null,
    );

    renderOrders(buyOrdersList, sellOrdersList);

    updateChart(buyLevels, sellLevels);

    el.bestBid.textContent =
      bestBuyTick === NONE || !buyLevels.length
        ? "--"
        : `${formatTick(bestBuyTick)} @ ${formatWetc(buyLevels[0].price)}`;

    el.bestAsk.textContent =
      bestSellTick === NONE || !sellLevels.length
        ? "--"
        : `${formatTick(bestSellTick)} @ ${formatWetc(sellLevels[0].price)}`;

    const hasTrade = lastTradeBlock !== 0n;

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
      state.tape.unshift({
        side: "trade",
        tick: lastTradeTick,
        price: lastTradePrice,
        lots: 1n,
      });

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
    window.ethereum.on("chainChanged", () => {
      window.location.reload();
    });

    window.ethereum.on("accountsChanged", () => {
      window.location.reload();
    });
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
        state.lotTokenDecimals ?? 0
      )
    );
  }
  el.refreshBtn.addEventListener("click", refresh);
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
}

async function waitForExpectedChain(timeoutMs = 5000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const chainHex = await window.ethereum.request({
      method: "eth_chainId"
    });

    const chainId = Number(BigInt(chainHex));

    if (chainId === EXPECTED_CHAIN_ID) {
      return chainId;
    }

    el.chainStatus.textContent =
      `Waiting for ${NETWORK_NAME} (${EXPECTED_CHAIN_ID})...`;

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const chainHex = await window.ethereum.request({
    method: "eth_chainId"
  });

  return Number(BigInt(chainHex));
}

async function boot() {
  bindEvents();

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
        `Wrong chain: ${chainId}. Switch wallet to ${NETWORK_NAME} (${EXPECTED_CHAIN_ID}).`
      );
    }

    // Only construct ethers BrowserProvider after Enkrypt
    // has settled onto the expected chain.
    await initProvider();

    const network = await state.readProvider.getNetwork();
    state.readChainId = Number(network.chainId);

    await loadMarket(DEFAULT_MARKET_ID);
  } catch (err) {
    setDemoMode(
      err.message || `Unable to connect to ${NETWORK_NAME}`
    );
    return;
  }

  await refresh();
  setInterval(refresh, 3000);
}

boot();