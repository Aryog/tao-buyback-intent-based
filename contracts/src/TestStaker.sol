// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IStaking {
    function addStake(bytes32 hotkey, uint256 amount, uint256 netuid) external payable;
}

contract TestStaker {
    constructor() payable {}

    function stake(address target, bytes32 hotkey, uint256 amount, uint256 netuid, uint256 val) external {
        IStaking(target).addStake{value: val}(hotkey, amount, netuid);
    }

    receive() external payable {}
}
