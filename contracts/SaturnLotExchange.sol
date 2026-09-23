// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/*
  Saturn Lot Exchange v0.7.1 (Multi-Market + Taker Fee Design)
  By PseudoDeterminist

  One WETC quote token, many DAO/owner-approved Lot Token markets.
  Each market has an independent sparse FIFO order book while sharing
  the same logarithmic ~0.5% tick lattice.
*/

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/* ===================== Multi-Market Lot CLOB ===================== */

contract SaturnLotExchange {
    using SafeERC20 for IERC20;

    // Tick range: -464 .. +1855 (5 decades * 464 ticks/decade)
    // Prices span 0.1 .. 9950 WETC per Lot.
    int32 private constant MIN_TICK = -464;
    int32 private constant MAX_TICK = 1855;
    uint32 private constant MAX_LOTS = 100000;

    int32 private constant NONE32 = type(int32).min;
    int256 private constant NONE256 = int256(NONE32);

    IERC20 public immutable WETC; // shared quote token for every market

    uint256 private constant ETC_MAINNET_CHAIN_ID = 61;
    address private constant ETC_MAINNET_WETC = 0x82A618305706B14e7bcf2592D4B9324A366b6dAd;

    address public owner;

    // Taker fees are charged only in WETC after a successful FOK.
    // Maker/order-book accounting remains gross and exact.
    uint16 public constant MAX_TAKER_FEE_BPS = 50; // governance can never exceed 0.50%
    uint16 public takerFeeBps;                     // 0 at deployment; owner/DAO may set later
    address public feeTreasury;                    // receives WETC fees immediately after each FOK

    // Event type tags used in each market-local integrity hash chain.
    uint8 private constant EVT_PLACE      = 1;
    uint8 private constant EVT_CANCEL     = 2;
    uint8 private constant EVT_TRADE      = 3;
    uint8 private constant EVT_SETTLEMENT = 4;

    /* -------------------- Events -------------------- */

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event TakerFeeUpdated(uint16 previousFeeBps, uint16 newFeeBps);
    event FeeTreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);

    event MarketApproved(uint32 indexed marketId, address indexed lotToken);
    event MarketUnapproved(uint32 indexed marketId, address indexed lotToken);

    event OrderPlaced(
        uint32 indexed marketId,
        uint64 seq,
        bytes32 newHash,
        uint64 indexed orderId,
        address indexed owner,
        bool isBuy,
        int32 tick,
        uint32 lots,
        uint128 value
    );

    event OrderCanceled(
        uint32 indexed marketId,
        uint64 seq,
        bytes32 newHash,
        uint64 indexed orderId,
        address indexed owner,
        bool isBuy,
        int32 tick,
        uint32 lotsCanceled,
        uint128 valueCanceled
    );

    // One Trade event per maker fill (FOK taker may generate multiple).
    event Trade(
        uint32 indexed marketId,
        uint64 seq,
        bytes32 newHash,
        uint64 indexed orderId,
        address taker,
        address indexed maker,
        bool takerIsBuy,
        int32 tick,
        uint96 pricePerLot,
        uint32 lotsFilled,
        uint128 valueFilled,
        uint32 lotsRemainingAfter,
        uint128 valueRemainingAfter
    );

    // One aggregate settlement event per successful FOK. This event is included
    // in the market-local integrity hash chain after all maker-fill Trade events.
    // takerWETC is total WETC paid by a buy taker (gross + fee), or net WETC
    // received by a sell taker (gross - fee).
    event FOKSettled(
        uint32 indexed marketId,
        uint64 seq,
        bytes32 newHash,
        address indexed taker,
        bool takerIsBuy,
        uint32 lots,
        uint128 grossWETC,
        uint128 feeWETC,
        uint128 takerWETC
    );

    /* -------------------- Order book data -------------------- */

    struct Order {
        address owner;
        uint32 marketId;
        int32 tick;
        uint32 lotsRemaining;
        bool isBuy;
        uint128 valueRemaining;
        uint64 prev;
        uint64 next;
    }

    struct TickLevel {
        uint96 price;
        int32 prev;
        int32 next;
        uint32 orderCount;
        uint64 head;
        uint64 tail;
        uint64 totalLots;
        uint128 totalValue;
    }

    struct Market {
        address lotToken;
        bool exists;
        bool active;

        // Market-local event integrity chain.
        uint64 historySeq;
        bytes32 historyHash;

        // Market-local oracle / top of book.
        int256 lastTradeTick;
        uint256 lastTradePrice;
        uint256 lastTradeBlock;
        bool lastTradeTakerIsBuy;
        int256 bestBuyTick;
        int256 bestSellTick;

        // Market-local accounting totals.
        uint256 bookEscrowWETC;
        uint256 bookEscrowLots;
        uint256 bookAskLots;
        uint256 bookAskWETC;

        // Sparse linked tick lists for this market only.
        mapping(int256 => TickLevel) buyLevels;
        mapping(int256 => TickLevel) sellLevels;
    }

    struct BookLevel {
        int256 tick;
        uint256 price;
        uint256 totalLots;
        uint256 totalValue;
        uint256 orderCount;
    }

    struct BookOrder {
        uint256 id;
        address owner;
        int256 tick;
        uint256 price;
        uint256 lotsRemaining;
        uint256 valueRemaining;
    }

    uint32 public marketCount;
    mapping(address => uint32) public marketIdOf;
    mapping(uint32 => Market) private markets;

    // Order IDs are globally unique across the whole exchange.
    uint64 public nextOrderId = 1;
    mapping(uint64 => Order) public orders;

    // Packed mantissa bytes (464 uint16, big-endian, 2 bytes each)
    bytes internal constant MANT =
        hex"03e803ed03f203f703fc04010406040b04100416041b04200425042b04300435"
        hex"043b04400445044b04500456045b04610466046c04720477047d04830489048e"
        hex"0494049a04a004a604ac04b204b804be04c404ca04d004d604dc04e204e804ef"
        hex"04f504fb05020508050e0515051b05220528052f0536053c0543054a05500557"
        hex"055e0565056c0572057905800587058e0595059d05a405ab05b205b905c105c8"
        hex"05cf05d705de05e605ed05f505fc0604060c0613061b0623062b0632063a0642"
        hex"064a0652065a0662066b0673067b0683068b0694069c06a506ad06b606be06c7"
        hex"06cf06d806e106e906f206fb0704070d0716071f07280731073a0744074d0756"
        hex"075f07690772077c0785078f079807a207ac07b607bf07c907d307dd07e707f1"
        hex"07fb08060810081a0824082f08390844084e08590863086e08790884088e0899"
        hex"08a408af08ba08c508d108dc08e708f208fe090909150920092c09380943094f"
        hex"095b09670973097f098b099709a309b009bc09c809d509e109ee09fb0a070a14"
        hex"0a210a2e0a3b0a480a550a620a6f0a7d0a8a0a970aa50ab20ac00ace0adb0ae9"
        hex"0af70b050b130b210b2f0b3e0b4c0b5a0b690b770b860b950ba30bb20bc10bd0"
        hex"0bdf0bee0bfe0c0d0c1c0c2c0c3b0c4b0c5a0c6a0c7a0c8a0c9a0caa0cba0cca"
        hex"0cda0ceb0cfb0d0c0d1c0d2d0d3e0d4f0d600d710d820d930da40db60dc70dd9"
        hex"0dea0dfc0e0e0e200e320e440e560e680e7b0e8d0e9f0eb20ec50ed80eeb0efe"
        hex"0f110f240f370f4a0f5e0f720f850f990fad0fc10fd50fe90ffd10121026103b"
        hex"104f10641079108e10a310b810ce10e310f8110e1124113a11501166117c1192"
        hex"11a811bf11d511ec1203121a12311248125f1277128e12a612be12d612ee1306"
        hex"131e1336134f13671380139913b213cb13e413fd14171430144a1464147e1498"
        hex"14b214cd14e71502151d15371552156e158915a415c015dc15f716131630164c"
        hex"1668168516a116be16db16f8171617331750176e178c17aa17c817e618051823"
        hex"184218611880189f18bf18de18fe191e193e195e197e199f19bf19e01a011a22"
        hex"1a431a651a861aa81aca1aec1b0f1b311b541b761b991bbd1be01c031c271c4b"
        hex"1c6f1c931cb81cdc1d011d261d4b1d701d961dbb1de11e071e2e1e541e7b1ea1"
        hex"1ec81ef01f171f3f1f661f8e1fb71fdf200820302059208320ac20d620ff2129"
        hex"2154217e21a921d421ff222a2256228122ad22d923062332235f238c23b923e7"
        hex"241524432471249f24ce24fd252c255b258b25bb25eb261b264b267c26ad26de";

    constructor(address wetcToken) {
        if (block.chainid == ETC_MAINNET_CHAIN_ID) {
            WETC = IERC20(ETC_MAINNET_WETC);
        } else {
            require(wetcToken != address(0), "zero WETC");
            WETC = IERC20(wetcToken);
        }

        owner = msg.sender;
        feeTreasury = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        emit FeeTreasuryUpdated(address(0), msg.sender);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    /* -------------------- Governance / Markets -------------------- */

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero owner");
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function setTakerFeeBps(uint16 newFeeBps) external onlyOwner {
        require(newFeeBps <= MAX_TAKER_FEE_BPS, "fee too high");
        uint16 oldFeeBps = takerFeeBps;
        takerFeeBps = newFeeBps;
        emit TakerFeeUpdated(oldFeeBps, newFeeBps);
    }

    function setFeeTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "zero treasury");
        address oldTreasury = feeTreasury;
        feeTreasury = newTreasury;
        emit FeeTreasuryUpdated(oldTreasury, newTreasury);
    }

    /// @notice Approve a Lot Token for trading. Re-approving a retired token
    ///         reactivates its original market and preserves its history.
    function approveMarket(address lotToken) external onlyOwner returns (uint32 marketId) {
        require(lotToken != address(0), "zero lot token");
        require(lotToken != address(WETC), "lot token is WETC");

        marketId = marketIdOf[lotToken];

        if (marketId == 0) {
            marketId = ++marketCount;
            Market storage mkt = markets[marketId];
            mkt.lotToken = lotToken;
            mkt.exists = true;
            mkt.active = true;
            mkt.bestBuyTick = NONE256;
            mkt.bestSellTick = NONE256;
            marketIdOf[lotToken] = marketId;
        } else {
            Market storage mkt = markets[marketId];
            require(mkt.exists, "invalid market");
            require(!mkt.active, "market already active");
            mkt.active = true;
        }

        emit MarketApproved(marketId, lotToken);
    }

    /// @notice Stop new orders and taker trades. Existing makers can still cancel.
    function unapproveMarket(uint32 marketId) external onlyOwner {
        Market storage mkt = _market(marketId);
        require(mkt.active, "market not active");
        mkt.active = false;
        emit MarketUnapproved(marketId, mkt.lotToken);
    }

    function getMarket(uint32 marketId)
        external
        view
        returns (
            address lotToken,
            bool active,
            uint64 historySeq,
            bytes32 historyHash,
            int256 bestBuyTick,
            int256 bestSellTick,
            int256 lastTradeTick,
            uint256 lastTradeBlock,
            uint256 lastTradePrice,
            bool lastTradeTakerIsBuy,
            uint256 bookEscrowWETC,
            uint256 bookEscrowLots,
            uint256 bookAskLots,
            uint256 bookAskWETC
        )
    {
        Market storage mkt = _marketView(marketId);
        return (
            mkt.lotToken,
            mkt.active,
            mkt.historySeq,
            mkt.historyHash,
            mkt.bestBuyTick,
            mkt.bestSellTick,
            mkt.lastTradeTick,
            mkt.lastTradeBlock,
            mkt.lastTradePrice,
            mkt.lastTradeTakerIsBuy,
            mkt.bookEscrowWETC,
            mkt.bookEscrowLots,
            mkt.bookAskLots,
            mkt.bookAskWETC
        );
    }

    /* -------------------- Price -------------------- */

    function priceAtTick(int256 tick) public pure returns (uint256 result) {
        require(tick >= MIN_TICK && tick <= MAX_TICK, "tick out of range");

        uint256 t = uint256(tick - MIN_TICK);
        uint256 d = t / 464;
        uint256 r = t % 464;

        uint256 i = r * 2;
        uint256 m = (uint256(uint8(MANT[i])) << 8) | uint256(uint8(MANT[i + 1]));

        uint256 factor;
        if (d == 0) factor = 1e14;       //    0.1 to      0.995 WETC per Lot
        else if (d == 1) factor = 1e15;  //      1 to      9.95  WETC per Lot
        else if (d == 2) factor = 1e16;  //     10 to     99.5   WETC per Lot
        else if (d == 3) factor = 1e17;  //    100 to    995     WETC per Lot
        else factor = 1e18;              //   1000 to   9950     WETC per Lot

        result = factor * m;
    }

    function _toTick(int256 tick) internal pure returns (int32) {
        require(tick >= MIN_TICK && tick <= MAX_TICK, "tick out of range");
        return int32(tick);
    }

    /* -------------------- Hash chain helpers -------------------- */

    function _chainHash(bytes32 chain, bytes32 recordHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(chain, recordHash));
    }

    function _emitPlaced(
        uint32 marketId,
        uint64 seq,
        bytes32 chain,
        uint64 orderId,
        address orderOwner,
        bool isBuy,
        int32 tick,
        uint32 lots,
        uint128 value
    ) internal returns (uint64, bytes32) {
        unchecked {
            ++seq;
        }
        bytes32 rec = keccak256(
            abi.encode(EVT_PLACE, marketId, seq, orderId, orderOwner, isBuy, tick, lots, value)
        );
        bytes32 newHash = _chainHash(chain, rec);
        emit OrderPlaced(marketId, seq, newHash, orderId, orderOwner, isBuy, tick, lots, value);
        return (seq, newHash);
    }

    function _emitCanceled(
        uint32 marketId,
        uint64 seq,
        bytes32 chain,
        uint64 orderId,
        address orderOwner,
        bool isBuy,
        int32 tick,
        uint32 lotsCanceled,
        uint128 valueCanceled
    ) internal returns (uint64, bytes32) {
        unchecked {
            ++seq;
        }
        bytes32 rec = keccak256(
            abi.encode(
                EVT_CANCEL,
                marketId,
                seq,
                orderId,
                orderOwner,
                isBuy,
                tick,
                lotsCanceled,
                valueCanceled
            )
        );
        bytes32 newHash = _chainHash(chain, rec);
        emit OrderCanceled(
            marketId,
            seq,
            newHash,
            orderId,
            orderOwner,
            isBuy,
            tick,
            lotsCanceled,
            valueCanceled
        );
        return (seq, newHash);
    }

    function _emitTrade(
        uint32 marketId,
        uint64 seq,
        bytes32 chain,
        uint64 orderId,
        address taker,
        address maker,
        bool takerIsBuy,
        int32 tick,
        uint96 pricePerLot,
        uint32 lotsFilled,
        uint128 valueFilled,
        uint32 lotsRemainingAfter,
        uint128 valueRemainingAfter
    ) internal returns (uint64, bytes32) {
        unchecked {
            ++seq;
        }
        bytes32 rec = keccak256(
            abi.encode(
                EVT_TRADE,
                marketId,
                seq,
                orderId,
                taker,
                maker,
                takerIsBuy,
                tick,
                pricePerLot,
                lotsFilled,
                valueFilled,
                lotsRemainingAfter,
                valueRemainingAfter
            )
        );
        bytes32 newHash = _chainHash(chain, rec);
        emit Trade(
            marketId,
            seq,
            newHash,
            orderId,
            taker,
            maker,
            takerIsBuy,
            tick,
            pricePerLot,
            lotsFilled,
            valueFilled,
            lotsRemainingAfter,
            valueRemainingAfter
        );
        return (seq, newHash);
    }

    function _emitSettled(
        uint32 marketId,
        uint64 seq,
        bytes32 chain,
        address taker,
        bool takerIsBuy,
        uint32 lots,
        uint128 grossWETC,
        uint128 feeWETC,
        uint128 takerWETC
    ) internal returns (uint64, bytes32) {
        unchecked {
            ++seq;
        }
        bytes32 rec = keccak256(
            abi.encode(
                EVT_SETTLEMENT,
                marketId,
                seq,
                taker,
                takerIsBuy,
                lots,
                grossWETC,
                feeWETC,
                takerWETC
            )
        );
        bytes32 newHash = _chainHash(chain, rec);
        emit FOKSettled(
            marketId,
            seq,
            newHash,
            taker,
            takerIsBuy,
            lots,
            grossWETC,
            feeWETC,
            takerWETC
        );
        return (seq, newHash);
    }

    function _takerFee(uint256 grossWETC) internal view returns (uint256) {
        return (grossWETC * uint256(takerFeeBps)) / 10_000;
    }

    /* -------------------- Maker Orders -------------------- */

    function placeBuy(uint32 marketId, int256 tick, uint256 lots) public returns (uint64 id) {
        Market storage mkt = _activeMarket(marketId);
        require(lots > 0 && lots <= MAX_LOTS, "invalid lots");
        int32 t = _toTick(tick);
        require(
            mkt.bestSellTick == NONE256 || mkt.bestSellTick > int256(t),
            "crossing sell book -- consider buyFOK"
        );

        uint64 seq = mkt.historySeq;
        bytes32 chain = mkt.historyHash;

        uint32 lots32 = uint32(lots);
        uint96 price = uint96(priceAtTick(tick));
        uint256 cost = uint256(lots32) * uint256(price);

        WETC.safeTransferFrom(msg.sender, address(this), cost);

        id = _newOrder(marketId, true, t, lots32, uint128(cost));
        _enqueue(mkt, true, t, price, lots32, uint128(cost), id);

        mkt.bookEscrowWETC += cost;
        mkt.bookAskLots += lots32;

        (seq, chain) = _emitPlaced(
            marketId,
            seq,
            chain,
            id,
            msg.sender,
            true,
            t,
            lots32,
            uint128(cost)
        );
        mkt.historySeq = seq;
        mkt.historyHash = chain;
    }

    function placeBuy(uint32 marketId, int256 tick, uint256 lots, bytes32 expectedHash)
        external
        returns (uint64 id)
    {
        Market storage mkt = _activeMarket(marketId);
        require(mkt.historyHash == expectedHash, "stale hash");
        return placeBuy(marketId, tick, lots);
    }

    function placeSell(uint32 marketId, int256 tick, uint256 lots) public returns (uint64 id) {
        Market storage mkt = _activeMarket(marketId);
        require(lots > 0 && lots <= MAX_LOTS, "invalid lots");
        int32 t = _toTick(tick);
        require(
            mkt.bestBuyTick == NONE256 || mkt.bestBuyTick < int256(t),
            "crossing buy book -- consider sellFOK"
        );

        uint64 seq = mkt.historySeq;
        bytes32 chain = mkt.historyHash;

        uint32 lots32 = uint32(lots);
        IERC20(mkt.lotToken).safeTransferFrom(msg.sender, address(this), uint256(lots32));

        uint96 price = uint96(priceAtTick(tick));
        uint256 value = uint256(lots32) * uint256(price);

        id = _newOrder(marketId, false, t, lots32, uint128(value));
        _enqueue(mkt, false, t, price, lots32, uint128(value), id);

        mkt.bookEscrowLots += lots32;
        mkt.bookAskWETC += value;

        (seq, chain) = _emitPlaced(
            marketId,
            seq,
            chain,
            id,
            msg.sender,
            false,
            t,
            lots32,
            uint128(value)
        );
        mkt.historySeq = seq;
        mkt.historyHash = chain;
    }

    function placeSell(uint32 marketId, int256 tick, uint256 lots, bytes32 expectedHash)
        external
        returns (uint64 id)
    {
        Market storage mkt = _activeMarket(marketId);
        require(mkt.historyHash == expectedHash, "stale hash");
        return placeSell(marketId, tick, lots);
    }

    function cancel(uint64 id) external {
        Order storage o = orders[id];
        require(o.owner == msg.sender, "not order owner");

        uint32 marketId = o.marketId;
        Market storage mkt = _market(marketId);

        uint64 seq = mkt.historySeq;
        bytes32 chain = mkt.historyHash;

        uint32 lotsRemaining = o.lotsRemaining;
        uint128 valueRemaining = o.valueRemaining;
        bool isBuy = o.isBuy;
        int32 tick = o.tick;

        _unlinkOrder(mkt, isBuy, tick, id);
        (seq, chain) = _emitCanceled(
            marketId,
            seq,
            chain,
            id,
            msg.sender,
            isBuy,
            tick,
            lotsRemaining,
            valueRemaining
        );
        mkt.historySeq = seq;
        mkt.historyHash = chain;

        delete orders[id];

        if (isBuy) {
            mkt.bookEscrowWETC -= valueRemaining;
            mkt.bookAskLots -= lotsRemaining;
            WETC.safeTransfer(msg.sender, uint256(valueRemaining));
        } else {
            mkt.bookAskWETC -= valueRemaining;
            mkt.bookEscrowLots -= lotsRemaining;
            IERC20(mkt.lotToken).safeTransfer(msg.sender, uint256(lotsRemaining));
        }
    }

    /* -------------------- Taker FOK -------------------- */

    function buyFOK(uint32 marketId, int256 limitTick, uint256 lots, uint256 maxWetcIn) public {
        Market storage mkt = _activeMarket(marketId);
        require(lots > 0, "You requested zero lots");
        require(lots <= MAX_LOTS, "invalid lots");
        require(mkt.bestSellTick != NONE256, "There are no sell orders on book");
        require(lots <= mkt.bookEscrowLots, "insufficient escrowed Lots on book");

        // maxWetcIn is the taker's absolute all-in debit cap, including fee.
        WETC.safeTransferFrom(msg.sender, address(this), maxWetcIn);

        uint64 seq = mkt.historySeq;
        bytes32 chain = mkt.historyHash;

        uint256 remain = lots;
        uint256 spent = 0; // exact gross maker consideration
        uint96 price;
        uint256 bookEscrowLots = mkt.bookEscrowLots;
        uint256 bookAskWetc = mkt.bookAskWETC;

        int256 t = mkt.bestSellTick;

        while (remain > 0) {
            require(t <= limitTick, "FOK--Limit tick crossed");
            TickLevel storage lvl = mkt.sellLevels[t];

            price = lvl.price;
            uint64 head = lvl.head;

            while (remain > 0) {
                uint64 oid = head;
                if (oid == 0) break;

                Order storage makerOrder = orders[oid];
                address maker = makerOrder.owner;
                uint32 makerLots = makerOrder.lotsRemaining;
                uint32 fill = remain < makerLots ? uint32(remain) : makerLots;
                makerLots -= fill;

                uint256 pay = uint256(fill) * uint256(price);
                spent += pay;

                uint128 remainingValue;
                if (makerLots == 0) {
                    head = makerOrder.next;
                    unchecked {
                        lvl.orderCount--;
                    }
                    delete orders[oid];
                    if (head == 0) {
                        lvl.tail = 0;
                    }
                    remainingValue = 0;
                } else {
                    remainingValue = makerOrder.valueRemaining - uint128(pay);
                    makerOrder.lotsRemaining = makerLots;
                    makerOrder.valueRemaining = remainingValue;
                }

                lvl.totalLots -= fill;
                lvl.totalValue -= uint128(pay);
                bookEscrowLots -= fill;
                bookAskWetc -= pay;
                remain -= fill;

                // Maker receives the exact gross book value. Fees never touch maker/order math.
                WETC.safeTransfer(maker, pay);

                (seq, chain) = _emitTrade(
                    marketId,
                    seq,
                    chain,
                    oid,
                    msg.sender,
                    maker,
                    true,
                    int32(t),
                    price,
                    fill,
                    uint128(pay),
                    makerLots,
                    remainingValue
                );
            }

            if (head == 0) {
                int32 nxt = lvl.next;
                _removeTick(mkt, false, int32(t));
                if (remain == 0) break;
                if (nxt == NONE32) break;
                t = int256(nxt);
            } else if (head != lvl.head) {
                lvl.head = head;
                orders[head].prev = 0;
            }
        }

        require(remain == 0, "FOK--Unfilled");

        // Fee is calculated exactly once on aggregate gross WETC.
        uint256 fee = _takerFee(spent);
        uint256 totalCost = spent + fee;
        require(totalCost <= maxWetcIn, "FOK--Slippage exceeded");

        mkt.bookEscrowLots = bookEscrowLots;
        mkt.bookAskWETC = bookAskWetc;

        mkt.lastTradeBlock = block.number;
        mkt.lastTradeTick = t;
        mkt.lastTradePrice = price;
        mkt.lastTradeTakerIsBuy = true;

        (seq, chain) = _emitSettled(
            marketId,
            seq,
            chain,
            msg.sender,
            true,
            uint32(lots),
            uint128(spent),
            uint128(fee),
            uint128(totalCost)
        );
        mkt.historySeq = seq;
        mkt.historyHash = chain;

        // Taker receives exact integer Lots. DAO treasury receives the WETC fee.
        IERC20(mkt.lotToken).safeTransfer(msg.sender, lots);
        if (fee != 0) {
            WETC.safeTransfer(feeTreasury, fee);
        }

        if (totalCost < maxWetcIn) {
            WETC.safeTransfer(msg.sender, maxWetcIn - totalCost);
        }
    }

    function buyFOK(
        uint32 marketId,
        int256 limitTick,
        uint256 lots,
        uint256 maxWetcIn,
        bytes32 expectedHash
    ) external {
        Market storage mkt = _activeMarket(marketId);
        require(mkt.historyHash == expectedHash, "stale hash");
        buyFOK(marketId, limitTick, lots, maxWetcIn);
    }

    function sellFOK(uint32 marketId, int256 limitTick, uint256 lots, uint256 minWetcOut) public {
        Market storage mkt = _activeMarket(marketId);
        require(lots > 0, "You requested zero lots");
        require(lots <= MAX_LOTS, "invalid lots");
        require(mkt.bestBuyTick != NONE256, "There are no buy orders on book");
        require(lots <= mkt.bookAskLots, "FOK--Insufficient asked Lots on book");
        require(minWetcOut <= mkt.bookEscrowWETC, "FOK--Insufficient escrowed WETC on book");

        IERC20(mkt.lotToken).safeTransferFrom(msg.sender, address(this), lots);

        uint64 seq = mkt.historySeq;
        bytes32 chain = mkt.historyHash;

        uint256 remain = lots;
        uint256 got = 0; // exact gross WETC released from maker bids
        uint96 price;
        uint256 bookAskLots = mkt.bookAskLots;
        uint256 bookEscrowWetc = mkt.bookEscrowWETC;

        int256 t = mkt.bestBuyTick;

        while (remain > 0) {
            require(t >= limitTick, "FOK--Limit tick crossed");
            TickLevel storage lvl = mkt.buyLevels[t];

            price = lvl.price;
            uint64 head = lvl.head;

            while (remain > 0) {
                uint64 oid = head;
                if (oid == 0) break;

                Order storage makerOrder = orders[oid];
                address maker = makerOrder.owner;
                uint32 makerLots = makerOrder.lotsRemaining;
                uint32 fill = remain < makerLots ? uint32(remain) : makerLots;
                makerLots -= fill;

                uint256 receiveAmt = uint256(fill) * uint256(price);
                got += receiveAmt;

                uint128 remainingValue;
                if (makerLots == 0) {
                    head = makerOrder.next;
                    unchecked {
                        lvl.orderCount--;
                    }
                    delete orders[oid];
                    if (head == 0) {
                        lvl.tail = 0;
                    }
                    remainingValue = 0;
                } else {
                    remainingValue = makerOrder.valueRemaining - uint128(receiveAmt);
                    makerOrder.lotsRemaining = makerLots;
                    makerOrder.valueRemaining = remainingValue;
                }

                lvl.totalLots -= fill;
                lvl.totalValue -= uint128(receiveAmt);
                bookAskLots -= fill;
                bookEscrowWetc -= receiveAmt;
                remain -= fill;

                // Maker receives exact integer Lots. Fees never touch maker/order math.
                IERC20(mkt.lotToken).safeTransfer(maker, uint256(fill));

                (seq, chain) = _emitTrade(
                    marketId,
                    seq,
                    chain,
                    oid,
                    msg.sender,
                    maker,
                    false,
                    int32(t),
                    price,
                    fill,
                    uint128(receiveAmt),
                    makerLots,
                    remainingValue
                );
            }

            if (head == 0) {
                int32 nxt = lvl.next;
                _removeTick(mkt, true, int32(t));
                if (remain == 0) break;
                if (nxt == NONE32) break;
                t = int256(nxt);
            } else if (head != lvl.head) {
                lvl.head = head;
                orders[head].prev = 0;
            }
        }

        require(remain == 0, "FOK--Unfilled");

        // minWetcOut is the seller's true net receipt after fee.
        uint256 fee = _takerFee(got);
        uint256 netWetc = got - fee;
        require(netWetc >= minWetcOut, "FOK--Slippage exceeded");

        mkt.bookAskLots = bookAskLots;
        mkt.bookEscrowWETC = bookEscrowWetc;

        mkt.lastTradeTick = t;
        mkt.lastTradePrice = price;
        mkt.lastTradeBlock = block.number;
        mkt.lastTradeTakerIsBuy = false;

        (seq, chain) = _emitSettled(
            marketId,
            seq,
            chain,
            msg.sender,
            false,
            uint32(lots),
            uint128(got),
            uint128(fee),
            uint128(netWetc)
        );
        mkt.historySeq = seq;
        mkt.historyHash = chain;

        WETC.safeTransfer(msg.sender, netWetc);
        if (fee != 0) {
            WETC.safeTransfer(feeTreasury, fee);
        }
    }

    function sellFOK(
        uint32 marketId,
        int256 limitTick,
        uint256 lots,
        uint256 minWetcOut,
        bytes32 expectedHash
    ) external {
        Market storage mkt = _activeMarket(marketId);
        require(mkt.historyHash == expectedHash, "stale hash");
        sellFOK(marketId, limitTick, lots, minWetcOut);
    }

    /* -------------------- Internals: Markets / Orders / Levels -------------------- */

    function _market(uint32 marketId) internal view returns (Market storage mkt) {
        mkt = markets[marketId];
        require(mkt.exists, "invalid market");
    }

    function _marketView(uint32 marketId) internal view returns (Market storage mkt) {
        mkt = markets[marketId];
        require(mkt.exists, "invalid market");
    }

    function _activeMarket(uint32 marketId) internal view returns (Market storage mkt) {
        mkt = markets[marketId];
        require(mkt.exists, "invalid market");
        require(mkt.active, "market inactive");
    }

    function _newOrder(
        uint32 marketId,
        bool isBuy,
        int32 tick,
        uint32 lots,
        uint128 value
    ) internal returns (uint64 id) {
        id = nextOrderId++;
        orders[id] = Order(msg.sender, marketId, tick, lots, isBuy, value, 0, 0);
    }

    function _enqueue(
        Market storage mkt,
        bool isBuy,
        int32 tick,
        uint96 price,
        uint32 lots,
        uint128 value,
        uint64 id
    ) internal {
        TickLevel storage lvl = isBuy ? mkt.buyLevels[tick] : mkt.sellLevels[tick];

        if (lvl.price == 0) {
            _insertTick(mkt, isBuy, tick, price);
        }

        if (lvl.tail == 0) {
            lvl.head = id;
            lvl.tail = id;
        } else {
            orders[lvl.tail].next = id;
            orders[id].prev = lvl.tail;
            lvl.tail = id;
        }

        unchecked {
            lvl.orderCount++;
        }
        lvl.totalValue += value;
        lvl.totalLots += lots;
    }

    function _insertTick(Market storage mkt, bool isBuy, int32 tick, uint96 price) internal {
        TickLevel storage lvl = isBuy ? mkt.buyLevels[tick] : mkt.sellLevels[tick];
        lvl.price = price;
        lvl.prev = NONE32;
        lvl.next = NONE32;

        if (isBuy) {
            if (mkt.bestBuyTick == NONE256) {
                mkt.bestBuyTick = int256(tick);
                return;
            }

            int256 cur = mkt.bestBuyTick;
            if (tick > cur) {
                lvl.next = int32(cur);
                mkt.buyLevels[cur].prev = tick;
                mkt.bestBuyTick = int256(tick);
                return;
            }

            while (true) {
                int32 nxt = mkt.buyLevels[cur].next;
                if (nxt == NONE32 || tick > nxt) {
                    lvl.prev = int32(cur);
                    lvl.next = nxt;
                    mkt.buyLevels[cur].next = tick;
                    if (nxt != NONE32) mkt.buyLevels[nxt].prev = tick;
                    return;
                }
                cur = nxt;
            }
        } else {
            if (mkt.bestSellTick == NONE256) {
                mkt.bestSellTick = int256(tick);
                return;
            }

            int256 cur = mkt.bestSellTick;
            if (tick < cur) {
                lvl.next = int32(cur);
                mkt.sellLevels[cur].prev = tick;
                mkt.bestSellTick = int256(tick);
                return;
            }

            while (true) {
                int32 nxt = mkt.sellLevels[cur].next;
                if (nxt == NONE32 || tick < nxt) {
                    lvl.prev = int32(cur);
                    lvl.next = nxt;
                    mkt.sellLevels[cur].next = tick;
                    if (nxt != NONE32) mkt.sellLevels[nxt].prev = tick;
                    return;
                }
                cur = nxt;
            }
        }
    }

    function _unlinkOrder(Market storage mkt, bool isBuy, int32 tick, uint64 id) internal {
        TickLevel storage lvl = isBuy ? mkt.buyLevels[tick] : mkt.sellLevels[tick];
        Order storage o = orders[id];

        if (o.prev == 0) lvl.head = o.next;
        else orders[o.prev].next = o.next;

        if (o.next == 0) lvl.tail = o.prev;
        else orders[o.next].prev = o.prev;

        unchecked {
            lvl.orderCount--;
        }
        lvl.totalLots -= o.lotsRemaining;
        lvl.totalValue -= o.valueRemaining;

        if (lvl.head == 0) _removeTick(mkt, isBuy, tick);
    }

    function _removeTick(Market storage mkt, bool isBuy, int32 tick) internal {
        TickLevel storage lvl = isBuy ? mkt.buyLevels[tick] : mkt.sellLevels[tick];
        int32 p = lvl.prev;
        int32 n = lvl.next;

        if (isBuy) {
            if (p == NONE32) mkt.bestBuyTick = int256(n);
            else mkt.buyLevels[p].next = n;
            if (n != NONE32) mkt.buyLevels[n].prev = p;
            delete mkt.buyLevels[tick];
        } else {
            if (p == NONE32) mkt.bestSellTick = int256(n);
            else mkt.sellLevels[p].next = n;
            if (n != NONE32) mkt.sellLevels[n].prev = p;
            delete mkt.sellLevels[tick];
        }
    }

    /* -------------------- Views -------------------- */

    function getBuyBook(uint32 marketId, uint256 maxLevels)
        external
        view
        returns (BookLevel[] memory out, uint256 n)
    {
        return getBook(marketId, true, maxLevels);
    }

    function getSellBook(uint32 marketId, uint256 maxLevels)
        external
        view
        returns (BookLevel[] memory out, uint256 n)
    {
        return getBook(marketId, false, maxLevels);
    }

    function getBuyOrders(uint32 marketId, uint256 maxOrders)
        external
        view
        returns (BookOrder[] memory out, uint256 n)
    {
        return getOrders(marketId, true, maxOrders);
    }

    function getSellOrders(uint32 marketId, uint256 maxOrders)
        external
        view
        returns (BookOrder[] memory out, uint256 n)
    {
        return getOrders(marketId, false, maxOrders);
    }

    function getBook(uint32 marketId, bool isBuy, uint256 maxLevels)
        internal
        view
        returns (BookLevel[] memory out, uint256 n)
    {
        Market storage mkt = _marketView(marketId);
        if (maxLevels == 0) return (new BookLevel[](0), 0);

        if (isBuy) {
            if (mkt.bestBuyTick == NONE256) return (new BookLevel[](0), 0);
        } else {
            if (mkt.bestSellTick == NONE256) return (new BookLevel[](0), 0);
        }

        out = new BookLevel[](maxLevels);
        n = 0;

        if (isBuy) {
            int256 t = mkt.bestBuyTick;
            while (t != NONE256 && n < maxLevels) {
                TickLevel storage lvl = mkt.buyLevels[t];
                if (lvl.totalLots > 0) {
                    out[n++] = BookLevel(t, lvl.price, lvl.totalLots, lvl.totalValue, lvl.orderCount);
                }
                t = lvl.next;
            }
        } else {
            int256 t = mkt.bestSellTick;
            while (t != NONE256 && n < maxLevels) {
                TickLevel storage lvl = mkt.sellLevels[t];
                if (lvl.totalLots > 0) {
                    out[n++] = BookLevel(t, lvl.price, lvl.totalLots, lvl.totalValue, lvl.orderCount);
                }
                t = lvl.next;
            }
        }
    }

    function getOrders(uint32 marketId, bool isBuy, uint256 maxOrders)
        internal
        view
        returns (BookOrder[] memory out, uint256 n)
    {
        Market storage mkt = _marketView(marketId);
        if (maxOrders == 0) return (new BookOrder[](0), 0);

        int256 t = isBuy ? mkt.bestBuyTick : mkt.bestSellTick;
        if (t == NONE256) return (new BookOrder[](0), 0);

        out = new BookOrder[](maxOrders);
        n = 0;

        while (t != NONE256 && n < maxOrders) {
            TickLevel storage lvl = isBuy ? mkt.buyLevels[t] : mkt.sellLevels[t];
            uint64 id = lvl.head;
            uint256 price = lvl.price;

            while (id != 0 && n < maxOrders) {
                Order storage o = orders[id];
                if (o.lotsRemaining > 0) {
                    out[n++] = BookOrder(
                        id,
                        o.owner,
                        t,
                        price,
                        o.lotsRemaining,
                        o.valueRemaining
                    );
                }
                id = o.next;
            }

            t = lvl.next;
        }
    }

    function getTopOfBook(uint32 marketId)
        external
        view
        returns (
            int256,
            uint256,
            uint256,
            int256,
            uint256,
            uint256
        )
    {
        Market storage mkt = _marketView(marketId);

        uint256 buyLots;
        uint256 buyOrders;
        uint256 sellLots;
        uint256 sellOrders;

        if (mkt.bestBuyTick != NONE256) {
            TickLevel storage b = mkt.buyLevels[mkt.bestBuyTick];
            buyLots = b.totalLots;
            buyOrders = b.orderCount;
        }

        if (mkt.bestSellTick != NONE256) {
            TickLevel storage s = mkt.sellLevels[mkt.bestSellTick];
            sellLots = s.totalLots;
            sellOrders = s.orderCount;
        }

        return (
            mkt.bestBuyTick,
            buyLots,
            buyOrders,
            mkt.bestSellTick,
            sellLots,
            sellOrders
        );
    }

    function getOracle(uint32 marketId)
        external
        view
        returns (int256, int256, int256, uint256, uint256)
    {
        Market storage mkt = _marketView(marketId);
        return (
            mkt.bestBuyTick,
            mkt.bestSellTick,
            mkt.lastTradeTick,
            mkt.lastTradeBlock,
            mkt.lastTradePrice
        );
    }

    function getEscrowTotals(uint32 marketId)
        external
        view
        returns (uint256 buyWETC, uint256 sellLots)
    {
        Market storage mkt = _marketView(marketId);
        return (mkt.bookEscrowWETC, mkt.bookEscrowLots);
    }
}
