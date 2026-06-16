// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "forge-std/Vm.sol";
import "../src/SynchronousIntent.sol";

Vm constant CHEATS = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

contract MockStakingPrecompile {
    bool public shouldFail;
    bool public slippageSimulation;

    mapping(bytes32 => mapping(uint256 => uint256)) public stakes; // hotkey => netuid => total alpha

    function setShouldFail(bool _shouldFail) external {
        shouldFail = _shouldFail;
    }

    function setSlippageSimulation(bool _slippageSimulation) external {
        slippageSimulation = _slippageSimulation;
    }

    function getTotalAlphaStaked(bytes32 hotkey, uint256 netuid) external view returns (uint256) {
        return stakes[hotkey][netuid];
    }

    function setStake(bytes32 hotkey, uint256 netuid, uint256 amount) external {
        stakes[hotkey][netuid] = amount;
    }

    // Real chain behavior (verified on Bittensor testnet): addStake debits the
    // calling contract's own balance directly, independent of EVM call value.
    // A mock can't pull funds from its caller, so we replicate the effect with
    // vm.deal; this also makes an insufficient-balance call underflow-revert,
    // matching the real failure mode.
    function addStake(bytes32 hotkey, uint256 amount, uint256 netuid) external {
        require(!shouldFail, "Precompile configured to fail");

        uint256 amountToAdd = amount;
        if (slippageSimulation) {
            amountToAdd = amount / 2;
        }
        stakes[hotkey][netuid] += amountToAdd;

        uint256 weiAmount = amount * 1e9;
        CHEATS.deal(msg.sender, msg.sender.balance - weiAmount);
    }

    function removeStake(bytes32 hotkey, uint256 amount, uint256 netuid) external {
        require(!shouldFail, "Precompile configured to fail");

        require(stakes[hotkey][netuid] >= amount, "Not enough mock stake");
        stakes[hotkey][netuid] -= amount;

        uint256 amountToMint = amount * 1e9;
        if (slippageSimulation) {
            amountToMint = (amount * 1e9) / 2;
        }

        payable(msg.sender).transfer(amountToMint);
    }

    function removeStakeFull(bytes32 hotkey, uint256 netuid) external {
        require(!shouldFail, "Precompile configured to fail");
        uint256 amount = stakes[hotkey][netuid];
        stakes[hotkey][netuid] = 0;

        uint256 amountToMint = amount * 1e9;
        if (slippageSimulation) {
            amountToMint = (amount * 1e9) / 2;
        }

        payable(msg.sender).transfer(amountToMint);
    }

    receive() external payable {}
}

contract MaliciousTarget {
    bool public called;

    function pwn() external payable {
        called = true;
    }

    receive() external payable {}
}

// Simulates a compromised self-fill wallet. This is etched onto the user's own
// EOA address purely for defense-in-depth testing of `nonReentrant`: a contract
// address can never produce a valid ECDSA signature for itself, so this path is
// not reachable on a real chain (the user can't simultaneously be a contract).
contract ReentrantSelfWallet is ISolver {
    function executeFill(bytes calldata solverData) external {
        (address target, Intent memory innerIntent) = abi.decode(solverData, (address, Intent));
        SynchronousIntent(payable(target)).fillIntent(innerIntent, "");
    }

    receive() external payable {}
}

contract SynchronousIntentTest is Test {
    SynchronousIntent public intentContract;

    uint256 userPk = 0x1234;
    address user = vm.addr(userPk);

    bytes32 testHotkey = keccak256("test_hotkey");
    uint16 testNetuid = 1;

    bytes32 private constant CONDITION_TYPEHASH = keccak256("Condition(uint8 asset,uint256 minOutput,bytes32 hotkey,uint16 netuid)");
    bytes32 private constant CALL_TYPEHASH = keccak256("Call(address target,bytes callData)");
    bytes32 private constant INTENT_TYPEHASH = keccak256("Intent(address user,Call[] calls,Condition condition,uint256 deadline,uint256 nonce)Call(address target,bytes callData)Condition(uint8 asset,uint256 minOutput,bytes32 hotkey,uint16 netuid)");

    function setUp() public {
        vm.etch(ISTAKING_ADDRESS, address(new MockStakingPrecompile()).code);
        vm.deal(ISTAKING_ADDRESS, 1000 * 1e18);

        intentContract = new SynchronousIntent();

        vm.deal(user, 100 * 1e18);
    }

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
                keccak256(calls[i].callData)
            ));
        }
        return keccak256(abi.encodePacked(callHashes));
    }

    function _digest(Intent memory intent) internal view returns (bytes32) {
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
        bytes32 domainSeparator = intentContract.domainSeparator();
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _signIntent(Intent memory intent, uint256 privateKey) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, _digest(intent));
        return abi.encodePacked(r, s, v);
    }

    function _buyAlphaIntent(uint256 amountTao, uint256 minOutputAlpha, uint256 nonce) internal view returns (Intent memory) {
        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            target: ISTAKING_ADDRESS,
            callData: abi.encodeWithSelector(IStaking.addStake.selector, testHotkey, amountTao / 1e9, testNetuid)
        });

        Condition memory cond = Condition({
            asset: AssetType.ALPHA,
            minOutput: minOutputAlpha,
            hotkey: testHotkey,
            netuid: testNetuid
        });

        return Intent({
            user: user,
            calls: calls,
            condition: cond,
            deadline: block.timestamp + 100,
            nonce: nonce,
            signature: ""
        });
    }

    // ---------------------------------------------------------------------
    // Happy path (self-fill is the only supported path)
    // ---------------------------------------------------------------------

    function test_BuyAlphaSuccess() public {
        Intent memory intent = _buyAlphaIntent(50 * 1e18, 50 * 1e9, 1);
        intent.signature = _signIntent(intent, userPk);

        vm.prank(user);
        intentContract.fillIntent{value: 50 * 1e18}(intent, "");

        assertEq(MockStakingPrecompile(payable(ISTAKING_ADDRESS)).getTotalAlphaStaked(testHotkey, testNetuid), 50 * 1e9);
        assertTrue(intentContract.usedNonces(user, 1));
        assertEq(address(intentContract).balance, 0);
    }

    function test_SellAlphaSuccess() public {
        MockStakingPrecompile(payable(ISTAKING_ADDRESS)).setStake(testHotkey, testNetuid, 50 * 1e9);
        vm.deal(address(intentContract), 7 * 1e18);

        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            target: ISTAKING_ADDRESS,
            callData: abi.encodeWithSelector(IStaking.removeStake.selector, testHotkey, 50 * 1e9, testNetuid)
        });

        Condition memory cond = Condition({
            asset: AssetType.TAO,
            minOutput: 45 * 1e18, // slippage tolerance
            hotkey: bytes32(0),
            netuid: 0
        });

        Intent memory intent = Intent({
            user: user,
            calls: calls,
            condition: cond,
            deadline: block.timestamp + 100,
            nonce: 1,
            signature: ""
        });
        intent.signature = _signIntent(intent, userPk);

        uint256 userBalBefore = user.balance;

        vm.prank(user);
        intentContract.fillIntent(intent, "");

        // User gets exact minOutput, plus the 5 TAO spread swept back (self-fill: no solver fee).
        assertEq(user.balance - userBalBefore, 50 * 1e18);
        assertEq(address(intentContract).balance, 7 * 1e18); // Stuck funds are not swept
    }

    function test_SwapAlphaSuccess() public {
        bytes32 targetHotkey = keccak256("target_hotkey");
        uint16 targetNetuid = 2;

        MockStakingPrecompile(payable(ISTAKING_ADDRESS)).setStake(testHotkey, testNetuid, 50 * 1e9);

        Call[] memory calls = new Call[](2);
        calls[0] = Call({
            target: ISTAKING_ADDRESS,
            callData: abi.encodeWithSelector(IStaking.removeStake.selector, testHotkey, 50 * 1e9, testNetuid)
        });
        calls[1] = Call({
            target: ISTAKING_ADDRESS,
            callData: abi.encodeWithSelector(IStaking.addStake.selector, targetHotkey, 50 * 1e9, targetNetuid)
        });

        Condition memory cond = Condition({
            asset: AssetType.ALPHA,
            minOutput: 50 * 1e9,
            hotkey: targetHotkey,
            netuid: targetNetuid
        });

        Intent memory intent = Intent({
            user: user,
            calls: calls,
            condition: cond,
            deadline: block.timestamp + 100,
            nonce: 1,
            signature: ""
        });
        intent.signature = _signIntent(intent, userPk);

        vm.prank(user);
        intentContract.fillIntent(intent, "");

        assertEq(MockStakingPrecompile(payable(ISTAKING_ADDRESS)).getTotalAlphaStaked(targetHotkey, targetNetuid), 50 * 1e9);
        assertEq(MockStakingPrecompile(payable(ISTAKING_ADDRESS)).getTotalAlphaStaked(testHotkey, testNetuid), 0);
    }

    // ---------------------------------------------------------------------
    // Authorization / signature / replay / expiry
    // ---------------------------------------------------------------------

    function test_NonUserCannotFillReverts() public {
        Intent memory intent = _buyAlphaIntent(50 * 1e18, 50 * 1e9, 1);
        intent.signature = _signIntent(intent, userPk);

        address someoneElse = address(0x123);
        vm.deal(someoneElse, 100 * 1e18);

        vm.prank(someoneElse);
        vm.expectRevert("only user can fill own intent");
        intentContract.fillIntent{value: 50 * 1e18}(intent, "");
    }

    function test_BadSignatureReverts() public {
        Intent memory intent = _buyAlphaIntent(50 * 1e18, 50 * 1e9, 1);
        uint256 attackerPk = 0xBEEF;
        intent.signature = _signIntent(intent, attackerPk);

        vm.prank(user);
        vm.expectRevert("bad sig");
        intentContract.fillIntent{value: 50 * 1e18}(intent, "");
    }

    function test_TamperedCallsAfterSigningReverts() public {
        Intent memory intent = _buyAlphaIntent(50 * 1e18, 50 * 1e9, 1);
        intent.signature = _signIntent(intent, userPk);

        intent.calls[0].callData = abi.encodeWithSelector(IStaking.addStake.selector, testHotkey, 1 * 1e9, testNetuid);

        vm.prank(user);
        vm.expectRevert("bad sig");
        intentContract.fillIntent{value: 50 * 1e18}(intent, "");
    }

    function test_ReplayReverts() public {
        Intent memory intent = _buyAlphaIntent(50 * 1e18, 50 * 1e9, 1);
        intent.signature = _signIntent(intent, userPk);

        vm.startPrank(user);
        intentContract.fillIntent{value: 50 * 1e18}(intent, "");

        vm.expectRevert("replayed");
        intentContract.fillIntent{value: 50 * 1e18}(intent, "");
        vm.stopPrank();
    }

    function test_ExpiredIntentReverts() public {
        Intent memory intent = _buyAlphaIntent(50 * 1e18, 50 * 1e9, 1);
        intent.deadline = block.timestamp;
        intent.signature = _signIntent(intent, userPk);

        vm.warp(block.timestamp + 1);

        vm.prank(user);
        vm.expectRevert("expired");
        intentContract.fillIntent{value: 50 * 1e18}(intent, "");
    }

    // ---------------------------------------------------------------------
    // Output-condition / slippage protection
    // ---------------------------------------------------------------------

    function test_ZeroMinOutputReverts() public {
        Intent memory intent = _buyAlphaIntent(50 * 1e18, 0, 1);
        intent.signature = _signIntent(intent, userPk);

        vm.prank(user);
        vm.expectRevert("minOutput must be positive");
        intentContract.fillIntent{value: 50 * 1e18}(intent, "");
    }

    function test_EmptyCallsReverts() public {
        Condition memory cond = Condition({asset: AssetType.ALPHA, minOutput: 1, hotkey: testHotkey, netuid: testNetuid});
        Intent memory intent = Intent({
            user: user,
            calls: new Call[](0),
            condition: cond,
            deadline: block.timestamp + 100,
            nonce: 1,
            signature: ""
        });
        intent.signature = _signIntent(intent, userPk);

        vm.prank(user);
        vm.expectRevert("no calls");
        intentContract.fillIntent(intent, "");
    }

    function test_SlippageBelowMinOutputReverts() public {
        MockStakingPrecompile(payable(ISTAKING_ADDRESS)).setSlippageSimulation(true);

        Intent memory intent = _buyAlphaIntent(50 * 1e18, 50 * 1e9, 1);
        intent.signature = _signIntent(intent, userPk);

        vm.prank(user);
        vm.expectRevert("output condition not met");
        intentContract.fillIntent{value: 50 * 1e18}(intent, "");
    }

    function test_InsufficientBalanceForCallReverts() public {
        // Sign for 50 TAO worth of stake but only attach 10 TAO of msg.value.
        Intent memory intent = _buyAlphaIntent(50 * 1e18, 50 * 1e9, 1);
        intent.signature = _signIntent(intent, userPk);

        vm.prank(user);
        vm.expectRevert("AI function call failed");
        intentContract.fillIntent{value: 10 * 1e18}(intent, "");
    }

    function test_PrecompileFailureReverts() public {
        MockStakingPrecompile(payable(ISTAKING_ADDRESS)).setShouldFail(true);

        Intent memory intent = _buyAlphaIntent(50 * 1e18, 50 * 1e9, 1);
        intent.signature = _signIntent(intent, userPk);

        vm.prank(user);
        vm.expectRevert("AI function call failed");
        intentContract.fillIntent{value: 50 * 1e18}(intent, "");
    }

    // ---------------------------------------------------------------------
    // Call restriction (target / selector allowlist)
    // ---------------------------------------------------------------------

    function test_InvalidCallTargetReverts() public {
        MaliciousTarget malicious = new MaliciousTarget();

        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            target: address(malicious),
            callData: abi.encodeWithSelector(MaliciousTarget.pwn.selector)
        });

        Condition memory cond = Condition({asset: AssetType.ALPHA, minOutput: 1, hotkey: testHotkey, netuid: testNetuid});
        Intent memory intent = Intent({
            user: user,
            calls: calls,
            condition: cond,
            deadline: block.timestamp + 100,
            nonce: 1,
            signature: ""
        });
        intent.signature = _signIntent(intent, userPk);

        vm.prank(user);
        vm.expectRevert("invalid call target");
        intentContract.fillIntent{value: 1 * 1e18}(intent, "");

        assertFalse(malicious.called());
    }

    function test_InvalidCallSelectorReverts() public {
        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            target: ISTAKING_ADDRESS,
            callData: abi.encodeWithSelector(IStaking.getTotalAlphaStaked.selector, testHotkey, testNetuid)
        });

        Condition memory cond = Condition({asset: AssetType.ALPHA, minOutput: 1, hotkey: testHotkey, netuid: testNetuid});
        Intent memory intent = Intent({
            user: user,
            calls: calls,
            condition: cond,
            deadline: block.timestamp + 100,
            nonce: 1,
            signature: ""
        });
        intent.signature = _signIntent(intent, userPk);

        vm.prank(user);
        vm.expectRevert("invalid call selector");
        intentContract.fillIntent(intent, "");
    }

    // ---------------------------------------------------------------------
    // Reentrancy (defense-in-depth; not reachable on a real chain, see comment
    // on ReentrantSelfWallet)
    // ---------------------------------------------------------------------

    function test_ReentrantSelfCallbackReverts() public {
        vm.etch(user, address(new ReentrantSelfWallet()).code);

        Intent memory outer = _buyAlphaIntent(10 * 1e18, 10 * 1e9, 1);
        outer.signature = _signIntent(outer, userPk);

        Intent memory inner = _buyAlphaIntent(10 * 1e18, 10 * 1e9, 2);
        inner.signature = _signIntent(inner, userPk);

        bytes memory solverData = abi.encode(address(intentContract), inner);

        vm.prank(user);
        vm.expectRevert(bytes("ReentrancyGuard: reentrant call"));
        intentContract.fillIntent{value: 10 * 1e18}(outer, solverData);
    }

    // ---------------------------------------------------------------------
    // Constructor / precompile availability
    // ---------------------------------------------------------------------

    function test_ConstructorRevertsWithoutPrecompile() public {
        vm.etch(ISTAKING_ADDRESS, "");
        vm.expectRevert("staking precompile unavailable");
        new SynchronousIntent();
    }
}
