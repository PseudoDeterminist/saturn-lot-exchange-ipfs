import { expect } from 'chai';
import hardhat from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
const {ethers}=hardhat;
async function fixture(){
  const [owner,maker,taker,treasury]=await ethers.getSigners();
  const Token=await ethers.getContractFactory('TestERC20');
  const quote=await Token.deploy('Quote','Q',18,ethers.parseEther('100000'));
  const lot=await Token.deploy('Lot','L',0,100000), other=await Token.deploy('Other','O',0,100000);
  const Factory=await ethers.getContractFactory('SaturnLotExchange');const ex=await Factory.deploy(quote.target);
  await ex.approveMarket(lot.target);await ex.approveMarket(other.target);await ex.setFeeTreasury(treasury.address);
  for(const token of [quote,lot,other])for(const user of [maker,taker]){
    await token.transfer(user.address,token===quote?ethers.parseEther('1000'):1000n);
    await token.connect(user).approve(ex.target,ethers.MaxUint256);
  }
  return {ex,quote,lot,other,owner,maker,taker,treasury};
}
describe('Exchange governance, fees and market isolation',function(){
  it('enforces ownership, fee cap and nonzero governance addresses',async()=>{
    const {ex,lot,taker}=await loadFixture(fixture);
    for(const [method,args] of [['transferOwnership',[taker.address]],['setTakerFeeBps',[1]],['setFeeTreasury',[taker.address]],['approveMarket',[lot.target]],['unapproveMarket',[1]]])
      await expect(ex.connect(taker)[method](...args)).to.be.revertedWith('not owner');
    await expect(ex.setTakerFeeBps(51)).to.be.revertedWith('fee too high');
    await expect(ex.setFeeTreasury(ethers.ZeroAddress)).to.be.revertedWith('zero treasury');
    await expect(ex.transferOwnership(ethers.ZeroAddress)).to.be.revertedWith('zero owner');
    await ex.transferOwnership(taker.address);await ex.connect(taker).setTakerFeeBps(50);
    expect(await ex.takerFeeBps()).to.equal(50);
  });
  it('retirement blocks trading but permits cancellation and preserves history on reactivation',async()=>{
    const {ex,lot,maker}=await loadFixture(fixture);
    await ex.connect(maker).placeSell(1,121,2);const before=await ex.getMarket(1);
    await ex.unapproveMarket(1);
    for(const [method,args] of [['placeBuy',[1,120,1]],['placeSell',[1,122,1]],['buyFOK(uint32,int256,uint256,uint256)',[1,121,1,0]],['sellFOK(uint32,int256,uint256,uint256)',[1,120,1,0]]])
      await expect(ex.connect(maker)[method](...args)).to.be.revertedWith('market inactive');
    await ex.connect(maker).cancel(1);const canceled=await ex.getMarket(1);
    expect(canceled.historySeq).to.equal(before.historySeq+1n);
    await ex.approveMarket(lot.target);const active=await ex.getMarket(1);
    expect(active.active).to.equal(true);expect(active.historyHash).to.equal(canceled.historyHash);
    expect(await ex.marketCount()).to.equal(2);expect(await ex.marketIdOf(lot.target)).to.equal(1);
    await expect(ex.approveMarket(lot.target)).to.be.revertedWith('market already active');
    await expect(ex.getMarket(99)).to.be.revertedWith('invalid market');
  });
  for(const buy of [true,false])for(const bps of [0n,1n,37n,50n])it(`${buy?'buy':'sell'} FOK settles gross makers and exact aggregate fee at ${bps} bps`,async()=>{
    const {ex,quote,lot,maker,taker,treasury}=await loadFixture(fixture);await ex.setTakerFeeBps(bps);
    const ticks=buy?[121,122]:[120,119];
    for(const tick of ticks)await ex.connect(maker)[buy?'placeSell':'placeBuy'](1,tick,1);
    // Keep unrelated quote escrow present to ensure rollback preserves other markets.
    await ex.connect(maker).placeBuy(2,110,3);const otherBefore=await ex.getMarket(2);
    const gross=(await ex.priceAtTick(ticks[0]))+(await ex.priceAtTick(ticks[1]));const fee=gross*bps/10000n;
    const before={t:await quote.balanceOf(taker.address),m:await quote.balanceOf(maker.address),f:await quote.balanceOf(treasury.address),l:await lot.balanceOf(taker.address),market:await ex.getMarket(1)};
    const method=buy?'buyFOK(uint32,int256,uint256,uint256)':'sellFOK(uint32,int256,uint256,uint256)';
    await expect(ex.connect(taker)[method](1,ticks[1],2,buy?gross+fee-1n:gross-fee+1n)).to.be.revertedWith(!buy && bps === 0n ? 'FOK--Insufficient escrowed WETC on book' : 'FOK--Slippage exceeded');
    expect(await ex.getMarket(1)).to.deep.equal(before.market);expect(await ex.getMarket(2)).to.deep.equal(otherBefore);
    expect(await quote.balanceOf(taker.address)).to.equal(before.t);
    const receipt=await (await ex.connect(taker)[method](1,ticks[1],2,buy?gross+fee+123n:gross-fee)).wait();
    expect(await quote.balanceOf(taker.address)).to.equal(before.t+(buy?-gross-fee:gross-fee));
    expect(await quote.balanceOf(treasury.address)).to.equal(before.f+fee);
    expect(await quote.balanceOf(maker.address)).to.equal(before.m+(buy?gross:0n));
    expect(await lot.balanceOf(taker.address)).to.equal(before.l+(buy?2n:-2n));
    expect(await ex.getMarket(2)).to.deep.equal(otherBefore);
    expect(await quote.balanceOf(ex.target)).to.equal(otherBefore.bookEscrowWETC);
    const events=receipt.logs.filter(l=>l.address.toLowerCase()===ex.target.toLowerCase()).map(l=>ex.interface.parseLog(l));
    expect(events.filter(e=>e.name==='Trade')).to.have.length(2);
    const settled=events.find(e=>e.name==='FOKSettled');expect(settled.args.feeWETC).to.equal(fee);expect(settled.args.grossWETC).to.equal(gross);
    expect(settled.args.takerWETC).to.equal(buy?gross+fee:gross-fee);
  });
});
