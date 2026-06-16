import { ethers } from 'ethers';
import abiData from '../abi.json';

export const CONTRACT_ABI = abiData;
export const EXPLORER_BASE_URL = 'https://evm-testnet.subtensor.io/tx/';
export const STAKING_PRECOMPILE_ADDRESS = '0x0000000000000000000000000000000000000805';

export interface IntentCall {
  target: string;
  callData: string;
}

export interface IntentCondition {
  asset: number;
  minOutput: bigint;
  hotkey: string;
  netuid: number;
}

export const getIntentTiming = () => {
  const now = Date.now();
  return {
    deadline: Math.floor(now / 1000) + 3600,
    nonce: now,
  };
};

// The contract rejects any intent with minOutput == 0, so every flow must derive
// a real floor from a live quote rather than disabling slippage protection.
export const OUTPUT_SLIPPAGE_TOLERANCE_BPS = 200n; // 2%

export const applySlippageFloor = (
  expectedAmountRao: bigint,
  toleranceBps: bigint = OUTPUT_SLIPPAGE_TOLERANCE_BPS,
): bigint => {
  if (expectedAmountRao <= 0n) return 0n;
  return expectedAmountRao - (expectedAmountRao * toleranceBps) / 10000n;
};

export const contractInterface = new ethers.Interface(CONTRACT_ABI);

export const stakingCallInterface = new ethers.Interface([
  'function addStake(bytes32 hotkey, uint256 amount, uint256 netuid) external',
  'function removeStake(bytes32 hotkey, uint256 amount, uint256 netuid) external',
  'function removeStakeFull(bytes32 hotkey, uint256 netuid) external',
]);
