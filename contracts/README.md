# SynchronousIntent Contracts

`SynchronousIntent` is the on-chain executor for a user's own signed intent. A
user does not directly submit the staking transaction. Instead, the app builds
an EIP-712 message that describes what the user wants, the minimum output they
will accept, and the exact contract calls that may be executed. The user then
signs the intent and fills it themselves, from their own connected wallet, in
one transaction.

There is no third-party solver delegation. The contract only allows the
address that signed the intent to fill it. This is a deliberate design
constraint, not a missing feature — see "Why self-fill only" below.

## Intent Fill Flow

The flow is:

1. The frontend builds an `Intent`.
2. The user signs the intent with EIP-712.
3. The same user calls `fillIntent(intent, solverData)` from their own wallet.
4. The contract verifies the signature, deadline, nonce, that `msg.sender`
   equals the signing user, and that every call targets the staking
   precompile with an allowed selector.
5. The contract optionally calls back into `msg.sender` with
   `executeFill(solverData)` (useful only if the user's own wallet is a smart
   contract that implements `ISolver`; harmless no-op for a normal EOA wallet).
6. The contract executes the signed calls against the Bittensor staking
   precompile, with no value attached to those calls (see "Precompile value
   semantics" below) — the contract must already hold the TAO it needs.
7. The contract checks the user's minimum output condition.
8. The user receives the guaranteed output, and any leftover new TAO (e.g.
   unspent `msg.value`) is swept back to them.

## Why self-fill only

An earlier version of this contract supported third-party solvers filling
intents on a user's behalf, gated by an owner-managed whitelist. That design
was removed because the on-chain output check for ALPHA has a fundamental
limitation: Bittensor EVM has no way to cheaply compute a contract's own
account identity on-chain (mapping an EVM address to its real coldkey requires
`blake2b("evm:" + address)`, and the chain does not expose a usable `blake2f`
precompile at the standard EIP-152 address — confirmed by direct testing
against both Bittensor testnet and mainnet). Without that, the contract can
only check the hotkey-wide stake total (`getTotalAlphaStaked`), not its own
specific position. A malicious *third-party* filler could pad that hotkey-wide
number using its own funds within the same transaction (via the
`executeFill` callback) to make a fill look successful without the contract's
own position actually growing.

Restricting `fillIntent` to self-fill only (`msg.sender == intent.user`)
closes this gap completely, rather than just documenting it as a trust
requirement: a user can never usefully attack their own transaction, and no
third party ever executes code within it.

## Intent Structure

An intent contains:

- `user`: the address that signed the intent, and the only address allowed to
  fill it.
- `calls`: the exact low-level calls that will be executed. Every call must
  target the staking precompile (`0x805`) and use the `addStake`,
  `removeStake`, or `removeStakeFull` selector — anything else reverts before
  any execution happens.
- `condition`: the minimum output requirement the contract must verify.
  `minOutput` must be greater than zero; an intent that disables slippage
  protection is rejected outright.
- `deadline`: the timestamp after which the intent is invalid.
- `nonce`: a user-scoped replay protection value.
- `signature`: the user's EIP-712 signature over the intent.

`calls` no longer carries a per-call `value` field. See "Precompile value
semantics" below for why.

Nothing about the calls, minimum output, hotkey, netuid, deadline, or nonce
can change after the user signs — any change produces a different EIP-712
digest and fails signature recovery.

## Precompile value semantics

The Bittensor staking precompile does not use EVM call value. Its `addStake`
debits the *calling contract's own balance* directly as part of its dispatch
logic, and `removeStake` / `removeStakeFull` credit that balance back the same
way — confirmed by direct testing on Bittensor testnet, matching the official
[`opentensor/evm-bittensor` `stakeV2.sol`](https://github.com/opentensor/evm-bittensor/blob/main/solidity/stakeV2.sol)
reference pattern, which calls the precompile with no value attached at all.

This means `SynchronousIntent` must already hold the TAO it needs before
calling the precompile (from `msg.value` on the `fillIntent` call itself, or
from the proceeds of an earlier call in the same intent — e.g. a `removeStake`
leg funding a subsequent `addStake` leg in a subnet-rotation intent). An
earlier version of this contract attached `value:` to the low-level precompile
call; that call reverts on the real chain when made from a contract (tested
and confirmed), which would have made every stake fail in production.

## Supported Actions

The contract is designed around two output types:

- `AssetType.ALPHA`: used for buy/stake flows. The contract snapshots the
  hotkey/netuid ALPHA stake total before execution, executes the signed
  calls, then requires the increase to be at least `minOutput`.
- `AssetType.TAO`: used for sell/unstake flows. The contract snapshots its TAO
  balance before execution, executes the signed calls, then requires the TAO
  increase to be at least `minOutput`. The guaranteed TAO amount is paid to
  the user.

For example, a buy ALPHA intent normally contains a call to:

```text
0x0000000000000000000000000000000000000805.addStake(hotkey, amount, netuid)
```

A sell ALPHA intent normally contains a call to:

```text
0x0000000000000000000000000000000000000805.removeStake(hotkey, amount, netuid)
```

or:

```text
0x0000000000000000000000000000000000000805.removeStakeFull(hotkey, netuid)
```

## Fill Economics

The user funds and fills their own intent in one transaction. When it
succeeds:

- for TAO output, the user receives exactly `minOutput`;
- for ALPHA output, the contract verifies the ALPHA stake increase is at
  least `minOutput`;
- any TAO left above the protected pre-fill balance (e.g. unspent
  `msg.value`) is swept back to the user — there is no separate solver to pay
  a spread to.

## Safety Model

The contract provides these guarantees:

- only the signing user can ever fill their own intent — there is no solver
  delegation or whitelist to misconfigure;
- EIP-712 signatures bind the user to the exact call list and output
  condition;
- deadlines prevent old quotes from being filled later;
- `usedNonces[user][nonce]` prevents replay;
- `nonReentrant` prevents nested fills;
- every call must target the staking precompile with an allowed selector —
  arbitrary call targets/selectors are rejected before execution;
- `minOutput` must be positive and `calls` must be non-empty — zero-protection
  intents are rejected outright;
- output checks revert the transaction if the user receives less than their
  signed minimum;
- existing contract TAO balances are protected from accidental sweeps.

The contract only ever executes calls against the staking precompile, so the
frontend only needs to build `addStake` / `removeStake` / `removeStakeFull`
calls — anything else is rejected on-chain.

## Chain Requirement

This contract is only deployable on a Bittensor-compatible EVM chain where the staking precompile exists at:

```text
0x0000000000000000000000000000000000000805
```

The constructor performs a real read-only `staticcall` to
`getTotalAlphaStaked(bytes32,uint256)` and reverts with
`staking precompile unavailable` if the call fails or returns less than 32
bytes. This has been verified against both live RPCs:
`https://lite.chain.opentensor.ai` (mainnet, chain ID 964) and
`https://test.chain.opentensor.ai` (testnet, chain ID 945). Ethereum mainnet,
Base, Arbitrum, and ordinary EVM chains will not work unless they provide a
compatible shim at `0x805`.

## EIP-712 Domain

Wallets must sign with this exact domain:

```text
name: SynchronousIntent
version: 1
chainId: the target Bittensor EVM chain ID
verifyingContract: deployed SynchronousIntent address
```

The contract exposes `EIP712_NAME`, `EIP712_VERSION`, `INTENT_TYPEHASH`, `CALL_TYPEHASH`, `CONDITION_TYPEHASH`, and `domainSeparator()` so clients can compare their generated signing data against on-chain values.

## Deploying

Install Foundry:

```shell
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

Forge's local dry-run (revm) has no knowledge of Bittensor's native staking
precompile, so the constructor's real precompile check fails during forge's
local simulation even though the real chain handles it correctly. The deploy
script works around this with a local-only stub (see
`script/DeploySynchronousIntent.s.sol`) and must be run with
`--skip-simulation` so forge doesn't re-simulate against a fork that hits the
same limitation right before broadcasting:

```shell
cd contracts
PRIVATE_KEY=<deployer_private_key> forge script script/DeploySynchronousIntent.s.sol \
  --tc DeploySynchronousIntent \
  --rpc-url https://lite.chain.opentensor.ai \
  --broadcast \
  --skip-simulation \
  -vvvv
```

Use `https://test.chain.opentensor.ai` (chain ID 945) for testnet.

## Checks Before Funding

- Confirm `chainId` in the deployment logs matches the chain used by wallet signing.
- Confirm `domainSeparator()` matches the frontend.
- Run `forge test` (17 tests) covering: buy/sell/swap happy paths, a non-user
  trying to fill someone else's intent, bad signature, tampered calls
  post-signing, replay, expiry, zero `minOutput`, empty `calls`, slippage
  below `minOutput`, insufficient balance for a call, precompile failure,
  invalid call target, invalid call selector, a reentrant self-callback
  (defense-in-depth), and constructor behavior without the precompile.
- After deploying, run a small real self-fill (see the pattern in
  `script/DeploySynchronousIntent.s.sol`, building and signing an `Intent` and
  calling `fillIntent` for ~0.01–0.05 TAO) and confirm the stake actually
  lands before pointing real user funds at the contract.
- Start with small funds on the target chain before increasing limits.
