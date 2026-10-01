// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/*
  Saturn Lot Exchange v0.8.2 (Atomic Quote Replacement)
  By PseudoDeterminist

  One WETC quote token, many DAO/owner-approved Lot Token markets.
  Each market has an independent sparse FIFO order book while sharing
  the same logarithmic ~0.5% tick lattice.
*/

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/* ===================== Multi-Market Lot CLOB ===================== */

contract SaturnLotExchange is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // Tick range: -464 .. +1855 (5 decades * 464 ticks/decade)
    // Prices span 0.1 .. 9950 WETC per Lot.
    int32 private constant MIN_TICK = -464;
    int32 private constant MAX_TICK = 1855;
    int32 private constant NONE32 = type(int32).min;
    int256 private constant NONE256 = int256(NONE32);

    // Bound batch calldata/work so maker convenience never creates an
    // unexpectedly huge single transaction. cancelMany has its own larger cap.
    uint256 public constant MAX_PLACE_BATCH = 32;
    uint256 public constant MAX_CANCEL_BATCH = 128;

    IERC20 public immutable WETC; // shared quote token for every market

    address public owner;
    bool public exchangeActive; // false at deployment; owner/DAO activates once accepted

    // Taker fees are charged only in WETC after a successful FOK.
    // Maker/order-book accounting remains gross and exact.
    uint16 public constant MAX_TAKER_FEE_BPS = 50; // governance can never exceed 0.50%
    uint16 public takerFeeBps;                     // 0 at deployment; owner/DAO may set later

    uint256 public constant MAX_MARKETS_PER_BATCH = 32;

    /* -------------------- Events -------------------- */

    event OwnershipTransferred(
        address indexed previousOwner,
        address indexed newOwner
    );

    event TakerFeeUpdated(
        uint16 previousFeeBps,
        uint16 newFeeBps
    );

    event ExchangeActivated();

    event MarketApproved(
        uint32 indexed marketId,
        address indexed lotToken
    );

    event MarketUnapproved(
        uint32 indexed marketId,
        address indexed lotToken
    );

    event OrderPlaced(
        uint32 indexed marketId,
        uint64 indexed orderId,
        address indexed owner,
        bool isBuy,
        int32 tick,
        uint32 lots
    );

    event OrderCanceled(
        uint32 indexed marketId,
        uint64 indexed orderId,
        address indexed owner,
        bool isBuy,
        int32 tick,
        uint32 lotsCanceled
    );

    // One Trade event per maker fill (FOK taker may generate multiple).
    // Price and value are exactly derivable from tick and lots.
    event Trade(
        uint32 indexed marketId,
        uint64 indexed orderId,
        address taker,
        address indexed maker,
        bool takerIsBuy,
        int32 tick,
        uint32 lotsFilled,
        uint32 lotsRemainingAfter
    );

    // One aggregate settlement event per successful FOK.
    event FOKSettled(
        uint32 indexed marketId,
        address indexed taker,
        bool takerIsBuy,
        uint32 lots,
        uint128 grossWETC,
        uint128 feeWETC
    );

    /* -------------------- Order book data -------------------- */

    struct Order {
        address owner;
        uint32 marketId;
        int32 tick;
        uint32 lotsRemaining;
        bool isBuy;
        uint64 prev;
        uint64 next;
    }

    struct TickLevel {
        int32 prev;
        int32 next;
        uint32 orderCount;
        uint64 head;
        uint64 tail;
        uint64 totalLots;
    }

    struct Market {
        address lotToken;
        bool active;

        // Market-local last trade / top of book.
        int256 lastTradeTick;
        uint256 lastTradeBlock;
        bool lastTradeTakerIsBuy;
        int256 bestBuyTick;
        int256 bestSellTick;

        // Directly queryable escrow totals.
        uint256 bookEscrowWETC;
        uint256 bookEscrowLots;

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


    constructor(address wetcToken, address daoOwner) {
        require(wetcToken != address(0), "zero WETC");
        require(daoOwner != address(0), "zero owner");

        WETC = IERC20(wetcToken);
        owner = daoOwner;

        emit OwnershipTransferred(address(0), daoOwner);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    /* -------------------- Governance / Markets -------------------- */

    function transferOwnership(address newOwner)
        external
        onlyOwner
    {
        require(newOwner != address(0), "zero owner");

        address oldOwner = owner;
        owner = newOwner;

        emit OwnershipTransferred(oldOwner, newOwner);
    }

    /// @notice Permanently enable trading after DAO acceptance.
    function activate()
        external
        onlyOwner
    {
        require(!exchangeActive, "already active");

        exchangeActive = true;

        emit ExchangeActivated();
    }

    function setTakerFeeBps(uint16 newFeeBps)
        external
        onlyOwner
    {
        require(newFeeBps <= MAX_TAKER_FEE_BPS, "fee too high");

        uint16 oldFeeBps = takerFeeBps;
        takerFeeBps = newFeeBps;

        emit TakerFeeUpdated(oldFeeBps, newFeeBps);
    }

    /// @notice Approve a Lot Token for trading. Re-approving a retired token
    ///         reactivates its original market and preserves its order book state.
    function approveMarket(address lotToken)
        external
        onlyOwner
        returns (uint32 marketId)
    {
        return _approveMarket(lotToken);
    }

    /// @notice Atomically approve up to MAX_MARKETS_PER_BATCH Lot Token markets.
    function approveMarkets(address[] calldata lotTokens)
        external
        onlyOwner
    {
        uint256 length = lotTokens.length;

        require(length != 0, "empty markets");
        require(length <= MAX_MARKETS_PER_BATCH, "too many markets");

        for (uint256 i; i < length; ++i) {
            _approveMarket(lotTokens[i]);
        }
    }

    /// @notice Stop new orders and taker trades. Existing makers can still cancel.
    function unapproveMarket(uint32 marketId)
        external
        onlyOwner
    {
        _unapproveMarket(marketId);
    }

    /// @notice Atomically unapprove up to MAX_MARKETS_PER_BATCH markets.
    function unapproveMarkets(uint32[] calldata marketIds)
        external
        onlyOwner
    {
        uint256 length = marketIds.length;

        require(length != 0, "empty markets");
        require(length <= MAX_MARKETS_PER_BATCH, "too many markets");

        for (uint256 i; i < length; ++i) {
            _unapproveMarket(marketIds[i]);
        }
    }

    function _approveMarket(address lotToken)
        internal
        returns (uint32 marketId)
    {
        require(lotToken != address(0), "zero lot token");
        require(lotToken != address(WETC), "lot token is WETC");

        marketId = marketIdOf[lotToken];

        if (marketId == 0) {
            marketId = ++marketCount;

            Market storage mkt = markets[marketId];

            mkt.lotToken = lotToken;
            mkt.active = true;
            mkt.bestBuyTick = NONE256;
            mkt.bestSellTick = NONE256;

            marketIdOf[lotToken] = marketId;
        } else {
            Market storage mkt = markets[marketId];

            require(mkt.lotToken != address(0), "invalid market");
            require(!mkt.active, "market already active");

            mkt.active = true;
        }

        emit MarketApproved(marketId, lotToken);
    }

    function _unapproveMarket(uint32 marketId)
        internal
    {
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
            int256 bestBuyTick,
            int256 bestSellTick,
            int256 lastTradeTick,
            uint256 lastTradeBlock,
            uint256 lastTradePrice,
            bool lastTradeTakerIsBuy,
            uint256 bookEscrowWETC,
            uint256 bookEscrowLots
        )
    {
        Market storage mkt = _market(marketId);

        uint256 lastPrice =
            mkt.lastTradeBlock == 0
                ? 0
                : priceAtTick(mkt.lastTradeTick);

        return (
            mkt.lotToken,
            mkt.active,
            mkt.bestBuyTick,
            mkt.bestSellTick,
            mkt.lastTradeTick,
            mkt.lastTradeBlock,
            lastPrice,
            mkt.lastTradeTakerIsBuy,
            mkt.bookEscrowWETC,
            mkt.bookEscrowLots
        );
    }

    /* -------------------- Price -------------------- */

    function priceAtTick(int256 tick)
        public
        pure
        returns (uint256 result)
    {
        require(
            tick >= MIN_TICK && tick <= MAX_TICK,
            "tick out of range"
        );

        uint256 t = uint256(tick - MIN_TICK);
        uint256 d = t / 464;
        uint256 r = t % 464;

        uint256 i = r * 2;

        uint256 m =
            (uint256(uint8(MANT[i])) << 8)
            | uint256(uint8(MANT[i + 1]));

        uint256 factor;

        if (d == 0) {
            factor = 1e14;       //    0.1 to      0.995 WETC per Lot
        } else if (d == 1) {
            factor = 1e15;       //      1 to      9.95  WETC per Lot
        } else if (d == 2) {
            factor = 1e16;       //     10 to     99.5   WETC per Lot
        } else if (d == 3) {
            factor = 1e17;       //    100 to    995     WETC per Lot
        } else {
            factor = 1e18;       //   1000 to   9950     WETC per Lot
        }

        result = factor * m;
    }

    function _toTick(int256 tick)
        internal
        pure
        returns (int32)
    {
        require(
            tick >= MIN_TICK && tick <= MAX_TICK,
            "tick out of range"
        );

        return int32(tick);
    }

    /* -------------------- Fee / token helpers -------------------- */

    function _takerFee(uint256 grossWETC)
        internal
        view
        returns (uint256)
    {
        return (
            grossWETC * uint256(takerFeeBps)
        ) / 10_000;
    }

    function _pullExact(
        IERC20 token,
        address from,
        uint256 amount
    )
        internal
    {
        uint256 beforeBalance =
            token.balanceOf(address(this));

        token.safeTransferFrom(
            from,
            address(this),
            amount
        );

        uint256 afterBalance =
            token.balanceOf(address(this));

        require(
            afterBalance == beforeBalance + amount,
            "non-exact transfer"
        );
    }

    /* -------------------- Maker Orders -------------------- */

    function placeBuy(
        uint32 marketId,
        int256 tick,
        uint256 lots
    )
        external
        nonReentrant
        returns (uint64 id)
    {
        Market storage mkt = _activeMarket(marketId);
        (int32 t, uint32 lots32, uint256 cost) =
            _validateBuyOrder(mkt, tick, lots);

        WETC.safeTransferFrom(
            msg.sender,
            address(this),
            cost
        );

        id = _placeBuyEscrowed(
            mkt,
            marketId,
            t,
            lots32
        );

        mkt.bookEscrowWETC += cost;
    }

    /// @notice Atomically place several buy orders in one market.
    ///         Array order determines FIFO priority for orders at the same tick.
    ///         WETC is pulled once for the aggregate cost.
    function placeBuyBatch(
        uint32 marketId,
        int256[] calldata ticks,
        uint256[] calldata lots
    )
        external
        nonReentrant
        returns (uint64[] memory ids)
    {
        uint256 n = ticks.length;
        require(n != 0 && n <= MAX_PLACE_BATCH, "invalid batch size");
        require(lots.length == n, "batch length mismatch");

        Market storage mkt = _activeMarket(marketId);
        int32[] memory validatedTicks = new int32[](n);
        uint32[] memory validatedLots = new uint32[](n);
        uint256 totalCost;

        // Validate every order and calculate the exact aggregate escrow before
        // making any external token call or mutating the book.
        for (uint256 i; i < n; ++i) {
            (int32 t, uint32 lots32, uint256 cost) =
                _validateBuyOrder(mkt, ticks[i], lots[i]);
            validatedTicks[i] = t;
            validatedLots[i] = lots32;
            totalCost += cost;
        }

        WETC.safeTransferFrom(
            msg.sender,
            address(this),
            totalCost
        );

        ids = new uint64[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = _placeBuyEscrowed(
                mkt,
                marketId,
                validatedTicks[i],
                validatedLots[i]
            );
        }

        mkt.bookEscrowWETC += totalCost;
    }



    /// @notice Atomically replace caller-owned buy orders in one market with a
    ///         new buy ladder. Old escrow is reused and only the net WETC
    ///         difference is transferred. Replacement orders receive new IDs
    ///         and normal tail-of-tick FIFO priority.
    function replaceBuyBatch(
        uint32 marketId,
        uint64[] calldata cancelIds,
        int256[] calldata ticks,
        uint256[] calldata lots
    )
        external
        nonReentrant
        returns (uint64[] memory ids)
    {
        uint256 cancelN = cancelIds.length;
        uint256 placeN = ticks.length;
        require(cancelN != 0 && cancelN <= MAX_CANCEL_BATCH, "invalid cancel batch size");
        require(placeN != 0 && placeN <= MAX_PLACE_BATCH, "invalid place batch size");
        require(lots.length == placeN, "batch length mismatch");

        Market storage mkt = _activeMarket(marketId);
        uint256 releasedWETC;

        // Validate the complete cancel set and calculate reusable escrow before
        // mutating state. The actual removal loop rechecks ownership/market/side,
        // so duplicate IDs also revert atomically.
        for (uint256 i; i < cancelN; ++i) {
            Order storage o = orders[cancelIds[i]];
            require(o.owner == msg.sender, "not order owner");
            require(o.marketId == marketId, "wrong market");
            require(o.isBuy, "wrong order side");
            releasedWETC += uint256(o.lotsRemaining) * priceAtTick(o.tick);
        }

        int32[] memory validatedTicks = new int32[](placeN);
        uint32[] memory validatedLots = new uint32[](placeN);
        uint256 newWETC;

        for (uint256 i; i < placeN; ++i) {
            (int32 t, uint32 lots32, uint256 cost) =
                _validateBuyOrder(mkt, ticks[i], lots[i]);
            validatedTicks[i] = t;
            validatedLots[i] = lots32;
            newWETC += cost;
        }

        // If the new ladder needs more quote escrow, pull only the difference.
        if (newWETC > releasedWETC) {
            WETC.safeTransferFrom(
                msg.sender,
                address(this),
                newWETC - releasedWETC
            );
        }

        for (uint256 i; i < cancelN; ++i) {
            _removeOwnedOrderNoTransfer(cancelIds[i], marketId, true);
        }

        ids = new uint64[](placeN);
        for (uint256 i; i < placeN; ++i) {
            ids[i] = _placeBuyEscrowed(
                mkt,
                marketId,
                validatedTicks[i],
                validatedLots[i]
            );
        }

        mkt.bookEscrowWETC =
            mkt.bookEscrowWETC - releasedWETC + newWETC;

        // If the new ladder needs less quote escrow, refund only the difference.
        if (releasedWETC > newWETC) {
            WETC.safeTransfer(
                msg.sender,
                releasedWETC - newWETC
            );
        }
    }

    function _validateBuyOrder(
        Market storage mkt,
        int256 tick,
        uint256 lots
    )
        internal
        view
        returns (
            int32 t,
            uint32 lots32,
            uint256 cost
        )
    {
        require(
            lots > 0 && lots <= type(uint32).max,
            "invalid lots"
        );

        t = _toTick(tick);

        require(
            mkt.bestSellTick == NONE256
                || mkt.bestSellTick > int256(t),
            "crossing sell book -- consider buyFOK"
        );

        lots32 = uint32(lots);
        cost = uint256(lots32) * priceAtTick(tick);
    }

    function _placeBuyEscrowed(
        Market storage mkt,
        uint32 marketId,
        int32 tick,
        uint32 lots
    )
        internal
        returns (uint64 id)
    {
        id = _newOrder(
            marketId,
            true,
            tick,
            lots
        );

        _enqueue(
            mkt,
            true,
            tick,
            lots,
            id
        );

        emit OrderPlaced(
            marketId,
            id,
            msg.sender,
            true,
            tick,
            lots
        );
    }

    function placeSell(
        uint32 marketId,
        int256 tick,
        uint256 lots
    )
        external
        nonReentrant
        returns (uint64 id)
    {
        Market storage mkt = _activeMarket(marketId);
        (int32 t, uint32 lots32) =
            _validateSellOrder(mkt, tick, lots);

        _pullExact(
            IERC20(mkt.lotToken),
            msg.sender,
            uint256(lots32)
        );

        id = _placeSellEscrowed(
            mkt,
            marketId,
            t,
            lots32
        );

        mkt.bookEscrowLots += lots32;
    }

    /// @notice Atomically place several sell orders in one market.
    ///         Array order determines FIFO priority for orders at the same tick.
    ///         Lot Tokens are pulled once for the aggregate lot count.
    function placeSellBatch(
        uint32 marketId,
        int256[] calldata ticks,
        uint256[] calldata lots
    )
        external
        nonReentrant
        returns (uint64[] memory ids)
    {
        uint256 n = ticks.length;
        require(n != 0 && n <= MAX_PLACE_BATCH, "invalid batch size");
        require(lots.length == n, "batch length mismatch");

        Market storage mkt = _activeMarket(marketId);
        int32[] memory validatedTicks = new int32[](n);
        uint32[] memory validatedLots = new uint32[](n);
        uint256 totalLots;

        for (uint256 i; i < n; ++i) {
            (int32 t, uint32 lots32) =
                _validateSellOrder(mkt, ticks[i], lots[i]);
            validatedTicks[i] = t;
            validatedLots[i] = lots32;
            totalLots += lots32;
        }

        _pullExact(
            IERC20(mkt.lotToken),
            msg.sender,
            totalLots
        );

        ids = new uint64[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = _placeSellEscrowed(
                mkt,
                marketId,
                validatedTicks[i],
                validatedLots[i]
            );
        }

        mkt.bookEscrowLots += totalLots;
    }



    /// @notice Atomically replace caller-owned sell orders in one market with a
    ///         new sell ladder. Old Lot Token escrow is reused and only the net
    ///         token difference is transferred. Replacement orders receive new
    ///         IDs and normal tail-of-tick FIFO priority.
    function replaceSellBatch(
        uint32 marketId,
        uint64[] calldata cancelIds,
        int256[] calldata ticks,
        uint256[] calldata lots
    )
        external
        nonReentrant
        returns (uint64[] memory ids)
    {
        uint256 cancelN = cancelIds.length;
        uint256 placeN = ticks.length;
        require(cancelN != 0 && cancelN <= MAX_CANCEL_BATCH, "invalid cancel batch size");
        require(placeN != 0 && placeN <= MAX_PLACE_BATCH, "invalid place batch size");
        require(lots.length == placeN, "batch length mismatch");

        Market storage mkt = _activeMarket(marketId);
        uint256 releasedLots;

        for (uint256 i; i < cancelN; ++i) {
            Order storage o = orders[cancelIds[i]];
            require(o.owner == msg.sender, "not order owner");
            require(o.marketId == marketId, "wrong market");
            require(!o.isBuy, "wrong order side");
            releasedLots += o.lotsRemaining;
        }

        int32[] memory validatedTicks = new int32[](placeN);
        uint32[] memory validatedLots = new uint32[](placeN);
        uint256 newLots;

        for (uint256 i; i < placeN; ++i) {
            (int32 t, uint32 lots32) =
                _validateSellOrder(mkt, ticks[i], lots[i]);
            validatedTicks[i] = t;
            validatedLots[i] = lots32;
            newLots += lots32;
        }

        IERC20 lotToken = IERC20(mkt.lotToken);

        // If the new ladder is larger, pull only the additional Lot Tokens.
        if (newLots > releasedLots) {
            _pullExact(
                lotToken,
                msg.sender,
                newLots - releasedLots
            );
        }

        for (uint256 i; i < cancelN; ++i) {
            _removeOwnedOrderNoTransfer(cancelIds[i], marketId, false);
        }

        ids = new uint64[](placeN);
        for (uint256 i; i < placeN; ++i) {
            ids[i] = _placeSellEscrowed(
                mkt,
                marketId,
                validatedTicks[i],
                validatedLots[i]
            );
        }

        mkt.bookEscrowLots =
            mkt.bookEscrowLots - releasedLots + newLots;

        // If the new ladder is smaller, refund only the excess Lot Tokens.
        if (releasedLots > newLots) {
            lotToken.safeTransfer(
                msg.sender,
                releasedLots - newLots
            );
        }
    }

    function _validateSellOrder(
        Market storage mkt,
        int256 tick,
        uint256 lots
    )
        internal
        view
        returns (
            int32 t,
            uint32 lots32
        )
    {
        require(
            lots > 0 && lots <= type(uint32).max,
            "invalid lots"
        );

        t = _toTick(tick);

        require(
            mkt.bestBuyTick == NONE256
                || mkt.bestBuyTick < int256(t),
            "crossing buy book -- consider sellFOK"
        );

        lots32 = uint32(lots);
    }

    function _placeSellEscrowed(
        Market storage mkt,
        uint32 marketId,
        int32 tick,
        uint32 lots
    )
        internal
        returns (uint64 id)
    {
        id = _newOrder(
            marketId,
            false,
            tick,
            lots
        );

        _enqueue(
            mkt,
            false,
            tick,
            lots,
            id
        );

        emit OrderPlaced(
            marketId,
            id,
            msg.sender,
            false,
            tick,
            lots
        );
    }



    /// @dev Remove an owned order from the book and emit OrderCanceled, but do
    ///      not update market escrow totals or transfer tokens. Used only by
    ///      atomic replacement, which settles the aggregate escrow difference.
    function _removeOwnedOrderNoTransfer(
        uint64 id,
        uint32 expectedMarketId,
        bool expectedIsBuy
    )
        internal
    {
        Order storage o = orders[id];
        require(o.owner == msg.sender, "not order owner");
        require(o.marketId == expectedMarketId, "wrong market");
        require(o.isBuy == expectedIsBuy, "wrong order side");

        Market storage mkt = _market(expectedMarketId);
        uint32 lotsRemaining = o.lotsRemaining;
        int32 tick = o.tick;

        _unlinkOrder(
            mkt,
            expectedIsBuy,
            tick,
            id
        );

        emit OrderCanceled(
            expectedMarketId,
            id,
            msg.sender,
            expectedIsBuy,
            tick,
            lotsRemaining
        );

        delete orders[id];
    }

    function cancel(uint64 id)
        external
        nonReentrant
    {
        _cancel(id);
    }

    /// @notice Atomically cancel several orders owned by the caller.
    ///         The frontend can implement "Cancel All My Orders" by supplying
    ///         the caller's currently visible order IDs. No owner index is stored.
    function cancelMany(uint64[] calldata ids)
        external
        nonReentrant
    {
        uint256 n = ids.length;
        require(n != 0 && n <= MAX_CANCEL_BATCH, "invalid batch size");

        for (uint256 i; i < n; ++i) {
            _cancel(ids[i]);
        }
    }

    function _cancel(uint64 id)
        internal
    {
        Order storage o = orders[id];

        require(
            o.owner == msg.sender,
            "not order owner"
        );

        uint32 marketId = o.marketId;
        Market storage mkt = _market(marketId);

        uint32 lotsRemaining = o.lotsRemaining;
        bool isBuy = o.isBuy;
        int32 tick = o.tick;
        uint256 valueRemaining =
            uint256(lotsRemaining) * priceAtTick(tick);

        _unlinkOrder(
            mkt,
            isBuy,
            tick,
            id
        );

        emit OrderCanceled(
            marketId,
            id,
            msg.sender,
            isBuy,
            tick,
            lotsRemaining
        );

        delete orders[id];

        if (isBuy) {
            mkt.bookEscrowWETC -= valueRemaining;

            WETC.safeTransfer(
                msg.sender,
                valueRemaining
            );
        } else {
            mkt.bookEscrowLots -= lotsRemaining;

            IERC20(mkt.lotToken).safeTransfer(
                msg.sender,
                uint256(lotsRemaining)
            );
        }
    }


    /* -------------------- Taker FOK -------------------- */

    function buyFOK(
        uint32 marketId,
        int256 limitTick,
        uint256 lots,
        uint256 maxWetcIn
    )
        external
        nonReentrant
    {
        _buyFOK(
            marketId,
            limitTick,
            lots,
            maxWetcIn
        );
    }

    function _buyFOK(
        uint32 marketId,
        int256 limitTick,
        uint256 lots,
        uint256 maxWetcIn
    )
        internal
    {
        Market storage mkt =
            _activeMarket(marketId);

        require(
            lots > 0 && lots <= type(uint32).max,
            "invalid lots"
        );

        require(
            mkt.bestSellTick != NONE256,
            "There are no sell orders on book"
        );

        require(
            lots <= mkt.bookEscrowLots,
            "insufficient escrowed Lots on book"
        );

        // maxWetcIn is the taker's absolute all-in debit cap, including fee.
        WETC.safeTransferFrom(
            msg.sender,
            address(this),
            maxWetcIn
        );

        uint256 remain = lots;
        uint256 spent = 0; // exact gross maker consideration
        uint256 bookEscrowLots = mkt.bookEscrowLots;
        int256 t = mkt.bestSellTick;

        while (remain > 0) {
            require(
                t <= limitTick,
                "FOK--Limit tick crossed"
            );

            TickLevel storage lvl =
                mkt.sellLevels[t];

            uint256 price = priceAtTick(t);
            uint64 head = lvl.head;

            while (remain > 0) {
                uint64 oid = head;

                if (oid == 0) {
                    break;
                }

                Order storage makerOrder =
                    orders[oid];

                address maker =
                    makerOrder.owner;

                uint32 makerLots =
                    makerOrder.lotsRemaining;

                uint32 fill =
                    remain < makerLots
                        ? uint32(remain)
                        : makerLots;

                makerLots -= fill;

                uint256 pay =
                    uint256(fill) * price;

                spent += pay;

                if (makerLots == 0) {
                    head = makerOrder.next;

                    unchecked {
                        lvl.orderCount--;
                    }

                    delete orders[oid];

                    if (head == 0) {
                        lvl.tail = 0;
                    }
                } else {
                    makerOrder.lotsRemaining =
                        makerLots;
                }

                lvl.totalLots -= fill;
                bookEscrowLots -= fill;
                remain -= fill;

                // Maker receives the exact gross book value.
                WETC.safeTransfer(
                    maker,
                    pay
                );

                emit Trade(
                    marketId,
                    oid,
                    msg.sender,
                    maker,
                    true,
                    int32(t),
                    fill,
                    makerLots
                );
            }

            if (head == 0) {
                int32 nxt = lvl.next;

                _removeTick(
                    mkt,
                    false,
                    int32(t)
                );

                if (remain == 0) {
                    break;
                }

                if (nxt == NONE32) {
                    break;
                }

                t = int256(nxt);
            } else if (head != lvl.head) {
                lvl.head = head;
                orders[head].prev = 0;
            }
        }

        require(
            remain == 0,
            "FOK--Unfilled"
        );

        uint256 fee = _takerFee(spent);
        uint256 totalCost = spent + fee;

        require(
            totalCost <= maxWetcIn,
            "FOK--Slippage exceeded"
        );

        mkt.bookEscrowLots = bookEscrowLots;
        mkt.lastTradeBlock = block.number;
        mkt.lastTradeTick = t;
        mkt.lastTradeTakerIsBuy = true;

        emit FOKSettled(
            marketId,
            msg.sender,
            true,
            uint32(lots),
            uint128(spent),
            uint128(fee)
        );

        // Taker receives exact integer Lots.
        IERC20(mkt.lotToken).safeTransfer(
            msg.sender,
            lots
        );

        if (fee != 0) {
            WETC.safeTransfer(
                owner,
                fee
            );
        }

        if (totalCost < maxWetcIn) {
            WETC.safeTransfer(
                msg.sender,
                maxWetcIn - totalCost
            );
        }
    }

    function sellFOK(
        uint32 marketId,
        int256 limitTick,
        uint256 lots,
        uint256 minWetcOut
    )
        external
        nonReentrant
    {
        _sellFOK(
            marketId,
            limitTick,
            lots,
            minWetcOut
        );
    }

    function _sellFOK(
        uint32 marketId,
        int256 limitTick,
        uint256 lots,
        uint256 minWetcOut
    )
        internal
    {
        Market storage mkt =
            _activeMarket(marketId);

        require(
            lots > 0 && lots <= type(uint32).max,
            "invalid lots"
        );

        require(
            mkt.bestBuyTick != NONE256,
            "There are no buy orders on book"
        );

        require(
            minWetcOut <= mkt.bookEscrowWETC,
            "FOK--Insufficient escrowed WETC on book"
        );

        _pullExact(
            IERC20(mkt.lotToken),
            msg.sender,
            lots
        );

        uint256 remain = lots;
        uint256 got = 0; // exact gross WETC released from maker bids
        uint256 bookEscrowWetc = mkt.bookEscrowWETC;
        int256 t = mkt.bestBuyTick;

        while (remain > 0) {
            require(
                t >= limitTick,
                "FOK--Limit tick crossed"
            );

            TickLevel storage lvl =
                mkt.buyLevels[t];

            uint256 price = priceAtTick(t);
            uint64 head = lvl.head;

            while (remain > 0) {
                uint64 oid = head;

                if (oid == 0) {
                    break;
                }

                Order storage makerOrder =
                    orders[oid];

                address maker =
                    makerOrder.owner;

                uint32 makerLots =
                    makerOrder.lotsRemaining;

                uint32 fill =
                    remain < makerLots
                        ? uint32(remain)
                        : makerLots;

                makerLots -= fill;

                uint256 receiveAmt =
                    uint256(fill) * price;

                got += receiveAmt;

                if (makerLots == 0) {
                    head = makerOrder.next;

                    unchecked {
                        lvl.orderCount--;
                    }

                    delete orders[oid];

                    if (head == 0) {
                        lvl.tail = 0;
                    }
                } else {
                    makerOrder.lotsRemaining =
                        makerLots;
                }

                lvl.totalLots -= fill;
                bookEscrowWetc -= receiveAmt;
                remain -= fill;

                // Maker receives exact integer Lots.
                IERC20(mkt.lotToken).safeTransfer(
                    maker,
                    uint256(fill)
                );

                emit Trade(
                    marketId,
                    oid,
                    msg.sender,
                    maker,
                    false,
                    int32(t),
                    fill,
                    makerLots
                );
            }

            if (head == 0) {
                int32 nxt = lvl.next;

                _removeTick(
                    mkt,
                    true,
                    int32(t)
                );

                if (remain == 0) {
                    break;
                }

                if (nxt == NONE32) {
                    break;
                }

                t = int256(nxt);
            } else if (head != lvl.head) {
                lvl.head = head;
                orders[head].prev = 0;
            }
        }

        require(
            remain == 0,
            "FOK--Unfilled"
        );

        uint256 fee = _takerFee(got);
        uint256 netWetc = got - fee;

        require(
            netWetc >= minWetcOut,
            "FOK--Slippage exceeded"
        );

        mkt.bookEscrowWETC = bookEscrowWetc;
        mkt.lastTradeTick = t;
        mkt.lastTradeBlock = block.number;
        mkt.lastTradeTakerIsBuy = false;

        emit FOKSettled(
            marketId,
            msg.sender,
            false,
            uint32(lots),
            uint128(got),
            uint128(fee)
        );

        WETC.safeTransfer(
            msg.sender,
            netWetc
        );

        if (fee != 0) {
            WETC.safeTransfer(
                owner,
                fee
            );
        }
    }

    /* -------------------- Internals: Markets / Orders / Levels -------------------- */

    function _market(uint32 marketId)
        internal
        view
        returns (Market storage mkt)
    {
        mkt = markets[marketId];

        require(
            mkt.lotToken != address(0),
            "invalid market"
        );
    }

    function _activeMarket(uint32 marketId)
        internal
        view
        returns (Market storage mkt)
    {
        require(
            exchangeActive,
            "exchange inactive"
        );

        mkt = _market(marketId);

        require(
            mkt.active,
            "market inactive"
        );
    }

    function _newOrder(
        uint32 marketId,
        bool isBuy,
        int32 tick,
        uint32 lots
    )
        internal
        returns (uint64 id)
    {
        id = nextOrderId++;

        orders[id] = Order(
            msg.sender,
            marketId,
            tick,
            lots,
            isBuy,
            0,
            0
        );
    }

    function _enqueue(
        Market storage mkt,
        bool isBuy,
        int32 tick,
        uint32 lots,
        uint64 id
    )
        internal
    {
        TickLevel storage lvl =
            isBuy
                ? mkt.buyLevels[tick]
                : mkt.sellLevels[tick];

        if (lvl.orderCount == 0) {
            _insertTick(
                mkt,
                isBuy,
                tick
            );
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

        lvl.totalLots += lots;
    }

    function _insertTick(
        Market storage mkt,
        bool isBuy,
        int32 tick
    )
        internal
    {
        TickLevel storage lvl =
            isBuy
                ? mkt.buyLevels[tick]
                : mkt.sellLevels[tick];

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

                if (
                    nxt == NONE32
                    || tick > nxt
                ) {
                    lvl.prev = int32(cur);
                    lvl.next = nxt;
                    mkt.buyLevels[cur].next = tick;

                    if (nxt != NONE32) {
                        mkt.buyLevels[nxt].prev = tick;
                    }

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

                if (
                    nxt == NONE32
                    || tick < nxt
                ) {
                    lvl.prev = int32(cur);
                    lvl.next = nxt;
                    mkt.sellLevels[cur].next = tick;

                    if (nxt != NONE32) {
                        mkt.sellLevels[nxt].prev = tick;
                    }

                    return;
                }

                cur = nxt;
            }
        }
    }

    function _unlinkOrder(
        Market storage mkt,
        bool isBuy,
        int32 tick,
        uint64 id
    )
        internal
    {
        TickLevel storage lvl =
            isBuy
                ? mkt.buyLevels[tick]
                : mkt.sellLevels[tick];

        Order storage o =
            orders[id];

        if (o.prev == 0) {
            lvl.head = o.next;
        } else {
            orders[o.prev].next =
                o.next;
        }

        if (o.next == 0) {
            lvl.tail = o.prev;
        } else {
            orders[o.next].prev =
                o.prev;
        }

        unchecked {
            lvl.orderCount--;
        }

        lvl.totalLots -=
            o.lotsRemaining;

        if (lvl.head == 0) {
            _removeTick(
                mkt,
                isBuy,
                tick
            );
        }
    }

    function _removeTick(
        Market storage mkt,
        bool isBuy,
        int32 tick
    )
        internal
    {
        TickLevel storage lvl =
            isBuy
                ? mkt.buyLevels[tick]
                : mkt.sellLevels[tick];

        int32 p = lvl.prev;
        int32 n = lvl.next;

        if (isBuy) {
            if (p == NONE32) {
                mkt.bestBuyTick =
                    int256(n);
            } else {
                mkt.buyLevels[p].next =
                    n;
            }

            if (n != NONE32) {
                mkt.buyLevels[n].prev =
                    p;
            }

            delete mkt.buyLevels[tick];
        } else {
            if (p == NONE32) {
                mkt.bestSellTick =
                    int256(n);
            } else {
                mkt.sellLevels[p].next =
                    n;
            }

            if (n != NONE32) {
                mkt.sellLevels[n].prev =
                    p;
            }

            delete mkt.sellLevels[tick];
        }
    }

    /* -------------------- Views -------------------- */

    function getBuyBook(
        uint32 marketId,
        uint256 maxLevels
    )
        external
        view
        returns (
            BookLevel[] memory out,
            uint256 n
        )
    {
        return getBook(
            marketId,
            true,
            maxLevels
        );
    }

    function getSellBook(
        uint32 marketId,
        uint256 maxLevels
    )
        external
        view
        returns (
            BookLevel[] memory out,
            uint256 n
        )
    {
        return getBook(
            marketId,
            false,
            maxLevels
        );
    }

    function getBuyOrders(
        uint32 marketId,
        uint256 maxOrders
    )
        external
        view
        returns (
            BookOrder[] memory out,
            uint256 n
        )
    {
        return getOrders(
            marketId,
            true,
            maxOrders
        );
    }

    function getSellOrders(
        uint32 marketId,
        uint256 maxOrders
    )
        external
        view
        returns (
            BookOrder[] memory out,
            uint256 n
        )
    {
        return getOrders(
            marketId,
            false,
            maxOrders
        );
    }

    function getBook(
        uint32 marketId,
        bool isBuy,
        uint256 maxLevels
    )
        internal
        view
        returns (
            BookLevel[] memory out,
            uint256 n
        )
    {
        Market storage mkt =
            _market(marketId);

        if (maxLevels == 0) {
            return (
                new BookLevel[](0),
                0
            );
        }

        if (isBuy) {
            if (
                mkt.bestBuyTick
                    == NONE256
            ) {
                return (
                    new BookLevel[](0),
                    0
                );
            }
        } else {
            if (
                mkt.bestSellTick
                    == NONE256
            ) {
                return (
                    new BookLevel[](0),
                    0
                );
            }
        }

        out =
            new BookLevel[](maxLevels);

        n = 0;

        if (isBuy) {
            int256 t =
                mkt.bestBuyTick;

            while (
                t != NONE256
                && n < maxLevels
            ) {
                TickLevel storage lvl =
                    mkt.buyLevels[t];

                if (lvl.totalLots > 0) {
                    uint256 price = priceAtTick(t);

                    out[n++] = BookLevel(
                        t,
                        price,
                        lvl.totalLots,
                        uint256(lvl.totalLots) * price,
                        lvl.orderCount
                    );
                }

                t = lvl.next;
            }
        } else {
            int256 t =
                mkt.bestSellTick;

            while (
                t != NONE256
                && n < maxLevels
            ) {
                TickLevel storage lvl =
                    mkt.sellLevels[t];

                if (lvl.totalLots > 0) {
                    uint256 price = priceAtTick(t);

                    out[n++] = BookLevel(
                        t,
                        price,
                        lvl.totalLots,
                        uint256(lvl.totalLots) * price,
                        lvl.orderCount
                    );
                }

                t = lvl.next;
            }
        }
    }

    function getOrders(
        uint32 marketId,
        bool isBuy,
        uint256 maxOrders
    )
        internal
        view
        returns (
            BookOrder[] memory out,
            uint256 n
        )
    {
        Market storage mkt =
            _market(marketId);

        if (maxOrders == 0) {
            return (
                new BookOrder[](0),
                0
            );
        }

        int256 t =
            isBuy
                ? mkt.bestBuyTick
                : mkt.bestSellTick;

        if (t == NONE256) {
            return (
                new BookOrder[](0),
                0
            );
        }

        out =
            new BookOrder[](maxOrders);

        n = 0;

        while (
            t != NONE256
            && n < maxOrders
        ) {
            TickLevel storage lvl =
                isBuy
                    ? mkt.buyLevels[t]
                    : mkt.sellLevels[t];

            uint64 id =
                lvl.head;

            uint256 price =
                priceAtTick(t);

            while (
                id != 0
                && n < maxOrders
            ) {
                Order storage o =
                    orders[id];

                if (
                    o.lotsRemaining > 0
                ) {
                    out[n++] =
                        BookOrder(
                            id,
                            o.owner,
                            t,
                            price,
                            o.lotsRemaining,
                            uint256(o.lotsRemaining) * price
                        );
                }

                id = o.next;
            }

            t = lvl.next;
        }
    }

    function getTopOfBook(
        uint32 marketId
    )
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
        Market storage mkt =
            _market(marketId);

        uint256 buyLots;
        uint256 buyOrders;
        uint256 sellLots;
        uint256 sellOrders;

        if (
            mkt.bestBuyTick
                != NONE256
        ) {
            TickLevel storage b =
                mkt.buyLevels[
                    mkt.bestBuyTick
                ];

            buyLots =
                b.totalLots;

            buyOrders =
                b.orderCount;
        }

        if (
            mkt.bestSellTick
                != NONE256
        ) {
            TickLevel storage s =
                mkt.sellLevels[
                    mkt.bestSellTick
                ];

            sellLots =
                s.totalLots;

            sellOrders =
                s.orderCount;
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

    // Exchange state helper; not intended as a manipulation-resistant price oracle.
    function getOracle(
        uint32 marketId
    )
        external
        view
        returns (
            int256,
            int256,
            int256,
            uint256,
            uint256
        )
    {
        Market storage mkt =
            _market(marketId);

        uint256 lastPrice =
            mkt.lastTradeBlock == 0
                ? 0
                : priceAtTick(mkt.lastTradeTick);

        return (
            mkt.bestBuyTick,
            mkt.bestSellTick,
            mkt.lastTradeTick,
            mkt.lastTradeBlock,
            lastPrice
        );
    }

    function getEscrowTotals(
        uint32 marketId
    )
        external
        view
        returns (
            uint256 buyWETC,
            uint256 sellLots
        )
    {
        Market storage mkt =
            _market(marketId);

        return (
            mkt.bookEscrowWETC,
            mkt.bookEscrowLots
        );
    }
}