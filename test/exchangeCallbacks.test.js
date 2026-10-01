import { expect } from "chai";
import hardhat from "hardhat";
const { ethers } = hardhat;

describe("SaturnLotExchange token callbacks", function () {
  it("preserves market history when a lot-token hook places a nested maker order", async () => {
    const Token = await ethers.getContractFactory("TestERC20");
    const wetc = await Token.deploy("WETC", "WETC", 18, ethers.parseEther("1000"));
    const HookToken = await ethers.getContractFactory("ReentrantERC20");
    const lot = await HookToken.deploy("LOT", "LOT", 0, 1000);
    const Factory = await ethers.getContractFactory("SaturnLotExchange");
    const [owner] = await ethers.getSigners();
    const exchange = await Factory.deploy(wetc.target, owner.address);
    await exchange.approveMarket(lot.target);
    await exchange.activate();
    const Probe = await ethers.getContractFactory("ExchangeCallbackProbe");
    const probe = await Probe.deploy();
    const bidValue = await exchange.priceAtTick(120);
    await wetc.transfer(probe.target, bidValue);
    await probe.execute(wetc.target, wetc.interface.encodeFunctionData("approve", [exchange.target, bidValue]));
    await probe.arm(exchange.target, exchange.interface.encodeFunctionData("placeBuy(uint32,int256,uint256)", [1, 120, 1]));
    await lot.setReentry(probe.target, probe.interface.encodeFunctionData("callback"), false, true);
    await lot.approve(exchange.target, 1);
    const before = await exchange.getMarket(1);
    const nextId = await exchange.nextOrderId();
    await expect(exchange.placeSell(1, 121, 1))
      .to.be.revertedWithCustomError(exchange, "ReentrancyGuardReentrantCall");
    expect(await exchange.getMarket(1)).to.deep.equal(before);
    expect(await exchange.nextOrderId()).to.equal(nextId);
    expect(await wetc.balanceOf(exchange.target)).to.equal(0);
    expect(await lot.balanceOf(exchange.target)).to.equal(0);
  });
});
