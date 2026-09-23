import { expect } from "chai";
import "../ui/trade-history.js";
const H = globalThis.TradeHistory;
const formatting = { formatTick: String, formatWetc: String, formatLots: String };
const log = (index, { marketId = 1, buy = true, block = 15, tx = "0xabc", lots = 1n } = {}) => ({
  index, blockNumber: block, transactionIndex: 0, transactionHash: tx,
  args: { marketId: BigInt(marketId), takerIsBuy: buy, tick: 121n, pricePerLot: 1823000000000000000n, lotsFilled: lots, valueFilled: 1823000000000000000n * lots },
});
function harness(logs = [], tip = 20) {
  const snapshots = [], listeners = [], removed = [], queries = [];
  const contract = {
    filters: { Trade: (marketId) => ({ marketId: Number(marketId) }) },
    async on(filter, handler) { listeners.push({ filter, handler }); },
    async off(filter, handler) { removed.push({ filter, handler }); const i = listeners.findIndex(l => l.handler === handler); if (i >= 0) listeners.splice(i, 1); },
    async queryFilter(filter, from, to) { queries.push([filter.marketId, from, to]); return logs.filter(l => Number(l.args.marketId) === filter.marketId && l.blockNumber >= from && l.blockNumber <= to); },
  };
  const history = H.create({ onChange: s => snapshots.push(s) });
  const provider = { getBlockNumber: async () => tip };
  return { history, contract, provider, listeners, removed, queries, snapshots,
    latest: () => snapshots.at(-1),
    emit(l) { for (const {handler} of [...listeners]) handler({ log: l, args: l.args }); },
    start(market = 1) { return history.start(contract, provider, market); },
  };
}

describe("Recent Trades history", function () {
  it("shows loading until a successful empty scan completes", async () => {
    const h = harness(); await h.start();
    expect(H.render(h.snapshots[0], formatting)).to.include("Loading recent trades");
    expect(H.render(h.latest(), formatting)).to.include("No trades yet.");
    expect(h.queries).to.deep.equal([[1, 0, 20]]);
  });
  it("renders real buy and sell fields with side colors and actual lot counts", async () => {
    const h = harness([log(0), log(1, { buy: false, lots: 7n })]); await h.start();
    const html = H.render(h.latest(), formatting);
    expect(html).to.include('class="tag buy">BUY');
    expect(html).to.include('class="tag sell">SELL');
    expect(html).to.include('1 lot</span>'); expect(html).to.include('7 lots</span>');
    expect(h.latest().trades[1].value).to.equal(12761000000000000000n);
  });
  it("keeps fills in one transaction separate, canonical oldest-first and rendered newest-first", async () => {
    const h = harness([log(2, {buy:false}), log(0), log(1)]); await h.start();
    expect(h.latest().trades.map(t => t.logIndex)).to.deep.equal([0, 1, 2]);
    expect(H.render(h.latest(), formatting).indexOf('SELL')).to.be.lessThan(H.render(h.latest(), formatting).indexOf('BUY'));
    expect(H.render(h.latest(), formatting).match(/class="table-row"/g)).to.have.length(3);
  });
  it("filters markets and removes/replaces the listener when switching", async () => {
    const h = harness([log(0), log(1, {marketId:2})]); await h.start();
    const old = h.listeners[0]; await h.start(2);
    expect(h.removed[0].handler).to.equal(old.handler);
    expect(h.listeners).to.have.length(1);
    expect(h.listeners[0].filter.marketId).to.equal(2);
    old.handler({log:log(3),args:log(3).args});
    h.emit(log(4));
    expect(h.latest().trades.map(t => t.marketId)).to.deep.equal([2]);
  });
  it("deduplicates historical/live overlap and immediately renders new prints", async () => {
    const h = harness([log(0)]);
    const query = h.contract.queryFilter;
    h.contract.queryFilter = async (...args) => { h.emit(log(0)); return query(...args); };
    await h.start(); expect(h.latest().trades).to.have.length(1);
    h.emit(log(1, {buy:false})); expect(h.latest().trades).to.have.length(2);
    expect(H.render(h.latest(), formatting)).to.include('class="tag sell">SELL');
  });
  it("grows backward windows and stops as soon as enough prints are found", async () => {
    const h = harness(Array.from({length:10}, (_,i) => log(i, {block:25000})), 50000);
    await h.start();
    expect(h.queries).to.deep.equal([[1,40001,50000],[1,20001,40000]]);
    expect(h.latest().trades).to.have.length(10);
  });
  it("shrinks rejected ranges without skipping blocks", async () => {
    const h = harness([], 19), accepted = [];
    h.contract.queryFilter = async (filter, from, to) => {
      if (to-from+1 > 5) throw Error("block range too large");
      accepted.push([from,to]); return [];
    };
    await h.start();
    expect(accepted).to.deep.equal([[15,19],[10,14],[5,9],[0,4]]);
    expect(h.latest().status).to.equal("ready");
  });
  it("reports unrelated errors instead of claiming there are no trades", async () => {
    const h = harness(); let calls=0;
    h.contract.queryFilter = async () => { calls++; throw Error("wallet disconnected <oops>"); };
    await h.start(); const html=H.render(h.latest(),formatting);
    expect(calls).to.equal(1); expect(html).to.include("wallet disconnected &lt;oops&gt;");
    expect(html).not.to.include("No trades yet");
  });
  it("ignores a stale history response after a market switch", async () => {
    const h = harness(); let release;
    h.contract.queryFilter = async filter => filter.marketId === 1 ? new Promise(r=>{release=r;}) : [log(1,{marketId:2})];
    const first=h.start();
    while (!release) await new Promise(r=>setTimeout(r,0));
    await h.start(2); release([log(0)]); await first;
    expect(h.latest().trades.map(t=>t.marketId)).to.deep.equal([2]);
    expect(h.listeners).to.have.length(1);
  });
  it("removes orphaned logs and retains only the display limit", async () => {
    const h=harness(); await h.start();
    for(let i=0;i<12;i++) h.emit(log(i));
    expect(h.latest().trades).to.have.length(10);
    h.emit({...log(11),removed:true}); h.emit(log(11));
    expect(h.latest().trades.map(t=>t.logIndex)).not.to.include(11);
    await h.history.stop(); expect(h.listeners).to.have.length(0);
  });
});
