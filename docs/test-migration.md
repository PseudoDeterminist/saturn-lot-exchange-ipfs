# Legacy test retirement coverage map

Baseline: `5a08aeb:test/saturnLotTrade.test.js`. This map was completed before deleting the legacy sources. It records preservation of the invariants tested there, not a claim of exhaustive exchange correctness.

| Legacy scenario | Current destination |
| --- | --- |
| reverts for out-of-range ticks and is monotonic at bounds | `test/exchangeMatching.test.js` — reverts for out-of-range ticks and is monotonic at bounds |
| rejects zero token addresses on deploy | `test/exchangeMatching.test.js` — rejects zero quote token on deploy and invalid lot tokens on approval |
| rejects zero or oversized lots | `test/exchangeMatching.test.js` — rejects zero or oversized lots |
| rejects out-of-range ticks for maker orders | `test/exchangeMatching.test.js` — rejects out-of-range ticks for maker orders |
| rejects zero lots for taker FOKs | `test/exchangeMatching.test.js` — rejects zero lots for taker FOKs |
| reverts taker when book side is empty | `test/exchangeMatching.test.js` — reverts taker when book side is empty |
| reverts taker when lots exceed book totals | `test/exchangeMatching.test.js` — reverts taker when lots exceed book totals |
| reverts sell FOK when min output exceeds escrow | `test/exchangeMatching.test.js` — reverts sell FOK when min output exceeds escrow |
| reverts sell FOK when limit tick blocks fill | `test/exchangeMatching.test.js` — reverts sell FOK when limit tick blocks fill |
| rejects buys that cross the sell book | `test/exchangeMatching.test.js` — rejects buys that cross the sell book |
| rejects sells that cross the buy book | `test/exchangeMatching.test.js` — rejects sells that cross the buy book |
| enforces expected hash on maker overloads | `test/exchangeMatching.test.js` — enforces expected hash on maker overloads |
| enforces expected hash on taker overloads | `test/exchangeMatching.test.js` — enforces expected hash on taker overloads |
| fills orders FIFO within a tick | `test/exchangeMatching.test.js` — fills orders FIFO within a tick |
| reverts FOK when limit tick blocks full fill (no state change) | `test/exchangeMatching.test.js` — reverts FOK when limit tick blocks full fill (no state change) |
| reverts buy FOK on slippage before state updates | `test/exchangeMatching.test.js` — reverts buy FOK on slippage before state updates |
| fills across ticks and updates oracle fields | `test/exchangeMatching.test.js` — fills across ticks and updates oracle fields |
| refunds unused quote in buy FOK | `test/exchangeMatching.test.js` — refunds unused quote in buy FOK |
| reverts sell FOK when min output is too high | `test/exchangeMatching.test.js` — reverts sell FOK when min output is too high |
| allows partial fills then cancel refunds remaining escrow | `test/exchangeMatching.test.js` — allows partial fills then cancel refunds remaining escrow |
| rejects cancel from non-owner | `test/exchangeMatching.test.js` — rejects cancel from non-owner |
| maintains book invariants under randomized actions (multi-seed) | `test/exchangeMatching.test.js` — maintains book invariants under randomized actions (multi-seed) |
| returns empty results for zero limits and empty book | `test/exchangeMatching.test.js` — returns empty results for zero limits and empty book |
| exposes book levels, FIFO orders, top-of-book, and oracle views | `test/exchangeMatching.test.js` — exposes book levels, FIFO orders, top-of-book, and oracle views |
| logs maker gas for placeBuy and placeSell | `test/exchangeMatching.test.js` — logs maker gas for placeBuy and placeSell |
| logs taker gas for takeBuyFOK single vs 200 orders (single tick + 200 ticks) | `test/exchangeMatching.test.js` — logs taker gas for buyFOK single vs 200 orders (single tick + 200 ticks) |
| logs taker gas for takeSellFOK single vs 200 orders (single tick + 200 ticks) | `test/exchangeMatching.test.js` — logs taker gas for sellFOK single vs 200 orders (single tick + 200 ticks) |
| TestERC20 transfers and allowances behave as expected | `test/tokens.test.js` — TestERC20 transfers and allowances behave as expected |
| TestERC20 mint guard reverts for zero address | `test/tokens.test.js` — TestERC20 mint guard reverts for zero address |
| ReentrantERC20 supports transfer hooks and bubbles failures | `test/tokens.test.js` — ReentrantERC20 supports transfer hooks and bubbles failures |
| ReentrantERC20 guards transfers and mint inputs | `test/tokens.test.js` — ReentrantERC20 guards transfers and mint inputs |

## Assertion-level review

- Every legacy scenario remains. The four token-test bodies are identical, moved into their own file.
- Matching calls now include market ID 1; `takeBuyFOK`/`takeSellFOK` map to `buyFOK`/`sellFOK`. Constructor lot-token validation moves to market approval.
- Global accounting/oracle assertions now read the corresponding fields from `getMarket(1)`. Expected-hash tests use the market-local hash.
- Level quantity, value, price, and order-count checks use public book views because level mappings are now private. An absent legacy level is checked as absence from the complete visible book; physical private storage clearing is not inferred. The 32-level bound exceeds the 21 possible randomized ticks and is asserted non-truncated.
- Random seeds, action count, tick bounds, actor set, remaining-order value arithmetic, both-side accounting totals, best ticks, and removed-level checks remain. Added exact visible level counts and actual quote/lot balance reconciliation.
- The underfunded-buy slippage test seeds an unrelated bid so the explicit slippage guard is reached rather than the token balance guard. Its original rollback assertion remains, with full market and exchange quote-balance rollback checks added.
- FIFO, cross-level fills, partial cancellation refunds, stale-hash rejection, empty views, order views, and oracle assertions retain the original expected outcomes.
- Gas scenarios preserve one order, 200 orders at one tick, and 200 distinct ticks, now measured against the exchange. These are measurements, not gas-regression budgets.

## Additional exchange coverage

`exchangeGuard.test.js` and `exchangeCallbacks.test.js` cover rejected nested mutations, caught/propagated callback failures, hash reconstruction, IDs, balances, fee/refund transfer boundaries, and cross-market protection. `saturnLotExchange.test.js` retains LAST/ABI/live history coverage. Governance and fee behavior are extended in `exchangePolicy.test.js`. UI history suites remain separate.

## Deletion gate

Run the current-contract matching and token suites before removing the old sources. After removal, clean Hardhat artifacts and rerun the entire suite; no executable source may reference the retired contract.
