// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import "openzeppelin-contracts/contracts/utils/cryptography/EIP712.sol";
import "openzeppelin-contracts/contracts/security/ReentrancyGuard.sol";

address constant ISTAKING_ADDRESS = 0x0000000000000000000000000000000000000805;

interface IStaking {
    function addStake(bytes32 hotkey, uint256 amount, uint256 netuid) external;
    function removeStake(bytes32 hotkey, uint256 amount, uint256 netuid) external;
    function removeStakeFull(bytes32 hotkey, uint256 netuid) external;
    function getTotalAlphaStaked(bytes32 hotkey, uint256 netuid) external view returns (uint256);
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
 * @dev Executes a user's own signed intent against the Bittensor staking
 *      precompile and mathematically guarantees the output condition is met.
 *      Only the signing user may fill their own intent — there is no
 *      third-party solver delegation, so the output check (which reads the
 *      hotkey-wide stake total, the only check computable on-chain here) can
 *      never be gamed by an untrusted third party.
 */
contract SynchronousIntent is EIP712, ReentrancyGuard {
    // TypeHashes for EIP712 Signature Verification
    string public constant EIP712_NAME = "SynchronousIntent";
    string public constant EIP712_VERSION = "1";
    string public constant CONDITION_TYPE = "Condition(uint8 asset,uint256 minOutput,bytes32 hotkey,uint16 netuid)";
    string public constant CALL_TYPE = "Call(address target,bytes callData)";
    string public constant INTENT_TYPE =
        "Intent(address user,Call[] calls,Condition condition,uint256 deadline,uint256 nonce)Call(address target,bytes callData)Condition(uint8 asset,uint256 minOutput,bytes32 hotkey,uint16 netuid)";

    bytes32 public constant CONDITION_TYPEHASH = keccak256(bytes(CONDITION_TYPE));
    bytes32 public constant CALL_TYPEHASH = keccak256(bytes(CALL_TYPE));
    bytes32 public constant INTENT_TYPEHASH = keccak256(bytes(INTENT_TYPE));

    mapping(address => mapping(uint256 => bool)) public usedNonces;

    event IntentFilled(address indexed user, address indexed solver, uint256 nonce);

    constructor() EIP712(EIP712_NAME, EIP712_VERSION) {
        require(_stakingPrecompileAvailable(), "staking precompile unavailable");
    }

    function domainSeparator() public view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _stakingPrecompileAvailable() internal view returns (bool) {
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

    /// @dev The staking precompile debits/credits the calling contract's own balance
    ///      directly as part of its dispatch logic; it does not use EVM call value.
    ///      Calls here are therefore made with no attached value, and the contract
    ///      must already hold the TAO it needs (from `msg.value` on this call, or
    ///      from proceeds of an earlier call in the same intent, e.g. an unstake
    ///      leg funding a subsequent stake leg).
    function fillIntent(Intent calldata intent, bytes calldata solverData) external payable nonReentrant {
        require(msg.sender == intent.user, "only user can fill own intent");
        require(_verifySignature(intent), "bad sig");
        require(block.timestamp <= intent.deadline, "expired");
        require(!usedNonces[intent.user][intent.nonce], "replayed");
        require(intent.calls.length > 0, "no calls");
        require(intent.condition.minOutput > 0, "minOutput must be positive");

        for (uint256 i = 0; i < intent.calls.length; i++) {
            require(intent.calls[i].target == ISTAKING_ADDRESS, "invalid call target");
            require(intent.calls[i].callData.length >= 4, "invalid call data");
            bytes4 selector = bytes4(intent.calls[i].callData[0:4]);
            require(
                selector == IStaking.addStake.selector || selector == IStaking.removeStake.selector
                    || selector == IStaking.removeStakeFull.selector,
                "invalid call selector"
            );
        }

        // Mark used to prevent reentrancy loops
        usedNonces[intent.user][intent.nonce] = true;

        // Snapshot state BEFORE execution. Keep older stuck funds out of this fill.
        uint256 protectedTaoBalance = address(this).balance > msg.value ? address(this).balance - msg.value : 0;
        uint256 taoBalanceBeforeCall = address(this).balance;
        uint256 alphaBalanceBeforeCall = 0;

        if (intent.condition.asset == AssetType.ALPHA) {
            alphaBalanceBeforeCall = IStaking(ISTAKING_ADDRESS).getTotalAlphaStaked(intent.condition.hotkey, intent.condition.netuid);
        }

        // Optional self-callback hook (e.g. for a smart-contract wallet acting as
        // intent.user) to prepare state/funds before execution.
        if (solverData.length > 0) {
            ISolver(msg.sender).executeFill(solverData);
        }

        // Execute the signed calls against the staking precompile only
        for (uint256 i = 0; i < intent.calls.length; i++) {
            (bool success, ) = intent.calls[i].target.call(intent.calls[i].callData);
            require(success, "AI function call failed");
        }

        // Verify the core guarantee mathematically
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

        // Sweep any remaining new TAO back to the user (e.g. unspent msg.value).
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
