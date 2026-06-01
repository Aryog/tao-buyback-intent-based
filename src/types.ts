export type WalletType = 'metamask' | 'talisman';
export type AppView = 'dashboard' | 'chat' | 'history';
export type StakingAction = 'stake' | 'swap' | 'unstake';
export type HistoryFilter = 'all' | 'stake' | 'unstake' | 'swap';
export type HistorySource = 'wallet' | 'contract';
export type StatusState = { type: 'idle' | 'loading' | 'success' | 'error'; msg: string };

export interface ChatAction {
  type: 'stake' | 'unstake' | 'swap' | 'wallet_connect';
  amount?: string;
  netuid: number;
  targetNetuid?: number;
  estimatedAlpha?: string;
  estimatedTao?: string;
  intermediateTao?: string;
}

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
  action?: ChatAction;
}

export interface ChatConversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface WalletOption {
  id: WalletType;
  label: string;
  subtitle: string;
  description: string;
  iconSrc: string;
  wordmarkSrc: string;
  accent: string;
  accentRgb: string;
}

export interface StakeEvent {
  type: 'stake' | 'unstake' | 'swap';
  title: string;
  detail: string;
  amount: string;
  user: string;
  solver?: string;
  nonce?: string;
  txHash: string;
  blockNumber: number;
  timestamp: number;
}

export interface SwapAlphaSimulation {
  targetAlpha: string;
  intermediateTao: string;
}

export interface StakingPositionSummary {
  netuid: number;
  hotkey: string;
  amount: string;
  apy: string;
}

export interface SubnetPresentation {
  netuid: number;
  code: string;
  name: string;
  category: string;
  apy: string;
}
