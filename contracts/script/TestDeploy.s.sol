// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/SynchronousIntent.sol";

contract MockStakingOnChain {
    uint256 public totalStaked = 1000 * 1e9; // 1000 Alpha

    function addStake(bytes32 hotkey, uint256 amount, uint256 netuid) external payable {
        totalStaked += amount;
    }

    function removeStake(bytes32 hotkey, uint256 amount, uint256 netuid) external {
        totalStaked -= amount;
        payable(msg.sender).transfer(amount * 1e9);
    }

    function removeStakeFull(bytes32 hotkey, uint256 netuid) external {
        payable(msg.sender).transfer(totalStaked * 1e9);
        totalStaked = 0;
    }

    function getTotalAlphaStaked(bytes32 hotkey, uint256 netuid) external view returns (uint256) {
        return totalStaked;
    }

    function getStake(bytes32 hotkey, bytes32 coldkey, uint256 netuid) external view returns (uint256) {
        return totalStaked;
    }

    receive() external payable {}
}

contract TestDeploy is Script {
    // Deployed contract address
    address constant INTENT_CONTRACT = 0xD3A3FFc410F9FBCA3D5989DEFcc45d7b2Eead74b;
    address constant ISTAKING = 0x0000000000000000000000000000000000000805;
    bytes32 constant DEFAULT_HOTKEY = 0x3cba5f549c02a4da782cadb65564d0e8159f339f5610db4bd5773f36c760f97c;
    uint16 constant DEFAULT_NETUID = 310;

    bytes32 private constant CONDITION_TYPEHASH = keccak256("Condition(uint8 asset,uint256 minOutput,bytes32 hotkey,uint16 netuid)");
    bytes32 private constant CALL_TYPEHASH = keccak256("Call(address target,uint256 value,bytes callData)");
    bytes32 private constant INTENT_TYPEHASH = keccak256("Intent(address user,Call[] calls,Condition condition,uint256 deadline,uint256 nonce)Call(address target,uint256 value,bytes callData)Condition(uint8 asset,uint256 minOutput,bytes32 hotkey,uint16 netuid)");

    function _hashCondition(Condition memory condition) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            CONDITION_TYPEHASH,
            condition.asset,
            condition.minOutput,
            condition.hotkey,
            condition.netuid
        ));
    }

    function _hashCalls(Call[] memory calls) internal pure returns (bytes32) {
        bytes32[] memory callHashes = new bytes32[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            callHashes[i] = keccak256(abi.encode(
                CALL_TYPEHASH,
                calls[i].target,
                calls[i].value,
                keccak256(calls[i].callData)
            ));
        }
        return keccak256(abi.encodePacked(callHashes));
    }

    function _signIntent(Intent memory intent, uint256 privateKey, bytes32 domainSeparator) internal pure returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                INTENT_TYPEHASH,
                intent.user,
                _hashCalls(intent.calls),
                _hashCondition(intent.condition),
                intent.deadline,
                intent.nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function run() external {
        // Etch the mock precompile to ISTAKING (0x805) to satisfy local simulation
        MockStakingOnChain mock = new MockStakingOnChain();
        vm.etch(ISTAKING, address(mock).code);
        vm.deal(ISTAKING, 10 ether);

        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address user = vm.addr(deployerPrivateKey);
        
        SynchronousIntent intentContract = SynchronousIntent(payable(INTENT_CONTRACT));
        bytes32 domainSeparator = intentContract.domainSeparator();

        console.log("Starting on-chain verification from user:", user);

        // --- TEST 1: BUY ALPHA ---
        console.log("--- Executing Buy Alpha Intent (1.0 TAO) ---");
        vm.startBroadcast(deployerPrivateKey);

        Call[] memory buyCalls = new Call[](1);
        buyCalls[0] = Call({
            target: ISTAKING,
            value: 1.0 ether,
            callData: abi.encodeWithSignature("addStake(bytes32,uint256,uint256)", DEFAULT_HOTKEY, 1 * 1e9, DEFAULT_NETUID)
        });

        Condition memory buyCondition = Condition({
            asset: AssetType.ALPHA,
            minOutput: 1, // Any amount of alpha minted is successful
            hotkey: DEFAULT_HOTKEY,
            netuid: DEFAULT_NETUID
        });

        Intent memory buyIntent = Intent({
            user: user,
            calls: buyCalls,
            condition: buyCondition,
            deadline: block.timestamp + 3600,
            nonce: block.timestamp, // Dynamic nonce
            signature: ""
        });
        buyIntent.signature = _signIntent(buyIntent, deployerPrivateKey, domainSeparator);

        if (intentContract.owner() == user && !intentContract.authorizedSolvers(user)) {
            intentContract.setSolver(user, true);
        }

        intentContract.fillIntent{value: 1.0 ether}(buyIntent, "");
        vm.stopBroadcast();
        console.log("Buy Alpha Intent completed successfully!");
    }
}
