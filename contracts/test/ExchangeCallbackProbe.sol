// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Test-only actor: executes exactly one nested exchange call from a token hook.
contract ExchangeCallbackProbe {
    address public target;
    bytes public callData;
    bool public armed;

    function execute(address to, bytes calldata data) external {
        (bool ok, bytes memory result) = to.call(data);
        if (!ok) assembly { revert(add(result, 32), mload(result)) }
    }

    function arm(address to, bytes calldata data) external {
        target = to;
        callData = data;
        armed = true;
    }

    function callback() external {
        if (!armed) return;
        armed = false;
        (bool ok, bytes memory result) = target.call(callData);
        if (!ok) assembly { revert(add(result, 32), mload(result)) }
    }
}
