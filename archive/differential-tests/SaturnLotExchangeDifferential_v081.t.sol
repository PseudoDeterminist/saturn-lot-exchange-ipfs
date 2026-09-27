// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SaturnLotExchange as SaturnLotExchangeV071} from "../src/SaturnLotExchange_v0.7.1_original.sol";
import {SaturnLotExchange as SaturnLotExchangeV081} from "../src/SaturnLotExchange_v0.8.1_batch.sol";

contract MockToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract SaturnLotExchangeDifferentialV081Test is Test {
    SaturnLotExchangeV071 internal oldEx;
    SaturnLotExchangeV081 internal newEx;

    MockToken internal oldWetc;
    MockToken internal newWetc;
    MockToken internal oldLot;
    MockToken internal newLot;

    address internal alice = address(0xA11CE);
    address internal bob   = address(0xB0B);
    address internal carol = address(0xCA401);
    address internal dave  = address(0xDA7E);

    uint32 internal constant MARKET = 1;

    function setUp() public {
        oldWetc = new MockToken("Old WETC", "oWETC");
        newWetc = new MockToken("New WETC", "nWETC");
        oldLot = new MockToken("Old LOT", "oLOT");
        newLot = new MockToken("New LOT", "nLOT");

        oldEx = new SaturnLotExchangeV071(address(oldWetc));
        newEx = new SaturnLotExchangeV081(address(newWetc));

        assertEq(oldEx.approveMarket(address(oldLot)), MARKET);
        assertEq(newEx.approveMarket(address(newLot)), MARKET);

        oldEx.setTakerFeeBps(25);
        newEx.setTakerFeeBps(25);

        address[4] memory users = [alice, bob, carol, dave];
        for (uint256 i; i < users.length; ++i) {
            oldWetc.mint(users[i], 1e36);
            newWetc.mint(users[i], 1e36);
            oldLot.mint(users[i], 1e12);
            newLot.mint(users[i], 1e12);

            vm.startPrank(users[i]);
            oldWetc.approve(address(oldEx), type(uint256).max);
            newWetc.approve(address(newEx), type(uint256).max);
            oldLot.approve(address(oldEx), type(uint256).max);
            newLot.approve(address(newEx), type(uint256).max);
            vm.stopPrank();
        }
    }

    function testDifferentialCoreBehavior() public {
        _placeBuyBoth(alice, 20, 10);
        _placeBuyBoth(bob, 20, 7);
        _placeBuyBoth(carol, 10, 9);
        uint64 sell1 = _placeSellBoth(alice, 40, 5);
        _placeSellBoth(bob, 50, 8);
        _placeSellBoth(carol, 60, 6);
        _assertBooksEqual();
        _assertTopAndEscrowEqual();
        _assertOracleEqual();

        uint256 grossBuy = 5 * oldEx.priceAtTick(40) + 2 * oldEx.priceAtTick(50);
        uint256 feeBuy = grossBuy * 25 / 10_000;
        vm.prank(dave);
        oldEx.buyFOK(MARKET, 50, 7, grossBuy + feeBuy);
        vm.prank(dave);
        newEx.buyFOK(MARKET, 50, 7, grossBuy + feeBuy);

        _assertBooksEqual();
        _assertTopAndEscrowEqual();
        _assertOracleEqual();
        assertTrue(_lastTakerWasBuyOld());
        assertTrue(_lastTakerWasBuyNew());

        // sell1 was fully consumed by the FOK; the next live ask remains comparable.
        (address oldOwner,,,,,,,) = oldEx.orders(sell1);
        (address newOwner,,,,,,) = newEx.orders(sell1);
        assertEq(oldOwner, address(0));
        assertEq(newOwner, address(0));

        uint256 grossSell = 8 * oldEx.priceAtTick(20);
        uint256 feeSell = grossSell * 25 / 10_000;
        vm.prank(dave);
        oldEx.sellFOK(MARKET, 20, 8, grossSell - feeSell);
        vm.prank(dave);
        newEx.sellFOK(MARKET, 20, 8, grossSell - feeSell);

        _assertBooksEqual();
        _assertTopAndEscrowEqual();
        _assertOracleEqual();
        assertFalse(_lastTakerWasBuyOld());
        assertFalse(_lastTakerWasBuyNew());

        uint64 cancelId = _placeBuyBoth(alice, 15, 3);
        vm.prank(alice);
        oldEx.cancel(cancelId);
        vm.prank(alice);
        newEx.cancel(cancelId);
        _assertBooksEqual();
        _assertTopAndEscrowEqual();

        oldEx.unapproveMarket(MARKET);
        newEx.unapproveMarket(MARKET);
        assertEq(oldEx.approveMarket(address(oldLot)), MARKET);
        assertEq(newEx.approveMarket(address(newLot)), MARKET);
        _assertBooksEqual();
    }

    function testPrunedRemovesArbitrary100kLotCap() public {
        uint256 lots = 100_001;
        uint256 p = newEx.priceAtTick(0);
        newWetc.mint(alice, lots * p);

        vm.prank(alice);
        vm.expectRevert("invalid lots");
        oldEx.placeBuy(MARKET, 0, lots);

        vm.prank(alice);
        uint64 id = newEx.placeBuy(MARKET, 0, lots);
        assertEq(id, 1);
    }

    function testCorrectedMantissaTable() public view {
        // v0.7.1 is missing one byte before mantissa index 259.
        int256 tick259 = -464 + 259;
        assertEq(newEx.priceAtTick(tick259), uint256(3616) * 1e14);
        assertTrue(oldEx.priceAtTick(tick259) != newEx.priceAtTick(tick259));

        // v0.7.1 is also missing the complete mantissa 0x1a86 at index 386.
        int256 tick386 = -464 + 386;
        assertEq(newEx.priceAtTick(tick386), uint256(6790) * 1e14);
        assertTrue(oldEx.priceAtTick(tick386) != newEx.priceAtTick(tick386));

        // Every r value must be readable in each decade in the corrected table.
        for (uint256 d; d < 5; ++d) {
            for (uint256 r; r < 464; ++r) {
                int256 tick = int256(d * 464 + r) - 464;
                uint256 px = newEx.priceAtTick(tick);
                assertGt(px, 0);
            }
        }
        assertEq(newEx.priceAtTick(1855), uint256(9950) * 1e18);
    }

    function _placeBuyBoth(address who, int256 tick, uint256 lots) internal returns (uint64 id) {
        vm.prank(who);
        uint64 oldId = oldEx.placeBuy(MARKET, tick, lots);
        vm.prank(who);
        uint64 newId = newEx.placeBuy(MARKET, tick, lots);
        assertEq(oldId, newId);
        return oldId;
    }

    function _placeSellBoth(address who, int256 tick, uint256 lots) internal returns (uint64 id) {
        vm.prank(who);
        uint64 oldId = oldEx.placeSell(MARKET, tick, lots);
        vm.prank(who);
        uint64 newId = newEx.placeSell(MARKET, tick, lots);
        assertEq(oldId, newId);
        return oldId;
    }

    function _assertBooksEqual() internal view {
        _assertBookSideEqual(true);
        _assertBookSideEqual(false);
        _assertOrderSideEqual(true);
        _assertOrderSideEqual(false);
    }

    function _assertBookSideEqual(bool isBuy) internal view {
        SaturnLotExchangeV071.BookLevel[] memory a;
        SaturnLotExchangeV081.BookLevel[] memory b;
        uint256 na;
        uint256 nb;
        if (isBuy) {
            (a, na) = oldEx.getBuyBook(MARKET, 64);
            (b, nb) = newEx.getBuyBook(MARKET, 64);
        } else {
            (a, na) = oldEx.getSellBook(MARKET, 64);
            (b, nb) = newEx.getSellBook(MARKET, 64);
        }
        assertEq(na, nb);
        for (uint256 i; i < na; ++i) {
            assertEq(a[i].tick, b[i].tick);
            assertEq(a[i].price, b[i].price);
            assertEq(a[i].totalLots, b[i].totalLots);
            assertEq(a[i].totalValue, b[i].totalValue);
            assertEq(a[i].orderCount, b[i].orderCount);
        }
    }

    function _assertOrderSideEqual(bool isBuy) internal view {
        SaturnLotExchangeV071.BookOrder[] memory a;
        SaturnLotExchangeV081.BookOrder[] memory b;
        uint256 na;
        uint256 nb;
        if (isBuy) {
            (a, na) = oldEx.getBuyOrders(MARKET, 128);
            (b, nb) = newEx.getBuyOrders(MARKET, 128);
        } else {
            (a, na) = oldEx.getSellOrders(MARKET, 128);
            (b, nb) = newEx.getSellOrders(MARKET, 128);
        }
        assertEq(na, nb);
        for (uint256 i; i < na; ++i) {
            assertEq(a[i].id, b[i].id);
            assertEq(a[i].owner, b[i].owner);
            assertEq(a[i].tick, b[i].tick);
            assertEq(a[i].price, b[i].price);
            assertEq(a[i].lotsRemaining, b[i].lotsRemaining);
            assertEq(a[i].valueRemaining, b[i].valueRemaining);
        }
    }

    function _assertTopAndEscrowEqual() internal view {
        (
            int256 abb, uint256 abl, uint256 abo,
            int256 abs, uint256 asl, uint256 aso
        ) = oldEx.getTopOfBook(MARKET);
        (
            int256 bbb, uint256 bbl, uint256 bbo,
            int256 bbs, uint256 bsl, uint256 bso
        ) = newEx.getTopOfBook(MARKET);
        assertEq(abb, bbb); assertEq(abl, bbl); assertEq(abo, bbo);
        assertEq(abs, bbs); assertEq(asl, bsl); assertEq(aso, bso);

        (uint256 aw, uint256 al) = oldEx.getEscrowTotals(MARKET);
        (uint256 bw, uint256 bl) = newEx.getEscrowTotals(MARKET);
        assertEq(aw, bw);
        assertEq(al, bl);
    }

    function _assertOracleEqual() internal view {
        (int256 abb, int256 abs, int256 alt, uint256 alb, uint256 alp) = oldEx.getOracle(MARKET);
        (int256 bbb, int256 bbs, int256 blt, uint256 blb, uint256 blp) = newEx.getOracle(MARKET);
        assertEq(abb, bbb); assertEq(abs, bbs); assertEq(alt, blt);
        assertEq(alb, blb); assertEq(alp, blp);
    }

    function _lastTakerWasBuyOld() internal view returns (bool side) {
        (,,,,,,,,, side,,,,) = oldEx.getMarket(MARKET);
    }

    function _lastTakerWasBuyNew() internal view returns (bool side) {
        (,,,,,,, side,,) = newEx.getMarket(MARKET);
    }
}
