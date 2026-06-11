// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import "openzeppelin-contracts/contracts/utils/cryptography/EIP712.sol";
import "openzeppelin-contracts/contracts/security/ReentrancyGuard.sol";

address constant ISTAKING_ADDRESS = 0x0000000000000000000000000000000000000805;
uint256 constant BITTENSOR_TESTNET_CHAIN_ID = 945;
uint256 constant BITTENSOR_MAINNET_CHAIN_ID = 964;

interface IStaking {
    function addStake(bytes32 hotkey, uint256 amount, uint256 netuid) external;
    function removeStake(bytes32 hotkey, uint256 amount, uint256 netuid) external;
    function removeStakeFull(bytes32 hotkey, uint256 netuid) external;
    function getTotalAlphaStaked(bytes32 hotkey, uint256 netuid) external view returns (uint256);
    function getStake(bytes32 hotkey, bytes32 coldkey, uint256 netuid) external view returns (uint256);
}

interface ISolver {
    function executeFill(bytes calldata solverData) external;
}

enum AssetType { TAO, ALPHA }

struct Condition {
    AssetType asset;
    uint256 minOutput;
    bytes32 hotkey; 
    uint16 netuid;  
}

struct Call {
    address target;
    uint256 value;
    bytes callData;
}

struct Intent {
    address user;
    Call[] calls;
    Condition condition;
    uint256 deadline;
    uint256 nonce;
    bytes signature;
}

/**
 * @title SynchronousIntent
 * @dev Universal Intent Executor. Blindly executes dynamic callData provided by AI Agents
 *      and mathematically guarantees the output condition is met.
 */
contract SynchronousIntent is EIP712, ReentrancyGuard {
    address public owner;
    bool public solverWhitelistEnabled = true;

    // TypeHashes for EIP712 Signature Verification
    string public constant EIP712_NAME = "SynchronousIntent";
    string public constant EIP712_VERSION = "1";
    string public constant CONDITION_TYPE = "Condition(uint8 asset,uint256 minOutput,bytes32 hotkey,uint16 netuid)";
    string public constant CALL_TYPE = "Call(address target,uint256 value,bytes callData)";
    string public constant INTENT_TYPE =
        "Intent(address user,Call[] calls,Condition condition,uint256 deadline,uint256 nonce)Call(address target,uint256 value,bytes callData)Condition(uint8 asset,uint256 minOutput,bytes32 hotkey,uint16 netuid)";

    bytes32 public constant CONDITION_TYPEHASH = keccak256(bytes(CONDITION_TYPE));
    bytes32 public constant CALL_TYPEHASH = keccak256(bytes(CALL_TYPE));
    bytes32 public constant INTENT_TYPEHASH = keccak256(bytes(INTENT_TYPE));

    mapping(address => mapping(uint256 => bool)) public usedNonces;
    mapping(address => bool) public authorizedSolvers;

    event IntentFilled(address indexed user, address indexed solver, uint256 nonce);
    event SolverAuthorizationUpdated(address indexed solver, bool authorized);
    event SolverWhitelistUpdated(bool enabled);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() EIP712(EIP712_NAME, EIP712_VERSION) {
        require(_stakingPrecompileAvailable(), "staking precompile unavailable");
        owner = msg.sender;
        authorizedSolvers[msg.sender] = true;
        emit OwnershipTransferred(address(0), msg.sender);
        emit SolverAuthorizationUpdated(msg.sender, true);
    }

    function getColdkey() public view returns (bytes32) {
        return bytes32(uint256(uint160(address(this))));
    }

    function domainSeparator() public view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function setSolver(address solver, bool authorized) external onlyOwner {
        require(solver != address(0), "zero solver");
        authorizedSolvers[solver] = authorized;
        emit SolverAuthorizationUpdated(solver, authorized);
    }

    function setSolverWhitelistEnabled(bool enabled) external onlyOwner {
        solverWhitelistEnabled = enabled;
        emit SolverWhitelistUpdated(enabled);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function _stakingPrecompileAvailable() internal view returns (bool) {
        if (block.chainid == BITTENSOR_TESTNET_CHAIN_ID || block.chainid == BITTENSOR_MAINNET_CHAIN_ID) {
            return true;
        }

        (bool success, bytes memory result) = ISTAKING_ADDRESS.staticcall(
            abi.encodeWithSelector(IStaking.getTotalAlphaStaked.selector, bytes32(0), uint256(0))
        );
        return success && result.length >= 32;
    }

    function _hashCondition(Condition calldata condition) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            CONDITION_TYPEHASH,
            condition.asset,
            condition.minOutput,
            condition.hotkey,
            condition.netuid
        ));
    }

    function _hashCalls(Call[] calldata calls) internal pure returns (bytes32) {
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

    function _verifySignature(Intent calldata intent) internal view returns (bool) {
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
        bytes32 hash = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(hash, intent.signature);
        return signer == intent.user;
    }

    function fillIntent(Intent calldata intent, bytes calldata solverData) external payable nonReentrant {
        require(!solverWhitelistEnabled || authorizedSolvers[msg.sender], "solver not authorized");
        require(_verifySignature(intent), "bad sig");
        require(block.timestamp <= intent.deadline, "expired");
        require(!usedNonces[intent.user][intent.nonce], "replayed");
        
        // Mark used to prevent reentrancy loops
        usedNonces[intent.user][intent.nonce] = true;

        // Snapshot state BEFORE execution. Keep older stuck funds out of this fill.
        uint256 protectedTaoBalance = address(this).balance > msg.value ? address(this).balance - msg.value : 0;
        uint256 taoBalanceBeforeCall = address(this).balance;
        uint256 alphaBalanceBeforeCall = 0;
        
        if (intent.condition.asset == AssetType.ALPHA) {
            alphaBalanceBeforeCall = IStaking(ISTAKING_ADDRESS).getTotalAlphaStaked(intent.condition.hotkey, intent.condition.netuid);
        }

        // 1. Solver callback to prepare state/funds
        if (solverData.length > 0) {
            ISolver(msg.sender).executeFill(solverData);
        }

        // 2. Blindly execute the dynamic calls prepared by the AI agent
        uint256 remainingMsgValue = msg.value;

        for (uint256 i = 0; i < intent.calls.length; i++) {
            uint256 spendableTao = 0;
            if (address(this).balance > protectedTaoBalance) {
                spendableTao = address(this).balance - protectedTaoBalance;
            }
            if (spendableTao < remainingMsgValue) {
                spendableTao = remainingMsgValue;
            }
            
            require(spendableTao >= intent.calls[i].value, "Insufficient TAO for call");

            if (remainingMsgValue >= intent.calls[i].value) {
                remainingMsgValue -= intent.calls[i].value;
            } else {
                remainingMsgValue = 0;
            }
            
            (bool success, ) = intent.calls[i].target.call{value: intent.calls[i].value}(intent.calls[i].callData);
            require(success, "AI function call failed");
        }

        // 3. Verify the core guarantee mathematically
        if (intent.condition.asset == AssetType.ALPHA) {
            uint256 alphaBalanceAfterCall = IStaking(ISTAKING_ADDRESS).getTotalAlphaStaked(intent.condition.hotkey, intent.condition.netuid);
            require(alphaBalanceAfterCall >= alphaBalanceBeforeCall, "ALPHA balance decreased");
            uint256 alphaReceived = alphaBalanceAfterCall - alphaBalanceBeforeCall;
            require(alphaReceived >= intent.condition.minOutput, "output condition not met");
        } else {
            uint256 taoBalanceAfterCall = address(this).balance;
            require(taoBalanceAfterCall >= taoBalanceBeforeCall, "TAO balance decreased");
            uint256 taoReceived = taoBalanceAfterCall - taoBalanceBeforeCall;
            require(taoReceived >= intent.condition.minOutput, "output condition not met");

            // Pay user their guaranteed minimum TAO
            _sendTao(intent.user, intent.condition.minOutput);
        }

        // 4. Sweep remaining TAO to solver.
        // This elegantly handles both refunding unspent msg.value AND paying the solver their spread fee.
        uint256 remainingTao = 0;
        if (address(this).balance > protectedTaoBalance) {
            remainingTao = address(this).balance - protectedTaoBalance;
        }
        if (remainingTao > 0) {
            _sendTao(msg.sender, remainingTao);
        }

        emit IntentFilled(intent.user, msg.sender, intent.nonce);
    }

    function _sendTao(address to, uint256 amount) internal {
        (bool success, ) = payable(to).call{value: amount}("");
        require(success, "TAO transfer failed");
    }

    // Required to receive Native TAO from precompiles/solvers
    receive() external payable {}
}
