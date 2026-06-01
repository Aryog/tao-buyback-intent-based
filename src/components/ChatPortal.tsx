import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import type { ChatSession, FunctionDeclaration, GenerateContentResult } from '@google/generative-ai';
import { Activity, Send, ShieldAlert, Sparkles, Pencil, Copy, Check } from 'lucide-react';
import { CHAT_WELCOME_MESSAGE, formatChatUid } from '../utils/chatConversations';
import type { ChatConversation, ChatMessage, SubnetPresentation } from '../types';
import { activeProvider, withRpcBackoff } from '../utils/rpc';
import { getHotkeyForNetuid } from '../utils/subnets';
import { ethers } from 'ethers';

interface ChatPortalProps {
  conversation: ChatConversation;
  account: string;
  balance: string;
  myAlphaBalance: string;
  allAlphaBalances: { [id: number]: string };
  currentNetuid: number;
  simulateStakeAlpha: (amount: string, netuid: number) => Promise<string | null>;
  simulateSwapAlpha: (
    sourceNetuid: number,
    targetNetuid: number,
    amount: string,
  ) => Promise<{ targetAlpha: string; intermediateTao: string } | null>;
  simulateUnstakeTao: (netuid: number, amount: string) => Promise<string | null>;
  executeStake: (amount: string, netuid: number) => Promise<boolean>;
  executeUnstake: (netuid: number, amount?: string) => Promise<boolean>;
  executeSwap: (sourceNetuid: number, targetNetuid: number, amount: string) => Promise<boolean>;
  status: { type: 'idle' | 'loading' | 'success' | 'error'; msg: string };
  openWalletSelector: () => void;
  onStartConversation: (conversationId: string, firstPrompt: string) => void;
  onUpdateConversationMessages: (
    conversationId: string,
    updater: (messages: ChatMessage[]) => ChatMessage[],
  ) => void;
  getUiSubnetPresentation: (netuid: number) => SubnetPresentation;
  availableNetuids: number[];
}

const stakeTool: FunctionDeclaration = {
  name: 'initiate_stake',
  description: 'Prepare a UI confirmation for staking TAO into a Bittensor subnet.',
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      amount: { type: SchemaType.STRING, description: 'Amount of TAO to stake, such as "1.5"' },
      netuid: { type: SchemaType.NUMBER, description: 'Target Bittensor netuid, usually 310 by default' },
    },
    required: ['amount', 'netuid'],
  },
};

const unstakeTool: FunctionDeclaration = {
  name: 'initiate_unstake',
  description: 'Prepare a UI confirmation for unstaking Alpha from a Bittensor subnet.',
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      netuid: { type: SchemaType.NUMBER, description: 'Netuid to unstake from, usually 310 by default' },
      amount: {
        type: SchemaType.STRING,
        description: 'Amount of Alpha to unstake. Omit to fully exit the subnet position.',
      },
    },
    required: ['netuid'],
  },
};

const swapTool: FunctionDeclaration = {
  name: 'initiate_swap',
  description:
    'Prepare a UI confirmation for moving Alpha stake from one Bittensor subnet to another on the same chain.',
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      sourceNetuid: { type: SchemaType.NUMBER, description: 'Source netuid that currently holds the Alpha stake' },
      targetNetuid: { type: SchemaType.NUMBER, description: 'Destination netuid that should receive the stake' },
      amount: { type: SchemaType.STRING, description: 'Amount of Alpha to move between the two subnets' },
    },
    required: ['sourceNetuid', 'targetNetuid', 'amount'],
  },
};

const checkBalancesTool: FunctionDeclaration = {
  name: 'check_balances',
  description:
    'Read the user current TAO balance and Alpha balances by netuid so the assistant can answer state-aware questions.',
  parameters: {
    type: SchemaType.OBJECT,
    properties: {},
  },
};

const getSubnetDetailsTool: FunctionDeclaration = {
  name: 'get_subnet_details',
  description: 'Get real-time details about a single Bittensor subnet or all available subnets. Returns the netuid, name, code, category, APY, hotkey, and current Alpha token price.',
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      netuid: {
        type: SchemaType.NUMBER,
        description: 'Optional. The netuid of the specific subnet to retrieve details for. If omitted, retrieves details for all subnets.',
      },
    },
  },
};

const INPUT_HINTS = [
  { label: '↑ Stake', prompt: 'Stake 50 TAO on Subnet 19' },
  { label: '↓ Unstake', prompt: 'Unstake my Subnet 27 position' },
  { label: '⇄ Move', prompt: 'Move 0.03 ALPHA from Subnet 310 to Subnet 395' },
  { label: '↗ Top subnet', prompt: 'What is the top subnet right now?' },
  { label: '⬡ Research', prompt: 'What does Subnet 4 do?' },
];

export default function ChatPortal({
  conversation,
  account,
  balance,
  myAlphaBalance,
  allAlphaBalances,
  currentNetuid,
  simulateStakeAlpha,
  simulateSwapAlpha,
  simulateUnstakeTao,
  executeStake,
  executeUnstake,
  executeSwap,
  status,
  openWalletSelector,
  onStartConversation,
  onUpdateConversationMessages,
  getUiSubnetPresentation,
  availableNetuids,
}: ChatPortalProps) {
  const messages = conversation.messages;
  const [inputByConversationId, setInputByConversationId] = useState<Record<string, string>>({});
  const [loadingConversationId, setLoadingConversationId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chatSessionsRef = useRef<Record<string, ChatSession>>({});
  const input = inputByConversationId[conversation.id] ?? '';
  const loading = loadingConversationId === conversation.id;

  const [editingMessageIndex, setEditingMessageIndex] = useState<number | null>(null);
  const [editingText, setEditingText] = useState<string>('');
  const [copiedMessageIndex, setCopiedMessageIndex] = useState<number | null>(null);

  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  const model = useMemo(
    () =>
      apiKey
        ? new GoogleGenerativeAI(apiKey).getGenerativeModel({
          model: 'gemini-2.5-flash',
          tools: [{ functionDeclarations: [stakeTool, unstakeTool, swapTool, checkBalancesTool, getSubnetDetailsTool] }],
          systemInstruction:
            'You are TaoChat for a Bittensor staking dashboard. Help users stake TAO, unstake Alpha, move positions between Bittensor subnets, and check subnet details. You have access to real-time tools to check wallet balances (check_balances) and get subnet details (get_subnet_details) including the current Alpha token price. Cross-chain deposits are not live yet, so if a user asks about SOL, ETH, bridging, or cross-chain, clearly say it is coming soon and steer them toward the live on-chain staking flows. Be concise, clear, and action-oriented. When the user wants to act, always call the provided tool instead of only describing the action.',
        })
        : null,
    [apiKey],
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [conversation.id]);

  useEffect(() => {
    if (account) {
      // Wallet is connected!
      // Check if there is a stale wallet_connect warning message in current history
      const walletConnectMsgIndex = messages.findIndex(
        (msg) => msg.role === 'model' && msg.action?.type === 'wallet_connect'
      );
      if (walletConnectMsgIndex !== -1) {
        // Find the user message before it
        let userMsgText = '';
        let userMsgIndex = -1;
        for (let i = walletConnectMsgIndex - 1; i >= 0; i--) {
          if (messages[i].role === 'user') {
            userMsgText = messages[i].text;
            userMsgIndex = i;
            break;
          }
        }
        if (userMsgText && userMsgIndex !== -1) {
          // Trigger the resubmission of that user prompt at its index
          handleResubmitMessage(userMsgIndex, userMsgText);
        }
      }
    }
  }, [account, conversation.id, messages]);

  const setConversationInput = (value: string) => {
    setInputByConversationId((previousInputs) => ({
      ...previousInputs,
      [conversation.id]: value,
    }));
  };

  const clearConversationLoading = (conversationId: string) => {
    setLoadingConversationId((currentConversationId) =>
      currentConversationId === conversationId ? null : currentConversationId,
    );
  };

  const updateMessages = (conversationId: string, updater: (currentMessages: ChatMessage[]) => ChatMessage[]) => {
    onUpdateConversationMessages(conversationId, updater);
  };

  const buildChatHistory = (chatMessages: ChatMessage[]) =>
    chatMessages
      .filter(
        (message) =>
          message.text !== CHAT_WELCOME_MESSAGE &&
          !(message.role === 'user' && message.text.startsWith('[System]')),
      )
      .map((message) => ({
        role: message.role,
        parts: [{ text: message.text }],
      }));

  const getChatSession = (activeConversation: ChatConversation, overrideMessages?: ChatMessage[]) => {
    if (!model) return null;

    const existingSession = chatSessionsRef.current[activeConversation.id];
    if (existingSession) return existingSession;

    const messagesToUse = overrideMessages ?? activeConversation.messages;
    const nextSession = model.startChat({ history: buildChatHistory(messagesToUse) });
    chatSessionsRef.current[activeConversation.id] = nextSession;

    return nextSession;
  };

  const handleResubmitMessage = async (indexToReplace: number, newText: string) => {
    const conversationId = conversation.id;
    const updatedMessages = [
      ...messages.slice(0, indexToReplace),
      { role: 'user' as const, text: newText },
    ];
    updateMessages(conversationId, () => updatedMessages);

    delete chatSessionsRef.current[conversationId];

    const prevMessagesHistory = messages.slice(0, indexToReplace);
    const chatSession = getChatSession(conversation, prevMessagesHistory);
    if (!chatSession) return;

    setLoadingConversationId(conversationId);
    try {
      const result = await chatSession.sendMessage(newText);
      await processResponse(result, chatSession, conversationId);
    } catch (error: unknown) {
      console.error(error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      updateMessages(conversationId, (previousMessages) => [
        ...previousMessages,
        {
          role: 'model',
          text: `I hit a network issue while preparing that response: ${errorMessage}`,
        },
      ]);
    } finally {
      clearConversationLoading(conversationId);
    }
  };

  const handleCopyMessage = async (text: string, index: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMessageIndex(index);
      setTimeout(() => {
        setCopiedMessageIndex((current) => current === index ? null : current);
      }, 2000);
    } catch (err) {
      console.error('Failed to copy text:', err);
    }
  };

  const adjustTextareaHeight = () => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  };

  const formatTokenAmount = (value?: string, digits = 6) => {
    if (!value) return '';
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return value;
    return parsed.toFixed(digits).replace(/\.?0+$/, '');
  };

  const chatReady = Boolean(model);
  const hasSubmittedPrompt = messages.some((message) => message.role === 'user' && !message.text.startsWith('[System]'));
  const isIntroState = !hasSubmittedPrompt;

  const dismissAction = (messageIndex: number) => {
    updateMessages(conversation.id, (previousMessages) =>
      previousMessages.map((message, index) => (index === messageIndex ? { ...message, action: undefined } : message)),
    );
  };

  const handleSend = async () => {
    if (!input.trim() || !chatReady) return;

    const userText = input.trim();
    const conversationId = conversation.id;
    onStartConversation(conversationId, userText);
    setConversationInput('');
    updateMessages(conversationId, (previousMessages) => [...previousMessages, { role: 'user', text: userText }]);

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    if (!account) {
      setLoadingConversationId(conversationId);
      setTimeout(() => {
        updateMessages(conversationId, (previousMessages) => [
          ...previousMessages,
          {
            role: 'model',
            text: "It looks like your wallet is not connected. To chat with TaoChat, view subnet stakes, query balances, or execute transactions, please connect your wallet first using the card below.",
            action: { type: 'wallet_connect' } as any,
          },
        ]);
        setLoadingConversationId(null);
      }, 750);
      return;
    }

    const chatSession = getChatSession(conversation);
    if (!chatSession) return;
    setLoadingConversationId(conversationId);

    try {
      const result = await chatSession.sendMessage(userText);
      await processResponse(result, chatSession, conversationId);
    } catch (error: unknown) {
      console.error(error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      updateMessages(conversationId, (previousMessages) => [
        ...previousMessages,
        {
          role: 'model',
          text: `I hit a network issue while preparing that response: ${errorMessage}`,
        },
      ]);
    } finally {
      clearConversationLoading(conversationId);
    }
  };

  const processResponse = async (
    result: GenerateContentResult,
    chatSession: ChatSession,
    conversationId: string,
  ) => {
    const response = result.response;
    const calls = response.functionCalls();

    if (calls && calls.length > 0) {
      for (const call of calls) {
        if (call.name === 'check_balances') {
          if (!account) {
            const functionResponse = {
              name: call.name,
              response: {
                error: 'Wallet not connected. User must connect their wallet first to view balances.',
              },
            };
            const nextResult = await chatSession.sendMessage([{ functionResponse }]);
            await processResponse(nextResult, chatSession, conversationId);
          } else {
            const functionResponse = {
              name: call.name,
              response: {
                taoBalance: balance,
                currentNetuidAlphaBalance: myAlphaBalance,
                allAlphaBalancesByNetuid: allAlphaBalances,
                currentNetuid,
              },
            };
            const nextResult = await chatSession.sendMessage([{ functionResponse }]);
            await processResponse(nextResult, chatSession, conversationId);
          }
        } else if (call.name === 'initiate_stake') {
          const { amount, netuid } = call.args as { amount: string; netuid: number };
          const estimatedAlpha = await simulateStakeAlpha(amount, netuid);
          updateMessages(conversationId, (previousMessages) => [
            ...previousMessages,
            {
              role: 'model',
              text: estimatedAlpha
                ? `I drafted a staking intent for ${amount} TAO into Netuid ${netuid}. Simulation estimates about ${formatTokenAmount(estimatedAlpha)} ALPHA before fees and final execution.`
                : `I drafted a staking intent for ${amount} TAO into Netuid ${netuid}. Review it below and confirm when you are ready.`,
              action: { type: 'stake', amount, netuid, estimatedAlpha: estimatedAlpha ?? undefined },
            },
          ]);
        } else if (call.name === 'initiate_unstake') {
          const { netuid, amount } = call.args as { netuid: number; amount?: string };

          if (!account) {
            const functionResponse = {
              name: call.name,
              response: {
                error: 'Wallet not connected. User must connect their wallet first to view stake balance or unstake.',
              },
            };
            const nextResult = await chatSession.sendMessage([{ functionResponse }]);
            await processResponse(nextResult, chatSession, conversationId);
          } else {
            const alphaOnNetuid = Number.parseFloat(allAlphaBalances[netuid] || '0');
            const amountToQuote = amount || allAlphaBalances[netuid] || '';

            if (alphaOnNetuid <= 0) {
              const functionResponse = {
                name: call.name,
                response: {
                  error: `User has no Alpha staked on netuid ${netuid}.`,
                },
              };
              const nextResult = await chatSession.sendMessage([{ functionResponse }]);
              await processResponse(nextResult, chatSession, conversationId);
            } else {
              const estimatedTao = amountToQuote ? await simulateUnstakeTao(netuid, amountToQuote) : null;
              updateMessages(conversationId, (previousMessages) => [
                ...previousMessages,
                {
                  role: 'model',
                  text: estimatedTao
                    ? `I prepared an unstake intent for ${amount ? `${amount} Alpha` : 'the full Alpha position'} on Netuid ${netuid}. Simulation estimates about ${formatTokenAmount(estimatedTao)} TAO back to your wallet.`
                    : `I prepared an unstake intent for ${amount ? `${amount} Alpha` : 'the full Alpha position'} on Netuid ${netuid}.`,
                  action: { type: 'unstake', netuid, amount, estimatedTao: estimatedTao ?? undefined },
                },
              ]);
            }
          }
        } else if (call.name === 'initiate_swap') {
          const { sourceNetuid, targetNetuid, amount } = call.args as {
            sourceNetuid: number;
            targetNetuid: number;
            amount: string;
          };

          if (!account) {
            const functionResponse = {
              name: call.name,
              response: {
                error: 'Wallet not connected. User must connect their wallet first to view stake balance or move positions.',
              },
            };
            const nextResult = await chatSession.sendMessage([{ functionResponse }]);
            await processResponse(nextResult, chatSession, conversationId);
          } else {
            const alphaOnSource = Number.parseFloat(allAlphaBalances[sourceNetuid] || '0');

            if (sourceNetuid === targetNetuid) {
              const functionResponse = {
                name: call.name,
                response: {
                  error: 'Source and destination netuid must be different for a subnet rotation.',
                },
              };
              const nextResult = await chatSession.sendMessage([{ functionResponse }]);
              await processResponse(nextResult, chatSession, conversationId);
            } else if (alphaOnSource < Number.parseFloat(amount)) {
              const functionResponse = {
                name: call.name,
                response: {
                  error: `User only has ${alphaOnSource} Alpha on source Netuid ${sourceNetuid}.`,
                },
              };
              const nextResult = await chatSession.sendMessage([{ functionResponse }]);
              await processResponse(nextResult, chatSession, conversationId);
            } else {
              const simulation = await simulateSwapAlpha(sourceNetuid, targetNetuid, amount);

              updateMessages(conversationId, (previousMessages) => [
                ...previousMessages,
                {
                  role: 'model',
                  text: simulation
                    ? `I prepared a subnet rotation: move ${amount} ALPHA from Netuid ${sourceNetuid} to Netuid ${targetNetuid}. Simulation estimates about ${formatTokenAmount(simulation.targetAlpha)} ALPHA on the destination.`
                    : `I prepared a subnet rotation: move ${amount} ALPHA from Netuid ${sourceNetuid} to Netuid ${targetNetuid}. Review it below and confirm when you are ready.`,
                  action: {
                    type: 'swap',
                    netuid: sourceNetuid,
                    targetNetuid,
                    amount,
                    estimatedAlpha: simulation?.targetAlpha,
                    intermediateTao: simulation?.intermediateTao,
                  },
                },
              ]);
            }
          }
        } else if (call.name === 'get_subnet_details') {
          const { netuid } = call.args as { netuid?: number };

          let subnetsInfo: any[];

          if (typeof netuid === 'number') {
            // Single subnet — fetch live price via RPC
            const presentation = getUiSubnetPresentation(netuid);
            let alphaPrice = 'unavailable';
            try {
              const priceRes = await withRpcBackoff(() => activeProvider.send('swap_currentAlphaPrice', [netuid]));
              if (priceRes) {
                alphaPrice = ethers.formatUnits(priceRes, 9);
              }
            } catch (err) {
              console.error(`Failed to get price for netuid ${netuid}:`, err);
            }
            subnetsInfo = [{
              netuid,
              name: presentation.name,
              code: presentation.code,
              category: presentation.category || 'N/A',
              apy: presentation.apy || 'N/A',
              hotkey: getHotkeyForNetuid(netuid),
              alphaPriceInTao: alphaPrice,
            }];
          } else {
            // All subnets — use local metadata only, no RPC calls
            subnetsInfo = availableNetuids.map((id) => {
              const presentation = getUiSubnetPresentation(id);
              return {
                netuid: id,
                name: presentation.name,
                code: presentation.code,
                category: presentation.category || 'N/A',
                apy: presentation.apy || 'N/A',
                hotkey: getHotkeyForNetuid(id),
              };
            });
          }

          const functionResponse = {
            name: call.name,
            response: { subnets: subnetsInfo },
          };
          const nextResult = await chatSession.sendMessage([{ functionResponse }]);
          await processResponse(nextResult, chatSession, conversationId);
        }
      }
    } else {
      const text = response.text();
      if (text) {
        updateMessages(conversationId, (previousMessages) => [...previousMessages, { role: 'model', text }]);
      }
    }
  };

  const handleAction = async (action: NonNullable<ChatMessage['action']>) => {
    const chatSession = getChatSession(conversation);
    if (!chatSession) return;

    const conversationId = conversation.id;

    // Snapshot balances before execution so we can report changes
    const preTaoBal = balance;
    const preAlphaBals = { ...allAlphaBalances };

    if (action.type === 'stake' && action.amount) {
      const success = await executeStake(action.amount, action.netuid);
      if (success) {
        const estimateInfo = action.estimatedAlpha
          ? ` The estimated Alpha received is ~${formatTokenAmount(action.estimatedAlpha)} ALPHA on Netuid ${action.netuid}.`
          : '';
        const balanceInfo = ` Before the transaction, the user had ${formatTokenAmount(preTaoBal)} TAO and ${formatTokenAmount(preAlphaBals[action.netuid] || '0')} ALPHA on Netuid ${action.netuid}. They spent ${action.amount} TAO.`;

        updateMessages(conversationId, (previousMessages) => [
          ...previousMessages,
          { role: 'user', text: `[System] Stake confirmed for ${action.amount} TAO on Netuid ${action.netuid}.` },
        ]);
        setLoadingConversationId(conversationId);
        try {
          const result = await chatSession.sendMessage(
            `The staking transaction of ${action.amount} TAO into Netuid ${action.netuid} succeeded.${estimateInfo}${balanceInfo} Tell the user the transaction was successful and report how much Alpha they received (use the estimated amount). Summarize the value changes clearly.`,
          );
          await processResponse(result, chatSession, conversationId);
        } finally {
          clearConversationLoading(conversationId);
        }
      }
    } else if (action.type === 'unstake') {
      const preAlphaOnNetuid = preAlphaBals[action.netuid] || '0';
      const success = await executeUnstake(action.netuid, action.amount);
      if (success) {

        const estimateInfo = action.estimatedTao
          ? ` The estimated TAO received is ~${formatTokenAmount(action.estimatedTao)} TAO.`
          : '';
        const balanceInfo = ` Before the transaction, the user had ${formatTokenAmount(preTaoBal)} TAO and ${formatTokenAmount(preAlphaOnNetuid)} ALPHA on Netuid ${action.netuid}. They unstaked ${action.amount ? `${formatTokenAmount(action.amount)} ALPHA` : 'their full ALPHA position'}.`;
        const message = action.amount
          ? `Unstake confirmed for ${formatTokenAmount(action.amount)} Alpha from Netuid ${action.netuid}.`
          : `Full unstake confirmed from Netuid ${action.netuid}.`;

        updateMessages(conversationId, (previousMessages) => [
          ...previousMessages,
          { role: 'user', text: `[System] ${message}` },
        ]);
        setLoadingConversationId(conversationId);
        try {
          const result = await chatSession.sendMessage(
            `The unstaking transaction from Netuid ${action.netuid} succeeded.${estimateInfo}${balanceInfo} Tell the user the transaction was successful and report how much TAO they received back (use the estimated amount). Summarize the value changes clearly.`,
          );
          await processResponse(result, chatSession, conversationId);
        } finally {
          clearConversationLoading(conversationId);
        }
      }
    } else if (action.type === 'swap' && action.targetNetuid !== undefined && action.amount) {
      const preSourceAlpha = preAlphaBals[action.netuid] || '0';
      const preTargetAlpha = preAlphaBals[action.targetNetuid] || '0';
      const success = await executeSwap(action.netuid, action.targetNetuid, action.amount);
      if (success) {
        const estimateInfo = action.estimatedAlpha
          ? ` The estimated Alpha received on Netuid ${action.targetNetuid} is ~${formatTokenAmount(action.estimatedAlpha)} ALPHA.`
          : '';
        const routeInfo = action.intermediateTao
          ? ` The route converted through ~${formatTokenAmount(action.intermediateTao)} TAO.`
          : '';
        const balanceInfo = ` Before the transaction: Netuid ${action.netuid} had ${formatTokenAmount(preSourceAlpha)} ALPHA, Netuid ${action.targetNetuid} had ${formatTokenAmount(preTargetAlpha)} ALPHA. The user moved ${formatTokenAmount(action.amount)} ALPHA from Netuid ${action.netuid}.`;

        updateMessages(conversationId, (previousMessages) => [
          ...previousMessages,
          {
            role: 'user',
            text: `[System] Stake move confirmed for ${formatTokenAmount(action.amount)} Alpha from Netuid ${action.netuid} to Netuid ${action.targetNetuid}.`,
          },
        ]);
        setLoadingConversationId(conversationId);
        try {
          const result = await chatSession.sendMessage(
            `The subnet rotation of ${formatTokenAmount(action.amount)} Alpha from Netuid ${action.netuid} to Netuid ${action.targetNetuid} succeeded.${estimateInfo}${routeInfo}${balanceInfo} Tell the user the transaction was successful and report how much Alpha they received on the destination subnet (use the estimated amount). Summarize the value changes clearly.`,
          );
          await processResponse(result, chatSession, conversationId);
        } finally {
          clearConversationLoading(conversationId);
        }
      }
    }
  };

  return (
    <div className={`chat-wrap ${isIntroState ? 'chat-wrap--intro' : 'chat-wrap--conversation'}`}>
      <div className="chat-head">
        <div className="chat-head-l">
          {isIntroState ? (
            <span className="chat-head-l__empty" aria-hidden="true" />
          ) : (
            <div className="chat-title-meta" title={conversation.id}>
              <span className="chat-title-uid">UID {formatChatUid(conversation.id)}</span>
              <h1 className="ch-title">{conversation.title}</h1>
            </div>
          )}
        </div>
      </div>

      <div className={`chat-body ${isIntroState ? 'chat-body--intro' : 'chat-body--conversation'}`}>
        {isIntroState && (
          <div className="chat-inline-banner">
            <ShieldAlert size={16} />
            <span>Live today: Bittensor EVM testnet staking, unstaking, and subnet rotation. External-chain deposits are coming soon.</span>
          </div>
        )}

        <div className={isIntroState ? 'chat-intro-grid' : 'chat-conversation-grid'}>
          <div className="chat-msgs">
            {messages.map((message, index) => (
              <div key={`${message.role}-${index}`} className={`msg ${message.role === 'user' ? 'user' : ''}`}>
                <div className={`av ${message.role === 'user' ? 'av-u' : 'av-b'}`}>
                  {message.role === 'user' ? 'U' : <Sparkles size={15} />}
                </div>

                <div className={`bub ${message.role === 'user' ? 'user' : 'bot'} ${editingMessageIndex === index ? 'editing' : ''}`}>
                  {message.role === 'user' && editingMessageIndex === index ? (
                    <div className="bub-edit-container">
                      <textarea
                        className="bub-edit-textarea"
                        value={editingText}
                        onChange={(e) => setEditingText(e.target.value)}
                        autoFocus
                      />
                      <div className="bub-edit-actions">
                        <button
                          type="button"
                          className="btn-confirm"
                          onClick={() => {
                            if (editingText.trim()) {
                              handleResubmitMessage(index, editingText.trim());
                              setEditingMessageIndex(null);
                            }
                          }}
                        >
                          Save & Submit
                        </button>
                        <button
                          type="button"
                          className="btn-cancel"
                          onClick={() => setEditingMessageIndex(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="chat-markdown">
                        <ReactMarkdown>{message.text}</ReactMarkdown>
                      </div>

                      {message.role === 'user' && !message.text.startsWith('[System]') && (
                        <div className="user-msg-actions">
                          <button
                            type="button"
                            className="user-msg-action-btn"
                            title="Edit prompt"
                            onClick={() => {
                              setEditingMessageIndex(index);
                              setEditingText(message.text);
                            }}
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            type="button"
                            className="user-msg-action-btn"
                            title="Copy prompt"
                            onClick={() => handleCopyMessage(message.text, index)}
                          >
                            {copiedMessageIndex === index ? (
                              <Check size={13} style={{ color: '#10b981' }} />
                            ) : (
                              <Copy size={13} />
                            )}
                          </button>
                        </div>
                      )}
                    </>
                  )}

                  {message.action && message.action.type === 'wallet_connect' && (
                    <button
                      type="button"
                      className="btn-confirm"
                      style={{ marginTop: '10px', padding: '8px 18px', fontSize: '13px', borderRadius: '8px', width: 'auto' }}
                      onClick={openWalletSelector}
                    >
                      Connect Wallet →
                    </button>
                  )}

                  {message.action && message.action.type !== 'wallet_connect' && (
                    <div className="tcard">
                      <div className="tcard-head">
                        <span className="tcard-head-ic">
                          {message.action.type === 'stake' ? '↑' : message.action.type === 'unstake' ? '↓' : '⇄'}
                        </span>
                        <span className="tcard-head-t">
                          {message.action.type === 'stake'
                            ? 'Stake confirmation'
                            : message.action.type === 'unstake'
                              ? 'Unstake confirmation'
                              : 'Subnet rotation'}
                        </span>
                      </div>

                      <div className="tcard-body">
                        {message.action.type === 'stake' && (
                          <>
                            <div className="trow">
                              <span className="trow-k">Action</span>
                              <span className="trow-v">Stake TAO</span>
                            </div>
                            <div className="trow">
                              <span className="trow-k">Amount</span>
                              <span className="trow-v">{message.action.amount} TAO</span>
                            </div>
                            <div className="trow">
                              <span className="trow-k">Subnet</span>
                              <span className="trow-v trow-vo">Netuid {message.action.netuid}</span>
                            </div>
                            <div className="trow">
                              <span className="trow-k">Estimated receive</span>
                              <span className="trow-v trow-vg">
                                {message.action.estimatedAlpha
                                  ? `≈${formatTokenAmount(message.action.estimatedAlpha)} ALPHA`
                                  : 'Simulation unavailable'}
                              </span>
                            </div>
                          </>
                        )}

                        {message.action.type === 'unstake' && (
                          <>
                            <div className="trow">
                              <span className="trow-k">Action</span>
                              <span className="trow-v">Unstake ALPHA</span>
                            </div>
                            <div className="trow">
                              <span className="trow-k">Amount</span>
                              <span className="trow-v">{message.action.amount ? `${message.action.amount} ALPHA` : 'All ALPHA'}</span>
                            </div>
                            <div className="trow">
                              <span className="trow-k">From</span>
                              <span className="trow-v trow-vo">Netuid {message.action.netuid}</span>
                            </div>
                            <div className="trow">
                              <span className="trow-k">Estimated receive</span>
                              <span className="trow-v trow-vg">
                                {message.action.estimatedTao
                                  ? `≈${formatTokenAmount(message.action.estimatedTao)} TAO`
                                  : 'Simulation unavailable'}
                              </span>
                            </div>
                          </>
                        )}

                        {message.action.type === 'swap' && (
                          <>
                            <div className="trow">
                              <span className="trow-k">Action</span>
                              <span className="trow-v">Move ALPHA</span>
                            </div>
                            <div className="trow">
                              <span className="trow-k">Amount</span>
                              <span className="trow-v">{message.action.amount} ALPHA</span>
                            </div>
                            <div className="trow">
                              <span className="trow-k">From</span>
                              <span className="trow-v">Netuid {message.action.netuid}</span>
                            </div>
                            <div className="trow">
                              <span className="trow-k">To</span>
                              <span className="trow-v trow-vo">Netuid {message.action.targetNetuid}</span>
                            </div>
                            <div className="trow">
                              <span className="trow-k">Estimated receive</span>
                              <span className="trow-v trow-vg">
                                {message.action.estimatedAlpha
                                  ? `≈${formatTokenAmount(message.action.estimatedAlpha)} ALPHA`
                                  : 'Simulation unavailable'}
                              </span>
                            </div>
                            {message.action.intermediateTao && (
                              <div className="trow">
                                <span className="trow-k">Route value</span>
                                <span className="trow-v">via ≈{formatTokenAmount(message.action.intermediateTao)} TAO</span>
                              </div>
                            )}
                          </>
                        )}
                      </div>

                      <div className="tcard-actions">
                        <button
                          type="button"
                          className="btn-confirm"
                          onClick={() => {
                            if (!account) {
                              openWalletSelector();
                            } else if (message.action) {
                              handleAction(message.action);
                            }
                          }}
                          disabled={status.type === 'loading'}
                        >
                          {!account
                            ? 'Connect wallet to execute'
                            : message.action.type === 'stake'
                              ? 'Confirm & stake →'
                              : message.action.type === 'unstake'
                                ? 'Confirm & unstake →'
                                : 'Confirm move →'}
                        </button>
                        <button type="button" className="btn-cancel" onClick={() => dismissAction(index)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {loading && (
              <div className="thinking-row">
                <Activity size={16} />
                Consulting the network...
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          <div className="chat-input-area">
            <div className="input-hints">
              {INPUT_HINTS.map((hint) => (
                <button key={hint.label} type="button" className="hint" onClick={() => setConversationInput(hint.prompt)}>
                  {hint.label}
                </button>
              ))}
            </div>

            <div className="chat-input-row">
              <textarea
                ref={textareaRef}
                rows={1}
                className="chat-textarea"
                placeholder={!chatReady ? 'Add VITE_GEMINI_API_KEY to enable live chat...' : 'Ask TaoChat anything — stake, unstake, swap, research…'}
                value={input}
                onChange={(event) => {
                  setConversationInput(event.target.value);
                  adjustTextareaHeight();
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    handleSend();
                  }
                }}
                disabled={loading || !chatReady}
              />
              <button
                type="button"
                className="send-btn"
                onClick={handleSend}
                disabled={loading || !input.trim() || !chatReady}
              >
                <Send size={16} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
