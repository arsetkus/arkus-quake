// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice TESTNET ONLY. Free-mint stablecoin stand-in (18 decimals like BEP-20 USDT).
contract MockUSDT is ERC20 {
    constructor() ERC20("Mock USDT", "mUSDT") {}

    /// @dev anyone can mint up to 10,000 per call, for demo wallets.
    function faucet(uint256 amount) external {
        require(amount <= 10_000 ether, "max 10,000 per call");
        _mint(msg.sender, amount);
    }
}
