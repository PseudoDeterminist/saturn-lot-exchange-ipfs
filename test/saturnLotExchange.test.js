import { expect } from "chai";
import hardhat from "hardhat";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import "../ui/trade-history.js";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const { ethers } = hardhat;

async function deployFixture() {
  const [, taker] = await ethers.getSigners();
  const Token = await ethers.getContractFactory("TestERC20");
  const wetc = await Token.deploy("WETC", "WETC", 18, ethers.parseEther("1000000"));
  const lot = await Token.deploy("LOT", "LOT", 0, 1000000n);
  const otherLot = await Token.deploy("OTHER", "OTHER", 0, 1000000n);
  const Exchange = await ethers.getContractFactory("SaturnLotExchange");
  const exchange = await Exchange.deploy(await wetc.getAddress());
  await exchange.approveMarket(await lot.getAddress());
  await exchange.approveMarket(await otherLot.getAddress());
  await wetc.transfer(taker.address, ethers.parseEther("1000"));
  await lot.transfer(taker.address, 100n);
  for (const token of [wetc, lot]) {
    await token.approve(exchange.target, ethers.MaxUint256);
    await token.connect(taker).approve(exchange.target, ethers.MaxUint256);
  }
  return { exchange, taker };
}

describe("SaturnLotExchange last taker side", function () {
  it("exposes an untraded market with a zero block and default false side", async () => {
    const { exchange } = await loadFixture(deployFixture);
    const market = await exchange.getMarket(1);
    expect(market.lastTradeBlock).to.equal(0n);
    expect(market.lastTradePrice).to.equal(0n);
    expect(market.lastTradeTakerIsBuy).to.equal(false);
  });

  it("tracks buy/sell/buy transitions and leaves another market untouched", async () => {
    const { exchange, taker } = await loadFixture(deployFixture);
    await exchange.placeSell(1, 121, 10);
    await exchange.placeBuy(1, 120, 10);
    for (const [isBuy, tick] of [[true, 121], [false, 120], [true, 121]]) {
      const tx = isBuy
        ? await exchange.connect(taker)["buyFOK(uint32,int256,uint256,uint256)"](1, tick, 1, ethers.parseEther("10"))
        : await exchange.connect(taker)["sellFOK(uint32,int256,uint256,uint256)"](1, tick, 1, 0);
      const receipt = await tx.wait();
      const market = await exchange.getMarket(1);
      expect(market.lastTradeTakerIsBuy).to.equal(isBuy);
      expect(market.lastTradeTick).to.equal(BigInt(tick));
      expect(market.lastTradePrice).to.equal(await exchange.priceAtTick(tick));
      expect(market.lastTradeBlock).to.equal(BigInt(receipt.blockNumber));
    }
    const other = await exchange.getMarket(2);
    expect(other.lastTradeBlock).to.equal(0n);
    expect(other.lastTradeTakerIsBuy).to.equal(false);
  });

  it("preserves the last execution when either FOK path reverts", async () => {
    const { exchange, taker } = await loadFixture(deployFixture);
    await exchange.placeSell(1, 121, 10);
    await exchange.placeBuy(1, 120, 10);
    await exchange.connect(taker)["buyFOK(uint32,int256,uint256,uint256)"](1, 121, 1, ethers.parseEther("10"));
    const before = await exchange.getMarket(1);
    await expect(exchange.connect(taker)["sellFOK(uint32,int256,uint256,uint256)"](1, 121, 1, 0))
      .to.be.revertedWith("FOK--Limit tick crossed");
    await expect(exchange.connect(taker)["buyFOK(uint32,int256,uint256,uint256)"](1, 120, 1, ethers.parseEther("10")))
      .to.be.revertedWith("FOK--Limit tick crossed");
    expect(await exchange.getMarket(1)).to.deep.equal(before);
  });
});


describe("Exchange UI market ABI", function () {
  it("decodes deployed market state and renders neutral, buy, and sell LAST states", async () => {
    const { exchange, taker } = await loadFixture(deployFixture);
    const source = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
    const abiSource = source.slice(source.indexOf("const ABI = ["), source.indexOf("const ERC20_ABI"));
    const abi = vm.runInNewContext(`${abiSource}; ABI;`, { TradeHistory: globalThis.TradeHistory });
    const uiContract = new ethers.Contract(exchange.target, abi, ethers.provider);
    const actual = exchange.interface.getFunction("getMarket").outputs;
    const ui = uiContract.interface.getFunction("getMarket").outputs;
    expect(ui.map((p) => [p.name, p.type])).to.deep.equal(actual.map((p) => [p.name, p.type]));
    const el = { lastTaken: {}, lastTakenPrice: {} };
    const context = vm.createContext({ el, formatWetc: (v) => Number(ethers.formatEther(v)).toFixed(4) });
    vm.runInContext(source.slice(source.indexOf("function renderLastTaken("), source.indexOf("function renderBook(")), context);
    async function check(side) {
      const market = await uiContract.getMarket(1);
      context.renderLastTaken(market.lastTradeBlock === 0n ? null : market.lastTradePrice, market.lastTradeTakerIsBuy);
      expect(el.lastTaken.className).to.equal(`last-taken ${side}`);
      expect(el.lastTakenPrice.textContent).to.equal(side === "neutral" ? "--" : Number(ethers.formatEther(market.lastTradePrice)).toFixed(4));
      const onchain = await exchange.getMarket(1);
      expect(market.bookEscrowWETC).to.equal(onchain.bookEscrowWETC);
      expect(market.bookEscrowLots).to.equal(onchain.bookEscrowLots);
    }
    await check("neutral");
    await exchange.placeSell(1, 121, 10);
    await exchange.placeBuy(1, 120, 10);
    await exchange.connect(taker)["buyFOK(uint32,int256,uint256,uint256)"](1, 121, 1, ethers.parseEther("10"));
    await check("buy");
    await exchange.connect(taker)["sellFOK(uint32,int256,uint256,uint256)"](1, 120, 1, 0);
    await check("sell");
  });
});


describe("Trade history through BrowserProvider", function () {
  it("loads each real maker fill and delivers subsequent live fills", async function () {
    this.timeout(15000);
    const { exchange, taker } = await loadFixture(deployFixture);
    await exchange.placeSell(1, 121, 1);
    await exchange.placeSell(1, 122, 3);
    await exchange.connect(taker)["buyFOK(uint32,int256,uint256,uint256)"](1, 122, 2, ethers.parseEther("10"));
    const provider = new ethers.BrowserProvider({ request: ({method, params}) => hardhat.network.provider.send(method, params || []) }, undefined, { polling: true, pollingInterval: 50, cacheTimeout: -1 });
    const contract = new ethers.Contract(exchange.target, [TradeHistory.TRADE_EVENT], provider);
    let snapshot;
    const history = TradeHistory.create({ onChange: s => { snapshot = s; } });
    try {
      await history.start(contract, provider, 1);
      expect(snapshot.status).to.equal("ready");
      expect(snapshot.trades).to.have.length(2);
      expect(snapshot.trades.map(t => t.tick)).to.deep.equal([121n, 122n]);
      expect(snapshot.trades[0].transactionHash).to.equal(snapshot.trades[1].transactionHash);
      await exchange.connect(taker)["buyFOK(uint32,int256,uint256,uint256)"](1, 122, 1, ethers.parseEther("10"));
      const deadline = Date.now() + 8000;
      while (snapshot.trades.length < 3 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(snapshot.trades).to.have.length(3);
      expect(snapshot.trades[2].takerIsBuy).to.equal(true);
      expect(snapshot.trades[2].lots).to.equal(1n);
    } finally {
      await history.stop();
      provider.destroy();
    }
  });
});
