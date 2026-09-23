import { expect } from "chai";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import hardhat from "hardhat";
import "../ui/trade-history.js";
import "../ui/chart-history.js";
const H = globalThis.TradeHistory, C = globalThis.ChartHistory;
const raw = (index, block=12, marketId=1, price=9007199254740993001n) => ({
  index, blockNumber:block, blockHash:`hash${block}`, transactionIndex:0, transactionHash:`tx${block}`,
  args:{marketId:BigInt(marketId),takerIsBuy:true,tick:121n,pricePerLot:price,lotsFilled:2n,valueFilled:price*2n},
});
function fixture(logs=[], tip=30) {
  const queries=[], blocks=[];
  const provider={getBlockNumber:async()=>tip, getBlock:async key=>{blocks.push(key); return {timestamp:Number(String(key).replace('hash',''))*60};}, getCode:async(address,block)=>block<4?'0x':'0x1234'};
  const contract={getAddress:async()=> 'exchange', filters:{Trade:marketId=>marketId}, queryFilter:async(marketId,from,to)=>{queries.push([from,to]); return logs.filter(l=>l.blockNumber>=from&&l.blockNumber<=to);}};
  const options={provider,contract,marketId:1};
  return {provider,contract,queries,blocks,options};
}
describe('Full chart history',function(){
  it('covers the full range after deployment, filters, deduplicates and orders every fill',async()=>{
    const f=fixture([raw(2,18000),raw(1,18000),raw(0,4),raw(0,2),raw(0,100,2),raw(1,18000)],30000);
    const trades=await C.loadTradeHistory(f.options);
    expect(trades.map(t=>[t.blockNumber,t.logIndex])).to.deep.equal([[4,0],[18000,1],[18000,2]]);
    expect(f.queries).to.deep.equal([[20001,30000],[4,20000]]);
    expect(trades[1].transactionHash).to.equal(trades[2].transactionHash);
    expect(trades[1].price).to.equal(9007199254740993001n);
  });
  it('honors explicit subranges and configured deployment lower bounds',async()=>{
    const f=fixture([raw(0,4),raw(0,12),raw(0,20)]);
    const trades=await C.loadTradeHistory({...f.options,exchangeDeploymentBlock:4,fromBlock:10,toBlock:15});
    expect(trades.map(t=>t.blockNumber)).to.deep.equal([12]);
    expect(f.queries).to.deep.equal([[10,15]]);
  });
  it('enriches each unique block once, preserves order, and reuses cache on reload',async()=>{
    const f=fixture([raw(1),raw(0),raw(0,13)]);
    const first=await C.loadTradeHistory(f.options); await C.loadTradeHistory(f.options);
    expect(f.blocks).to.deep.equal(['hash12','hash13']);
    expect(first.map(t=>[t.logIndex,t.timestamp])).to.deep.equal([[0,720],[1,720],[0,780]]);
  });
  it('handles empty and one-execution markets without making up prices',async()=>{
    const f=fixture(); expect(await C.loadTradeHistory(f.options)).to.deep.equal([]); expect(f.blocks).to.deep.equal([]);
    const one=fixture([raw(0)]); const result=await C.loadTradeHistory(one.options);
    expect(result).to.have.length(1); expect(result[0].timestamp).to.equal(720);
  });
  it('uses range retry logic without swallowing unrelated errors',async()=>{
    const f=fixture(); const accepted=[];
    f.contract.queryFilter=async(m,a,b)=>{if(b-a+1>5)throw Error('block range too large');accepted.push([a,b]);return [];};
    await C.loadTradeHistory({...f.options,exchangeDeploymentBlock:4});
    expect(accepted[0][1]).to.equal(30);expect(accepted.at(-1)[0]).to.equal(4);
    f.contract.queryFilter=async()=>{throw Error('disconnected');};
    let error;try{await C.loadTradeHistory(f.options);}catch(e){error=e;}
    expect(error.message).to.equal('disconnected');
  });
  it('builds exact OHLC and volume sums, with no fabricated empty buckets',()=>{
    const prices=[9007199254740993001n,9007199254740993009n,9007199254740992999n,9007199254740993003n];
    const trades=prices.map((p,i)=>({...H.normalize(raw(i,12,1,p)),timestamp:720+i}));
    trades.push({...H.normalize(raw(0,100)),timestamp:6000});
    const candles=C.buildCandles([...trades].reverse(),60);
    expect(candles).to.have.length(2);
    expect(candles[0]).to.include({open:prices[0],high:prices[1],low:prices[2],close:prices[3],volumeLots:8n,volumeQuote:prices.reduce((a,b)=>a+b*2n,0n)});
    expect(C.buildCandles([],60)).to.deep.equal([]);
    expect(()=>C.buildCandles(trades,0)).to.throw();
  });
  it('appends live trades without a range reload and deduplicates overlap',async()=>{
    const f=fixture([raw(0)]);let snapshot;const c=C.create({onChange:s=>snapshot=s});
    await c.start(f.options);const calls=f.queries.length;
    await c.append(H.normalize(raw(0)));await c.append(H.normalize(raw(1,13)));
    expect(snapshot.trades).to.have.length(2);expect(f.queries).to.have.length(calls);
    await c.append(H.normalize(raw(1,13)),true);expect(snapshot.trades).to.have.length(1);
  });
  it('clears on market change and ignores stale timestamp completions',async()=>{
    const f=fixture([raw(0),raw(0,15,2)]);let snapshot;const c=C.create({onChange:s=>snapshot=s});
    await c.start(f.options);let release; f.provider.getBlock=()=>new Promise(r=>release=r);
    const pending=c.append(H.normalize(raw(1,20)));
    c.clear();expect(snapshot.trades).to.deep.equal([]);
    f.provider.getBlock=async()=>({timestamp:900});
    await c.start({...f.options,marketId:2});release({timestamp:1200});await pending;
    expect(snapshot.trades.map(t=>t.marketId)).to.deep.equal([2]);
  });
  it('handles a live fill arriving while full history is loading',async()=>{
    const f=fixture([raw(0)]);let release;f.contract.queryFilter=()=>new Promise(r=>release=r);
    let snapshot;const c=C.create({onChange:s=>snapshot=s});const loading=c.start({...f.options,exchangeDeploymentBlock:4});
    while(!release)await new Promise(r=>setTimeout(r,0));
    await c.append(H.normalize(raw(1,31)));release([raw(0)]);await loading;
    expect(snapshot.trades.map(t=>t.blockNumber)).to.deep.equal([12,31]);
  });
  it('reports missing timestamps and permits retry rather than caching failures',async()=>{
    const f=fixture([raw(0)]);f.provider.getBlock=async()=>null;
    let snapshot;const c=C.create({onChange:s=>snapshot=s});await c.start(f.options);
    expect(snapshot.status).to.equal('error');
    f.provider.getBlock=async()=>({timestamp:720});await c.start(f.options);expect(snapshot.status).to.equal('ready');
  });
});


describe("Execution chart rendering", function () {
  it("draws a single real fill and breaks long gaps instead of inventing activity", () => {
    const source = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
    const points = [], lines = [], moves = [];
    const ctx = { clearRect(){}, beginPath(){}, stroke(){}, fill(){}, fillText(){}, arc:(...a)=>points.push(a), lineTo:(...a)=>lines.push(a), moveTo:(...a)=>moves.push(a) };
    const el = { sparkline:{width:560,height:200,getContext:()=>ctx}, chartStatus:{} };
    const scope = vm.createContext({el,formatWetc:String,errorMessage:e=>e.message});
    vm.runInContext(source.slice(source.indexOf("function updateChart("),source.indexOf("function buildDemoBook(")),scope);
    scope.updateChart({status:"ready",trades:[]});expect(points).to.have.length(0);expect(el.chartStatus.textContent).to.include("No executions");
    const t = {...H.normalize(raw(0)),timestamp:720};
    scope.updateChart({status:"ready",trades:[t]});expect(points).to.have.length(1);expect(points[0][0]).to.equal(280);
    scope.updateChart({status:"ready",trades:[t,{...t,timestamp:90000}]});expect(lines).to.have.length(0);
    scope.updateChart({status:"error",error:Error("RPC failed"),trades:[]});expect(el.chartStatus.textContent).to.include("RPC failed");
  });

  it("loads actual Hardhat fills with timestamps via BrowserProvider, excluding seeded orders", async function () {
    const {ethers} = hardhat;
    const Token=await ethers.getContractFactory("TestERC20");
    const wetc=await Token.deploy("WETC","WETC",18,ethers.parseEther("1000"));
    const lot=await Token.deploy("LOT","LOT",0,1000);
    const Exchange=await ethers.getContractFactory("SaturnLotExchange");
    const exchange=await Exchange.deploy(wetc.target);
    const receipt=await exchange.deploymentTransaction().wait();
    await exchange.approveMarket(lot.target);
    await wetc.approve(exchange.target,ethers.MaxUint256);await lot.approve(exchange.target,ethers.MaxUint256);
    await exchange.placeSell(1,121,1);await exchange.placeSell(1,122,2);
    const provider=new ethers.BrowserProvider({request:({method,params})=>hardhat.network.provider.send(method,params||[])},undefined,{cacheTimeout:-1});
    const contract=new ethers.Contract(exchange.target,[H.TRADE_EVENT],provider);
    try {
      const options={provider,contract,marketId:1,exchangeDeploymentBlock:receipt.blockNumber};
      expect(await C.loadTradeHistory(options)).to.deep.equal([]);
      await exchange["buyFOK(uint32,int256,uint256,uint256)"](1,122,2,ethers.parseEther("10"));
      const trades=await C.loadTradeHistory(options);
      expect(trades.map(t=>t.tick)).to.deep.equal([121n,122n]);
      expect(trades[0].timestamp).to.be.a("number");
      expect(trades[0].timestamp).to.equal(trades[1].timestamp);
      expect(trades[0].transactionHash).to.equal(trades[1].transactionHash);
    } finally {provider.destroy();}
  });
});
