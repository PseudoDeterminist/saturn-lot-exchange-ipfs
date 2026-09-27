import { expect } from "chai";
import hardhat from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const { ethers } = hardhat;

const MIN_TICK = -464;
const MAX_TICK = 1855;
const MAX_LOTS = 100000n;
const NONE = -(1n << 31n);

const RNG_MOD = 1n << 64n;

function makeRng(seed) {
  let s = BigInt(seed);
  return () => {
    s = (s * 6364136223846793005n + 1442695040888963407n) % RNG_MOD;
    return s;
  };
}

function randIndex(next, max) {
  return Number(next() % BigInt(max));
}

function randBetween(next, min, max) {
  const span = max - min + 1n;
  return min + (next() % span);
}

// These level assertions use ticks -10..10 (at most 21 levels).
// Public book views replace the legacy contract's public level mappings.
async function levelAt(exchange, isBuy, tick) {
  const [levels, count] = isBuy ? await exchange.getBuyBook(1, 32) : await exchange.getSellBook(1, 32);
  expect(count).to.be.lessThan(32n); // Exhaustive for these scenarios; never silently truncate.
  return Array.from(levels).slice(0, Number(count)).find(level => level.tick === BigInt(tick))
    || { price: 0n, totalLots: 0n, totalValue: 0n, orderCount: 0n };
}

async function assertBookInvariants(exchange, orderIds, buyTicks, sellTicks) {
  let buyLots = 0n;
  let buyValue = 0n;
  let sellLots = 0n;
  let sellValue = 0n;
  let bestBuy = NONE;
  let bestSell = NONE;

  const perBuy = new Map();
  const perSell = new Map();
  const priceCache = new Map();

  for (const id of orderIds) {
    const o = await exchange.orders(id);
    if (o.owner === ethers.ZeroAddress) continue;
    expect(o.lotsRemaining).to.be.greaterThan(0n);

    const key = o.tick.toString();
    let price = priceCache.get(key);
    if (!price) {
      price = await exchange.priceAtTick(o.tick);
      priceCache.set(key, price);
    }
    expect((o.lotsRemaining * await exchange.priceAtTick(o.tick))).to.equal(o.lotsRemaining * price);

    if (o.isBuy) {
      buyLots += o.lotsRemaining;
      buyValue += (o.lotsRemaining * await exchange.priceAtTick(o.tick));
      if (bestBuy === NONE || o.tick > bestBuy) bestBuy = o.tick;
      const entry = perBuy.get(key) ?? { tick: o.tick, lots: 0n, value: 0n, count: 0n };
      entry.lots += o.lotsRemaining;
      entry.value += o.lotsRemaining * await exchange.priceAtTick(o.tick);
      entry.count += 1n;
      perBuy.set(key, entry);
    } else {
      sellLots += o.lotsRemaining;
      sellValue += (o.lotsRemaining * await exchange.priceAtTick(o.tick));
      if (bestSell === NONE || o.tick < bestSell) bestSell = o.tick;
      const entry = perSell.get(key) ?? { tick: o.tick, lots: 0n, value: 0n, count: 0n };
      entry.lots += o.lotsRemaining;
      entry.value += o.lotsRemaining * await exchange.priceAtTick(o.tick);
      entry.count += 1n;
      perSell.set(key, entry);
    }
  }

  expect((await exchange.getMarket(1)).bookEscrowWETC).to.equal(buyValue);
  expect((await exchange.getMarket(1)).bookEscrowLots).to.equal(sellLots);

  const market = await exchange.getMarket(1);
  const quote = await ethers.getContractAt("TestERC20", await exchange.WETC());
  const lot = await ethers.getContractAt("TestERC20", market.lotToken);
  expect(await quote.balanceOf(exchange.target)).to.equal(buyValue);
  expect(await lot.balanceOf(exchange.target)).to.equal(sellLots);
  for (const [isBuy, expectedLevels] of [[true, perBuy], [false, perSell]]) {
    const [book, count] = isBuy ? await exchange.getBuyBook(1, 32) : await exchange.getSellBook(1, 32);
    expect(count).to.equal(BigInt(expectedLevels.size));
    for (const level of Array.from(book).slice(0, Number(count))) {
      expect(expectedLevels.has(level.tick.toString())).to.equal(true);
    }
  }

  const onchainBestBuy = (await exchange.getMarket(1)).bestBuyTick;
  const onchainBestSell = (await exchange.getMarket(1)).bestSellTick;
  expect(onchainBestBuy).to.equal(buyLots === 0n ? NONE : bestBuy);
  expect(onchainBestSell).to.equal(sellLots === 0n ? NONE : bestSell);

  for (const entry of perBuy.values()) {
    const lvl = await levelAt(exchange, true, entry.tick);
    expect(lvl.price).to.be.greaterThan(0n);
    expect(lvl.totalLots).to.equal(entry.lots);
    expect(lvl.totalValue).to.equal(entry.value);
    expect(lvl.orderCount).to.equal(entry.count);
  }
  for (const entry of perSell.values()) {
    const lvl = await levelAt(exchange, false, entry.tick);
    expect(lvl.price).to.be.greaterThan(0n);
    expect(lvl.totalLots).to.equal(entry.lots);
    expect(lvl.totalValue).to.equal(entry.value);
    expect(lvl.orderCount).to.equal(entry.count);
  }

  for (const tick of buyTicks) {
    const key = tick.toString();
    if (!perBuy.has(key)) {
      const lvl = await levelAt(exchange, true, tick);
      expect(lvl.price).to.equal(0n);
    }
  }
  for (const tick of sellTicks) {
    const key = tick.toString();
    if (!perSell.has(key)) {
      const lvl = await levelAt(exchange, false, tick);
      expect(lvl.price).to.equal(0n);
    }
  }
}

async function deployFixture() {
  const [deployer, alice, bob, carol] = await ethers.getSigners();
  const TestERC20 = await ethers.getContractFactory("TestERC20");
  const wetc = await TestERC20.deploy(
    "WETC",
    "WETC",
    18,
    ethers.parseUnits("1000000", 18)
  );
  const strn10k = await TestERC20.deploy("STRN10K", "STRN10K", 0, 1000000n);
  const SaturnLotExchange = await ethers.getContractFactory("SaturnLotExchange");
  const exchange = await SaturnLotExchange.deploy(
    await wetc.getAddress()
  );

  await exchange.approveMarket(await strn10k.getAddress());

  const wetcAmount = ethers.parseUnits("100000", 18);
  const strn10kAmount = 100000n;
  for (const user of [alice, bob, carol]) {
    await wetc.transfer(user.address, wetcAmount);
    await strn10k.transfer(user.address, strn10kAmount);
  }

  return { deployer, alice, bob, carol, wetc, strn10k, exchange };
}


describe("SaturnLotExchange", function () {
  it("reverts for out-of-range ticks and is monotonic at bounds", async () => {
    const { exchange } = await loadFixture(deployFixture);

    await expect(exchange.priceAtTick(MIN_TICK - 1)).to.be.revertedWith(
      "tick out of range"
    );
    await expect(exchange.priceAtTick(MAX_TICK + 1)).to.be.revertedWith(
      "tick out of range"
    );

    const pMin = await exchange.priceAtTick(MIN_TICK);
    const pMinPlus = await exchange.priceAtTick(MIN_TICK + 1);
    const pMax = await exchange.priceAtTick(MAX_TICK);
    expect(pMinPlus).to.be.greaterThan(pMin);
    expect(pMax).to.be.greaterThan(pMinPlus);
  });

  it("rejects zero quote token on deploy and invalid lot tokens on approval", async () => {
    const Factory = await ethers.getContractFactory("SaturnLotExchange");
    await expect(Factory.deploy(ethers.ZeroAddress)).to.be.revertedWith("zero WETC");
    const { exchange, wetc } = await loadFixture(deployFixture);
    await expect(exchange.approveMarket(ethers.ZeroAddress)).to.be.revertedWith("zero lot token");
    await expect(exchange.approveMarket(wetc.target)).to.be.revertedWith("lot token is WETC");
  });

  it("rejects zero or oversized lots", async () => {
    const { exchange } = await loadFixture(deployFixture);

    await expect(exchange["placeBuy(uint32,int256,uint256)"](1, 0, 0)).to.be.revertedWith("invalid lots");
    await expect(exchange["placeSell(uint32,int256,uint256)"](1, 0, 0)).to.be.revertedWith("invalid lots");
    const TOO_MANY_LOTS = (1n << 32n);
    await expect(exchange["placeBuy(uint32,int256,uint256)"](1, 0, TOO_MANY_LOTS)).to.be.revertedWith(
      "invalid lots"
    );
    await expect(exchange["placeSell(uint32,int256,uint256)"](1, 0, TOO_MANY_LOTS)).to.be.revertedWith(
      "invalid lots"
    );
  });

  it("rejects out-of-range ticks for maker orders", async () => {
    const { exchange, alice } = await loadFixture(deployFixture);

    await expect(
      exchange.connect(alice)["placeBuy(uint32,int256,uint256)"](1, MIN_TICK - 1, 1n)
    ).to.be.revertedWith("tick out of range");
    await expect(
      exchange.connect(alice)["placeBuy(uint32,int256,uint256)"](1, MAX_TICK + 1, 1n)
    ).to.be.revertedWith("tick out of range");
    await expect(
      exchange.connect(alice)["placeSell(uint32,int256,uint256)"](1, MIN_TICK - 1, 1n)
    ).to.be.revertedWith("tick out of range");
    await expect(
      exchange.connect(alice)["placeSell(uint32,int256,uint256)"](1, MAX_TICK + 1, 1n)
    ).to.be.revertedWith("tick out of range");
  });

  it("rejects zero lots for taker FOKs", async () => {
    const { exchange } = await loadFixture(deployFixture);

    await expect(
      exchange["buyFOK(uint32,int256,uint256,uint256)"](1, 0, 0, 0)
    ).to.be.revertedWith("invalid lots");
    await expect(
      exchange["sellFOK(uint32,int256,uint256,uint256)"](1, 0, 0, 0)
    ).to.be.revertedWith("invalid lots");
  });

  it("reverts taker when book side is empty", async () => {
    const { exchange } = await loadFixture(deployFixture);

    await expect(
      exchange["buyFOK(uint32,int256,uint256,uint256)"](1, 0, 1n, 1n)
    ).to.be.revertedWith("There are no sell orders on book");
    await expect(
      exchange["sellFOK(uint32,int256,uint256,uint256)"](1, 0, 1n, 0)
    ).to.be.revertedWith("There are no buy orders on book");
  });

  it("reverts taker when lots exceed book totals", async () => {
    const { exchange, wetc, strn10k, alice, bob } = await loadFixture(deployFixture);

    await strn10k.connect(alice).approve(exchange, 1n);
    await (await exchange.connect(alice)["placeSell(uint32,int256,uint256)"](1, 0, 1n)).wait();

    const price = await exchange.priceAtTick(0);
    await wetc.connect(bob).approve(exchange, price * 2n);
    await expect(
      exchange.connect(bob)["buyFOK(uint32,int256,uint256,uint256)"](1, 0, 2n, price * 2n)
    ).to.be.revertedWith("insufficient escrowed Lots on book");

    const buyPrice = await exchange.priceAtTick(-1);
    await wetc.connect(alice).approve(exchange, buyPrice);
    await (await exchange.connect(alice)["placeBuy(uint32,int256,uint256)"](1, -1, 1n)).wait();

    await strn10k.connect(bob).approve(exchange, 2n);
    await expect(
      exchange.connect(bob)["sellFOK(uint32,int256,uint256,uint256)"](1, -1, 2n, 0)
    ).to.be.revertedWith("FOK--Unfilled");
  });

  it("reverts sell FOK when min output exceeds escrow", async () => {
    const { exchange, wetc, alice } = await loadFixture(deployFixture);

    const price = await exchange.priceAtTick(0);
    await wetc.connect(alice).approve(exchange, price);
    await (await exchange.connect(alice)["placeBuy(uint32,int256,uint256)"](1, 0, 1n)).wait();

    await expect(
      exchange["sellFOK(uint32,int256,uint256,uint256)"](1, 0, 1n, price * 2n)
    ).to.be.revertedWith("FOK--Insufficient escrowed WETC on book");
  });

  it("reverts sell FOK when limit tick blocks fill", async () => {
    const { exchange, wetc, strn10k, alice, carol } = await loadFixture(deployFixture);

    const price = await exchange.priceAtTick(0);
    await wetc.connect(alice).approve(exchange, price);
    await (await exchange.connect(alice)["placeBuy(uint32,int256,uint256)"](1, 0, 1n)).wait();

    await strn10k.connect(carol).approve(exchange, 1n);
    await expect(
      exchange.connect(carol)["sellFOK(uint32,int256,uint256,uint256)"](1, 1, 1n, 0)
    ).to.be.revertedWith("FOK--Limit tick crossed");
  });

  it("rejects buys that cross the sell book", async () => {
    const { exchange, wetc, strn10k, alice, bob } = await loadFixture(deployFixture);

    await strn10k.connect(alice).approve(exchange, 5n);
    await (await exchange.connect(alice)["placeSell(uint32,int256,uint256)"](1, 0, 5n)).wait();

    const price = await exchange.priceAtTick(0);
    await wetc.connect(bob).approve(exchange, price * 5n);

    await expect(exchange.connect(bob)["placeBuy(uint32,int256,uint256)"](1, 0, 5n)).to.be.revertedWith(
      "crossing sell book -- consider buyFOK"
    );
    await expect(exchange.connect(bob)["placeBuy(uint32,int256,uint256)"](1, 1, 5n)).to.be.revertedWith(
      "crossing sell book -- consider buyFOK"
    );
  });

  it("rejects sells that cross the buy book", async () => {
    const { exchange, wetc, strn10k, alice, bob } = await loadFixture(deployFixture);

    const price = await exchange.priceAtTick(0);
    await wetc.connect(alice).approve(exchange, price * 5n);
    await (await exchange.connect(alice)["placeBuy(uint32,int256,uint256)"](1, 0, 5n)).wait();

    await strn10k.connect(bob).approve(exchange, 5n);
    await expect(exchange.connect(bob)["placeSell(uint32,int256,uint256)"](1, 0, 5n)).to.be.revertedWith(
      "crossing buy book -- consider sellFOK"
    );
    await expect(exchange.connect(bob)["placeSell(uint32,int256,uint256)"](1, -1, 5n)).to.be.revertedWith(
      "crossing buy book -- consider sellFOK"
    );
  });

  it("fills orders FIFO within a tick", async () => {
    const { exchange, wetc, strn10k, alice, bob, carol } =
      await loadFixture(deployFixture);
    const tick = 0;

    await strn10k.connect(alice).approve(exchange, 5n);
    await strn10k.connect(bob).approve(exchange, 5n);

    const id1 = await exchange.connect(alice)["placeSell(uint32,int256,uint256)"].staticCall(1, tick, 5n);
    await (await exchange.connect(alice)["placeSell(uint32,int256,uint256)"](1, tick, 5n)).wait();
    const id2 = await exchange.connect(bob)["placeSell(uint32,int256,uint256)"].staticCall(1, tick, 5n);
    await (await exchange.connect(bob)["placeSell(uint32,int256,uint256)"](1, tick, 5n)).wait();

    const price = await exchange.priceAtTick(tick);
    const buyLots = 3n;
    const maxWetcIn = price * buyLots;
    await wetc.connect(carol).approve(exchange, maxWetcIn);
    await (await exchange.connect(carol)["buyFOK(uint32,int256,uint256,uint256)"](1, tick, buyLots, maxWetcIn)).wait();

    const order1 = await exchange.orders(id1);
    const order2 = await exchange.orders(id2);
    expect(order1.lotsRemaining).to.equal(2n);
    expect(order2.lotsRemaining).to.equal(5n);

    const lvl = await levelAt(exchange, false, tick);
    expect(lvl.orderCount).to.equal(2n);
    expect(lvl.totalLots).to.equal(7n);
  });

  it("reverts FOK when limit tick blocks full fill (no state change)", async () => {
    const { exchange, wetc, strn10k, alice, bob, carol } =
      await loadFixture(deployFixture);

    await strn10k.connect(alice).approve(exchange, 5n);
    await strn10k.connect(bob).approve(exchange, 4n);
    const id1 = await exchange.connect(alice)["placeSell(uint32,int256,uint256)"].staticCall(1, 0, 5n);
    await (await exchange.connect(alice)["placeSell(uint32,int256,uint256)"](1, 0, 5n)).wait();
    const id2 = await exchange.connect(bob)["placeSell(uint32,int256,uint256)"].staticCall(1, 1, 4n);
    await (await exchange.connect(bob)["placeSell(uint32,int256,uint256)"](1, 1, 4n)).wait();

    const price0 = await exchange.priceAtTick(0);
    const price1 = await exchange.priceAtTick(1);
    const maxWetcIn = price0 * 5n + price1 * 4n;
    await wetc.connect(carol).approve(exchange, maxWetcIn);

    await expect(exchange.connect(carol)["buyFOK(uint32,int256,uint256,uint256)"](1, 0, 9n, maxWetcIn)).to.be.revertedWith(
      "FOK--Limit tick crossed"
    );

    const order1 = await exchange.orders(id1);
    const order2 = await exchange.orders(id2);
    expect(order1.lotsRemaining).to.equal(5n);
    expect(order2.lotsRemaining).to.equal(4n);

    const totals = await exchange.getEscrowTotals(1);
    expect(totals[1]).to.equal(9n);
  });

  it("reverts buy FOK on slippage before state updates", async () => {
    const { exchange, wetc, strn10k, alice, carol } =
      await loadFixture(deployFixture);

    await strn10k.connect(alice).approve(exchange, 5n);
    await (await exchange.connect(alice)["placeSell(uint32,int256,uint256)"](1, 0, 5n)).wait();

    const price = await exchange.priceAtTick(0);
    const cost = price * 5n;
    // Another maker's bid funds gross transfers, so the explicit slippage guard
    // is reached. The reverted transaction must also preserve that escrow.
    const bidValue = await exchange.priceAtTick(-1);
    await wetc.connect(alice).approve(exchange, bidValue);
    await exchange.connect(alice)["placeBuy(uint32,int256,uint256)"](1, -1, 1);
    const beforeMarket = await exchange.getMarket(1);
    const beforeBalance = await wetc.balanceOf(exchange.target);
    await wetc.connect(carol).approve(exchange, cost - 1n);
    await expect(
      exchange.connect(carol)["buyFOK(uint32,int256,uint256,uint256)"](1, 0, 5n, cost - 1n)
    ).to.be.revertedWith("FOK--Slippage exceeded");

    const lvl = await levelAt(exchange, false, 0);
    expect(lvl.totalLots).to.equal(5n);
    expect(await exchange.getMarket(1)).to.deep.equal(beforeMarket);
    expect(await wetc.balanceOf(exchange.target)).to.equal(beforeBalance);
  });

  it("fills across ticks and updates oracle fields", async () => {
    const { exchange, wetc, strn10k, alice, bob, carol } =
      await loadFixture(deployFixture);

    await strn10k.connect(alice).approve(exchange, 5n);
    await strn10k.connect(bob).approve(exchange, 4n);
    const id1 = await exchange.connect(alice)["placeSell(uint32,int256,uint256)"].staticCall(1, 0, 5n);
    await (await exchange.connect(alice)["placeSell(uint32,int256,uint256)"](1, 0, 5n)).wait();
    const id2 = await exchange.connect(bob)["placeSell(uint32,int256,uint256)"].staticCall(1, 1, 4n);
    await (await exchange.connect(bob)["placeSell(uint32,int256,uint256)"](1, 1, 4n)).wait();

    const price0 = await exchange.priceAtTick(0);
    const price1 = await exchange.priceAtTick(1);
    const maxWetcIn = price0 * 5n + price1 * 2n;
    await wetc.connect(carol).approve(exchange, maxWetcIn);
    await (await exchange.connect(carol)["buyFOK(uint32,int256,uint256,uint256)"](1, 1, 7n, maxWetcIn)).wait();

    const order1 = await exchange.orders(id1);
    const order2 = await exchange.orders(id2);
    expect(order1.owner).to.equal(ethers.ZeroAddress);
    expect(order2.lotsRemaining).to.equal(2n);

    expect((await exchange.getMarket(1)).bestSellTick).to.equal(1n);
    expect((await exchange.getMarket(1)).lastTradeTick).to.equal(1n);
    const lastTradeTick = (await exchange.getMarket(1)).lastTradeTick;
    expect(await exchange.priceAtTick(lastTradeTick)).to.equal(price1);

    const totals = await exchange.getEscrowTotals(1);
    expect(totals[1]).to.equal(2n);
    const [sellBook, sellCount] = await exchange.getSellBook(1, 1);
    expect(sellCount).to.equal(1n);
    expect(sellBook[0].totalValue).to.equal(price1 * 2n);
  });

  it("refunds unused quote in buy FOK", async () => {
    const { exchange, wetc, strn10k, alice, carol } =
      await loadFixture(deployFixture);

    await strn10k.connect(alice).approve(exchange, 3n);
    await (await exchange.connect(alice)["placeSell(uint32,int256,uint256)"](1, 0, 3n)).wait();

    const price = await exchange.priceAtTick(0);
    const cost = price * 3n;
    const maxWetcIn = cost + 1n;

    const before = await wetc.balanceOf(carol.address);
    await wetc.connect(carol).approve(exchange, maxWetcIn);
    await (await exchange.connect(carol)["buyFOK(uint32,int256,uint256,uint256)"](1, 0, 3n, maxWetcIn)).wait();
    const after = await wetc.balanceOf(carol.address);

    expect(before - after).to.equal(cost);
  });

  it("reverts sell FOK when min output is too high", async () => {
    const { exchange, wetc, strn10k, alice, carol } =
      await loadFixture(deployFixture);

    const price = await exchange.priceAtTick(0);
    const cost = price * 10n;

    await wetc.connect(alice).approve(exchange, cost);
    await (await exchange.connect(alice)["placeBuy(uint32,int256,uint256)"](1, 0, 10n)).wait();

    await strn10k.connect(carol).approve(exchange, 5n);
    await expect(
      exchange.connect(carol)["sellFOK(uint32,int256,uint256,uint256)"](1, 0, 5n, price * 5n + 1n)
    ).to.be.revertedWith("FOK--Slippage exceeded");
  });

  it("allows partial fills then cancel refunds remaining escrow", async () => {
    const { exchange, wetc, strn10k, alice, carol } =
      await loadFixture(deployFixture);

    const price = await exchange.priceAtTick(0);
    const cost = price * 10n;

    await wetc.connect(alice).approve(exchange, cost);
    const id = await exchange.connect(alice)["placeBuy(uint32,int256,uint256)"].staticCall(1, 0, 10n);
    await (await exchange.connect(alice)["placeBuy(uint32,int256,uint256)"](1, 0, 10n)).wait();

    await strn10k.connect(carol).approve(exchange, 4n);
    await (await exchange.connect(carol)["sellFOK(uint32,int256,uint256,uint256)"](1, 0, 4n, 0)).wait();

    const order = await exchange.orders(id);
    expect(order.lotsRemaining).to.equal(6n);

    const before = await wetc.balanceOf(alice.address);
    await (await exchange.connect(alice).cancel(id)).wait();
    const after = await wetc.balanceOf(alice.address);

    expect(after - before).to.equal(price * 6n);
    expect((await exchange.getMarket(1)).bookEscrowWETC).to.equal(0n);
    const [, buyCount] = await exchange.getBuyBook(1, 1);
    expect(buyCount).to.equal(0n);
  });

  it("rejects cancel from non-owner", async () => {
    const { exchange, wetc, alice, bob } = await loadFixture(deployFixture);

    const price = await exchange.priceAtTick(0);
    await wetc.connect(alice).approve(exchange, price);
    const id = await exchange.connect(alice)["placeBuy(uint32,int256,uint256)"].staticCall(1, 0, 1n);
    await (await exchange.connect(alice)["placeBuy(uint32,int256,uint256)"](1, 0, 1n)).wait();

    await expect(exchange.connect(bob).cancel(id)).to.be.revertedWith("not order owner");
  });

  it("maintains book invariants under randomized actions (multi-seed)", async () => {
    const { exchange, wetc, strn10k, alice, bob, carol } =
      await loadFixture(deployFixture);

    const actors = [alice, bob, carol];
    const maxWetc = ethers.parseUnits("100000", 18);
    for (const actor of actors) {
      await wetc.connect(actor).approve(exchange, maxWetc);
      await strn10k.connect(actor).approve(exchange, 100000n);
    }

    const orderIds = [];
    const buyTicks = new Set();
    const sellTicks = new Set();
    const TICK_MIN = -10n;
    const TICK_MAX = 10n;
    const seeds = [123n, 999n];
    const steps = 80;

    for (const seed of seeds) {
      const nextRand = makeRng(seed);
      for (let i = 0; i < steps; i++) {
        const actor = actors[randIndex(nextRand, actors.length)];
        const action = randIndex(nextRand, 5);
        let didWork = false;

        if (action === 0) {
          let maxTick = TICK_MAX;
          const bestSell = (await exchange.getMarket(1)).bestSellTick;
          if (bestSell !== NONE) maxTick = bestSell - 1n;
          if (maxTick >= TICK_MIN) {
            const tick = randBetween(nextRand, TICK_MIN, maxTick);
            const lots = randBetween(nextRand, 1n, 5n);
            const id = await exchange.connect(actor)["placeBuy(uint32,int256,uint256)"].staticCall(1, tick, lots);
            await exchange.connect(actor)["placeBuy(uint32,int256,uint256)"](1, tick, lots);
            orderIds.push(id);
            buyTicks.add(tick);
            didWork = true;
          }
        } else if (action === 1) {
          let minTick = TICK_MIN;
          const bestBuy = (await exchange.getMarket(1)).bestBuyTick;
          if (bestBuy !== NONE) minTick = bestBuy + 1n;
          if (minTick <= TICK_MAX) {
            const tick = randBetween(nextRand, minTick, TICK_MAX);
            const lots = randBetween(nextRand, 1n, 5n);
            const id = await exchange.connect(actor)["placeSell(uint32,int256,uint256)"].staticCall(1, tick, lots);
            await exchange.connect(actor)["placeSell(uint32,int256,uint256)"](1, tick, lots);
            orderIds.push(id);
            sellTicks.add(tick);
            didWork = true;
          }
        } else if (action === 2) {
          const [sellBook, sellLevelCount] = await exchange.getSellBook(1, 32);
          const visibleSellLevels = Array.from(sellBook).slice(0, Number(sellLevelCount));
          const available = visibleSellLevels.reduce((sum, level) => sum + level.totalLots, 0n);
          const maxWetcIn = visibleSellLevels.reduce((sum, level) => sum + level.totalValue, 0n);
          if (available > 0n && maxWetcIn > 0n) {
            const maxLots = available < 5n ? available : 5n;
            const lots = randBetween(nextRand, 1n, maxLots);
            await exchange.connect(actor)["buyFOK(uint32,int256,uint256,uint256)"](1, MAX_TICK, lots, maxWetcIn);
            didWork = true;
          }
        } else if (action === 3) {
          const [buyBook, buyLevelCount] = await exchange.getBuyBook(1, 32);
          const visibleBuyLevels = Array.from(buyBook).slice(0, Number(buyLevelCount));
          const available = visibleBuyLevels.reduce((sum, level) => sum + level.totalLots, 0n);
          if (available > 0n) {
            const maxLots = available < 5n ? available : 5n;
            const lots = randBetween(nextRand, 1n, maxLots);
            await exchange.connect(actor)["sellFOK(uint32,int256,uint256,uint256)"](1, MIN_TICK, lots, 0);
            didWork = true;
          }
        } else {
          if (orderIds.length > 0) {
            const id = orderIds[randIndex(nextRand, orderIds.length)];
            const o = await exchange.orders(id);
            if (o.owner !== ethers.ZeroAddress && o.owner === actor.address) {
              await exchange.connect(actor).cancel(id);
              didWork = true;
            }
          }
        }

        if (didWork) {
          await assertBookInvariants(exchange, orderIds, buyTicks, sellTicks);
        }
      }
    }
  });

  it("returns empty results for zero limits and empty book", async () => {
    const { exchange } = await loadFixture(deployFixture);

    const [emptyBuy, buyCount] = await exchange.getBuyBook(1, 0);
    const [emptySell, sellCount] = await exchange.getSellBook(1, 0);
    const [emptyBuyOrders, buyOrdersCount] = await exchange.getBuyOrders(1, 0);
    const [emptySellOrders, sellOrdersCount] = await exchange.getSellOrders(1, 0);
    expect(emptyBuy.length).to.equal(0);
    expect(emptySell.length).to.equal(0);
    expect(emptyBuyOrders.length).to.equal(0);
    expect(emptySellOrders.length).to.equal(0);
    expect(buyCount).to.equal(0n);
    expect(sellCount).to.equal(0n);
    expect(buyOrdersCount).to.equal(0n);
    expect(sellOrdersCount).to.equal(0n);

    const [buyBook, buyBookCount] = await exchange.getBuyBook(1, 5);
    const [sellBook, sellBookCount] = await exchange.getSellBook(1, 5);
    expect(buyBook.length).to.equal(0);
    expect(sellBook.length).to.equal(0);
    expect(buyBookCount).to.equal(0n);
    expect(sellBookCount).to.equal(0n);
  });

  it("exposes book levels, FIFO orders, top-of-book, and oracle views", async () => {
    const { exchange, wetc, strn10k, alice, bob, carol } =
      await loadFixture(deployFixture);

    const buyTick1 = 2;
    const buyTick2 = 0;
    const sellTick1 = 3;
    const sellTick2 = 5;

    const priceBuy1 = await exchange.priceAtTick(buyTick1);
    const priceBuy2 = await exchange.priceAtTick(buyTick2);
    await wetc.connect(alice).approve(exchange, priceBuy1 * 3n);
    await wetc.connect(bob).approve(exchange, priceBuy2 * 2n);
    const buyId1 = await exchange.connect(alice)["placeBuy(uint32,int256,uint256)"].staticCall(1, buyTick1, 3n);
    await exchange.connect(alice)["placeBuy(uint32,int256,uint256)"](1, buyTick1, 3n);
    const buyId2 = await exchange.connect(bob)["placeBuy(uint32,int256,uint256)"].staticCall(1, buyTick2, 2n);
    await exchange.connect(bob)["placeBuy(uint32,int256,uint256)"](1, buyTick2, 2n);

    await strn10k.connect(alice).approve(exchange, 4n);
    await strn10k.connect(bob).approve(exchange, 3n);
    const sellId1 = await exchange.connect(alice)["placeSell(uint32,int256,uint256)"].staticCall(1, sellTick1, 4n);
    await exchange.connect(alice)["placeSell(uint32,int256,uint256)"](1, sellTick1, 4n);
    const sellId2 = await exchange.connect(bob)["placeSell(uint32,int256,uint256)"].staticCall(1, sellTick2, 3n);
    await exchange.connect(bob)["placeSell(uint32,int256,uint256)"](1, sellTick2, 3n);

    const [buyBook, buyCount] = await exchange.getBuyBook(1, 10);
    const [sellBook, sellCount] = await exchange.getSellBook(1, 10);
    expect(buyCount).to.equal(2n);
    expect(sellCount).to.equal(2n);
    expect(buyBook[0].tick).to.equal(buyTick1);
    expect(buyBook[1].tick).to.equal(buyTick2);
    expect(sellBook[0].tick).to.equal(sellTick1);
    expect(sellBook[1].tick).to.equal(sellTick2);

    expect(buyBook[0].totalLots).to.equal(3n);
    expect(buyBook[0].totalValue).to.equal(priceBuy1 * 3n);
    expect(buyBook[1].totalLots).to.equal(2n);
    expect(buyBook[1].totalValue).to.equal(priceBuy2 * 2n);

    const [buyOrders, buyOrdersCount] = await exchange.getBuyOrders(1, 10);
    expect(buyOrdersCount).to.equal(2n);
    expect(buyOrders[0].id).to.equal(buyId1);
    expect(buyOrders[1].id).to.equal(buyId2);

    const [sellOrders, sellOrdersCount] = await exchange.getSellOrders(1, 10);
    expect(sellOrdersCount).to.equal(2n);
    expect(sellOrders[0].id).to.equal(sellId1);
    expect(sellOrders[1].id).to.equal(sellId2);

    const [bestBuy, buyLots, buyOrdersTop, bestSell, sellLots, sellOrdersTop] =
      await exchange.getTopOfBook(1);
    expect(bestBuy).to.equal(buyTick1);
    expect(buyLots).to.equal(3n);
    expect(buyOrdersTop).to.equal(1n);
    expect(bestSell).to.equal(sellTick1);
    expect(sellLots).to.equal(4n);
    expect(sellOrdersTop).to.equal(1n);

    const priceSell1 = await exchange.priceAtTick(sellTick1);
    await wetc.connect(carol).approve(exchange, priceSell1 * 2n);
    await exchange.connect(carol)["buyFOK(uint32,int256,uint256,uint256)"](1, sellTick1, 2n, priceSell1 * 2n);

    const [obBestBuy, obBestSell, lastTick, lastBlock, lastPrice] =
      await exchange.getOracle(1);
    expect(obBestBuy).to.equal((await exchange.getMarket(1)).bestBuyTick);
    expect(obBestSell).to.equal((await exchange.getMarket(1)).bestSellTick);
    expect(lastTick).to.equal(sellTick1);
    expect(lastPrice).to.equal(priceSell1);
    expect(lastBlock).to.be.greaterThan(0n);
  });

});

describe("Gas metrics", function () {
  const GAS_PRICE = ethers.parseUnits("1", "gwei");
  const GAS_OVERRIDES = { type: 0, gasPrice: GAS_PRICE };

  async function gasUsedFor(txPromise) {
    const tx = await txPromise;
    const receipt = await tx.wait();
    return receipt.gasUsed;
  }

  function logGas(label, gasUsed) {
    const costWei = gasUsed * GAS_PRICE;
    const costGwei = ethers.formatUnits(costWei, "gwei");
    console.log(`${label}: gasUsed=${gasUsed} cost=${costGwei} gwei`);
  }

  it("logs maker gas for placeBuy and placeSell", async () => {
    const { exchange, wetc, strn10k, alice, bob } = await loadFixture(deployFixture);

    const buyTick = 0;
    const sellTick = 1;
    const lots = 1n;

    const buyPrice = await exchange.priceAtTick(buyTick);
    const buyCost = buyPrice * lots;
    await wetc.connect(alice).approve(exchange, buyCost * 2n);
    await exchange.connect(alice)["placeBuy(uint32,int256,uint256)"](1, buyTick, lots, GAS_OVERRIDES);
    const gasPlaceBuy = await gasUsedFor(
      exchange.connect(alice)["placeBuy(uint32,int256,uint256)"](1, buyTick, lots, GAS_OVERRIDES)
    );
    logGas("placeBuy (1 lot, warmed)", gasPlaceBuy);

    await strn10k.connect(bob).approve(exchange, lots * 2n);
    await exchange.connect(bob)["placeSell(uint32,int256,uint256)"](1, sellTick, lots, GAS_OVERRIDES);
    const gasPlaceSell = await gasUsedFor(
      exchange.connect(bob)["placeSell(uint32,int256,uint256)"](1, sellTick, lots, GAS_OVERRIDES)
    );
    logGas("placeSell (1 lot, warmed)", gasPlaceSell);

    expect(gasPlaceBuy).to.be.greaterThan(0n);
    expect(gasPlaceSell).to.be.greaterThan(0n);
  });

  it("logs taker gas for buyFOK single vs 200 orders (single tick + 200 ticks)", async () => {
    {
      const { exchange, wetc, strn10k, alice, bob } = await loadFixture(deployFixture);
      const tick = 0;
      const lots = 1n;

      await strn10k.connect(alice).approve(exchange, lots);
      await exchange.connect(alice)["placeSell(uint32,int256,uint256)"](1, tick, lots);

      const price = await exchange.priceAtTick(tick);
      const maxWetcIn = price * lots;
      await wetc.connect(bob).approve(exchange, maxWetcIn);
      const gasUsed = await gasUsedFor(
        exchange.connect(bob)["buyFOK(uint32,int256,uint256,uint256)"](1, tick, lots, maxWetcIn, GAS_OVERRIDES)
      );
      logGas("buyFOK single order", gasUsed);
      expect(gasUsed).to.be.greaterThan(0n);
    }

    {
      const { exchange, wetc, strn10k, alice, bob } = await loadFixture(deployFixture);
      const orders = 200;
      const tick = 0;
      const lotsPerOrder = 1n;
      const price = await exchange.priceAtTick(tick);
      const maxWetcIn = price * BigInt(orders);

      await strn10k.connect(alice).approve(exchange, BigInt(orders));
      for (let i = 0; i < orders; i++) {
        await exchange.connect(alice)["placeSell(uint32,int256,uint256)"](1, tick, lotsPerOrder);
      }

      await wetc.connect(bob).approve(exchange, maxWetcIn);
      const gasUsed = await gasUsedFor(
        exchange
          .connect(bob)
          ["buyFOK(uint32,int256,uint256,uint256)"](1, tick, BigInt(orders), maxWetcIn, GAS_OVERRIDES)
      );
      logGas("buyFOK 200 orders single tick", gasUsed);
      expect(gasUsed).to.be.greaterThan(0n);
    }

    {
      const { exchange, wetc, strn10k, alice, bob } = await loadFixture(deployFixture);
      const orders = 200;
      const lotsPerOrder = 1n;
      let maxWetcIn = 0n;

      await strn10k.connect(alice).approve(exchange, BigInt(orders));
      for (let i = 0; i < orders; i++) {
        const tick = i;
        await exchange.connect(alice)["placeSell(uint32,int256,uint256)"](1, tick, lotsPerOrder);
        const price = await exchange.priceAtTick(tick);
        maxWetcIn += price * lotsPerOrder;
      }

      await wetc.connect(bob).approve(exchange, maxWetcIn);
      const gasUsed = await gasUsedFor(
        exchange
          .connect(bob)
          ["buyFOK(uint32,int256,uint256,uint256)"](1, orders - 1, BigInt(orders), maxWetcIn, GAS_OVERRIDES)
      );
      logGas("buyFOK 200 orders across 200 ticks", gasUsed);
      expect(gasUsed).to.be.greaterThan(0n);
    }
  });

  it("logs taker gas for sellFOK single vs 200 orders (single tick + 200 ticks)", async () => {
    {
      const { exchange, wetc, strn10k, alice, bob } = await loadFixture(deployFixture);
      const tick = 0;
      const lots = 1n;

      const price = await exchange.priceAtTick(tick);
      await wetc.connect(alice).approve(exchange, price * lots);
      await exchange.connect(alice)["placeBuy(uint32,int256,uint256)"](1, tick, lots);

      await strn10k.connect(bob).approve(exchange, lots);
      const gasUsed = await gasUsedFor(
        exchange.connect(bob)["sellFOK(uint32,int256,uint256,uint256)"](1, tick, lots, price * lots, GAS_OVERRIDES)
      );
      logGas("sellFOK single order", gasUsed);
      expect(gasUsed).to.be.greaterThan(0n);
    }

    {
      const { exchange, wetc, strn10k, alice, bob } = await loadFixture(deployFixture);
      const orders = 200;
      const tick = 0;
      const lotsPerOrder = 1n;
      const price = await exchange.priceAtTick(tick);
      const minWetcOut = price * BigInt(orders);

      await wetc.connect(alice).approve(exchange, minWetcOut);
      for (let i = 0; i < orders; i++) {
        await exchange.connect(alice)["placeBuy(uint32,int256,uint256)"](1, tick, lotsPerOrder);
      }

      await strn10k.connect(bob).approve(exchange, BigInt(orders));
      const gasUsed = await gasUsedFor(
        exchange
          .connect(bob)
          ["sellFOK(uint32,int256,uint256,uint256)"](1, tick, BigInt(orders), minWetcOut, GAS_OVERRIDES)
      );
      logGas("sellFOK 200 orders single tick", gasUsed);
      expect(gasUsed).to.be.greaterThan(0n);
    }

    {
      const { exchange, wetc, strn10k, alice, bob } = await loadFixture(deployFixture);
      const orders = 200;
      const lotsPerOrder = 1n;
      let minWetcOut = 0n;

      for (let i = 0; i < orders; i++) {
        const tick = i;
        const price = await exchange.priceAtTick(tick);
        minWetcOut += price * lotsPerOrder;
      }

      await wetc.connect(alice).approve(exchange, minWetcOut);
      for (let i = 0; i < orders; i++) {
        const tick = i;
        await exchange.connect(alice)["placeBuy(uint32,int256,uint256)"](1, tick, lotsPerOrder);
      }

      await strn10k.connect(bob).approve(exchange, BigInt(orders));
      const gasUsed = await gasUsedFor(
        exchange
          .connect(bob)
          ["sellFOK(uint32,int256,uint256,uint256)"](1, 0, BigInt(orders), minWetcOut, GAS_OVERRIDES)
      );
      logGas("sellFOK 200 orders across 200 ticks", gasUsed);
      expect(gasUsed).to.be.greaterThan(0n);
    }
  });
});
