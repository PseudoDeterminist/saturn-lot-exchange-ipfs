// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SaturnLotExchange} from "../contracts/SaturnLotExchange.sol";

contract BatchMockToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract SaturnLotExchangeBatchTest is Test {
    SaturnLotExchange internal batchEx;
    SaturnLotExchange internal singleEx;

    BatchMockToken internal batchWetc;
    BatchMockToken internal singleWetc;
    BatchMockToken internal batchLot1;
    BatchMockToken internal singleLot1;
    BatchMockToken internal batchLot2;
    BatchMockToken internal singleLot2;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    uint32 internal constant MARKET1 = 1;
    uint32 internal constant MARKET2 = 2;

    function setUp() public {
        batchWetc = new BatchMockToken("Batch WETC", "bWETC");
        singleWetc = new BatchMockToken("Single WETC", "sWETC");
        batchLot1 = new BatchMockToken("Batch LOT1", "bLOT1");
        singleLot1 = new BatchMockToken("Single LOT1", "sLOT1");
        batchLot2 = new BatchMockToken("Batch LOT2", "bLOT2");
        singleLot2 = new BatchMockToken("Single LOT2", "sLOT2");

        batchEx = new SaturnLotExchange(address(batchWetc));
        singleEx = new SaturnLotExchange(address(singleWetc));

        assertEq(batchEx.approveMarket(address(batchLot1)), MARKET1);
        assertEq(singleEx.approveMarket(address(singleLot1)), MARKET1);
        assertEq(batchEx.approveMarket(address(batchLot2)), MARKET2);
        assertEq(singleEx.approveMarket(address(singleLot2)), MARKET2);

        address[2] memory users = [alice, bob];
        for (uint256 i; i < users.length; ++i) {
            batchWetc.mint(users[i], 1e36);
            singleWetc.mint(users[i], 1e36);
            batchLot1.mint(users[i], 1e12);
            singleLot1.mint(users[i], 1e12);
            batchLot2.mint(users[i], 1e12);
            singleLot2.mint(users[i], 1e12);

            vm.startPrank(users[i]);
            batchWetc.approve(address(batchEx), type(uint256).max);
            singleWetc.approve(address(singleEx), type(uint256).max);
            batchLot1.approve(address(batchEx), type(uint256).max);
            singleLot1.approve(address(singleEx), type(uint256).max);
            batchLot2.approve(address(batchEx), type(uint256).max);
            singleLot2.approve(address(singleEx), type(uint256).max);
            vm.stopPrank();
        }
    }

    function testBuyBatchEqualsRepeatedSinglePlacement() public {
        int256[] memory ticks = new int256[](6);
        uint256[] memory lots = new uint256[](6);
        ticks[0] = 20; lots[0] = 3;
        ticks[1] = 10; lots[1] = 4;
        ticks[2] = 20; lots[2] = 5;
        ticks[3] = 0;  lots[3] = 2;
        ticks[4] = 15; lots[4] = 7;
        ticks[5] = 20; lots[5] = 1;

        vm.prank(alice);
        uint64[] memory ids = batchEx.placeBuyBatch(MARKET1, ticks, lots);
        assertEq(ids.length, ticks.length);

        vm.startPrank(alice);
        for (uint256 i; i < ticks.length; ++i) {
            uint64 id = singleEx.placeBuy(MARKET1, ticks[i], lots[i]);
            assertEq(ids[i], id);
        }
        vm.stopPrank();

        _assertMarketBooksEqual(MARKET1);
        _assertEscrowEqual(MARKET1);

        // Same-tick FIFO must follow input array order: ids 1,3,6 at tick 20.
        (SaturnLotExchange.BookOrder[] memory orders, uint256 n) =
            batchEx.getBuyOrders(MARKET1, 32);
        assertEq(n, 6);
        assertEq(orders[0].tick, 20);
        assertEq(orders[0].id, ids[0]);
        assertEq(orders[1].tick, 20);
        assertEq(orders[1].id, ids[2]);
        assertEq(orders[2].tick, 20);
        assertEq(orders[2].id, ids[5]);
    }

    function testSellBatchEqualsRepeatedSinglePlacement() public {
        int256[] memory ticks = new int256[](5);
        uint256[] memory lots = new uint256[](5);
        ticks[0] = 40; lots[0] = 6;
        ticks[1] = 60; lots[1] = 3;
        ticks[2] = 40; lots[2] = 2;
        ticks[3] = 50; lots[3] = 9;
        ticks[4] = 70; lots[4] = 1;

        vm.prank(alice);
        uint64[] memory ids = batchEx.placeSellBatch(MARKET1, ticks, lots);

        vm.startPrank(alice);
        for (uint256 i; i < ticks.length; ++i) {
            uint64 id = singleEx.placeSell(MARKET1, ticks[i], lots[i]);
            assertEq(ids[i], id);
        }
        vm.stopPrank();

        _assertMarketBooksEqual(MARKET1);
        _assertEscrowEqual(MARKET1);
    }

    function testCancelManyEqualsRepeatedCancelAcrossMarketsAndSides() public {
        uint64[] memory cancelIds = new uint64[](4);

        vm.startPrank(alice);
        cancelIds[0] = batchEx.placeBuy(MARKET1, 10, 3);
        cancelIds[1] = batchEx.placeSell(MARKET1, 40, 4);
        cancelIds[2] = batchEx.placeBuy(MARKET2, 20, 5);
        cancelIds[3] = batchEx.placeSell(MARKET2, 50, 6);
        vm.stopPrank();

        uint64[] memory singleIds = new uint64[](4);
        vm.startPrank(alice);
        singleIds[0] = singleEx.placeBuy(MARKET1, 10, 3);
        singleIds[1] = singleEx.placeSell(MARKET1, 40, 4);
        singleIds[2] = singleEx.placeBuy(MARKET2, 20, 5);
        singleIds[3] = singleEx.placeSell(MARKET2, 50, 6);
        vm.stopPrank();

        for (uint256 i; i < 4; ++i) assertEq(cancelIds[i], singleIds[i]);

        vm.prank(alice);
        batchEx.cancelMany(cancelIds);

        vm.startPrank(alice);
        for (uint256 i; i < 4; ++i) singleEx.cancel(singleIds[i]);
        vm.stopPrank();

        _assertMarketBooksEqual(MARKET1);
        _assertMarketBooksEqual(MARKET2);
        _assertEscrowEqual(MARKET1);
        _assertEscrowEqual(MARKET2);

        assertEq(batchWetc.balanceOf(alice), singleWetc.balanceOf(alice));
        assertEq(batchLot1.balanceOf(alice), singleLot1.balanceOf(alice));
        assertEq(batchLot2.balanceOf(alice), singleLot2.balanceOf(alice));
    }

    function testBatchPlacementIsAtomicOnInvalidOrder() public {
        // Establish an ask so one buy in the proposed batch would cross it.
        vm.prank(bob);
        batchEx.placeSell(MARKET1, 30, 5);

        int256[] memory ticks = new int256[](3);
        uint256[] memory lots = new uint256[](3);
        ticks[0] = 10; lots[0] = 2;
        ticks[1] = 30; lots[1] = 3; // crosses existing ask
        ticks[2] = 20; lots[2] = 4;

        uint64 beforeId = batchEx.nextOrderId();
        (uint256 beforeWetc, uint256 beforeLots) = batchEx.getEscrowTotals(MARKET1);

        vm.prank(alice);
        vm.expectRevert("crossing sell book -- consider buyFOK");
        batchEx.placeBuyBatch(MARKET1, ticks, lots);

        assertEq(batchEx.nextOrderId(), beforeId);
        (uint256 afterWetc, uint256 afterLots) = batchEx.getEscrowTotals(MARKET1);
        assertEq(afterWetc, beforeWetc);
        assertEq(afterLots, beforeLots);
    }

    function testCancelManyIsAtomicIfAnyOrderIsNotOwned() public {
        vm.prank(alice);
        uint64 aliceId = batchEx.placeBuy(MARKET1, 10, 2);
        vm.prank(bob);
        uint64 bobId = batchEx.placeBuy(MARKET1, 5, 3);

        uint64[] memory ids = new uint64[](2);
        ids[0] = aliceId;
        ids[1] = bobId;

        vm.prank(alice);
        vm.expectRevert("not order owner");
        batchEx.cancelMany(ids);

        (address ownerA,,,,,,) = batchEx.orders(aliceId);
        (address ownerB,,,,,,) = batchEx.orders(bobId);
        assertEq(ownerA, alice);
        assertEq(ownerB, bob);
    }

    function testBatchBoundsAndLengthChecks() public {
        int256[] memory oneTick = new int256[](1);
        uint256[] memory noLots = new uint256[](0);
        oneTick[0] = 1;

        vm.prank(alice);
        vm.expectRevert("batch length mismatch");
        batchEx.placeBuyBatch(MARKET1, oneTick, noLots);

        int256[] memory tooManyTicks = new int256[](33);
        uint256[] memory tooManyLots = new uint256[](33);
        for (uint256 i; i < 33; ++i) {
            tooManyTicks[i] = int256(i);
            tooManyLots[i] = 1;
        }

        vm.prank(alice);
        vm.expectRevert("invalid batch size");
        batchEx.placeSellBatch(MARKET1, tooManyTicks, tooManyLots);
    }

    function _assertMarketBooksEqual(uint32 marketId) internal view {
        _assertSideEqual(marketId, true);
        _assertSideEqual(marketId, false);
    }

    function _assertSideEqual(uint32 marketId, bool isBuy) internal view {
        SaturnLotExchange.BookOrder[] memory a;
        SaturnLotExchange.BookOrder[] memory b;
        uint256 na;
        uint256 nb;

        if (isBuy) {
            (a, na) = batchEx.getBuyOrders(marketId, 128);
            (b, nb) = singleEx.getBuyOrders(marketId, 128);
        } else {
            (a, na) = batchEx.getSellOrders(marketId, 128);
            (b, nb) = singleEx.getSellOrders(marketId, 128);
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

    function _assertEscrowEqual(uint32 marketId) internal view {
        (uint256 aWetc, uint256 aLots) = batchEx.getEscrowTotals(marketId);
        (uint256 bWetc, uint256 bLots) = singleEx.getEscrowTotals(marketId);
        assertEq(aWetc, bWetc);
        assertEq(aLots, bLots);
    }
}
