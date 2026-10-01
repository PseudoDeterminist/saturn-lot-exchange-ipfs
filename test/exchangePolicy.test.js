import { expect } from 'chai';
import hardhat from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
const {ethers}=hardhat;
async function fixture(){
  const [owner,maker,taker,treasury]=await ethers.getSigners();
  const Token=await ethers.getContractFactory('TestERC20');
  const quote=await Token.deploy('Quote','Q',18,ethers.parseEther('100000'));
  const lot=await Token.deploy('Lot','L',0,100000), other=await Token.deploy('Other','O',0,100000);
  const Factory=await ethers.getContractFactory('SaturnLotExchange');const ex=await Factory.deploy(quote.target,owner.address);
  await ex.approveMarket(lot.target);await ex.approveMarket(other.target);await ex.activate();
  for(const token of [quote,lot,other])for(const user of [maker,taker]){
    await token.transfer(user.address,token===quote?ethers.parseEther('1000'):1000n);
    await token.connect(user).approve(ex.target,ethers.MaxUint256);
  }
  return {ex,quote,lot,other,owner,maker,taker,treasury};
}
describe('Exchange governance, fees and market isolation',function(){
  it('deploys inactive and only the designated owner can activate once',async()=>{
    const {quote,lot,owner,maker}=await loadFixture(fixture);
    const Factory=await ethers.getContractFactory('SaturnLotExchange');
    const ex=await Factory.deploy(quote.target,owner.address);

    expect(await ex.owner()).to.equal(owner.address);
    expect(await ex.exchangeActive()).to.equal(false);

    await ex.approveMarket(lot.target);

    await expect(ex.connect(maker).activate()).to.be.revertedWith('not owner');
    await expect(ex.connect(maker).placeBuy(1,120,1)).to.be.revertedWith('exchange inactive');

    await expect(ex.activate()).to.emit(ex,'ExchangeActivated');
    expect(await ex.exchangeActive()).to.equal(true);

    await expect(ex.activate()).to.be.revertedWith('already active');
  });

  it('enforces ownership, fee cap and nonzero governance addresses',async()=>{
    const {ex,lot,taker}=await loadFixture(fixture);
    for(const [method,args] of [['transferOwnership',[taker.address]],['setTakerFeeBps',[1]],['activate',[]],['approveMarket',[lot.target]],['unapproveMarket',[1]]])
      await expect(ex.connect(taker)[method](...args)).to.be.revertedWith('not owner');
    await expect(ex.setTakerFeeBps(51)).to.be.revertedWith('fee too high');
    await expect(ex.activate()).to.be.revertedWith('already active');
    await expect(ex.transferOwnership(ethers.ZeroAddress)).to.be.revertedWith('zero owner');
    await ex.transferOwnership(taker.address);await ex.connect(taker).setTakerFeeBps(50);
    expect(await ex.takerFeeBps()).to.equal(50);
  });
  it('atomically approves and unapproves batches of markets',async()=>{
    const {quote,lot,other,owner}=await loadFixture(fixture);
    const Factory=await ethers.getContractFactory('SaturnLotExchange');
    const ex=await Factory.deploy(quote.target,owner.address);

    await expect(ex.approveMarkets([])).to.be.revertedWith('empty markets');
    await expect(ex.unapproveMarkets([])).to.be.revertedWith('empty markets');

    await ex.approveMarkets([lot.target,other.target]);

    expect(await ex.marketCount()).to.equal(2);
    expect(await ex.marketIdOf(lot.target)).to.equal(1);
    expect(await ex.marketIdOf(other.target)).to.equal(2);
    expect((await ex.getMarket(1)).active).to.equal(true);
    expect((await ex.getMarket(2)).active).to.equal(true);

    await ex.unapproveMarkets([1,2]);

    expect((await ex.getMarket(1)).active).to.equal(false);
    expect((await ex.getMarket(2)).active).to.equal(false);
  });

  it('rolls back an entire market batch if any member fails',async()=>{
    const {quote,lot,other,owner}=await loadFixture(fixture);
    const Factory=await ethers.getContractFactory('SaturnLotExchange');
    const ex=await Factory.deploy(quote.target,owner.address);

    await ex.approveMarket(lot.target);

    await expect(
      ex.approveMarkets([other.target,lot.target])
    ).to.be.revertedWith('market already active');

    expect(await ex.marketCount()).to.equal(1);
    expect(await ex.marketIdOf(other.target)).to.equal(0);

    await ex.approveMarket(other.target);

    await expect(
      ex.unapproveMarkets([1,1])
    ).to.be.revertedWith('market not active');

    expect((await ex.getMarket(1)).active).to.equal(true);
    expect((await ex.getMarket(2)).active).to.equal(true);
  });

  it('caps market batches and restricts them to the owner',async()=>{
    const {ex,lot,taker}=await loadFixture(fixture);

    await expect(
      ex.connect(taker).approveMarkets([lot.target])
    ).to.be.revertedWith('not owner');

    await expect(
      ex.connect(taker).unapproveMarkets([1])
    ).to.be.revertedWith('not owner');

    const tooManyTokens =
      Array(Number(await ex.MAX_MARKETS_PER_BATCH()) + 1).fill(lot.target);

    const tooManyIds =
      Array(Number(await ex.MAX_MARKETS_PER_BATCH()) + 1).fill(1);

    await expect(
      ex.approveMarkets(tooManyTokens)
    ).to.be.revertedWith('too many markets');

    await expect(
      ex.unapproveMarkets(tooManyIds)
    ).to.be.revertedWith('too many markets');
  });

  it('retirement blocks trading but permits cancellation and reactivation',async()=>{
    const {ex,lot,maker}=await loadFixture(fixture);

    await ex.connect(maker).placeSell(1,121,2);
    const before=await ex.getMarket(1);
    expect(before.bookEscrowLots).to.equal(2n);

    await ex.unapproveMarket(1);

    for(const [method,args] of [['placeBuy',[1,120,1]],['placeSell',[1,122,1]],['buyFOK(uint32,int256,uint256,uint256)',[1,121,1,0]],['sellFOK(uint32,int256,uint256,uint256)',[1,120,1,0]]])
      await expect(ex.connect(maker)[method](...args)).to.be.revertedWith('market inactive');

    await ex.connect(maker).cancel(1);
    const canceled=await ex.getMarket(1);

    expect(canceled.active).to.equal(false);
    expect(canceled.bookEscrowLots).to.equal(0n);

    const [, sellCount] = await ex.getSellBook(1,1);
    expect(sellCount).to.equal(0n);

    await ex.approveMarket(lot.target);
    const active=await ex.getMarket(1);

    expect(active.active).to.equal(true);
    expect(await ex.marketCount()).to.equal(2);
    expect(await ex.marketIdOf(lot.target)).to.equal(1);

    await expect(ex.approveMarket(lot.target)).to.be.revertedWith('market already active');
    await expect(ex.getMarket(99)).to.be.revertedWith('invalid market');
  });
  for(const buy of [true,false])for(const bps of [0n,1n,37n,50n])it(`${buy?'buy':'sell'} FOK settles gross makers and exact aggregate fee at ${bps} bps`,async()=>{
    const {ex,quote,lot,owner,maker,taker}=await loadFixture(fixture);await ex.setTakerFeeBps(bps);
    const ticks=buy?[121,122]:[120,119];
    for(const tick of ticks)await ex.connect(maker)[buy?'placeSell':'placeBuy'](1,tick,1);
    // Keep unrelated quote escrow present to ensure rollback preserves other markets.
    await ex.connect(maker).placeBuy(2,110,3);const otherBefore=await ex.getMarket(2);
    const gross=(await ex.priceAtTick(ticks[0]))+(await ex.priceAtTick(ticks[1]));const fee=gross*bps/10000n;
    const before={t:await quote.balanceOf(taker.address),m:await quote.balanceOf(maker.address),f:await quote.balanceOf(owner.address),l:await lot.balanceOf(taker.address),market:await ex.getMarket(1)};
    const method=buy?'buyFOK(uint32,int256,uint256,uint256)':'sellFOK(uint32,int256,uint256,uint256)';
    await expect(ex.connect(taker)[method](1,ticks[1],2,buy?gross+fee-1n:gross-fee+1n)).to.be.revertedWith(!buy && bps === 0n ? 'FOK--Insufficient escrowed WETC on book' : 'FOK--Slippage exceeded');
    expect(await ex.getMarket(1)).to.deep.equal(before.market);expect(await ex.getMarket(2)).to.deep.equal(otherBefore);
    expect(await quote.balanceOf(taker.address)).to.equal(before.t);
    const receipt=await (await ex.connect(taker)[method](1,ticks[1],2,buy?gross+fee+123n:gross-fee)).wait();
    expect(await quote.balanceOf(taker.address)).to.equal(before.t+(buy?-gross-fee:gross-fee));
    expect(await quote.balanceOf(owner.address)).to.equal(before.f+fee);
    expect(await quote.balanceOf(maker.address)).to.equal(before.m+(buy?gross:0n));
    expect(await lot.balanceOf(taker.address)).to.equal(before.l+(buy?2n:-2n));
    expect(await ex.getMarket(2)).to.deep.equal(otherBefore);
    expect(await quote.balanceOf(ex.target)).to.equal(otherBefore.bookEscrowWETC);
    const events=receipt.logs.filter(l=>l.address.toLowerCase()===ex.target.toLowerCase()).map(l=>ex.interface.parseLog(l));
    expect(events.filter(e=>e.name==='Trade')).to.have.length(2);
    const settled=events.find(e=>e.name==='FOKSettled');expect(settled.args.feeWETC).to.equal(fee);expect(settled.args.grossWETC).to.equal(gross);
  });
});
