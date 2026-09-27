import { expect } from "chai";
import hardhat from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
const { ethers, network } = hardhat;

async function fixture() {
  const [owner,maker,taker,treasury]=await ethers.getSigners();
  const Token=await ethers.getContractFactory('CallbackERC20');
  const quote=await Token.deploy(), lot=await Token.deploy(), other=await Token.deploy();
  const F=await ethers.getContractFactory('SaturnLotExchange');const ex=await F.deploy(quote.target);
  await ex.approveMarket(lot.target);await ex.approveMarket(other.target);
  await ex.setTakerFeeBps(37);await ex.setFeeTreasury(treasury.address);
  for(const t of [quote,lot,other]) for(const a of [owner,maker,taker]) {
    if(a!==owner) await t.transfer(a.address,ethers.parseEther('1000'));
    await t.connect(a).approve(ex.target,ethers.MaxUint256);
  }
  await ex.connect(maker).placeBuy(1,120,5);await ex.connect(maker).placeSell(1,121,5);
  await ex.connect(maker).placeBuy(2,120,6);await ex.connect(maker).placeSell(2,121,7);
  return {ex,quote,lot,other,owner,maker,taker,treasury};
}
async function state(f) {
  const {ex,quote,lot,other,owner,maker,taker,treasury}=f;
  const accounts=[owner.address,maker.address,taker.address,treasury.address,ex.target,quote.target,lot.target];
  const next=await ex.nextOrderId(); const orders=[];
  for(let i=1n;i<=next;i++) orders.push(await ex.orders(i));
  const tokens=[];
  for(const t of [quote,lot,other]) tokens.push(await Promise.all(accounts.flatMap(a=>[t.balanceOf(a),t.allowance(a,ex.target)])));
  return {markets:await Promise.all([ex.getMarket(1),ex.getMarket(2)]),books:await Promise.all([ex.getBuyBook(1,20),ex.getSellBook(1,20),ex.getBuyBook(2,20),ex.getSellBook(2,20)]),orders,next,tokens,owner:await ex.owner(),fee:await ex.takerFeeBps(),treasury:await ex.feeTreasury()};
}
async function reconcile(f) {
  const {ex,quote,lot,other}=f;let escrow=0n;
  for(const [id,token] of [[1,lot],[2,other]]) {
    const m=await ex.getMarket(id);escrow+=m.bookEscrowWETC;
    expect(await token.balanceOf(ex.target)).to.equal(m.bookEscrowLots);
    for(const buy of [true,false]) {
      const [rows,n]=await (buy?ex.getBuyBook(id,20):ex.getSellBook(id,20));
      const levels=Array.from(rows).slice(0,Number(n));
      expect(levels.reduce((a,l)=>a+l.totalLots,0n)).to.equal(buy?m.bookAskLots:m.bookEscrowLots);
      expect(levels.reduce((a,l)=>a+l.totalValue,0n)).to.equal(buy?m.bookEscrowWETC:m.bookAskWETC);
      expect(buy?m.bestBuyTick:m.bestSellTick).to.equal(levels[0]?.tick ?? -(1n<<31n));
    }
  }
  expect(await quote.balanceOf(ex.target)).to.equal(escrow);
}
async function history(f,receipt,before) {
  let seq=before.historySeq, hash=before.historyHash;
  const kinds={OrderPlaced:1,OrderCanceled:2,Trade:3,FOKSettled:4};
  for(const log of receipt.logs) {
    if(log.address.toLowerCase()!==f.ex.target.toLowerCase())continue;
    const e=f.ex.interface.parseLog(log);if(!kinds[e.name])continue;
    expect(e.args.seq).to.equal(++seq);
    const fields=e.fragment.inputs.map((input,i)=>({input,value:e.args[i]})).filter(x=>x.input.name!=='newHash');
    const rec=ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['uint8',...fields.map(x=>x.input.type)],[kinds[e.name],...fields.map(x=>x.value)]));
    hash=ethers.keccak256(ethers.concat([hash,rec]));expect(e.args.newHash).to.equal(hash);
  }
  const m=await f.ex.getMarket(1);expect(m.historySeq).to.equal(seq);expect(m.historyHash).to.equal(hash);
}
async function boundary(f,name) {
  const {ex,quote,lot,maker,taker,treasury}=f;
  const price=await ex.priceAtTick(121),gross=price*2n,fee=gross*37n/10000n;
  const buy=()=>ex.connect(taker)['buyFOK(uint32,int256,uint256,uint256)'](1,121,2,gross+fee+100n);
  const sell=()=>ex.connect(taker)['sellFOK(uint32,int256,uint256,uint256)'](1,120,2,0);
  const table={
    placeBuy:[quote,taker.address,ex.target,true,()=>ex.connect(taker).placeBuy(1,119,1)],
    placeSell:[lot,taker.address,ex.target,true,()=>ex.connect(taker).placeSell(1,122,1)],
    buyInput:[quote,taker.address,ex.target,true,buy],sellInput:[lot,taker.address,ex.target,true,sell],
    buyMaker:[quote,ex.target,maker.address,false,buy],sellMaker:[lot,ex.target,maker.address,false,sell],
    buyOutput:[lot,ex.target,taker.address,false,buy],sellOutput:[quote,ex.target,taker.address,false,sell],
    buyRefund:[quote,ex.target,taker.address,false,buy],buyFee:[quote,ex.target,treasury.address,false,buy],sellFee:[quote,ex.target,treasury.address,false,sell],
    cancelBuy:[quote,ex.target,maker.address,false,()=>ex.connect(maker).cancel(1)],cancelSell:[lot,ex.target,maker.address,false,()=>ex.connect(maker).cancel(2)],
  };
  return table[name];
}

describe('Exchange-wide reentrancy guard',function(){
  it('authenticates each fill plus settlement for a multi-level FOK', async () => {
    const f = await loadFixture(fixture);
    await f.ex.connect(f.maker).placeSell(1, 122, 2);
    const before = await f.ex.getMarket(1);
    const gross = (await f.ex.priceAtTick(121)) * 5n + (await f.ex.priceAtTick(122));
    const fee = gross * 37n / 10000n;
    const receipt = await (await f.ex.connect(f.taker)["buyFOK(uint32,int256,uint256,uint256,bytes32)"](
      1, 122, 6, gross + fee, before.historyHash
    )).wait();
    await history(f, receipt, before);
    expect((await f.ex.getMarket(1)).historySeq).to.equal(before.historySeq + 3n);
    await reconcile(f);
  });

  for(const name of ['placeBuy','placeSell','buyInput','sellInput','buyMaker','sellMaker','buyOutput','sellOutput','buyRefund','buyFee','sellFee','cancelBuy','cancelSell']) {
    for(const caught of [false,true]) it(`${name}: ${caught?'caught callback preserves normal result':'propagated callback rolls everything back'}`,async()=>{
      const f=await loadFixture(fixture);const [token,from,to,input,run]=await boundary(f,name);
      const before=await state(f);const checkpoint=await network.provider.send('evm_snapshot');
      const normal=await (await run()).wait();await history(f,normal,before.markets[0]);await reconcile(f);
      const expected=await state(f);await network.provider.send('evm_revert',[checkpoint]);
      const data=f.ex.interface.encodeFunctionData('placeBuy(uint32,int256,uint256)',[2,119,1]);
      await token.arm(f.ex.target,data,from,to,input,caught);
      if(!caught) {
        await expect(run()).to.be.revertedWithCustomError(f.ex,'ReentrancyGuardReentrantCall');
        expect(await state(f)).to.deep.equal(before);
        // Disarm and prove the reverted operation did not leave the lock engaged.
        await token.arm(f.ex.target,data,ethers.ZeroAddress,to,input,true);
        await run();await reconcile(f);
      } else {
        const receipt=await (await run()).wait();
        expect(await token.armed()).to.equal(false);expect(await token.callbackSucceeded()).to.equal(false);
        expect(await token.callbackResult()).to.equal(f.ex.interface.getError('ReentrancyGuardReentrantCall').selector);
        const actual=await state(f);
        // Extra arming transaction changes the block number, but no other market field.
        for(let i=0;i<2;i++) {actual.markets[i]=Array.from(actual.markets[i]);expected.markets[i]=Array.from(expected.markets[i]);actual.markets[i][7]=expected.markets[i][7];}
        expect(actual).to.deep.equal(expected);await history(f,receipt,before.markets[0]);await reconcile(f);
        await f.ex.connect(f.taker).placeBuy(1,118,1);
      }
    });
  }
  for(const market of [1,2]) for(const [signature,args] of [
    ['placeBuy(uint32,int256,uint256)',[119,1]],['placeBuy(uint32,int256,uint256,bytes32)',[119,1,ethers.ZeroHash]],
    ['placeSell(uint32,int256,uint256)',[122,1]],['placeSell(uint32,int256,uint256,bytes32)',[122,1,ethers.ZeroHash]],
    ['buyFOK(uint32,int256,uint256,uint256)',[121,1,0]],['buyFOK(uint32,int256,uint256,uint256,bytes32)',[121,1,0,ethers.ZeroHash]],
    ['sellFOK(uint32,int256,uint256,uint256)',[120,1,0]],['sellFOK(uint32,int256,uint256,uint256,bytes32)',[120,1,0,ethers.ZeroHash]],
  ]) it(`rejects ${signature} callback into market ${market}`,async()=>{
    const f=await loadFixture(fixture);const [token,from,to,input,run]=await boundary(f,'placeSell');
    await token.arm(f.ex.target,f.ex.interface.encodeFunctionData(signature,[market,...args]),from,to,input,true);
    await run();expect(await token.callbackResult()).to.equal(f.ex.interface.getError('ReentrancyGuardReentrantCall').selector);
    await reconcile(f);
  });
  for(const name of ['cancel','transferOwnership','approveMarket','unapproveMarket','setTakerFeeBps','setFeeTreasury']) it(`rejects authorized ${name} during callback`,async()=>{
    const f=await loadFixture(fixture);const {ex,lot,taker}=f;
    await ex.transferOwnership(lot.target);
    await f.quote.transfer(lot.target,ethers.parseEther('10'));
    await lot.execute(f.quote.target,f.quote.interface.encodeFunctionData('approve',[ex.target,ethers.MaxUint256]));
    const id=await ex.nextOrderId();await lot.execute(ex.target,ex.interface.encodeFunctionData('placeBuy(uint32,int256,uint256)',[1,118,1]));
    const args={cancel:[id],transferOwnership:[taker.address],approveMarket:[f.quote.target],unapproveMarket:[1],setTakerFeeBps:[1],setFeeTreasury:[taker.address]};
    // A valid new lot-token address ensures approval would otherwise succeed.
    if(name==='approveMarket')args[name]=[(await (await ethers.getContractFactory('CallbackERC20')).deploy()).target];
    await lot.arm(ex.target,ex.interface.encodeFunctionData(name,args[name]),taker.address,ex.target,true,true);
    const before=await ex.getMarket(1);const receipt=await (await ex.connect(taker).placeSell(1,122,1)).wait();
    expect(await lot.callbackResult()).to.equal(ex.interface.getError('ReentrancyGuardReentrantCall').selector);
    expect(await ex.owner()).to.equal(lot.target);expect(await ex.takerFeeBps()).to.equal(37);
    expect(await ex.feeTreasury()).to.equal(f.treasury.address);expect(await ex.marketCount()).to.equal(2);
    expect((await ex.orders(id)).owner).to.equal(lot.target);await history(f,receipt,before);await reconcile(f);
  });
});
