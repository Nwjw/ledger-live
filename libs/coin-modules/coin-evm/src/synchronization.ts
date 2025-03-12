import { log } from "@ledgerhq/logs";
import BigNumber from "bignumber.js";
import {
  decodeAccountId,
  decodeTokenAccountId,
  emptyHistoryCache,
  encodeAccountId,
  encodeTokenAccountId,
  generateHistoryFromOperations,
} from "@ledgerhq/coin-framework/account/index";
import {
  AccountShapeInfo,
  GetAccountShape,
  makeSync,
  mergeOps,
  mergeNfts,
} from "@ledgerhq/coin-framework/bridge/jsHelpers";
import { Account, Operation, TokenAccount, isSandbox } from "@ledgerhq/types-live";
import { decodeOperationId } from "@ledgerhq/coin-framework/operation";
import { nftsFromOperations } from "@ledgerhq/coin-framework/nft/helpers";
import { CryptoCurrency, TokenCurrency } from "@ledgerhq/types-cryptoassets";
import { attachOperations, getSyncHash, mergeSubAccounts, createSwapHistoryMap } from "./logic";
import { ExplorerApi } from "./api/explorer/types";
import { getExplorerApi } from "./api/explorer";
import { getNodeApi } from "./api/node/index";

export const SAFE_REORG_THRESHOLD = 80;

export const getAccountShape: GetAccountShape<Account> = async (infos, { blacklistedTokenIds }) => {
  const { initialAccount, address, derivationMode, currency } = infos;
  const nodeApi = getNodeApi(currency);
  const isSandboxMode = initialAccount && isSandbox(initialAccount);

  let latestBlock, balance, blockHeight;
  if (isSandboxMode) {
    latestBlock = { height: 1000 };
    // Use the last operation's value as the balance if available, else default
    const userAmount = initialAccount?.operations?.[0]?.value || new BigNumber(1000); // Fallback to 1000
    balance = userAmount;
    blockHeight = latestBlock.height;

    const lastCoinOperations = [
      {
        id: `${encodeAccountId({ type: "js", version: "2", currencyId: currency.id, xpubOrAddress: address, derivationMode })}-tx1`,
        hash: "mock-tx-hash-1",
        type: "IN",
        value: userAmount, // Reflects user input
        fee: new BigNumber(0),
        date: new Date("2025-03-01"),
        senders: ["sandbox-sender"],
        recipients: [address],
      },
    ];
    const lastTokenOperations = [];
    const lastNftOperations = [];
    const lastInternalOperations = [];
    
    const accountId = encodeAccountId({
      type: "js",
      version: "2",
      currencyId: currency.id,
      xpubOrAddress: address,
      derivationMode,
    });
    const syncHash = getSyncHash(currency, blacklistedTokenIds);
    const operations = lastCoinOperations; // Initial ops for sandbox

    return {
      type: "Account",
      id: accountId,
      syncHash,
      balance,
      spendableBalance: balance,
      blockHeight,
      operations,
      operationsCount: operations.length,
      subAccounts: [],
      nfts: [],
      lastSyncDate: new Date(),
      balanceHistoryCache: generateHistoryFromOperations(operations), // Stabilize graph
    } as Partial<Account>;
  }

  // Non-sandbox logic
  [latestBlock, balance] = await Promise.all([
    nodeApi.getBlockByHeight(currency, "latest"),
    nodeApi.getCoinBalance(currency, address),
  ]);
  blockHeight = latestBlock.height;
  const accountId = encodeAccountId({
    type: "js",
    version: "2",
    currencyId: currency.id,
    xpubOrAddress: address,
    derivationMode,
  });
  const syncHash = getSyncHash(currency, blacklistedTokenIds);
  const shouldSyncFromScratch =
    syncHash !== initialAccount?.syncHash || initialAccount === undefined;
  const latestSyncedHeight = shouldSyncFromScratch ? 0 : initialAccount.blockHeight;

  const { lastCoinOperations, lastTokenOperations, lastNftOperations, lastInternalOperations } =
    await (async (): ReturnType<ExplorerApi["getLastOperations"]> => {
      try {
        const { getLastOperations } = getExplorerApi(currency);
        return await getLastOperations(
          currency,
          address,
          accountId,
          Math.max(latestSyncedHeight - SAFE_REORG_THRESHOLD, 0),
          blockHeight,
        );
      } catch (e) {
        log("EVM Family", "Failed to get latest transactions", { address, currency, error: e });
        throw e;
      }
    })();

  const swapHistoryMap = createSwapHistoryMap(initialAccount);
  const newSubAccounts = await getSubAccounts(
    infos,
    accountId,
    lastTokenOperations,
    blacklistedTokenIds,
    swapHistoryMap,
  );
  const subAccounts = shouldSyncFromScratch
    ? newSubAccounts
    : mergeSubAccounts(initialAccount, newSubAccounts);

  const confirmPendingOperations =
    initialAccount?.pendingOperations?.map(op => getOperationStatus(currency, op, initialAccount)) || [];
  const confirmedOperations = await Promise.all(confirmPendingOperations).then(ops =>
    ops.filter((op): op is Operation => !!op),
  );

  const lastCoinOperationsWithAttachements = attachOperations(
    lastCoinOperations,
    lastTokenOperations,
    lastNftOperations,
    lastInternalOperations,
    { blacklistedTokenIds },
  );
  const newOperations = [...confirmedOperations, ...lastCoinOperationsWithAttachements];
  const operations =
    shouldSyncFromScratch || !initialAccount?.operations
      ? newOperations
      : mergeOps(initialAccount?.operations, newOperations);
  const operationsWithPendings = mergeOps(operations, initialAccount?.pendingOperations || []);

  const nfts = mergeNfts(
    initialAccount?.nfts || [],
    nftsFromOperations(operationsWithPendings),
  ).filter(nft => nft.amount.gt(0));

  return {
    type: "Account",
    id: accountId,
    syncHash,
    balance,
    spendableBalance: balance,
    blockHeight,
    operations,
    operationsCount: operations.length,
    subAccounts,
    nfts,
    lastSyncDate: new Date(),
    balanceHistoryCache: generateHistoryFromOperations(operations), // For non-sandbox too
  } as Partial<Account>;
};

/**
 * Getting all token related operations in order to provide TokenAccounts
 */
export const getSubAccounts = async (
  infos: AccountShapeInfo<Account>,
  accountId: string,
  lastTokenOperations: Operation[],
  blacklistedTokenIds: string[] = [],
  swapHistoryMap: Map<TokenCurrency, TokenAccount["swapHistory"]>,
): Promise<Partial<TokenAccount>[]> => {
  const { currency } = infos;

  // Creating a Map of Operations by TokenCurrencies in order to know which TokenAccounts should be synced as well
  const erc20OperationsByToken = lastTokenOperations.reduce<Map<TokenCurrency, Operation[]>>(
    (acc, operation) => {
      const { accountId } = decodeOperationId(operation.id);
      const { token } = decodeTokenAccountId(accountId);
      if (!token || blacklistedTokenIds.includes(token.id)) return acc;

      if (!acc.has(token)) {
        acc.set(token, []);
      }
      acc.get(token)?.push(operation);

      return acc;
    },
    new Map<TokenCurrency, Operation[]>(),
  );

  // Fetching all TokenAccounts possible and providing already filtered operations
  const subAccountsPromises: Promise<Partial<TokenAccount>>[] = [];
  for (const [token, ops] of erc20OperationsByToken.entries()) {
    const swapHistory = swapHistoryMap.get(token) || [];
    subAccountsPromises.push(getSubAccountShape(currency, accountId, token, ops, swapHistory));
  }

  return Promise.all(subAccountsPromises);
};

/**
 * Fetch the balance for a token and creates a TokenAccount based on this and the provided operations
 */
export const getSubAccountShape = async (
  currency: CryptoCurrency,
  parentId: string,
  token: TokenCurrency,
  operations: Operation[],
  swapHistory: TokenAccount["swapHistory"],
): Promise<Partial<TokenAccount>> => {
  const nodeApi = getNodeApi(currency);
  const { xpubOrAddress: address } = decodeAccountId(parentId);
  const tokenAccountId = encodeTokenAccountId(parentId, token);
  const balance = await nodeApi.getTokenBalance(currency, address, token.contractAddress);

  return {
    type: "TokenAccount",
    id: tokenAccountId,
    parentId,
    token,
    balance,
    spendableBalance: balance,
    creationDate: new Date(),
    operations,
    operationsCount: operations.length,
    pendingOperations: [],
    balanceHistoryCache: emptyHistoryCache,
    swapHistory,
  };
};

/**
 * Get a finalized operation depending on it status (confirmed or not)
 */
export const getOperationStatus = async (
  currency: CryptoCurrency,
  op: Operation,
  account: Account  | null = null,
): Promise<Operation | null> => {
  try {
    if(account && isSandbox(account)){
      console.log("YES BABY!")
      console.log(op)
      return {
        ...op,
        transactionSequenceNumber: 0, // Mock
        blockHash: "", // Mock
        blockHeight: 0, // Mock
        date: new Date(), // Mock
        subOperations: op.subOperations?.map(subOp => ({
          ...subOp,
          transactionSequenceNumber: nonce,
          blockHash,
          blockHeight,
          date,
        })),
        nftOperations: op.nftOperations?.map(nftOp => ({
          ...nftOp,
          transactionSequenceNumber: nonce,
          blockHash,
          blockHeight,
          date,
        })),
      } as Operation;
    }
    const nodeApi = getNodeApi(currency);
    const { blockHeight, blockHash, nonce, gasPrice, gasUsed, value } =
      await nodeApi.getTransaction(currency, op.hash);

    if (!blockHeight) {
      throw new Error("getOperationStatus: Transaction has no block");
    }

    const { timestamp } = await nodeApi.getBlockByHeight(currency, blockHeight);
    const date = new Date(timestamp);
    const fee = new BigNumber(gasPrice).multipliedBy(gasUsed);

    return {
      ...op,
      transactionSequenceNumber: nonce,
      blockHash,
      blockHeight,
      date,
      fee,
      value: new BigNumber(value).plus(fee),
      subOperations: op.subOperations?.map(subOp => ({
        ...subOp,
        transactionSequenceNumber: nonce,
        blockHash,
        blockHeight,
        date,
      })),
      nftOperations: op.nftOperations?.map(nftOp => ({
        ...nftOp,
        transactionSequenceNumber: nonce,
        blockHash,
        blockHeight,
        date,
      })),
    } as Operation;
  } catch (e) {
    return null;
  }
};

/**
 * After each sync, it might be necessary to remove pending operations
 * inside of subAccounts.
 */
export const postSync = (initial: Account, synced: Account): Account => {
  // Get the latest nonce from the synced account
  const lastOperation = synced.operations.find(op => ["OUT", "FEES", "NFT_OUT"].includes(op.type));
  const latestNonce = lastOperation?.transactionSequenceNumber || -1;
  // Set of ids from the already existing subAccount from previous sync
  const initialSubAccountsIds = new Set();
  for (const subAccount of initial.subAccounts || []) {
    initialSubAccountsIds.add(subAccount.id);
  }
  const initialPendingOperations = initial.pendingOperations || [];
  const { operations } = synced;
  const pendingOperations = initialPendingOperations.filter(
    op =>
      !operations.some(o => o.hash === op.hash) &&
      op.transactionSequenceNumber !== undefined &&
      op.transactionSequenceNumber > latestNonce,
  );
  // Set of hashes from the pending operations of the main account
  const coinPendingOperationsHashes = new Set();
  for (const op of pendingOperations) {
    coinPendingOperationsHashes.add(op.hash);
  }

  return {
    ...synced,
    pendingOperations,
    subAccounts:
      synced.subAccounts?.map(subAccount => {
        // If the subAccount is new, just return the freshly synced subAccount
        if (!initialSubAccountsIds.has(subAccount.id)) return subAccount;

        return {
          ...subAccount,
          pendingOperations: subAccount.pendingOperations.filter(
            tokenPendingOperation =>
              // if the pending operation got removed from the main account, remove it as well
              coinPendingOperationsHashes.has(tokenPendingOperation.hash) &&
              // if the transaction has been confirmed, remove it
              !subAccount.operations.some(op => op.hash === tokenPendingOperation.hash) &&
              // if the nonce is still lower than the last one in operations, keep it
              tokenPendingOperation.transactionSequenceNumber !== undefined &&
              tokenPendingOperation.transactionSequenceNumber > latestNonce,
          ),
        };
      }) || [],
  };
};

export const sync = makeSync({
  getAccountShape,
  postSync,
  shouldMergeOps: false,
});
