const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const ROOT = path.join(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");

function updateEnvFile(filePath, entries) {
  let lines = [];

  if (fs.existsSync(filePath)) {
    lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  }

  const used = new Set();

  const next = lines.map((line) => {
    for (const [key, value] of Object.entries(entries)) {
      if (line.startsWith(`${key}=`)) {
        used.add(key);
        return `${key}=${value}`;
      }
    }
    return line;
  });

  for (const [key, value] of Object.entries(entries)) {
    if (!used.has(key)) {
      next.push(`${key}=${value}`);
    }
  }

  while (next.length && next[next.length - 1] === "") {
    next.pop();
  }

  fs.writeFileSync(filePath, `${next.join("\n")}\n`);
}

async function waitForReceipt(tx, label) {
  const hash = tx.hash;

  for (let i = 0; i < 30; i += 1) {
    try {
      const receipt = await ethers.provider.getTransactionReceipt(hash);

      if (receipt) {
        if (receipt.status !== 1) {
          throw new Error(`${label} reverted: ${hash}`);
        }

        return receipt;
      }
    } catch (err) {
      if (!String(err).includes("transaction indexing is in progress")) {
        throw err;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${label}: ${hash}`);
}

async function seedMarket(
  exchange,
  wetc,
  lotToken,
  marketId,
  label
) {
  const maxApprove = ethers.MaxUint256;

  await waitForReceipt(
    await wetc.approve(exchange.target, maxApprove),
    `${label} WETC approve`
  );

  await waitForReceipt(
    await lotToken.approve(exchange.target, maxApprove),
    `${label} lot token approve`
  );

  const sellSeeds = label === "TESTLOT"
  ? [
      { tick: 305, lots: 15 },
      { tick: 306, lots: 25 },
      { tick: 307, lots: 35 },
      { tick: 308, lots: 45 },
      { tick: 309, lots: 55 }
    ]
  : [
      { tick: 121, lots: 60 },
      { tick: 122, lots: 56 },
      { tick: 123, lots: 52 },
      { tick: 124, lots: 48 },
      { tick: 125, lots: 44 }
    ];

const buySeeds = label === "TESTLOT"
  ? [
      { tick: 304, lots: 18 },
      { tick: 303, lots: 28 },
      { tick: 302, lots: 38 },
      { tick: 301, lots: 48 },
      { tick: 300, lots: 58 }
    ]
  : [
      { tick: 120, lots: 60 },
      { tick: 119, lots: 56 },
      { tick: 118, lots: 52 },
      { tick: 117, lots: 48 },
      { tick: 116, lots: 44 }
    ];

  for (const order of sellSeeds) {
    await waitForReceipt(
      await exchange.placeSell(
        marketId,
        order.tick,
        order.lots
      ),
      `${label} seed sell ${order.tick}`
    );
  }

  for (const order of buySeeds) {
    await waitForReceipt(
      await exchange.placeBuy(
        marketId,
        order.tick,
        order.lots
      ),
      `${label} seed buy ${order.tick}`
    );
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log(
    "Network:",
    network.name,
    network.config.url || "in-process"
  );

  console.log("Deployer:", deployer.address);

  const TestERC20 = await ethers.getContractFactory("TestERC20");

  // ------------------------------------------------------------------
  // Deploy local WETC
  // ------------------------------------------------------------------

  const wetcSupply = ethers.parseUnits("1000000", 18);

  const wetc = await TestERC20.deploy(
    "Test Wrapped ETC",
    "WETC",
    18,
    wetcSupply
  );

  await waitForReceipt(
    wetc.deploymentTransaction(),
    "WETC deploy"
  );

  console.log("WETC:", wetc.target);

  // ------------------------------------------------------------------
  // Deploy first Lot Token
  // ------------------------------------------------------------------

  const strn10kSupply = ethers.parseUnits("100000", 0);

  const strn10k = await TestERC20.deploy(
    "STRN10K",
    "STRN10K",
    0,
    strn10kSupply
  );

  await waitForReceipt(
    strn10k.deploymentTransaction(),
    "STRN10K deploy"
  );

  console.log("STRN10K:", strn10k.target);

  // ------------------------------------------------------------------
  // Deploy second Lot Token so we can exercise multi-market behavior
  // ------------------------------------------------------------------

  const testLotSupply = ethers.parseUnits("100000", 0);

  const testLot = await TestERC20.deploy(
    "Test Lot Token",
    "TESTLOT",
    0,
    testLotSupply
  );

  await waitForReceipt(
    testLot.deploymentTransaction(),
    "TESTLOT deploy"
  );

  console.log("TESTLOT:", testLot.target);

  // ------------------------------------------------------------------
  // Deploy SaturnLotExchange
  // ------------------------------------------------------------------

  const SaturnLotExchange =
    await ethers.getContractFactory("SaturnLotExchange");

  const exchange =
    await SaturnLotExchange.deploy(wetc.target);

  await waitForReceipt(
    exchange.deploymentTransaction(),
    "SaturnLotExchange deploy"
  );

  console.log("SaturnLotExchange:", exchange.target);

  // ------------------------------------------------------------------
  // Approve two markets
  // ------------------------------------------------------------------

  await waitForReceipt(
    await exchange.approveMarket(strn10k.target),
    "approve STRN10K market"
  );

  const strn10kMarketId =
    await exchange.marketIdOf(strn10k.target);

  console.log(
    `Market ${strn10kMarketId}: STRN10K / WETC`
  );

  await waitForReceipt(
    await exchange.approveMarket(testLot.target),
    "approve TESTLOT market"
  );

  const testLotMarketId =
    await exchange.marketIdOf(testLot.target);

  console.log(
    `Market ${testLotMarketId}: TESTLOT / WETC`
  );

  // ------------------------------------------------------------------
  // Seed both order books
  // ------------------------------------------------------------------

  await seedMarket(
    exchange,
    wetc,
    strn10k,
    strn10kMarketId,
    "STRN10K"
  );

  console.log("Seeded STRN10K / WETC book.");

  await seedMarket(
    exchange,
    wetc,
    testLot,
    testLotMarketId,
    "TESTLOT"
  );

  console.log("Seeded TESTLOT / WETC book.");

  // ------------------------------------------------------------------
  // Save local deployment data
  // ------------------------------------------------------------------

  const addresses = {
    WETC_ADDRESS: wetc.target,
    STRN10K_ADDRESS: strn10k.target,
    TESTLOT_ADDRESS: testLot.target,
    SATURN_LOT_EXCHANGE_ADDRESS: exchange.target,
    STRN10K_MARKET_ID: strn10kMarketId.toString(),
    TESTLOT_MARKET_ID: testLotMarketId.toString()
  };

  updateEnvFile(ENV_PATH, addresses);

  console.log("");
  console.log("Local deployment complete.");
  console.log("");
  console.log("WETC:", wetc.target);
  console.log("Exchange:", exchange.target);
  console.log(
    `Market ${strn10kMarketId}: STRN10K / WETC`
  );
  console.log(
    `Market ${testLotMarketId}: TESTLOT / WETC`
  );
  console.log("");
  console.log("Saved deployment values to .env");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});