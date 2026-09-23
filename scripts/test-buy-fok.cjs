const { ethers } = require("hardhat");

async function main() {
  const [taker] = await ethers.getSigners();

  const exchangeAddress = "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9";
  const wetcAddress = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

  const exchange = await ethers.getContractAt(
    "SaturnLotExchange",
    exchangeAddress,
    taker
  );

  const wetc = await ethers.getContractAt(
    "TestERC20",
    wetcAddress,
    taker
  );

  const marketId = 1;
  const limitTick = 121;
  const lots = 1n;

  const price = await exchange.priceAtTick(limitTick);

  console.log("Taker:", taker.address);
  console.log("Price:", ethers.formatEther(price), "WETC");

  const approveTx = await wetc.approve(exchangeAddress, price);
  await approveTx.wait();

  console.log("WETC approved");

  const tx = await exchange.buyFOK(
    marketId,
    limitTick,
    lots,
    price
  );

  console.log("buyFOK tx:", tx.hash);

  await tx.wait();

  const market = await exchange.getMarket(marketId);

  console.log("Trade complete");
  console.log("Last tick:", market.lastTradeTick.toString());
  console.log(
    "Last price:",
    ethers.formatEther(market.lastTradePrice),
    "WETC"
  );
  console.log(
    "Last taker was buy:",
    market.lastTradeTakerIsBuy
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});