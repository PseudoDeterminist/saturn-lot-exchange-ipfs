const assert = require('node:assert/strict');

// Explicit manual local-chain transaction test. Importable for isolated tests.
async function runFok(hre, side, options = {}) {
  const { ethers } = hre;
  const chain = await ethers.provider.getNetwork();
  if (![31337n, 1337n].includes(chain.chainId)) throw Error('FOK smoke scripts are restricted to local test chains');
  const address = options.exchangeAddress || process.env.SATURN_LOT_EXCHANGE_ADDRESS;
  if (!address) throw Error('Set SATURN_LOT_EXCHANGE_ADDRESS from the current local deployment');
  const marketId = Number(options.marketId ?? process.env.MARKET_ID ?? 1);
  const tick = BigInt(options.tick ?? process.env.LIMIT_TICK ?? (side === 'buy' ? 121 : 120));
  const lots = BigInt(options.lots ?? process.env.LOTS ?? 1);
  if (!Number.isSafeInteger(marketId) || marketId <= 0 || lots <= 0n) throw Error('Invalid market or lots');
  const [defaultSigner] = await ethers.getSigners();
  const signer = options.signer || defaultSigner;
  const user = await signer.getAddress();
  const ex = await ethers.getContractAt('SaturnLotExchange', address, signer);
  const market = await ex.getMarket(marketId);
  if (!market.active) throw Error('Market is inactive');
  const abi = ['function approve(address,uint256) returns(bool)','function balanceOf(address) view returns(uint256)'];
  const quote = new ethers.Contract(await ex.WETC(), abi, signer);
  const lot = new ethers.Contract(market.lotToken, abi, signer);
  const bps = await ex.takerFeeBps(), treasury = await ex.owner();
  const boundGross = (await ex.priceAtTick(tick)) * lots;
  const boundFee = boundGross * bps / 10000n;
  const buy = side === 'buy';
  const bound = buy ? boundGross + boundFee : boundGross - boundFee;
  await (await (buy ? quote : lot).approve(address, buy ? bound : lots)).wait();
  const beforeQuote = await quote.balanceOf(user), beforeLots = await lot.balanceOf(user);
  const signature = `${buy ? 'buyFOK' : 'sellFOK'}(uint32,int256,uint256,uint256)`;
  const receipt = await (await ex[signature](marketId,tick,lots,bound)).wait();
  const events = receipt.logs.filter(l => l.address.toLowerCase() === address.toLowerCase()).map(l => ex.interface.parseLog(l));
  const fills = events.filter(e => e.name === 'Trade');
  assert(fills.length > 0);
  assert.equal(fills.reduce((sum,e) => sum + e.args.lotsFilled,0n), lots);
  const gross = await fills.reduce(async (sumP,e) => {
    const sum = await sumP;
    return sum + e.args.lotsFilled * await ex.priceAtTick(e.args.tick);
  }, Promise.resolve(0n));
  const fee = gross * bps / 10000n;
  const settlement = events.find(e => e.name === 'FOKSettled');
  assert.equal(settlement.args.grossWETC,gross);assert.equal(settlement.args.feeWETC,fee);
  const ownFills = fills.filter(e => e.args.maker.toLowerCase() === user.toLowerCase());
  const ownQuote = await ownFills.reduce(async (sumP,e) => {
    const sum = await sumP;
    return sum + e.args.lotsFilled * await ex.priceAtTick(e.args.tick);
  }, Promise.resolve(0n));
  const ownLots = ownFills.reduce((sum,e) => sum + e.args.lotsFilled,0n);
  const treasuryCredit = treasury.toLowerCase() === user.toLowerCase() ? fee : 0n;
  assert.equal(await quote.balanceOf(user), beforeQuote + (buy ? -gross-fee+ownQuote : gross-fee) + treasuryCredit);
  assert.equal(await lot.balanceOf(user), beforeLots + (buy ? lots : -lots+ownLots));
  for (const e of fills) { assert.equal(e.args.marketId,BigInt(marketId));assert.equal(e.args.takerIsBuy,buy); }
  const after = await ex.getMarket(marketId), last = fills.at(-1).args;
  assert.equal(after.lastTradeTick,last.tick);
  assert.equal(await ex.priceAtTick(after.lastTradeTick),await ex.priceAtTick(last.tick));
  assert.equal(after.lastTradeTakerIsBuy,buy);assert.equal(after.lastTradeBlock,BigInt(receipt.blockNumber));
  return { hash:receipt.hash, fills:fills.length, lots:lots.toString(), gross:gross.toString(), fee:fee.toString() };
}
module.exports = { runFok };
