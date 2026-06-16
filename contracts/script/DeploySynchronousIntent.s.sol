// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/SynchronousIntent.sol";

// Forge's local dry-run uses revm, which has no knowledge of Bittensor's native
// staking precompile at 0x805 (it is implemented at the runtime/pallet level, not
// as deployed bytecode). Without a stub, the constructor's real precompile check
// fails during the local simulation that forge always runs before broadcasting,
// even though the real chain handles it correctly.
contract LocalPrecompileStub {
    function getTotalAlphaStaked(bytes32, uint256) external pure returns (uint256) {
        return 0;
    }
}

contract DeploySynchronousIntent is Script {
    function run() external {
        if (ISTAKING_ADDRESS.code.length == 0) {
            vm.etch(ISTAKING_ADDRESS, address(new LocalPrecompileStub()).code);
        }

        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);

        SynchronousIntent intentContract = new SynchronousIntent();

        vm.stopBroadcast();

        console.log("SynchronousIntent deployed to:", address(intentContract));
        console.log("Chain ID:", block.chainid);
        console.log("Domain separator:");
        console.logBytes32(intentContract.domainSeparator());
    }
}
