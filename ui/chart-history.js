/* Full execution history and exact candle data; wallet provider supplied by caller. */
(function (root) {
  const H = root.TradeHistory;
  const timestampCaches = new WeakMap();
  const deploymentCaches = new WeakMap();

  function cacheFor(store, provider) {
    if (!store.has(provider)) store.set(provider, new Map());
    return store.get(provider);
  }

  async function deploymentBlock(provider, contract, configured, tip) {
    if (configured !== null && configured !== undefined) {
      if (!Number.isSafeInteger(configured) || configured < 0) throw Error("Invalid exchange deployment block");
      return configured;
    }
    const address = await contract.getAddress();
    const cache = cacheFor(deploymentCaches, provider);
    if (!cache.has(address)) {
      const pending = (async () => {
        if (await provider.getCode(address, tip) === "0x") throw Error("Exchange has no code on this chain");
        let low = 0, high = tip;
        while (low < high) {
          const mid = Math.floor((low + high) / 2);
          if (await provider.getCode(address, mid) === "0x") low = mid + 1;
          else high = mid;
        }
        return low;
      })();
      cache.set(address, pending);
      pending.catch(() => cache.delete(address));
    }
    return cache.get(address);
  }

  async function enrichTimestamps(provider, trades, active = () => true) {
    const cache = cacheFor(timestampCaches, provider);
    const keys = new Map();
    for (const t of trades) keys.set(t.blockHash || t.blockNumber, t);
    const queue = [...keys.entries()];
    let cursor = 0;
    // Bounded concurrency avoids flooding a wallet RPC with block requests.
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (active() && cursor < queue.length) {
        const [key, trade] = queue[cursor++];
        if (!cache.has(key)) {
          const pending = provider.getBlock(trade.blockHash || trade.blockNumber).then(block => {
            if (!block) throw Error(`Missing block ${trade.blockNumber}`);
            return Number(block.timestamp); // seconds throughout the history API
          });
          cache.set(key, pending);
          pending.catch(() => cache.delete(key));
        }
        await cache.get(key);
      }
    }));
    if (!active()) return [];
    return Promise.all(trades.map(async t => ({ ...t, timestamp: await cache.get(t.blockHash || t.blockNumber) })));
  }

  async function loadTradeHistory({ provider, contract, marketId, fromBlock, toBlock, exchangeDeploymentBlock, active = () => true }) {
    const tip = toBlock ?? await provider.getBlockNumber();
    const deployed = await deploymentBlock(provider, contract, exchangeDeploymentBlock, tip);
    const start = Math.max(fromBlock ?? deployed, deployed);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(tip) || start < 0 || tip < 0) throw Error("Invalid history block range");
    const trades = new Map();
    for await (const logs of H.ranges({ contract, marketId, fromBlock: start, toBlock: tip, active })) {
      for (const log of logs) {
        const trade = H.normalize(log);
        if (trade.marketId !== Number(marketId)) continue;
        if (log.removed) trades.delete(H.identity(trade));
        else trades.set(H.identity(trade), trade);
      }
    }
    if (!active()) return [];
    return enrichTimestamps(provider, [...trades.values()].sort(H.compare), active);
  }

  function buildCandles(trades, intervalSeconds) {
    if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds <= 0) throw Error("Candle interval must be positive integer seconds");
    const buckets = new Map();
    for (const t of [...trades].sort(H.compare)) {
      if (!Number.isSafeInteger(t.timestamp)) throw Error("Trade timestamp required");
      const timestamp = Math.floor(t.timestamp / intervalSeconds) * intervalSeconds;
      let c = buckets.get(timestamp);
      if (!c) {
        c = { timestamp, open: t.price, high: t.price, low: t.price, close: t.price, openTick: t.tick, closeTick: t.tick, volumeLots: 0n, volumeQuote: 0n };
        buckets.set(timestamp, c);
      }
      c.high = t.price > c.high ? t.price : c.high;
      c.low = t.price < c.low ? t.price : c.low;
      c.close = t.price;
      c.closeTick = t.tick;
      c.volumeLots += t.lots;
      c.volumeQuote += t.value;
    }
    return [...buckets.values()].sort((a, b) => a.timestamp - b.timestamp);
  }

  function create({ onChange }) {
    let session;
    function publish(s) {
      if (session === s) onChange({ status: s.status, error: s.error, trades: [...s.trades.values()].sort(H.compare) });
    }
    function clear() {
      session = null;
      onChange({ status: "loading", error: null, trades: [] });
    }
    function fail(error) {
      session = null;
      onChange({ status: "error", error, trades: [] });
    }
    async function start(options) {
      const s = { ...options, trades: new Map(), removed: new Set(), status: "loading", error: null };
      session = s;
      publish(s);
      try {
        const trades = await loadTradeHistory({ ...options, active: () => session === s });
        if (session !== s) return;
        for (const t of trades) if (!s.removed.has(H.identity(t))) s.trades.set(H.identity(t), t);
        if (s.status !== "error") s.status = "ready";
        publish(s);
      } catch (error) {
        if (session !== s) return;
        s.status = "error"; s.error = error; publish(s);
      }
    }
    async function append(trade, removed = false) {
      const s = session;
      if (!s || trade.marketId !== Number(s.marketId)) return;
      const key = H.identity(trade);
      if (removed) {
        s.removed.add(key); s.trades.delete(key); publish(s); return;
      }
      if (s.removed.has(key) || s.trades.has(key)) return;
      try {
        const [enriched] = await enrichTimestamps(s.provider, [trade], () => session === s);
        if (session !== s || s.removed.has(key)) return;
        s.trades.set(key, enriched); publish(s);
      } catch (error) {
        if (session !== s) return;
        s.status = "error"; s.error = error; publish(s);
      }
    }
    return { start, append, clear, fail };
  }

  root.ChartHistory = { loadTradeHistory, enrichTimestamps, deploymentBlock, buildCandles, create };
})(globalThis);
