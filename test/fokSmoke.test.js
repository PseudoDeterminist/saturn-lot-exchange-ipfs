import { expect } from 'chai';
import hardhat from 'hardhat';
import smoke from '../scripts/lib/fok-smoke.cjs';
const {ethers}=hardhat;
describe('Local manual FOK helper',function(){
  for(const self of [false,true])it(`verifies buy and sell balances with fees, self-trade=${self}`,async()=>{
    const [owner,taker]=await ethers.getSigners();const Token=await ethers.getContractFactory('TestERC20');
    const q=await Token.deploy('Q','Q',18,ethers.parseEther('1000'));const l=await Token.deploy('L','L',0,1000);
    const F=await ethers.getContractFactory('SaturnLotExchange');const ex=await F.deploy(q.target);
    await ex.approveMarket(l.target);await ex.setTakerFeeBps(37);
    await q.approve(ex.target,ethers.MaxUint256);await l.approve(ex.target,ethers.MaxUint256);
    await ex.placeBuy(1,120,2);await ex.placeSell(1,121,2);
    await q.transfer(taker.address,ethers.parseEther('100'));await l.transfer(taker.address,10);
    for(const side of ['buy','sell']){
      const result=await smoke.runFok(hardhat,side,{exchangeAddress:ex.target,signer:self?owner:taker});
      expect(result.fills).to.equal(1);expect(result.lots).to.equal('1');
    }
  });
});
