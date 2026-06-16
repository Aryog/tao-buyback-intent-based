import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ethers } from 'ethers';
import { CONFIG } from '../config';
import { WALLET_OPTIONS } from '../data/wallets';
import { DISPLAY_SUBNETS } from '../data/subnets';
import type {
  AppView,
  HistoryFilter,
  HistorySource,
  StakeEvent,
  StakingAction,
  StakingPositionSummary,
  StatusState,
  SubnetPresentation,
  SwapAlphaSimulation,
  WalletType,
} from '../types';
import { AppContext, type AppContextValue, type Surface } from './appContextValue';
import { getEvmColdkey, hexToBytes } from '../utils/coldkeys';
import {
  applySlippageFloor,
  CONTRACT_ABI,
  STAKING_PRECOMPILE_ADDRESS,
  getIntentTiming,
  stakingCallInterface,
  type IntentCall,
  type IntentCondition,
} from '../utils/contracts';
import { escapeCsvValue, formatShortValue, formatTokenAmount, normalizeAddress } from '../utils/formatters';
import {
  HISTORY_PAGE_SIZE,
  decodeOnchainHistoryLogs,
  fetchIntentFilledLogGroups,
  getHistoryCacheKey,
  mergeHistoryEvents,
  type HistoryCacheEntry,
} from '../utils/history';
import { activeProvider, logRejectedRpcResult, settleRpcBatch, stakingPrecompile, toBigIntOrZero } from '../utils/rpc';
import { decodeDelegations, decodeSubnetCatalog } from '../utils/scaleDecoders';
import { simulateStakeAlpha, simulateSwapAlpha, simulateUnstakeTao } from '../utils/simulations';
import { getHotkeyForNetuid, getMockApyForNetuid, getSubnetLabel, getSubnetPresentation } from '../utils/subnets';
import { getInjectedProvider } from '../utils/wallets';

const APP_VIEWS: AppView[] = ['dashboard', 'chat', 'history'];

const getInitialAppView = (): AppView => {
  if (typeof window === 'undefined') return 'chat';
  const params = new URLSearchParams(window.location.search);
  const requestedView = params.get('view') as AppView | null;
  return requestedView && APP_VIEWS.includes(requestedView) ? requestedView : 'chat';
};

export function AppProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const surface: Surface = location.pathname.startsWith('/app') ? 'app' : 'landing';
  const [provider, setProvider] = useState<ethers.BrowserProvider | null>(null);
  const [signer, setSigner] = useState<ethers.JsonRpcSigner | null>(null);
  const [account, setAccount] = useState('');
  const [balance, setBalance] = useState('0');
  const [myAlphaBalance, setMyAlphaBalance] = useState('0');
  const [totalAlphaStaked, setTotalAlphaStaked] = useState('0');
  const [allAlphaBalances, setAllAlphaBalances] = useState<{ [id: number]: string }>({});
  const [stakedHotkeys, setStakedHotkeys] = useState<{ [netuid: number]: string }>({});
  const [availableNetuids, setAvailableNetuids] = useState<number[]>(DISPLAY_SUBNETS.map((subnet) => subnet.netuid));
  const [subnetNamesByNetuid, setSubnetNamesByNetuid] = useState<{ [netuid: number]: string }>({});
  const [stakeHistory, setStakeHistory] = useState<StakeEvent[]>([]);
  const [sessionStakeHistory, setSessionStakeHistory] = useState<StakeEvent[]>([]);
  const [walletType, setWalletType] = useState<WalletType | null>(null);
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [isWalletHydrating, setIsWalletHydrating] = useState(false);

  const [stakeAmount, setStakeAmount] = useState('');
  const [unstakeAmount, setUnstakeAmount] = useState('');
  const [netuid, setNetuid] = useState<number>(CONFIG.DEFAULT_NETUID);
  const [unstakeNetuid, setUnstakeNetuid] = useState<number>(CONFIG.DEFAULT_NETUID);
  const [stakeAlphaEstimate, setStakeAlphaEstimate] = useState<string | null>(null);
  const [isStakeEstimateLoading, setIsStakeEstimateLoading] = useState(false);
  const [swapAmount, setSwapAmount] = useState('');
  const [swapSourceNetuid, setSwapSourceNetuid] = useState<number>(CONFIG.DEFAULT_NETUID);
  const [swapTargetNetuid, setSwapTargetNetuid] = useState<number>(19);
  const [swapAlphaEstimate, setSwapAlphaEstimate] = useState<SwapAlphaSimulation | null>(null);
  const [isSwapEstimateLoading, setIsSwapEstimateLoading] = useState(false);
  const [unstakeTaoEstimate, setUnstakeTaoEstimate] = useState<string | null>(null);
  const [isUnstakeEstimateLoading, setIsUnstakeEstimateLoading] = useState(false);
  const [destinationPage, setDestinationPage] = useState(1);
  const [subnetSearchQuery, setSubnetSearchQuery] = useState('');

  const [appView, setAppView] = useState<AppView>(getInitialAppView);
  const [stakingAction, setStakingAction] = useState<StakingAction>('stake');
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('all');
  const [historyPage, setHistoryPage] = useState(1);
  const [historySource, setHistorySource] = useState<HistorySource>('contract');
  const [status, setStatus] = useState<StatusState>({ type: 'idle', msg: '' });
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const historyCacheRef = useRef(new Map<string, HistoryCacheEntry>());
  const historyRequestsRef = useRef(new Map<string, Promise<HistoryCacheEntry>>());
  const isWalletConnectingRef = useRef(false);

  const fetchStats = async (address: string) => {
    try {
      const contractColdkey = getEvmColdkey(CONFIG.CONTRACT_ADDRESS);
      const walletColdkey = getEvmColdkey(address);
      const hotkey = stakedHotkeys[netuid] || getHotkeyForNetuid(netuid);

      const balances: { [id: number]: string } = {};
      const hotkeysMap: { [id: number]: string } = {};

      const [balanceResult, totalAlphaResult, myStakeResult, contractScaleResult, walletScaleResult, subnetInfoResult] =
        await settleRpcBatch(() => [
          activeProvider.getBalance(address),
          stakingPrecompile.getTotalAlphaStaked(hotkey, netuid),
          stakingPrecompile.getStake(hotkey, contractColdkey, netuid),
          activeProvider.send('delegateInfo_getDelegated', [hexToBytes(contractColdkey)]),
          activeProvider.send('delegateInfo_getDelegated', [hexToBytes(walletColdkey)]),
          activeProvider.send('subnetInfo_getAllDynamicInfo', []),
        ]);

      logRejectedRpcResult('TAO balance', balanceResult);
      logRejectedRpcResult('getTotalAlphaStaked', totalAlphaResult);
      logRejectedRpcResult('getStake', myStakeResult);
      logRejectedRpcResult('contract delegation positions', contractScaleResult);
      logRejectedRpcResult('wallet delegation positions', walletScaleResult);
      logRejectedRpcResult('available subnet scan', subnetInfoResult);

      setBalance(balanceResult?.status === 'fulfilled' ? ethers.formatEther(toBigIntOrZero(balanceResult.value)) : '0');
      setTotalAlphaStaked(
        totalAlphaResult?.status === 'fulfilled'
          ? (Number(toBigIntOrZero(totalAlphaResult.value)) / 1e9).toString()
          : '0',
      );
      setMyAlphaBalance(
        myStakeResult?.status === 'fulfilled'
          ? (Number(toBigIntOrZero(myStakeResult.value)) / 1e9).toString()
          : '0',
      );

      const contractPositions =
        contractScaleResult?.status === 'fulfilled' ? decodeDelegations(contractScaleResult.value) : [];
      const walletPositions = walletScaleResult?.status === 'fulfilled' ? decodeDelegations(walletScaleResult.value) : [];
      const subnetCatalog =
        subnetInfoResult?.status === 'fulfilled' ? decodeSubnetCatalog(subnetInfoResult.value) : [];

      if (subnetCatalog.length > 0) {
        setAvailableNetuids(subnetCatalog.map((subnet) => subnet.netuid));
        setSubnetNamesByNetuid(
          subnetCatalog.reduce<{ [netuid: number]: string }>((namesByNetuid, subnet) => {
            namesByNetuid[subnet.netuid] = subnet.name || 'unknown';
            return namesByNetuid;
          }, {}),
        );
      }

      for (const position of contractPositions) {
        if (position.stake > 0) {
          balances[position.netuid] = position.stake.toString();
          hotkeysMap[position.netuid] = position.hotkey;
        }
      }

      for (const position of walletPositions) {
        if (position.stake > 0) {
          const existingStake = balances[position.netuid] ? Number.parseFloat(balances[position.netuid]) : 0;
          balances[position.netuid] = (existingStake + position.stake).toString();
          if (!hotkeysMap[position.netuid]) {
            hotkeysMap[position.netuid] = position.hotkey;
          }
        }
      }

      if (balances[netuid] === undefined) {
        balances[netuid] = '0';
      }

      setAllAlphaBalances(balances);
      setStakedHotkeys(hotkeysMap);
    } catch (error) {
      console.error(error);
    }
  };

  const fetchOnchainHistory = async (address?: string, options: { force?: boolean } = {}) => {
    const cacheKey = getHistoryCacheKey(address);
    const cachedHistory = historyCacheRef.current.get(cacheKey);

    if (!options.force && cachedHistory) {
      setHistorySource(cachedHistory.source);
      setStakeHistory(cachedHistory.events);
      setIsHistoryLoading(false);
      return;
    }

    const pendingHistory = historyRequestsRef.current.get(cacheKey);
    if (!options.force && pendingHistory) {
      setIsHistoryLoading(true);
      try {
        const cachedEntry = await pendingHistory;
        if (historyRequestsRef.current.get(cacheKey) === pendingHistory) {
          setHistorySource(cachedEntry.source);
          setStakeHistory(cachedEntry.events);
        }
      } finally {
        setIsHistoryLoading(false);
      }
      return;
    }

    const historyRequest = (async (): Promise<HistoryCacheEntry> => {
      const targetAddress = address ? normalizeAddress(address) : '';

      const logGroups = await fetchIntentFilledLogGroups(targetAddress || undefined);
      const walletLogGroup = logGroups.find((group) => group.source === 'wallet');
      const contractLogGroup = logGroups.find((group) => group.source === 'contract');
      let historySourceForLogs: HistorySource = walletLogGroup && walletLogGroup.logs.length > 0 ? 'wallet' : 'contract';
      let nextHistory = await decodeOnchainHistoryLogs(
        historySourceForLogs === 'wallet' ? walletLogGroup?.logs ?? [] : contractLogGroup?.logs ?? [],
      );

      if (targetAddress && historySourceForLogs === 'wallet' && nextHistory.length === 0) {
        historySourceForLogs = 'contract';
        nextHistory = await decodeOnchainHistoryLogs(contractLogGroup?.logs ?? []);
      }

      return {
        events: nextHistory,
        source: historySourceForLogs,
      };
    })();

    historyRequestsRef.current.set(cacheKey, historyRequest);
    setIsHistoryLoading(true);

    try {
      const nextHistoryEntry = await historyRequest;
      if (historyRequestsRef.current.get(cacheKey) === historyRequest) {
        historyCacheRef.current.set(cacheKey, nextHistoryEntry);
        setHistorySource(nextHistoryEntry.source);
        setStakeHistory(nextHistoryEntry.events);
      }
    } catch (error) {
      if (historyRequestsRef.current.get(cacheKey) === historyRequest) {
        console.error('Failed to fetch contract-backed history:', error);
        setHistorySource('contract');
        setStakeHistory([]);
      }
    } finally {
      if (historyRequestsRef.current.get(cacheKey) === historyRequest) {
        historyRequestsRef.current.delete(cacheKey);
      }
      setIsHistoryLoading(false);
    }
  };

  useEffect(() => {
    if (surface !== 'app' || appView === 'history' || !provider || !account) return undefined;

    const timer = window.setTimeout(() => {
      if (typeof netuid === 'number' && netuid >= 0) {
        fetchStats(account);
      }
    }, 500);

    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [netuid, account, provider, surface, appView]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDestinationPage(1), 0);
    return () => window.clearTimeout(timer);
  }, [stakingAction, availableNetuids.length, subnetSearchQuery]);

  useEffect(() => {
    if (swapSourceNetuid !== swapTargetNetuid) return undefined;

    const fallbackTarget = [
      ...DISPLAY_SUBNETS.map((subnet) => subnet.netuid),
      ...availableNetuids,
    ].find((candidateNetuid) => candidateNetuid > 0 && candidateNetuid !== swapSourceNetuid);

    if (fallbackTarget !== undefined) {
      const timer = window.setTimeout(() => {
        setSwapTargetNetuid((currentTargetNetuid) =>
          currentTargetNetuid === swapSourceNetuid ? fallbackTarget : currentTargetNetuid,
        );
      }, 0);

      return () => window.clearTimeout(timer);
    }

    return undefined;
  }, [swapSourceNetuid, swapTargetNetuid, availableNetuids]);

  useEffect(() => {
    let cancelled = false;

    if (surface !== 'app' || appView !== 'dashboard' || stakingAction !== 'stake' || !stakeAmount) {
      const clearTimer = window.setTimeout(() => {
        if (cancelled) return;
        setStakeAlphaEstimate(null);
        setIsStakeEstimateLoading(false);
      }, 0);

      return () => {
        cancelled = true;
        window.clearTimeout(clearTimer);
      };
    }

    const loadingTimer = window.setTimeout(() => {
      if (!cancelled) {
        setIsStakeEstimateLoading(true);
      }
    }, 0);

    const estimateTimer = window.setTimeout(() => {
      void simulateStakeAlpha(stakeAmount, netuid).then((estimate) => {
        if (cancelled) return;
        setStakeAlphaEstimate(estimate);
        setIsStakeEstimateLoading(false);
      });
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(loadingTimer);
      window.clearTimeout(estimateTimer);
    };
  }, [stakeAmount, netuid, stakingAction, surface, appView]);

  useEffect(() => {
    const amountToQuote = swapAmount || allAlphaBalances[swapSourceNetuid] || '';
    let cancelled = false;

    if (
      surface !== 'app' ||
      appView !== 'dashboard' ||
      stakingAction !== 'swap' ||
      !amountToQuote ||
      swapSourceNetuid === swapTargetNetuid
    ) {
      const clearTimer = window.setTimeout(() => {
        if (cancelled) return;
        setSwapAlphaEstimate(null);
        setIsSwapEstimateLoading(false);
      }, 0);

      return () => {
        cancelled = true;
        window.clearTimeout(clearTimer);
      };
    }

    const loadingTimer = window.setTimeout(() => {
      if (!cancelled) {
        setIsSwapEstimateLoading(true);
      }
    }, 0);

    const estimateTimer = window.setTimeout(() => {
      void simulateSwapAlpha(swapSourceNetuid, swapTargetNetuid, amountToQuote).then((estimate) => {
        if (cancelled) return;
        setSwapAlphaEstimate(estimate);
        setIsSwapEstimateLoading(false);
      });
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(loadingTimer);
      window.clearTimeout(estimateTimer);
    };
  }, [swapAmount, swapSourceNetuid, swapTargetNetuid, stakingAction, surface, appView, allAlphaBalances]);

  useEffect(() => {
    const amountToQuote = unstakeAmount || allAlphaBalances[unstakeNetuid] || '';
    let cancelled = false;

    if (
      surface !== 'app' ||
      appView !== 'dashboard' ||
      stakingAction !== 'unstake' ||
      !amountToQuote
    ) {
      const clearTimer = window.setTimeout(() => {
        if (cancelled) return;
        setUnstakeTaoEstimate(null);
        setIsUnstakeEstimateLoading(false);
      }, 0);

      return () => {
        cancelled = true;
        window.clearTimeout(clearTimer);
      };
    }

    const loadingTimer = window.setTimeout(() => {
      if (!cancelled) {
        setIsUnstakeEstimateLoading(true);
      }
    }, 0);

    const estimateTimer = window.setTimeout(() => {
      void simulateUnstakeTao(unstakeNetuid, amountToQuote).then((estimate) => {
        if (cancelled) return;
        setUnstakeTaoEstimate(estimate);
        setIsUnstakeEstimateLoading(false);
      });
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(loadingTimer);
      window.clearTimeout(estimateTimer);
    };
  }, [unstakeAmount, unstakeNetuid, stakingAction, surface, appView, allAlphaBalances]);

  const clearWalletState = () => {
    setIsWalletHydrating(false);
    setIsHistoryLoading(false);
    setAccount('');
    setSigner(null);
    setProvider(null);
    setStatus({ type: 'idle', msg: '' });
    setBalance('0');
    setHistorySource('contract');
    setTotalAlphaStaked('0');
    setMyAlphaBalance('0');
    setStakeHistory([]);
    setSessionStakeHistory([]);
    setAllAlphaBalances({});
    setStakedHotkeys({});
    setStakeAlphaEstimate(null);
    setIsStakeEstimateLoading(false);
    setSwapAlphaEstimate(null);
    setIsSwapEstimateLoading(false);
    setUnstakeTaoEstimate(null);
    setIsUnstakeEstimateLoading(false);
    setSubnetNamesByNetuid({});
    setAvailableNetuids(DISPLAY_SUBNETS.map((subnet) => subnet.netuid));
    setDestinationPage(1);
    setSubnetSearchQuery('');
    setWalletType(null);
    setShowWalletModal(false);
    localStorage.removeItem('connected_wallet');
    if (appView === 'history') {
      void fetchOnchainHistory();
    }
  };

  const disconnectWallet = async () => {
    const selectedWallet = walletType || (localStorage.getItem('connected_wallet') as WalletType | null);
    clearWalletState();

    try {
      const ethereumProvider = getInjectedProvider(selectedWallet);

      if (ethereumProvider) {
        await ethereumProvider.request({
          method: 'wallet_revokePermissions',
          params: [{ eth_accounts: {} }],
        });
      }
    } catch (error) {
      console.error('Failed to revoke permissions:', error);
    }
  };

  const connectWallet = async (wallet?: WalletType) => {
    const selectedWallet = wallet || (localStorage.getItem('connected_wallet') as WalletType) || 'metamask';
    const ethereumProvider = getInjectedProvider(selectedWallet);

    if (!ethereumProvider) {
      setIsWalletHydrating(false);
      setStatus({
        type: 'error',
        msg:
          selectedWallet === 'talisman'
            ? 'Talisman wallet not found. Install or enable Talisman, or choose MetaMask.'
            : 'MetaMask not installed',
      });
      return;
    }

    if (isWalletConnectingRef.current) return;
    isWalletConnectingRef.current = true;

    try {
      setIsWalletHydrating(true);
      setStatus({
        type: 'loading',
        msg: `Connecting to ${selectedWallet === 'talisman' ? 'Talisman' : 'MetaMask'}...`,
      });

      const prov = new ethers.BrowserProvider(ethereumProvider as ethers.Eip1193Provider);
      const network = await prov.getNetwork();

      if (network.chainId !== BigInt(CONFIG.NETWORK.chainId)) {
        try {
          await ethereumProvider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: CONFIG.NETWORK.chainId }],
          });
        } catch (switchError: unknown) {
          const isMissingChainError =
            typeof switchError === 'object' &&
            switchError !== null &&
            'code' in switchError &&
            switchError.code === 4902;

          if (isMissingChainError) {
            await ethereumProvider.request({
              method: 'wallet_addEthereumChain',
              params: [CONFIG.NETWORK],
            });
          } else {
            throw switchError;
          }
        }
      }

      await prov.send('eth_requestAccounts', []);
      const nextSigner = await prov.getSigner();
      const address = await nextSigner.getAddress();

      setProvider(prov);
      setSigner(nextSigner);
      setAccount(address);
      setWalletType(selectedWallet);
      localStorage.setItem('connected_wallet', selectedWallet);
      setShowWalletModal(false);
      setStakeHistory([]);
      setSessionStakeHistory([]);
      if (surface === 'app' && appView === 'history') {
        await fetchOnchainHistory(address);
      }

      setIsWalletHydrating(false);
      setStatus({ type: 'idle', msg: '' });
    } catch (error: unknown) {
      console.error(error);
      setIsWalletHydrating(false);
      setStatus({ type: 'error', msg: error instanceof Error ? error.message : 'Failed to connect' });
    } finally {
      isWalletConnectingRef.current = false;
    }
  };

  useEffect(() => {
    const savedWallet = localStorage.getItem('connected_wallet') as WalletType | null;
    if (savedWallet) {
      void Promise.resolve().then(() => connectWallet(savedWallet));
    }

    const ethereumProvider = getInjectedProvider(savedWallet);

    if (!ethereumProvider) {
      return undefined;
    }

    const handleAccountsChanged = (accounts: string[]) => {
      if (accounts.length > 0) {
        connectWallet();
      } else {
        clearWalletState();
      }
    };

    const handleChainChanged = () => {
      window.location.reload();
    };

    const accountsChangedListener = (...args: unknown[]) => {
      const [value] = args;
      const accounts = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
      handleAccountsChanged(accounts);
    };

    const chainChangedListener = () => {
      handleChainChanged();
    };

    if (ethereumProvider.on) {
      ethereumProvider.on('accountsChanged', accountsChangedListener);
      ethereumProvider.on('chainChanged', chainChangedListener);
    }

    return () => {
      if (ethereumProvider.removeListener) {
        ethereumProvider.removeListener('accountsChanged', accountsChangedListener);
        ethereumProvider.removeListener('chainChanged', chainChangedListener);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!status.msg || status.type === 'loading') return undefined;

    const timer = window.setTimeout(() => {
      setStatus((currentStatus) =>
        currentStatus.msg === status.msg && currentStatus.type === status.type
          ? { type: 'idle', msg: '' }
          : currentStatus,
      );
    }, 8000);

    return () => window.clearTimeout(timer);
  }, [status.msg, status.type]);

  const signAndExecuteIntent = async (
    calls: IntentCall[],
    condition: IntentCondition,
    valueToSend: bigint,
  ): Promise<{ txHash: string; blockNumber: number } | null> => {
    if (!signer || !account) return null;

    try {
      const contract = new ethers.Contract(CONFIG.CONTRACT_ADDRESS, CONTRACT_ABI, signer);

      const domain = {
        name: 'SynchronousIntent',
        version: '1',
        chainId: Number(CONFIG.NETWORK.chainId),
        verifyingContract: CONFIG.CONTRACT_ADDRESS,
      };

      const types = {
        Condition: [
          { name: 'asset', type: 'uint8' },
          { name: 'minOutput', type: 'uint256' },
          { name: 'hotkey', type: 'bytes32' },
          { name: 'netuid', type: 'uint16' },
        ],
        Call: [
          { name: 'target', type: 'address' },
          { name: 'callData', type: 'bytes' },
        ],
        Intent: [
          { name: 'user', type: 'address' },
          { name: 'calls', type: 'Call[]' },
          { name: 'condition', type: 'Condition' },
          { name: 'deadline', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
        ],
      };

      const { deadline, nonce } = getIntentTiming();

      const intentValue = {
        user: account,
        calls,
        condition,
        deadline,
        nonce,
      };

      setStatus({ type: 'loading', msg: 'Requesting signature in your wallet...' });
      const signature = await signer.signTypedData(domain, types, intentValue);

      const intentWithSig = {
        ...intentValue,
        signature,
      };

      setStatus({ type: 'loading', msg: 'Broadcasting fillIntent transaction...' });
      const tx = await contract.fillIntent(intentWithSig, '0x', {
        value: valueToSend,
        gasLimit: 800000n,
      });

      setStatus({ type: 'loading', msg: 'Waiting for blockchain confirmation...' });
      const receipt = await tx.wait();

      return {
        txHash: tx.hash,
        blockNumber: receipt?.blockNumber ?? 0,
      };
    } catch (error: unknown) {
      console.error(error);
      const reason =
        typeof error === 'object' && error !== null && 'reason' in error && typeof error.reason === 'string'
          ? error.reason
          : error instanceof Error
            ? error.message
            : 'Transaction failed';
      setStatus({ type: 'error', msg: reason });
      return null;
    }
  };

  const executeStake = async (amount: string, targetNetuid: number, targetHotkey?: string): Promise<boolean> => {
    if (!signer || !amount) return false;

    try {
      setStatus({ type: 'loading', msg: `Preparing stake intent for ${amount} TAO...` });

      const amountInWei = ethers.parseEther(amount);
      const amountInRao = amountInWei / 1000000000n;

      const hotkey =
        targetHotkey && targetHotkey.startsWith('0x') && targetHotkey.length === 66
          ? targetHotkey
          : getHotkeyForNetuid(targetNetuid);

      setStatus({ type: 'loading', msg: 'Fetching Alpha output quote...' });
      const expectedAlpha = await simulateStakeAlpha(amount, targetNetuid);
      if (!expectedAlpha) {
        setStatus({ type: 'error', msg: 'Unable to fetch a price quote for this stake. Please try again.' });
        return false;
      }
      const minOutput = applySlippageFloor(ethers.parseUnits(expectedAlpha, 9));
      if (minOutput <= 0n) {
        setStatus({ type: 'error', msg: 'Quoted output is too small to guarantee a minimum.' });
        return false;
      }

      const calls = [
        {
          target: STAKING_PRECOMPILE_ADDRESS,
          callData: stakingCallInterface.encodeFunctionData('addStake', [hotkey, amountInRao, targetNetuid]),
        },
      ];

      const condition = {
        asset: 1,
        minOutput,
        hotkey,
        netuid: targetNetuid,
      };

      setStatus({ type: 'loading', msg: `Preparing stake intent for ${amount} TAO...` });
      const txResult = await signAndExecuteIntent(calls, condition, amountInWei);
      if (txResult) {
        setSessionStakeHistory((prev) =>
          mergeHistoryEvents(
            [
              {
                type: 'stake',
                title: 'Stake TAO',
                detail: `${getSubnetLabel(targetNetuid)} • Hotkey ${formatShortValue(hotkey, 8, 6)}`,
                amount: `${formatTokenAmount(amount)} TAO`,
                user: account,
                txHash: txResult.txHash,
                blockNumber: txResult.blockNumber,
                timestamp: Date.now(),
              },
            ],
            prev,
          ),
        );
        setStatus({ type: 'success', msg: 'Stake intent executed successfully.' });
        await fetchStats(account);
        await fetchOnchainHistory(account, { force: true });
        return true;
      }

      return false;
    } catch (error: unknown) {
      console.error(error);
      const reason =
        typeof error === 'object' && error !== null && 'reason' in error && typeof error.reason === 'string'
          ? error.reason
          : error instanceof Error
            ? error.message
            : 'Failed to prepare stake';
      setStatus({ type: 'error', msg: reason });
      return false;
    }
  };

  const executeUnstake = async (
    targetNetuid: number,
    amountOrHotkey?: string,
    amountIfHotkeyUsed?: string,
  ): Promise<boolean> => {
    if (!signer) return false;

    try {
      setStatus({ type: 'loading', msg: 'Preparing unstake intent...' });

      let hotkey = getHotkeyForNetuid(targetNetuid);
      let amount = amountOrHotkey;

      if (amountOrHotkey && amountOrHotkey.startsWith('0x') && amountOrHotkey.length === 66) {
        hotkey = amountOrHotkey;
        amount = amountIfHotkeyUsed;
      }

      const truncatedAmount = amount && amount !== '' && Number.parseFloat(amount) > 0
        ? Number.parseFloat(amount).toFixed(9).replace(/\.?0+$/, '')
        : '';

      const quoteAmount = truncatedAmount || allAlphaBalances[targetNetuid] || '';
      if (!quoteAmount || Number.parseFloat(quoteAmount) <= 0) {
        setStatus({ type: 'error', msg: 'Unable to determine an amount to quote for this unstake.' });
        return false;
      }

      setStatus({ type: 'loading', msg: 'Fetching TAO output quote...' });
      const expectedTao = await simulateUnstakeTao(targetNetuid, quoteAmount);
      if (!expectedTao) {
        setStatus({ type: 'error', msg: 'Unable to fetch a price quote for this unstake. Please try again.' });
        return false;
      }
      // condition.minOutput for TAO output is denominated in wei, while the quote is rao.
      const minOutput = applySlippageFloor(ethers.parseUnits(expectedTao, 9)) * 1000000000n;
      if (minOutput <= 0n) {
        setStatus({ type: 'error', msg: 'Quoted output is too small to guarantee a minimum.' });
        return false;
      }

      const callData =
        truncatedAmount
          ? stakingCallInterface.encodeFunctionData('removeStake', [
              hotkey,
              ethers.parseUnits(truncatedAmount, 9),
              targetNetuid,
            ])
          : stakingCallInterface.encodeFunctionData('removeStakeFull', [hotkey, targetNetuid]);

      const calls = [
        {
          target: STAKING_PRECOMPILE_ADDRESS,
          callData,
        },
      ];

      const condition = {
        asset: 0,
        minOutput,
        hotkey: ethers.ZeroHash,
        netuid: 0,
      };

      setStatus({ type: 'loading', msg: 'Preparing unstake intent...' });
      const txResult = await signAndExecuteIntent(calls, condition, 0n);
      if (txResult) {
        setSessionStakeHistory((prev) =>
          mergeHistoryEvents(
            [
              {
                type: 'unstake',
                title: 'Unstake Alpha',
                detail: `${getSubnetLabel(targetNetuid)} • Hotkey ${formatShortValue(hotkey, 8, 6)}`,
                amount: amount && Number.parseFloat(amount) > 0 ? `${formatTokenAmount(amount)} ALPHA` : 'All ALPHA',
                user: account,
                txHash: txResult.txHash,
                blockNumber: txResult.blockNumber,
                timestamp: Date.now(),
              },
            ],
            prev,
          ),
        );
        setStatus({ type: 'success', msg: 'Unstake intent executed successfully.' });
        await fetchStats(account);
        await fetchOnchainHistory(account, { force: true });
        return true;
      }

      return false;
    } catch (error: unknown) {
      console.error(error);
      const reason =
        typeof error === 'object' && error !== null && 'reason' in error && typeof error.reason === 'string'
          ? error.reason
          : error instanceof Error
            ? error.message
            : 'Failed to prepare unstake';
      setStatus({ type: 'error', msg: reason });
      return false;
    }
  };

  const executeSwap = async (
    sourceNetuid: number,
    targetNetuid: number,
    amountOrHotkey: string,
    amountIfHotkeyUsed?: string,
  ): Promise<boolean> => {
    if (!signer || !amountOrHotkey) return false;

    try {
      setStatus({ type: 'loading', msg: 'Preparing subnet rotation intent...' });

      let sourceHotkey = getHotkeyForNetuid(sourceNetuid);
      let targetHotkey = getHotkeyForNetuid(targetNetuid);
      let amount = amountOrHotkey;

      if (amountOrHotkey.startsWith('0x') && amountOrHotkey.length === 66) {
        sourceHotkey = amountOrHotkey;
        targetHotkey = getHotkeyForNetuid(targetNetuid);
        amount = amountIfHotkeyUsed || '';
      }

      const truncatedSwapAmount = Number.parseFloat(amount).toFixed(9).replace(/\.?0+$/, '');
      const amountInRao = ethers.parseUnits(truncatedSwapAmount, 9);

      setStatus({ type: 'loading', msg: 'Fetching Alpha output quote...' });
      const swapEstimate = await simulateSwapAlpha(sourceNetuid, targetNetuid, truncatedSwapAmount);
      if (!swapEstimate) {
        setStatus({ type: 'error', msg: 'Unable to fetch a price quote for this swap. Please try again.' });
        return false;
      }
      const minOutput = applySlippageFloor(ethers.parseUnits(swapEstimate.targetAlpha, 9));
      if (minOutput <= 0n) {
        setStatus({ type: 'error', msg: 'Quoted output is too small to guarantee a minimum.' });
        return false;
      }
      // addStake's amount is baked into the signed calldata, so it must be a safe
      // underestimate of what removeStake will actually yield (the AMM-simulated
      // quote), not a flat haircut off the spot price — otherwise addStake can
      // request more TAO than the contract ends up holding and revert.
      const expectedTaoInRao = applySlippageFloor(ethers.parseUnits(swapEstimate.intermediateTao, 9));
      if (expectedTaoInRao <= 0n) {
        setStatus({ type: 'error', msg: 'Quoted intermediate TAO amount is too small.' });
        return false;
      }

      setStatus({ type: 'loading', msg: 'Preparing subnet rotation intent...' });

      const calls = [
        {
          target: STAKING_PRECOMPILE_ADDRESS,
          callData: stakingCallInterface.encodeFunctionData('removeStake', [
            sourceHotkey,
            amountInRao,
            sourceNetuid,
          ]),
        },
        {
          target: STAKING_PRECOMPILE_ADDRESS,
          callData: stakingCallInterface.encodeFunctionData('addStake', [
            targetHotkey,
            expectedTaoInRao,
            targetNetuid,
          ]),
        },
      ];

      const condition = {
        asset: 1,
        minOutput,
        hotkey: targetHotkey,
        netuid: targetNetuid,
      };

      const txResult = await signAndExecuteIntent(calls, condition, 0n);
      if (txResult) {
        setSessionStakeHistory((prev) =>
          mergeHistoryEvents(
            [
              {
                type: 'swap',
                title: 'Move stake',
                detail: `${getSubnetLabel(sourceNetuid)} → ${getSubnetLabel(targetNetuid)}`,
                amount: `${formatTokenAmount(amount)} ALPHA`,
                user: account,
                txHash: txResult.txHash,
                blockNumber: txResult.blockNumber,
                timestamp: Date.now(),
              },
            ],
            prev,
          ),
        );
        setStatus({ type: 'success', msg: 'Subnet rotation executed successfully.' });
        await fetchStats(account);
        await fetchOnchainHistory(account, { force: true });
        return true;
      }

      return false;
    } catch (error: unknown) {
      console.error(error);
      const reason =
        typeof error === 'object' && error !== null && 'reason' in error && typeof error.reason === 'string'
          ? error.reason
          : error instanceof Error
            ? error.message
            : 'Failed to prepare subnet rotation';
      setStatus({ type: 'error', msg: reason });
      return false;
    }
  };

  const handleBuyAlpha = async () => {
    const hotkey = stakedHotkeys[netuid] || getHotkeyForNetuid(netuid);
    if (await executeStake(stakeAmount, netuid, hotkey)) {
      setStakeAmount('');
      setAppView('history');
    }
  };

  const handleUnstake = async () => {
    const hotkey = stakedHotkeys[unstakeNetuid] || getHotkeyForNetuid(unstakeNetuid);
    if (await executeUnstake(unstakeNetuid, hotkey, unstakeAmount)) {
      setUnstakeAmount('');
      setAppView('history');
    }
  };

  const handleSwap = async () => {
    const amountToSwap = swapAmount !== '' ? swapAmount : allAlphaBalances[swapSourceNetuid] || '0';
    if (!amountToSwap || Number.parseFloat(amountToSwap) <= 0) {
      setStatus({ type: 'error', msg: 'Please enter a valid amount of ALPHA to move.' });
      return;
    }
    if (swapSourceNetuid === swapTargetNetuid) {
      setStatus({ type: 'error', msg: 'Choose a different destination subnet for the move.' });
      return;
    }

    const hotkey = stakedHotkeys[swapSourceNetuid] || getHotkeyForNetuid(swapSourceNetuid);
    if (await executeSwap(swapSourceNetuid, swapTargetNetuid, hotkey, amountToSwap)) {
      setSwapAmount('');
      setAppView('history');
    }
  };

  const openApp = useCallback((view: AppView = 'chat') => {
    setAppView(view);
    if (surface !== 'app') {
      navigate('/app');
    }
    if (view === 'history') {
      void fetchOnchainHistory(account || undefined);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface, account, navigate]);

  // No-op setter kept for context interface compatibility
  const setSurface = useCallback((_v: Surface | ((prev: Surface) => Surface)) => {
    // Surface is now derived from the route; use navigate() instead.
  }, []);

  const activePositions = useMemo(
    () => Object.entries(allAlphaBalances).filter(([, bal]) => Number.parseFloat(bal) > 0),
    [allAlphaBalances],
  );

  const stakingPositions = useMemo<StakingPositionSummary[]>(
    () =>
      activePositions
        .map(([id, bal]) => {
          const targetNetuid = Number(id);

          return {
            netuid: targetNetuid,
            hotkey: stakedHotkeys[targetNetuid] || getHotkeyForNetuid(targetNetuid),
            amount: formatTokenAmount(bal),
            apy: getMockApyForNetuid(targetNetuid),
          };
        })
        .sort((left, right) => Number.parseFloat(right.amount) - Number.parseFloat(left.amount)),
    [activePositions, stakedHotkeys],
  );

  const stakingPositionsByNetuid = useMemo(
    () => new Map(stakingPositions.map((position) => [position.netuid, position])),
    [stakingPositions],
  );

  useEffect(() => {
    if (stakingAction !== 'swap' || activePositions.length === 0) return undefined;

    const timer = window.setTimeout(() => {
      const sourceStillAvailable = activePositions.some(([id]) => Number(id) === swapSourceNetuid);
      if (!sourceStillAvailable) {
        const nextSourceNetuid = activePositions[0]?.[0];
        if (nextSourceNetuid !== undefined) {
          setSwapSourceNetuid(Number(nextSourceNetuid));
        }
      }
    }, 0);

    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stakingAction, swapSourceNetuid, allAlphaBalances]);

  const hasSubnetCatalog = Object.keys(subnetNamesByNetuid).length > 0;
  const getUiSubnetPresentation = (targetNetuid: number): SubnetPresentation => {
    const presentation = getSubnetPresentation(targetNetuid);
    const registeredName = subnetNamesByNetuid[targetNetuid];

    if (registeredName !== undefined || hasSubnetCatalog) {
      return {
        ...presentation,
        name: registeredName || 'unknown',
        category: 'Registered testnet subnet',
      };
    }

    return presentation;
  };

  const getUiSubnetLabel = (targetNetuid: number) => {
    const subnetMeta = getUiSubnetPresentation(targetNetuid);
    return `${subnetMeta.code} - ${subnetMeta.name}`;
  };

  const connectingWallet =
    !account && status.type === 'loading'
      ? WALLET_OPTIONS.find((option) => status.msg.toLowerCase().includes(option.label.toLowerCase()))?.id ?? null
      : null;
  const showStatusBanner = Boolean(status.msg) && !(status.type === 'loading' && (!account || isWalletHydrating));
  const dismissStatusToast = () => setStatus({ type: 'idle', msg: '' });

  const combinedHistory = useMemo(
    () => mergeHistoryEvents(stakeHistory, sessionStakeHistory),
    [stakeHistory, sessionStakeHistory],
  );
  const filteredHistory =
    historyFilter === 'all' ? combinedHistory : combinedHistory.filter((event) => event.type === historyFilter);
  const historyPageCount = Math.max(1, Math.ceil(filteredHistory.length / HISTORY_PAGE_SIZE));
  const currentHistoryPage = Math.min(historyPage, historyPageCount);
  const paginatedHistory = filteredHistory.slice(
    (currentHistoryPage - 1) * HISTORY_PAGE_SIZE,
    currentHistoryPage * HISTORY_PAGE_SIZE,
  );
  const historyPageStart = filteredHistory.length > 0 ? (currentHistoryPage - 1) * HISTORY_PAGE_SIZE + 1 : 0;
  const historyPageEnd = Math.min(currentHistoryPage * HISTORY_PAGE_SIZE, filteredHistory.length);
  const historyNote =
    historySource === 'wallet' && account
      ? `Showing decoded IntentFilled events for ${formatShortValue(account, 6, 4)}.`
      : account
        ? 'No decoded activity for this wallet yet. Showing latest decoded contract events.'
        : 'Showing latest decoded IntentFilled events from the intent contract.';

  const selectedStakeSubnet = getUiSubnetPresentation(netuid);
  const selectedSwapSourceSubnet = getUiSubnetPresentation(swapSourceNetuid);
  const selectedSwapTargetSubnet = getUiSubnetPresentation(swapTargetNetuid);
  const selectedUnstakeSubnet = getUiSubnetPresentation(unstakeNetuid);

  const handleExportHistory = () => {
    const rows = [
      ['Date', 'Type', 'Details', 'Amount', 'User', 'Solver', 'Nonce', 'Status', 'Tx Hash'],
      ...filteredHistory.map((event) => [
        new Date(event.timestamp).toISOString(),
        event.title,
        event.detail,
        event.amount,
        event.user,
        event.solver ?? '',
        event.nonce ?? '',
        'Done',
        event.txHash,
      ]),
    ];
    const csv = rows.map((row) => row.map(escapeCsvValue).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `taochat-history-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const value: AppContextValue = {
    account,
    activePositions,
    allAlphaBalances,
    appView,
    availableNetuids,
    balance,
    connectingWallet,
    currentHistoryPage,
    destinationPage,
    filteredHistory,
    getUiSubnetLabel,
    getUiSubnetPresentation,
    handleBuyAlpha,
    handleExportHistory,
    handleSwap,
    handleUnstake,
    historyFilter,
    historyNote,
    historyPageCount,
    historyPageEnd,
    historyPageStart,
    isHistoryLoading,
    isStakeEstimateLoading,
    isSwapEstimateLoading,
    isUnstakeEstimateLoading,
    isWalletHydrating,
    myAlphaBalance,
    netuid,
    paginatedHistory,
    selectedStakeSubnet,
    selectedSwapSourceSubnet,
    selectedSwapTargetSubnet,
    selectedUnstakeSubnet,
    setAppView,
    setDestinationPage,
    setHistoryFilter,
    setHistoryPage,
    setNetuid,
    setStakeAmount,
    setStakingAction,
    setSubnetSearchQuery,
    setSurface,
    setSwapAmount,
    setSwapSourceNetuid,
    setSwapTargetNetuid,
    setUnstakeAmount,
    setUnstakeNetuid,
    showStatusBanner,
    showWalletModal,
    stakeAlphaEstimate,
    stakeAmount,
    stakingAction,
    stakingPositions,
    stakingPositionsByNetuid,
    status,
    stakedHotkeys,
    subnetSearchQuery,
    surface,
    swapAlphaEstimate,
    swapAmount,
    swapSourceNetuid,
    swapTargetNetuid,
    totalAlphaStaked,
    unstakeAmount,
    unstakeNetuid,
    unstakeTaoEstimate,
    closeWalletModal: () => setShowWalletModal(false),
    connectWallet,
    disconnectWallet,
    dismissStatusToast,
    executeStake,
    executeSwap,
    executeUnstake,
    fetchOnchainHistory,
    openApp,
    openWalletModal: () => setShowWalletModal(true),
    simulateStakeAlpha,
    simulateSwapAlpha,
    simulateUnstakeTao,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
