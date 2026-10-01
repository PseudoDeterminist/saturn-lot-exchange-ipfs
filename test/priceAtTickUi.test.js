import { expect } from "chai";
import hardhat from "hardhat";
import "../ui/trade-history.js";

const { ethers } = hardhat;
const H = globalThis.TradeHistory;

describe("CID UI price lattice", function () {
  it("matches Solidity priceAtTick for every valid tick", async function () {
    this.timeout(30000);

    const [owner] = await ethers.getSigners();

    // priceAtTick is pure; constructor only requires a nonzero WETC address.
    const Exchange = await ethers.getContractFactory("SaturnLotExchange");
    const exchange = await Exchange.deploy(owner.address, owner.address);

    const MIN = -464;
    const MAX = 1855;
    const BATCH = 128;

    for (let start = MIN; start <= MAX; start += BATCH) {
      const end = Math.min(MAX, start + BATCH - 1);
      const ticks = Array.from(
        { length: end - start + 1 },
        (_, i) => start + i
      );

      const solidity = await Promise.all(
        ticks.map(tick => exchange.priceAtTick(tick))
      );

      for (let i = 0; i < ticks.length; i++) {
        expect(
          H.priceAtTick(BigInt(ticks[i])),
          `tick ${ticks[i]}`
        ).to.equal(solidity[i]);
      }
    }
  });

  it("rejects ticks outside the Solidity range", function () {
    expect(() => H.priceAtTick(-465n)).to.throw("tick out of range");
    expect(() => H.priceAtTick(1856n)).to.throw("tick out of range");
  });
});
