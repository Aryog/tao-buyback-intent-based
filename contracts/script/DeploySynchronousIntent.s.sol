// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/SynchronousIntent.sol";

contract DeploySynchronousIntent is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        
        vm.startBroadcast(deployerPrivateKey);
        
        SynchronousIntent intentContract = new SynchronousIntent();
        
        vm.stopBroadcast();
        
        console.log("SynchronousIntent deployed to:", address(intentContract));
        console.log("Chain ID:", block.chainid);
        console.log("Domain separator:");
        console.logBytes32(intentContract.domainSeparator());
        console.log("Deployer is authorized solver:", intentContract.authorizedSolvers(vm.addr(deployerPrivateKey)));
        console.log("Solver whitelist enabled:", intentContract.solverWhitelistEnabled());
    }
}
