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

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Network:", network.name, network.config.url || "in-process");
  if (network.name !== "etc") {
    throw new Error("deploy-etc.cjs must be run with --network etc");
  }
  console.log("Deployer:", deployer.address);

  const wetcAddress = process.env.MAINNET_WETC_ADDRESS;
  const strn10kAddress = process.env.MAINNET_STRN10K_ADDRESS;

  if (!wetcAddress || !strn10kAddress) {
    throw new Error("Set MAINNET_WETC_ADDRESS and MAINNET_STRN10K_ADDRESS in .env");
  }

  if (wetcAddress.toLowerCase() !== "0x82a618305706b14e7bcf2592d4b9324a366b6dad") {
    throw new Error("ETC exchange uses its fixed mainnet WETC address");
  }

  const wetcCode = await ethers.provider.getCode(wetcAddress);
  if (!wetcCode || wetcCode === "0x") {
    throw new Error(`No code at MAINNET_WETC_ADDRESS: ${wetcAddress}`);
  }
  const strn10kCode = await ethers.provider.getCode(strn10kAddress);
  if (!strn10kCode || strn10kCode === "0x") {
    throw new Error(`No code at MAINNET_STRN10K_ADDRESS: ${strn10kAddress}`);
  }

  const SaturnLotExchange = await ethers.getContractFactory("SaturnLotExchange");
  const clob = await SaturnLotExchange.deploy(wetcAddress);
  const receipt = await clob.deploymentTransaction().wait();
  console.log("SaturnLotExchange:", clob.target, "tx:", receipt.hash);

  await (await clob.approveMarket(strn10kAddress)).wait();

  const addresses = {
    MAINNET_EXCHANGE_DEPLOYMENT_BLOCK: receipt.blockNumber,
    MAINNET_SATURN_LOT_EXCHANGE_ADDRESS: clob.target,
  };
  writeAddresses(addresses);
  console.log("Saved MAINNET_SATURN_LOT_EXCHANGE_ADDRESS to .env");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
