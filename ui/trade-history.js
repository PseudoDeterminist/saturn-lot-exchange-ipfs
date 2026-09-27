/* Browser-only trade history. No storage or transport of its own. */
(function (root) {
  const TRADE_EVENT = "event Trade(uint32 indexed marketId,uint64 indexed orderId,address taker,address indexed maker,bool takerIsBuy,int32 tick,uint32 lotsFilled,uint32 lotsRemainingAfter)";
  // CID-stamped copy of SaturnLotExchange.priceAtTick().
  // MANT is copied mechanically from the Solidity contract source.
  const MIN_TICK = -464n;
  const MAX_TICK = 1855n;
  const MANT_HEX =
    "03e803ed03f203f703fc04010406040b04100416041b04200425042b04300435" +
    "043b04400445044b04500456045b04610466046c04720477047d04830489048e" +
    "0494049a04a004a604ac04b204b804be04c404ca04d004d604dc04e204e804ef" +
    "04f504fb05020508050e0515051b05220528052f0536053c0543054a05500557" +
    "055e0565056c0572057905800587058e0595059d05a405ab05b205b905c105c8" +
    "05cf05d705de05e605ed05f505fc0604060c0613061b0623062b0632063a0642" +
    "064a0652065a0662066b0673067b0683068b0694069c06a506ad06b606be06c7" +
    "06cf06d806e106e906f206fb0704070d0716071f07280731073a0744074d0756" +
    "075f07690772077c0785078f079807a207ac07b607bf07c907d307dd07e707f1" +
    "07fb08060810081a0824082f08390844084e08590863086e08790884088e0899" +
    "08a408af08ba08c508d108dc08e708f208fe090909150920092c09380943094f" +
    "095b09670973097f098b099709a309b009bc09c809d509e109ee09fb0a070a14" +
    "0a210a2e0a3b0a480a550a620a6f0a7d0a8a0a970aa50ab20ac00ace0adb0ae9" +
    "0af70b050b130b210b2f0b3e0b4c0b5a0b690b770b860b950ba30bb20bc10bd0" +
    "0bdf0bee0bfe0c0d0c1c0c2c0c3b0c4b0c5a0c6a0c7a0c8a0c9a0caa0cba0cca" +
    "0cda0ceb0cfb0d0c0d1c0d2d0d3e0d4f0d600d710d820d930da40db60dc70dd9" +
    "0dea0dfc0e0e0e200e320e440e560e680e7b0e8d0e9f0eb20ec50ed80eeb0efe" +
    "0f110f240f370f4a0f5e0f720f850f990fad0fc10fd50fe90ffd10121026103b" +
    "104f10641079108e10a310b810ce10e310f8110e1124113a11501166117c1192" +
    "11a811bf11d511ec1203121a12311248125f1277128e12a612be12d612ee1306" +
    "131e1336134f13671380139913b213cb13e413fd14171430144a1464147e1498" +
    "14b214cd14e71502151d15371552156e158915a415c015dc15f716131630164c" +
    "1668168516a116be16db16f8171617331750176e178c17aa17c817e618051823" +
    "184218611880189f18bf18de18fe191e193e195e197e199f19bf19e01a011a22" +
    "1a431a651a861aa81aca1aec1b0f1b311b541b761b991bbd1be01c031c271c4b" +
    "1c6f1c931cb81cdc1d011d261d4b1d701d961dbb1de11e071e2e1e541e7b1ea1" +
    "1ec81ef01f171f3f1f661f8e1fb71fdf200820302059208320ac20d620ff2129" +
    "2154217e21a921d421ff222a2256228122ad22d923062332235f238c23b923e7" +
    "241524432471249f24ce24fd252c255b258b25bb25eb261b264b267c26ad26de";

  function priceAtTick(tick) {
    tick = BigInt(tick);
    if (tick < MIN_TICK || tick > MAX_TICK) {
      throw Error("tick out of range");
    }

    const t = tick - MIN_TICK;
    const d = t / 464n;
    const r = Number(t % 464n);

    // Solidity reads two big-endian bytes at byte offset r * 2.
    // Four hex characters represent those same two bytes here.
    const m = BigInt("0x" + MANT_HEX.slice(r * 4, r * 4 + 4));

    let factor;
    if (d === 0n) factor = 100000000000000n;
    else if (d === 1n) factor = 1000000000000000n;
    else if (d === 2n) factor = 10000000000000000n;
    else if (d === 3n) factor = 100000000000000000n;
    else factor = 1000000000000000000n;

    return factor * m;
  }

  const RECENT_TRADE_LIMIT = 10;

  function normalize(log) {
    const a = log.args;
    const tick = BigInt(a.tick);
    const lots = BigInt(a.lotsFilled);

    // Older/synthetic logs may already carry price/value. Current on-chain
    // Trade events do not, so derive them deterministically from the tick.
    const price = a.pricePerLot ?? priceAtTick(tick);
    const value = a.valueFilled ?? price * lots;

    return {
      marketId: Number(a.marketId),
      blockNumber: Number(log.blockNumber),
      blockHash: log.blockHash,
      transactionIndex: Number(log.transactionIndex),
      logIndex: Number(log.index ?? log.logIndex),
      transactionHash: log.transactionHash,
      takerIsBuy: a.takerIsBuy,
      tick,
      price,
      lots,
      value,
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

  root.TradeHistory = { TRADE_EVENT, RECENT_TRADE_LIMIT, priceAtTick, normalize, compare, identity, rangeTooLarge, ranges, create, render };
})(globalThis);
