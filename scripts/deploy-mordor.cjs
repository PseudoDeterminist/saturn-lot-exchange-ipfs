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
    if (!used.has(key)) next.push(`${key}=${value}`);
  }
  let last = next.length - 1;
  while (last >= 0 && next[last] === "") last -= 1;
  const output = last >= 0 ? `${next.slice(0, last + 1).join("\n")}\n` : "";
  fs.writeFileSync(filePath, output);
}

function writeAddresses(entries) {
  updateEnvFile(ENV_PATH, entries);
}

async function seedOrders(clob, wetc, strn10k, waitForReceipt) {
  const marketId = await clob.marketIdOf(strn10k.target);
  const maxApprove = ethers.MaxUint256;

  await waitForReceipt(await wetc.approve(clob.target, maxApprove), "WETC approve");
  await waitForReceipt(await strn10k.approve(clob.target, maxApprove), "STRN10K approve");

  const sellSeeds = [
    { tick: 121, lots: 60 },
    { tick: 122, lots: 56 },
    { tick: 123, lots: 52 },
    { tick: 124, lots: 48 },
    { tick: 125, lots: 44 }
  ];

  const buySeeds = [
    { tick: 120, lots: 60 },
    { tick: 119, lots: 56 },
    { tick: 118, lots: 52 },
    { tick: 117, lots: 48 },
    { tick: 116, lots: 44 }
  ];

  for (const order of sellSeeds) {
    await waitForReceipt(
      await clob.placeSell(marketId, order.tick, order.lots),
      `seed sell ${order.tick}`
    );
  }

  for (const order of buySeeds) {
    await waitForReceipt(
      await clob.placeBuy(marketId, order.tick, order.lots),
      `seed buy ${order.tick}`
    );
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Network:", network.name, network.config.url || "in-process");
  if (network.name !== "mordor") {
    throw new Error("deploy-mordor.cjs must be run with --network mordor");
  }
  console.log("Deployer:", deployer.address);

  async function waitForReceipt(tx, label) {
    const hash = tx.hash;
    for (let i = 0; i < 30; i += 1) {
      try {
        const receipt = await ethers.provider.getTransactionReceipt(hash);
        if (receipt) {
          return receipt;
        }
      } catch (err) {
        if (!String(err).includes("transaction indexing is in progress")) {
          throw err;
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`Timed out waiting for ${label} tx receipt: ${hash}`);
  }

  const TestERC20 = await ethers.getContractFactory("TestERC20");

  const wetcSupply = ethers.parseUnits("1000000", 18); // 1,000,000 WETC
  const strn10kSupply = ethers.parseUnits("100000", 0); // 100,000 lots

  let wetc;
  if (process.env.MORDOR_WETC_ADDRESS) {
    const code = await ethers.provider.getCode(process.env.MORDOR_WETC_ADDRESS);
    if (code && code !== "0x") {
      wetc = await ethers.getContractAt("TestERC20", process.env.MORDOR_WETC_ADDRESS);
      console.log("WETC (existing):", wetc.target);
    }
  }
  if (!wetc) {
    wetc = await TestERC20.deploy("WETC", "WETC", 18, wetcSupply);
    await waitForReceipt(wetc.deploymentTransaction(), "WETC deploy");
    console.log("WETC:", wetc.target);
  }

  let strn10k;
  if (process.env.MORDOR_STRN10K_ADDRESS) {
    const code = await ethers.provider.getCode(process.env.MORDOR_STRN10K_ADDRESS);
    if (code && code !== "0x") {
      strn10k = await ethers.getContractAt("TestERC20", process.env.MORDOR_STRN10K_ADDRESS);
      console.log("STRN10K (existing):", strn10k.target);
    }
  }
  if (!strn10k) {
    strn10k = await TestERC20.deploy("STRN10K", "STRN10K", 0, strn10kSupply);
    await waitForReceipt(strn10k.deploymentTransaction(), "STRN10K deploy");
    console.log("STRN10K:", strn10k.target);
  }

  const daoAddress = process.env.MORDOR_DAO_ADDRESS;
  if (!daoAddress) {
    throw new Error("Set MORDOR_DAO_ADDRESS in .env");
  }

  const daoCode = await ethers.provider.getCode(daoAddress);
  if (!daoCode || daoCode === "0x") {
    throw new Error(`No code at MORDOR_DAO_ADDRESS: ${daoAddress}`);
  }

  const SaturnLotExchange = await ethers.getContractFactory("SaturnLotExchange");
  const clob = await SaturnLotExchange.deploy(wetc.target, daoAddress);
  const deploymentReceipt = await waitForReceipt(clob.deploymentTransaction(), "SaturnLotExchange deploy");
  console.log("SaturnLotExchange:", clob.target);
  console.log("Owner (DAO):", await clob.owner());
  console.log("Exchange active:", await clob.exchangeActive());

  const addresses = {
    MORDOR_EXCHANGE_DEPLOYMENT_BLOCK: deploymentReceipt.blockNumber,
    MORDOR_STRN10K_MARKET_ID: "0",
    MORDOR_WETC_ADDRESS: wetc.target,
    MORDOR_STRN10K_ADDRESS: strn10k.target,
    MORDOR_SATURN_LOT_EXCHANGE_ADDRESS: clob.target
  };
  writeAddresses(addresses);
  console.log("Saved addresses to .env");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
