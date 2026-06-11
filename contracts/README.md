# SynchronousIntent Contracts

This contract is only deployable on a Bittensor-compatible EVM chain where the staking precompile exists at:

```text
0x0000000000000000000000000000000000000805
```

The constructor performs a read-only call to `getTotalAlphaStaked(bytes32,uint256)` and reverts with `staking precompile unavailable` if the chain does not support that precompile. Ethereum mainnet, Base, Arbitrum, and ordinary EVM chains will not work unless they provide a compatible shim at `0x805`.

## EIP-712 Domain

Wallets and solver services must sign with this exact domain:

```text
name: SynchronousIntent
version: 1
chainId: the target Bittensor EVM chain ID
verifyingContract: deployed SynchronousIntent address
```

The contract exposes `EIP712_NAME`, `EIP712_VERSION`, `INTENT_TYPEHASH`, `CALL_TYPEHASH`, `CONDITION_TYPEHASH`, and `domainSeparator()` so clients can compare their generated signing data against on-chain values.

## Mainnet Deployment

Install Foundry:

```shell
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

Deploy to Bittensor EVM mainnet:

```shell
cd contracts
PRIVATE_KEY=<deployer_private_key> forge script script/DeploySynchronousIntent.s.sol \
  --rpc-url https://lite.chain.opentensor.ai \
  --broadcast \
  -vvvv
```

The deployer is authorized as the first solver, and the solver whitelist is enabled by default.

Add or remove production solvers after deployment:

```shell
cast send <contract> "setSolver(address,bool)" <solver_address> true \
  --rpc-url https://lite.chain.opentensor.ai \
  --private-key <owner_private_key>
```

Disable the solver whitelist only for controlled development:

```shell
cast send <contract> "setSolverWhitelistEnabled(bool)" false \
  --rpc-url <dev_rpc_url> \
  --private-key <owner_private_key>
```

## Checks Before Funding

- Confirm `chainId` in the deployment logs matches the chain used by wallet signing.
- Confirm `domainSeparator()` matches the frontend or solver service.
- Confirm every solver address that can call `fillIntent` is trusted and authorized.
- Run `forge test` and simulate buy, sell, swap, failed call, expired intent, replayed nonce, and ALPHA slippage cases.
- Start with small funds on the target chain before increasing limits.
