const params = new URLSearchParams(window.location.search);

// During development, Hardhat is the default.
// Production can later default to "etc" and omit Hardhat from the UI selector.
const net = params.get("net") || "hardhat";

const NETWORKS = {
  hardhat: {
    name: "Hardhat",
    chainId: 31337,

    // Useful for development / optional direct-RPC reads.
    rpcUrl: "http://127.0.0.1:8545",

    quoteSymbol: "WETC",
    quoteTokenAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3",

    exchangeAddress: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",

    // null: locate the deployment block through the injected provider.
    exchangeDeploymentBlock: null,

    // Initial market shown when the UI loads.
    defaultMarketId: 1,

    maxLevels: 5,
    maxOrders: 50,
  },

  etc: {
    name: "Ethereum Classic",
    chainId: 61,

    // Normal production access will come through the user's wallet provider.
    rpcUrl: null,

    quoteSymbol: "WETC",
    quoteTokenAddress: "0x82A618305706B14e7bcf2592D4B9324A366b6dAd",

    // Fill this after SaturnLotExchange is deployed on ETC.
    exchangeAddress: "",
    // Set to the deployment receipt block when deploying this network.
    exchangeDeploymentBlock: null,

    defaultMarketId: 1,

    maxLevels: 5,
    maxOrders: 50,
  },

  eth: {
    name: "Ethereum",
    chainId: 1,

    // Normal production access will come through the user's wallet provider.
    rpcUrl: null,

    quoteSymbol: "WETH",
    quoteTokenAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",

    // Fill this after SaturnLotExchange is deployed on Ethereum.
    exchangeAddress: "",
    // Set to the deployment receipt block when deploying this network.
    exchangeDeploymentBlock: null,

    defaultMarketId: 1,

    maxLevels: 5,
    maxOrders: 50,
  },
};

if (!NETWORKS[net]) {
  throw new Error(`Unknown network: ${net}`);
}

window.APP_CONFIG = {
  ...NETWORKS[net],
  net,
};