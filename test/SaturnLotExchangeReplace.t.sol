// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SaturnLotExchange} from "../contracts/SaturnLotExchange.sol";

contract ReplaceMockToken is ERC20 {
    uint256 public transferCount;
    uint256 public transferFromCount;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external { _mint(to, amount); }

    function resetCounts() external {
        transferCount = 0;
        transferFromCount = 0;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        ++transferCount;
        return super.transfer(to, value);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        ++transferFromCount;
        return super.transferFrom(from, to, value);
    }
}

contract SaturnLotExchangeReplaceTest is Test {
    SaturnLotExchange internal replaceEx;
    SaturnLotExchange internal referenceEx;

    ReplaceMockToken internal replaceWetc;
    ReplaceMockToken internal referenceWetc;
    ReplaceMockToken internal replaceLot1;
    ReplaceMockToken internal referenceLot1;
    ReplaceMockToken internal replaceLot2;
    ReplaceMockToken internal referenceLot2;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    uint32 internal constant MARKET1 = 1;
    uint32 internal constant MARKET2 = 2;

    function setUp() public {
        replaceWetc = new ReplaceMockToken("Replace WETC", "rWETC");
        referenceWetc = new ReplaceMockToken("Reference WETC", "xWETC");
        replaceLot1 = new ReplaceMockToken("Replace LOT1", "rLOT1");
        referenceLot1 = new ReplaceMockToken("Reference LOT1", "xLOT1");
        replaceLot2 = new ReplaceMockToken("Replace LOT2", "rLOT2");
        referenceLot2 = new ReplaceMockToken("Reference LOT2", "xLOT2");

        replaceEx = new SaturnLotExchange(address(replaceWetc), address(this));
        referenceEx = new SaturnLotExchange(address(referenceWetc), address(this));

        assertEq(replaceEx.approveMarket(address(replaceLot1)), MARKET1);
        assertEq(referenceEx.approveMarket(address(referenceLot1)), MARKET1);
        assertEq(replaceEx.approveMarket(address(replaceLot2)), MARKET2);
        assertEq(referenceEx.approveMarket(address(referenceLot2)), MARKET2);

        replaceEx.activate();
        referenceEx.activate();

        address[2] memory users = [alice, bob];
        for (uint256 i; i < users.length; ++i) {
            replaceWetc.mint(users[i], 1e36);
            referenceWetc.mint(users[i], 1e36);
            replaceLot1.mint(users[i], 1e12);
            referenceLot1.mint(users[i], 1e12);
            replaceLot2.mint(users[i], 1e12);
            referenceLot2.mint(users[i], 1e12);

            vm.startPrank(users[i]);
            replaceWetc.approve(address(replaceEx), type(uint256).max);
            referenceWetc.approve(address(referenceEx), type(uint256).max);
            replaceLot1.approve(address(replaceEx), type(uint256).max);
            referenceLot1.approve(address(referenceEx), type(uint256).max);
            replaceLot2.approve(address(replaceEx), type(uint256).max);
            referenceLot2.approve(address(referenceEx), type(uint256).max);
            vm.stopPrank();
        }
    }

    function testReplaceBuyEqualsAtomicCancelThenPlaceFinalState() public {
        (int256[] memory initialTicks, uint256[] memory initialLots) = _buyInitial();

        vm.prank(alice);
        uint64[] memory replaceInitial = replaceEx.placeBuyBatch(MARKET1, initialTicks, initialLots);
        vm.prank(alice);
        uint64[] memory referenceInitial = referenceEx.placeBuyBatch(MARKET1, initialTicks, initialLots);
        _assertIdsEqual(replaceInitial, referenceInitial);

        uint64[] memory cancelIds = new uint64[](2);
        cancelIds[0] = replaceInitial[0];
        cancelIds[1] = replaceInitial[2];
        uint64[] memory referenceCancelIds = new uint64[](2);
        referenceCancelIds[0] = referenceInitial[0];
        referenceCancelIds[1] = referenceInitial[2];

        int256[] memory newTicks = new int256[](3);
        uint256[] memory newLots = new uint256[](3);
        newTicks[0] = 25; newLots[0] = 2;
        newTicks[1] = 18; newLots[1] = 7;
        newTicks[2] = 5;  newLots[2] = 1;

        vm.prank(alice);
        uint64[] memory newIds = replaceEx.replaceBuyBatch(MARKET1, cancelIds, newTicks, newLots);

        vm.startPrank(alice);
        referenceEx.cancelMany(referenceCancelIds);
        uint64[] memory referenceNewIds = referenceEx.placeBuyBatch(MARKET1, newTicks, newLots);
        vm.stopPrank();

        _assertIdsEqual(newIds, referenceNewIds);
        _assertMarketBooksEqual(MARKET1);
        _assertEscrowEqual(MARKET1);
        assertEq(replaceWetc.balanceOf(alice), referenceWetc.balanceOf(alice));
        assertEq(replaceEx.nextOrderId(), referenceEx.nextOrderId());
    }

    function testReplaceSellEqualsAtomicCancelThenPlaceFinalState() public {
        int256[] memory initialTicks = new int256[](4);
        uint256[] memory initialLots = new uint256[](4);
        initialTicks[0] = 40; initialLots[0] = 3;
        initialTicks[1] = 50; initialLots[1] = 4;
        initialTicks[2] = 60; initialLots[2] = 5;
        initialTicks[3] = 70; initialLots[3] = 6;

        vm.prank(alice);
        uint64[] memory replaceInitial = replaceEx.placeSellBatch(MARKET1, initialTicks, initialLots);
        vm.prank(alice);
        uint64[] memory referenceInitial = referenceEx.placeSellBatch(MARKET1, initialTicks, initialLots);

        uint64[] memory cancelIds = new uint64[](3);
        uint64[] memory referenceCancelIds = new uint64[](3);
        cancelIds[0] = replaceInitial[0]; referenceCancelIds[0] = referenceInitial[0];
        cancelIds[1] = replaceInitial[1]; referenceCancelIds[1] = referenceInitial[1];
        cancelIds[2] = replaceInitial[3]; referenceCancelIds[2] = referenceInitial[3];

        int256[] memory newTicks = new int256[](2);
        uint256[] memory newLots = new uint256[](2);
        newTicks[0] = 45; newLots[0] = 8;
        newTicks[1] = 80; newLots[1] = 2;

        vm.prank(alice);
        uint64[] memory newIds = replaceEx.replaceSellBatch(MARKET1, cancelIds, newTicks, newLots);

        vm.startPrank(alice);
        referenceEx.cancelMany(referenceCancelIds);
        uint64[] memory referenceNewIds = referenceEx.placeSellBatch(MARKET1, newTicks, newLots);
        vm.stopPrank();

        _assertIdsEqual(newIds, referenceNewIds);
        _assertMarketBooksEqual(MARKET1);
        _assertEscrowEqual(MARKET1);
        assertEq(replaceLot1.balanceOf(alice), referenceLot1.balanceOf(alice));
    }

    function testBuyReplacementMovesOnlyNetWETCDifference() public {
        int256[] memory ticks = new int256[](2);
        uint256[] memory lots = new uint256[](2);
        ticks[0] = 0; lots[0] = 3;
        ticks[1] = 10; lots[1] = 2;

        vm.prank(alice);
        uint64[] memory ids = replaceEx.placeBuyBatch(MARKET1, ticks, lots);

        uint256 oldEscrow = 3 * replaceEx.priceAtTick(0) + 2 * replaceEx.priceAtTick(10);
        replaceWetc.resetCounts();

        int256[] memory higherTicks = new int256[](2);
        uint256[] memory higherLots = new uint256[](2);
        higherTicks[0] = 20; higherLots[0] = 4;
        higherTicks[1] = 15; higherLots[1] = 3;
        uint256 newEscrow = 4 * replaceEx.priceAtTick(20) + 3 * replaceEx.priceAtTick(15);
        assertGt(newEscrow, oldEscrow);

        vm.prank(alice);
        replaceEx.replaceBuyBatch(MARKET1, ids, higherTicks, higherLots);

        assertEq(replaceWetc.transferFromCount(), 1);
        assertEq(replaceWetc.transferCount(), 0);

        (SaturnLotExchange.BookOrder[] memory current, uint256 n) =
            replaceEx.getBuyOrders(MARKET1, 16);
        uint64[] memory currentIds = new uint64[](n);
        for (uint256 i; i < n; ++i) currentIds[i] = uint64(current[i].id);

        replaceWetc.resetCounts();
        int256[] memory lowerTicks = new int256[](1);
        uint256[] memory lowerLots = new uint256[](1);
        lowerTicks[0] = -10; lowerLots[0] = 1;

        vm.prank(alice);
        replaceEx.replaceBuyBatch(MARKET1, currentIds, lowerTicks, lowerLots);

        assertEq(replaceWetc.transferFromCount(), 0);
        assertEq(replaceWetc.transferCount(), 1);
    }

    function testSellReplacementMovesOnlyNetLotDifference() public {
        int256[] memory ticks = new int256[](2);
        uint256[] memory lots = new uint256[](2);
        ticks[0] = 50; lots[0] = 2;
        ticks[1] = 60; lots[1] = 3;

        vm.prank(alice);
        uint64[] memory ids = replaceEx.placeSellBatch(MARKET1, ticks, lots);
        replaceLot1.resetCounts();

        int256[] memory biggerTicks = new int256[](2);
        uint256[] memory biggerLots = new uint256[](2);
        biggerTicks[0] = 55; biggerLots[0] = 5;
        biggerTicks[1] = 65; biggerLots[1] = 4;

        vm.prank(alice);
        replaceEx.replaceSellBatch(MARKET1, ids, biggerTicks, biggerLots);
        assertEq(replaceLot1.transferFromCount(), 1);
        assertEq(replaceLot1.transferCount(), 0);

        (SaturnLotExchange.BookOrder[] memory current, uint256 n) =
            replaceEx.getSellOrders(MARKET1, 16);
        uint64[] memory currentIds = new uint64[](n);
        for (uint256 i; i < n; ++i) currentIds[i] = uint64(current[i].id);

        replaceLot1.resetCounts();
        int256[] memory smallerTicks = new int256[](1);
        uint256[] memory smallerLots = new uint256[](1);
        smallerTicks[0] = 70; smallerLots[0] = 1;

        vm.prank(alice);
        replaceEx.replaceSellBatch(MARKET1, currentIds, smallerTicks, smallerLots);
        assertEq(replaceLot1.transferFromCount(), 0);
        assertEq(replaceLot1.transferCount(), 1);
    }

    function testReplacementGetsNewIdsAndTailFIFO() public {
        vm.prank(bob);
        uint64 bobId = replaceEx.placeBuy(MARKET1, 20, 1);
        vm.prank(alice);
        uint64 aliceId = replaceEx.placeBuy(MARKET1, 10, 2);

        uint64[] memory cancelIds = new uint64[](1);
        cancelIds[0] = aliceId;
        int256[] memory ticks = new int256[](1);
        uint256[] memory lots = new uint256[](1);
        ticks[0] = 20;
        lots[0] = 2;

        vm.prank(alice);
        uint64[] memory replacementIds = replaceEx.replaceBuyBatch(MARKET1, cancelIds, ticks, lots);
        assertGt(replacementIds[0], aliceId);

        (SaturnLotExchange.BookOrder[] memory orders, uint256 n) =
            replaceEx.getBuyOrders(MARKET1, 8);
        assertEq(n, 2);
        assertEq(orders[0].id, bobId);
        assertEq(orders[1].id, replacementIds[0]);
    }

    function testReplacementAtomicOnWrongOwnerWrongMarketWrongSideAndCross() public {
        vm.prank(alice);
        uint64 buyId = replaceEx.placeBuy(MARKET1, 10, 2);
        vm.prank(alice);
        uint64 sellId = replaceEx.placeSell(MARKET1, 40, 2);
        vm.prank(bob);
        uint64 bobBuyId = replaceEx.placeBuy(MARKET1, 5, 1);
        vm.prank(alice);
        uint64 otherMarketBuyId = replaceEx.placeBuy(MARKET2, 10, 1);

        int256[] memory ticks = new int256[](1);
        uint256[] memory lots = new uint256[](1);
        ticks[0] = 15; lots[0] = 3;
        uint64 beforeNext = replaceEx.nextOrderId();
        (uint256 beforeWetc, uint256 beforeLots) = replaceEx.getEscrowTotals(MARKET1);

        uint64[] memory ids = new uint64[](1);

        ids[0] = bobBuyId;
        vm.prank(alice);
        vm.expectRevert("not order owner");
        replaceEx.replaceBuyBatch(MARKET1, ids, ticks, lots);

        ids[0] = otherMarketBuyId;
        vm.prank(alice);
        vm.expectRevert("wrong market");
        replaceEx.replaceBuyBatch(MARKET1, ids, ticks, lots);

        ids[0] = sellId;
        vm.prank(alice);
        vm.expectRevert("wrong order side");
        replaceEx.replaceBuyBatch(MARKET1, ids, ticks, lots);

        ids[0] = buyId;
        ticks[0] = 40; // crosses the existing ask at 40
        vm.prank(alice);
        vm.expectRevert("crossing sell book -- consider buyFOK");
        replaceEx.replaceBuyBatch(MARKET1, ids, ticks, lots);

        assertEq(replaceEx.nextOrderId(), beforeNext);
        (uint256 afterWetc, uint256 afterLots) = replaceEx.getEscrowTotals(MARKET1);
        assertEq(afterWetc, beforeWetc);
        assertEq(afterLots, beforeLots);
        (address owner,,,,,,) = replaceEx.orders(buyId);
        assertEq(owner, alice);
    }

    function testReplacementRejectsEmptySidesAndLengthMismatch() public {
        vm.prank(alice);
        uint64 id = replaceEx.placeBuy(MARKET1, 10, 1);

        uint64[] memory oneId = new uint64[](1);
        oneId[0] = id;
        uint64[] memory noIds = new uint64[](0);
        int256[] memory oneTick = new int256[](1);
        oneTick[0] = 11;
        int256[] memory noTicks = new int256[](0);
        uint256[] memory oneLot = new uint256[](1);
        oneLot[0] = 1;
        uint256[] memory noLots = new uint256[](0);

        vm.prank(alice);
        vm.expectRevert("invalid cancel batch size");
        replaceEx.replaceBuyBatch(MARKET1, noIds, oneTick, oneLot);

        vm.prank(alice);
        vm.expectRevert("invalid place batch size");
        replaceEx.replaceBuyBatch(MARKET1, oneId, noTicks, noLots);

        vm.prank(alice);
        vm.expectRevert("batch length mismatch");
        replaceEx.replaceBuyBatch(MARKET1, oneId, oneTick, noLots);
    }

    function _buyInitial() internal pure returns (int256[] memory ticks, uint256[] memory lots) {
        ticks = new int256[](4);
        lots = new uint256[](4);
        ticks[0] = 20; lots[0] = 3;
        ticks[1] = 10; lots[1] = 4;
        ticks[2] = 0;  lots[2] = 5;
        ticks[3] = -10; lots[3] = 6;
    }

    function _assertIdsEqual(uint64[] memory a, uint64[] memory b) internal pure {
        assertEq(a.length, b.length);
        for (uint256 i; i < a.length; ++i) assertEq(a[i], b[i]);
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
            (a, na) = replaceEx.getBuyOrders(marketId, 128);
            (b, nb) = referenceEx.getBuyOrders(marketId, 128);
        } else {
            (a, na) = replaceEx.getSellOrders(marketId, 128);
            (b, nb) = referenceEx.getSellOrders(marketId, 128);
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
        (uint256 aWetc, uint256 aLots) = replaceEx.getEscrowTotals(marketId);
        (uint256 bWetc, uint256 bLots) = referenceEx.getEscrowTotals(marketId);
        assertEq(aWetc, bWetc);
        assertEq(aLots, bLots);
    }
}
