/* Browser-only trade history. No storage or transport of its own. */
(function (root) {
  const TRADE_EVENT = "event Trade(uint32 indexed marketId,uint64 seq,bytes32 newHash,uint64 indexed orderId,address taker,address indexed maker,bool takerIsBuy,int32 tick,uint96 pricePerLot,uint32 lotsFilled,uint128 valueFilled,uint32 lotsRemainingAfter,uint128 valueRemainingAfter)";
  const RECENT_TRADE_LIMIT = 10;

  function normalize(log) {
    const a = log.args;
    return {
      marketId: Number(a.marketId),
      blockNumber: Number(log.blockNumber),
      blockHash: log.blockHash,
      transactionIndex: Number(log.transactionIndex),
      logIndex: Number(log.index ?? log.logIndex),
      transactionHash: log.transactionHash,
      takerIsBuy: a.takerIsBuy,
      tick: a.tick,
      price: a.pricePerLot,
      lots: a.lotsFilled,
      value: a.valueFilled,
    };
  }

  const identity = (trade) => `${trade.transactionHash}:${trade.logIndex}`;
  const compare = (a, b) => a.blockNumber - b.blockNumber ||
    a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex;

  function rangeTooLarge(error) {
    const message = [error.message, error.shortMessage, error.info?.error?.message, error.error?.message].filter(Boolean).join(" ");
    return /block range|range.{0,40}(too (large|wide)|exceed|limit)|too many (results|logs)|query returned more than|response size exceeded|log response size exceeded|limited to.{0,30}blocks/i.test(message);
  }

  // Shared backward range walker; callers decide when enough history is loaded.
  async function* ranges({ contract, marketId, fromBlock = 0, toBlock, active = () => true }) {
    const filter = contract.filters.Trade(marketId);
    let end = toBlock, size = 10000, ceiling = 160000;
    while (active() && end >= fromBlock) {
      const from = Math.max(fromBlock, end - size + 1);
      let logs;
      try { logs = await contract.queryFilter(filter, from, end); }
      catch (error) {
        if (!active()) return;
        const count = end - from + 1;
        if (!rangeTooLarge(error) || count === 1) throw error;
        size = ceiling = Math.max(1, Math.floor(count / 2));
        continue;
      }
      if (!active()) return;
      yield logs;
      end = from - 1;
      size = Math.min(size * 2, ceiling);
    }
  }

  function create({ onChange, onSubscribe = () => {}, onLive = () => {}, limit = RECENT_TRADE_LIMIT }) {
    let current = null;
    let generation = 0;

    function publish(session) {
      if (current !== session) return;
      const trades = [...session.trades.values()].sort(compare);
      // Canonical data is oldest-first; presentation chooses its own direction.
      onChange({ status: session.status, error: session.error, trades });
    }

    function merge(session, logs) {
      for (const log of logs) {
        const trade = normalize(log);
        if (trade.marketId !== session.marketId) continue;
        const key = identity(trade);
        if (log.removed) {
          session.trades.delete(key);
          session.removed.add(key);
        } else if (!session.removed.has(key)) {
          session.trades.set(key, trade);
        }
      }
      const ordered = [...session.trades.values()].sort(compare);
      for (const trade of ordered.slice(0, Math.max(0, ordered.length - limit))) {
        session.trades.delete(identity(trade));
      }
      publish(session);
    }

    async function stop() {
      generation += 1;
      const old = current;
      current = null;
      if (old) {
        // on() may still be registering while a market switch arrives.
        await Promise.resolve(old.subscription).catch(() => {});
        await old.contract.off(old.filter, old.handler);
      }
    }

    async function start(contract, provider, marketId) {
      const cleanup = stop();
      const token = generation;
      await cleanup;
      if (token !== generation) return;
      const session = {
        contract, marketId: Number(marketId), filter: contract.filters.Trade(marketId),
        trades: new Map(), removed: new Set(), status: "loading", error: null,
      };
      current = session;
      const active = () => current === session;
      publish(session);
      session.handler = (...args) => {
        if (!active()) return;
        const payload = args[args.length - 1];
        const log = { ...payload.log, args: payload.args };
        merge(session, [log]);
        onLive(normalize(log), Boolean(log.removed));
      };
      try {
        // Subscribe before taking the history snapshot so no block falls in a gap.
        session.subscription = Promise.resolve(contract.on(session.filter, session.handler));
        await session.subscription;
        if (!active()) return;
        onSubscribe({ contract, provider, marketId: session.marketId });
        const tip = await provider.getBlockNumber();
        for await (const logs of ranges({ contract, marketId, toBlock: tip, active })) {
          merge(session, logs);
          if (session.trades.size >= limit) break;
        }
        if (active()) {
          session.status = "ready";
          publish(session);
        }
      } catch (error) {
        if (!active()) return;
        session.status = "error";
        session.error = error;
        publish(session);
        // Failed registration must not cause cleanup to reject on the next switch.
        session.subscription = Promise.resolve();
      }
    }

    return { start, stop };
  }

  function render(snapshot, { formatTick, formatWetc, formatLots }) {
    const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const rows = [...snapshot.trades].sort(compare).reverse().map((trade) => {
      const side = trade.takerIsBuy ? "buy" : "sell";
      return `<div class="table-row"><span class="tag ${side}">${side.toUpperCase()}</span><span>${formatTick(trade.tick)} @ ${formatWetc(trade.price)}</span><span>${formatLots(trade.lots)} ${trade.lots === 1n ? "lot" : "lots"}</span></div>`;
    }).join("");
    const message = snapshot.status === "loading" ? "Loading recent trades…"
      : snapshot.status === "error" ? `Recent trades unavailable: ${snapshot.error?.shortMessage || snapshot.error?.message || "Unknown error"}`
      : snapshot.status === "ready" && !snapshot.trades.length ? "No trades yet."
      : "";
    return rows + (message ? `<div class="panel-sub" role="status">${escape(message)}</div>` : "");
  }

  root.TradeHistory = { TRADE_EVENT, RECENT_TRADE_LIMIT, normalize, compare, identity, rangeTooLarge, ranges, create, render };
})(globalThis);
