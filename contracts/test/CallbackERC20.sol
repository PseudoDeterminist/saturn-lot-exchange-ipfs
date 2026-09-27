// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// Test token with a one-shot hook aimed at a specific transfer boundary.
contract CallbackERC20 is ERC20 {
    address public target;
    bytes public data;
    address public fromFilter;
    address public toFilter;
    bool public inputHook;
    bool public catchFailure;
    bool public armed;
    bool public callbackSucceeded;
    bytes public callbackResult;

    constructor() ERC20("Callback", "CB") { _mint(msg.sender, 10**30); }
    function arm(address target_, bytes calldata data_, address from_, address to_, bool input_, bool catch_) external {
        target = target_; data = data_; fromFilter = from_; toFilter = to_;
        inputHook = input_; catchFailure = catch_; armed = true;
        callbackSucceeded = false; delete callbackResult;
    }
    function execute(address to, bytes calldata callData) external {
        (bool ok, bytes memory result) = to.call(callData);
        if (!ok) assembly { revert(add(result, 32), mload(result)) }
    }
    function hook(address from, address to, bool input) private {
        if (!armed || input != inputHook || from != fromFilter || to != toFilter) return;
        armed = false;
        (callbackSucceeded, callbackResult) = target.call(data);
        if (!callbackSucceeded && !catchFailure) {
            bytes memory result = callbackResult;
            assembly { revert(add(result, 32), mload(result)) }
        }
    }
    function transfer(address to, uint256 value) public override returns (bool) {
        bool ok = super.transfer(to, value); hook(msg.sender, to, false); return ok;
    }
    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        bool ok = super.transferFrom(from, to, value); hook(from, to, true); return ok;
    }
}
