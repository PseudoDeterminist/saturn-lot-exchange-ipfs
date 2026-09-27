import { expect } from "chai";
import hardhat from "hardhat";
const { ethers } = hardhat;

describe("Token contracts", function () {
  it("TestERC20 transfers and allowances behave as expected", async () => {
    const [owner, alice] = await ethers.getSigners();
    const TestERC20 = await ethers.getContractFactory("TestERC20");
    const token = await TestERC20.deploy("Test", "TST", 18, 1000n);

    await expect(token.transfer(ethers.ZeroAddress, 1n)).to.be.revertedWith(
      "zero to"
    );
    await expect(
      token.connect(alice).transfer(owner.address, 1n)
    ).to.be.revertedWith("balance");

    await expect(token.approve(ethers.ZeroAddress, 1n)).to.be.revertedWith(
      "zero spender"
    );

    await expect(
      token.connect(alice).transferFrom(owner.address, alice.address, 1n)
    ).to.be.revertedWith("allowance");

    await expect(token.approve(alice.address, 200n))
      .to.emit(token, "Approval")
      .withArgs(owner.address, alice.address, 200n);

    await expect(token.transfer(alice.address, 300n))
      .to.emit(token, "Transfer")
      .withArgs(owner.address, alice.address, 300n);
    expect(await token.balanceOf(alice.address)).to.equal(300n);

    await token.connect(alice).transferFrom(owner.address, alice.address, 100n);
    expect(await token.allowance(owner.address, alice.address)).to.equal(100n);

    await token.approve(alice.address, 500n);
    await token.transfer(alice.address, 590n);
    await expect(
      token.connect(alice).transferFrom(owner.address, alice.address, 200n)
    ).to.be.revertedWith("balance");
  });

  it("TestERC20 mint guard reverts for zero address", async () => {
    const [owner] = await ethers.getSigners();
    const TestERC20Harness = await ethers.getContractFactory("TestERC20Harness");
    const token = await TestERC20Harness.deploy("Test", "TST", 18, 1n);

    await expect(token.mintTo(ethers.ZeroAddress, 1n)).to.be.revertedWith(
      "zero to"
    );
    await token.mintTo(owner.address, 1n);
    expect(await token.totalSupply()).to.equal(2n);
  });

  it("ReentrantERC20 supports transfer hooks and bubbles failures", async () => {
    const [owner, alice] = await ethers.getSigners();
    const ReentrantERC20 = await ethers.getContractFactory("ReentrantERC20");
    const ReentryTarget = await ethers.getContractFactory("ReentryTarget");
    const token = await ReentrantERC20.deploy("Re", "RE", 18, 1000n);
    const target = await ReentryTarget.deploy();

    await expect(token.approve(ethers.ZeroAddress, 1n)).to.be.revertedWith(
      "zero spender"
    );

    await expect(
      token.connect(alice).transfer(owner.address, 1n)
    ).to.be.revertedWith("balance");
    await expect(
      token.connect(alice).transferFrom(owner.address, alice.address, 1n)
    ).to.be.revertedWith("allowance");
    await expect(token.transfer(ethers.ZeroAddress, 1n)).to.be.revertedWith(
      "zero to"
    );

    await token.transfer(alice.address, 1n);
    expect(await target.calls()).to.equal(0n);

    await token.setReentry(await target.getAddress(), "0x", false, false);
    await token.transfer(alice.address, 1n);
    expect(await target.calls()).to.equal(0n);

    const pingData = target.interface.encodeFunctionData("ping");
    await token.setReentry(await target.getAddress(), pingData, true, false);
    await token.transfer(alice.address, 1n);
    expect(await target.calls()).to.equal(1n);

    await token.approve(alice.address, 10n);
    await token.setReentry(await target.getAddress(), pingData, false, false);
    await token.connect(alice).transferFrom(owner.address, alice.address, 1n);
    expect(await target.calls()).to.equal(1n);

    await token.setReentry(await target.getAddress(), pingData, false, true);
    await token.connect(alice).transferFrom(owner.address, alice.address, 1n);
    expect(await target.calls()).to.equal(2n);

    const boomData = target.interface.encodeFunctionData("boom");
    await token.setReentry(await target.getAddress(), boomData, true, false);
    await expect(token.transfer(alice.address, 1n)).to.be.revertedWith("boom");

    const silentData = target.interface.encodeFunctionData("silentBoom");
    await token.setReentry(await target.getAddress(), silentData, true, false);
    await expect(token.transfer(alice.address, 1n)).to.be.revertedWith(
      "reentry failed"
    );
  });

  it("ReentrantERC20 guards transfers and mint inputs", async () => {
    const [owner, alice] = await ethers.getSigners();
    const ReentrantERC20Harness = await ethers.getContractFactory(
      "ReentrantERC20Harness"
    );
    const token = await ReentrantERC20Harness.deploy("Re", "RE", 18, 1000n);

    await expect(token.transfer(ethers.ZeroAddress, 1n)).to.be.revertedWith(
      "zero to"
    );
    await expect(
      token.connect(alice).transfer(owner.address, 1n)
    ).to.be.revertedWith("balance");
    await expect(
      token.connect(alice).transferFrom(owner.address, alice.address, 1n)
    ).to.be.revertedWith("allowance");

    await expect(token.mintTo(ethers.ZeroAddress, 1n)).to.be.revertedWith(
      "zero to"
    );
    await token.mintTo(owner.address, 1n);
    expect(await token.totalSupply()).to.equal(1001n);
  });
});
