// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/SynchronousIntent.sol";

contract MockStakingPrecompile {
    bool public shouldFail;
    bool public slippageSimulation;

    mapping(bytes32 => mapping(uint256 => uint256)) public stakes;

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

    function addStake(bytes32 hotkey, uint256 amount, uint256 netuid) external payable {
        require(!shouldFail, "Precompile configured to fail");

        uint256 amountToAdd = amount;
        if (slippageSimulation) {
            amountToAdd = amount / 2;
        }

        stakes[hotkey][netuid] += amountToAdd;
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

contract MockSolver is ISolver {
    SynchronousIntent public intentContract;

    constructor(SynchronousIntent _intentContract) {
        intentContract = _intentContract;
    }

    function executeFill(bytes calldata solverData) external {
        // Mock solver callback - does nothing right now
    }
    
    receive() external payable {}
}

contract SynchronousIntentTest is Test {
    SynchronousIntent public intentContract;
    MockSolver public solver;

    uint256 userPk = 0x1234;
    address user = vm.addr(userPk);
    address solverAddr = address(0x999);

    bytes32 testHotkey = keccak256("test_hotkey");
    uint16 testNetuid = 1;

    bytes32 private constant CONDITION_TYPEHASH = keccak256("Condition(uint8 asset,uint256 minOutput,bytes32 hotkey,uint16 netuid)");
    bytes32 private constant CALL_TYPEHASH = keccak256("Call(address target,uint256 value,bytes callData)");
    bytes32 private constant INTENT_TYPEHASH = keccak256("Intent(address user,Call[] calls,Condition condition,uint256 deadline,uint256 nonce)Call(address target,uint256 value,bytes callData)Condition(uint8 asset,uint256 minOutput,bytes32 hotkey,uint16 netuid)");

    function setUp() public {
        vm.etch(ISTAKING_ADDRESS, address(new MockStakingPrecompile()).code);
        vm.deal(ISTAKING_ADDRESS, 1000 * 1e18);

        intentContract = new SynchronousIntent();
        solver = new MockSolver(intentContract);

        intentContract.setSolver(solverAddr, true);

        vm.deal(user, 100 * 1e18);
        vm.deal(solverAddr, 1000 * 1e18);
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
                calls[i].value,
                keccak256(calls[i].callData)
            ));
        }
        return keccak256(abi.encodePacked(callHashes));
    }

    function _signIntent(Intent memory intent, uint256 privateKey) internal view returns (bytes memory) {
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
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_BuyAlphaSuccess() public {
        Call[] memory calls = new Call[](1);
        // Using amount 50 TAO = 50 * 1e18
        // amountInRao = 50 * 1e9
        calls[0] = Call({
            target: ISTAKING_ADDRESS,
            value: 50 * 1e18,
            callData: abi.encodeWithSelector(IStaking.addStake.selector, testHotkey, 50 * 1e9, testNetuid)
        });

        Condition memory cond = Condition({
            asset: AssetType.ALPHA,
            minOutput: 50 * 1e9,
            hotkey: testHotkey,
            netuid: testNetuid
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

        vm.startPrank(solverAddr);
        intentContract.fillIntent{value: 50 * 1e18}(intent, "");
        vm.stopPrank();

        assertEq(MockStakingPrecompile(payable(ISTAKING_ADDRESS)).getTotalAlphaStaked(testHotkey, testNetuid), 50 * 1e9);
        assertTrue(intentContract.usedNonces(user, 1));
    }

    function test_UnauthorizedSolverReverts() public {
        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            target: ISTAKING_ADDRESS,
            value: 50 * 1e18,
            callData: abi.encodeWithSelector(IStaking.addStake.selector, testHotkey, 50 * 1e9, testNetuid)
        });

        Condition memory cond = Condition({
            asset: AssetType.ALPHA,
            minOutput: 50 * 1e9,
            hotkey: testHotkey,
            netuid: testNetuid
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

        address unauthorizedSolver = address(0x123);
        vm.deal(unauthorizedSolver, 100 * 1e18);

        vm.prank(unauthorizedSolver);
        vm.expectRevert("solver not authorized");
        intentContract.fillIntent{value: 50 * 1e18}(intent, "");
    }

    function test_SellAlphaSuccess() public {
        MockStakingPrecompile(payable(ISTAKING_ADDRESS)).setStake(testHotkey, testNetuid, 50 * 1e9);
        vm.deal(address(intentContract), 7 * 1e18);

        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            target: ISTAKING_ADDRESS,
            value: 0,
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
        uint256 solverBalBefore = solverAddr.balance;

        vm.startPrank(solverAddr);
        intentContract.fillIntent(intent, "");
        vm.stopPrank();

        assertEq(user.balance - userBalBefore, 45 * 1e18); // User gets exact minOutput
        assertEq(solverAddr.balance - solverBalBefore, 5 * 1e18); // Solver gets the 5 TAO spread
        assertEq(address(intentContract).balance, 7 * 1e18); // Stuck funds are not swept to solver
    }

    function test_SwapAlphaSuccess() public {
        bytes32 targetHotkey = keccak256("target_hotkey");
        uint16 targetNetuid = 2;
        
        MockStakingPrecompile(payable(ISTAKING_ADDRESS)).setStake(testHotkey, testNetuid, 50 * 1e9);

        Call[] memory calls = new Call[](2);
        // Call 1: Unstake from source
        calls[0] = Call({
            target: ISTAKING_ADDRESS,
            value: 0,
            callData: abi.encodeWithSelector(IStaking.removeStake.selector, testHotkey, 50 * 1e9, testNetuid)
        });
        // Call 2: Stake to target (uses the 50 TAO generated from Call 1)
        calls[1] = Call({
            target: ISTAKING_ADDRESS,
            value: 50 * 1e18,
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

        vm.startPrank(solverAddr);
        intentContract.fillIntent(intent, "");
        vm.stopPrank();

        assertEq(MockStakingPrecompile(payable(ISTAKING_ADDRESS)).getTotalAlphaStaked(targetHotkey, targetNetuid), 50 * 1e9);
        assertEq(MockStakingPrecompile(payable(ISTAKING_ADDRESS)).getTotalAlphaStaked(testHotkey, testNetuid), 0);
    }
}
