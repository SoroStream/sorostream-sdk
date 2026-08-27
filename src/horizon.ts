/**
 * Horizon API integration for transaction history lookup (issue #200).
 *
 * Provides methods to retrieve historical stream transactions from the Stellar Horizon API.
 */

import type { Network } from './types.js';
import { isValidStellarAddress } from './utils.js';
import { InvalidAddressError } from './errors.js';

const HORIZON_URLS: Record<Network, string> = {
  mainnet: 'https://horizon.stellar.org',
  testnet: 'https://horizon-testnet.stellar.org',
  futurenet: 'https://horizon-futurenet.stellar.org',
};

/**
 * A single stream-related transaction from Horizon.
 */
export interface StreamTransaction {
  /** Transaction hash. */
  hash: string;
  /** Ledger number. */
  ledger: number;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** Source account that submitted the transaction. */
  sourceAccount: string;
  /** Operation type (e.g., "invoke_host_function"). */
  operationType: string;
  /** Stream-specific operation details if available. */
  streamDetails?: {
    streamId?: string;
    amount?: string;
    recipient?: string;
    sender?: string;
  };
}

/**
 * Paginated transaction history response.
 */
export interface TransactionHistoryPage {
  /** Transactions in this page. */
  transactions: StreamTransaction[];
  /** Cursor for fetching the next page. */
  nextCursor: string | null;
  /** Whether more pages are available. */
  hasMore: boolean;
}

/**
 * Options for transaction history queries.
 */
export interface TransactionHistoryOptions {
  /** Maximum number of results per page (default: 10, max: 200). */
  limit?: number;
  /** Pagination cursor from a previous response. */
  cursor?: string;
  /** Optional contract ID filter for stream-related operations. */
  contractId?: string;
}

/**
 * Fetches transaction history for a specific stream ID.
 *
 * @param streamId - The stream ID to query
 * @param network - The Stellar network to query
 * @param options - Pagination and filter options
 * @returns Paginated transaction history
 *
 * @example
 * ```ts
 * const history = await getTransactionHistory("123", "testnet", { limit: 20 });
 * console.log(`Found ${history.transactions.length} transactions`);
 *
 * if (history.hasMore) {
 *   const nextPage = await getTransactionHistory("123", "testnet", {
 *     cursor: history.nextCursor
 *   });
 * }
 * ```
 */
export async function getTransactionHistory(
  streamId: string,
  network: Network,
  options: TransactionHistoryOptions = {},
): Promise<TransactionHistoryPage> {
  const { limit = 10, cursor, contractId } = options;
  const horizonUrl = HORIZON_URLS[network];

  // Issue #458: sanitise the caller-supplied contract ID before it is
  // interpolated into the Horizon request URL, so a malformed value fails
  // with a clear SDK error instead of an opaque Horizon 400 (or worse,
  // altering the request path/query).
  if (contractId !== undefined && !isValidStellarAddress(contractId)) {
    throw new InvalidAddressError(contractId);
  }

  // Build query parameters
  const params = new URLSearchParams({
    limit: Math.min(limit, 200).toString(),
    order: 'desc',
  });

  if (cursor) {
    params.set('cursor', cursor);
  }

  // Note: This is a simplified implementation. In production, you would need to:
  // 1. Query operations for the contract
  // 2. Filter by stream ID in the operation details
  // 3. Parse contract invocation results

  const url = contractId
    ? `${horizonUrl}/accounts/${contractId}/operations?${params}`
    : `${horizonUrl}/operations?${params}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Horizon API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  // Parse Horizon response into our format
  const transactions: StreamTransaction[] = [];

  for (const record of data._embedded?.records ?? []) {
    // Filter for stream-related operations
    if (record.type === 'invoke_host_function') {
      // Check if this operation relates to our stream
      // In a real implementation, you'd parse the contract invocation details
      const streamDetails = parseStreamOperation(record, streamId);

      if (streamDetails !== null) {
        transactions.push({
          hash: record.transaction_hash,
          ledger: record.ledger,
          createdAt: record.created_at,
          sourceAccount: record.source_account,
          operationType: record.type,
          streamDetails: streamDetails ?? undefined,
        });
      }
    }
  }

  // Extract next cursor from Horizon links
  const nextLink = data._links?.next?.href;
  const nextCursor = nextLink ? new URL(nextLink).searchParams.get('cursor') : null;

  return {
    transactions,
    nextCursor,
    hasMore: !!nextCursor,
  };
}

/**
 * Fetches all stream-related transactions for a given address.
 *
 * @param address - The Stellar address to query
 * @param network - The Stellar network to query
 * @param options - Pagination and filter options
 * @returns Paginated transaction history
 *
 * @example
 * ```ts
 * const activity = await getAddressActivity("GUSER...", "mainnet");
 * for (const tx of activity.transactions) {
 *   console.log(`${tx.operationType} at ${tx.createdAt}`);
 * }
 * ```
 */
export async function getAddressActivity(
  address: string,
  network: Network,
  options: TransactionHistoryOptions = {},
): Promise<TransactionHistoryPage> {
  const { limit = 10, cursor, contractId } = options;
  const horizonUrl = HORIZON_URLS[network];

  // Issue #458: sanitise caller-supplied addresses before they are
  // interpolated into the Horizon request URL.
  if (!isValidStellarAddress(address)) {
    throw new InvalidAddressError(address);
  }
  if (contractId !== undefined && !isValidStellarAddress(contractId)) {
    throw new InvalidAddressError(contractId);
  }

  const params = new URLSearchParams({
    limit: Math.min(limit, 200).toString(),
    order: 'desc',
  });

  if (cursor) {
    params.set('cursor', cursor);
  }

  const url = `${horizonUrl}/accounts/${address}/operations?${params}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Horizon API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const transactions: StreamTransaction[] = [];

  for (const record of data._embedded?.records ?? []) {
    if (record.type === 'invoke_host_function') {
      // Filter by contract if specified
      if (contractId && record.contract !== contractId) {
        continue;
      }

      const streamDetails = parseStreamOperation(record);

      transactions.push({
        hash: record.transaction_hash,
        ledger: record.ledger,
        createdAt: record.created_at,
        sourceAccount: record.source_account,
        operationType: record.type,
        streamDetails: streamDetails ?? undefined,
      });
    }
  }

  const nextLink = data._links?.next?.href;
  const nextCursor = nextLink ? new URL(nextLink).searchParams.get('cursor') : null;

  return {
    transactions,
    nextCursor,
    hasMore: !!nextCursor,
  };
}

/**
 * Parses a Horizon operation record to extract stream-specific details.
 * This is a helper function that would need contract-specific parsing logic.
 */
function parseStreamOperation(
  record: Record<string, unknown>,
  filterStreamId?: string,
): StreamTransaction['streamDetails'] | null {
  // In a real implementation, you would:
  // 1. Parse the function name from the operation
  // 2. Decode the parameters based on the function
  // 3. Extract stream ID, amounts, addresses, etc.
  // 4. Filter by streamId if provided

  // Placeholder implementation
  const functionName = record.function as string;

  // Check if this is a stream-related function
  const streamFunctions = [
    'create_stream',
    'withdraw',
    'cancel_stream',
    'top_up',
    'update_flow_rate',
    'transfer_stream',
    'pause_stream',
    'resume_stream',
  ];

  if (!functionName || !streamFunctions.includes(functionName)) {
    return null;
  }

  // If filtering by stream ID, check if this operation matches
  // (In real implementation, parse parameters to extract stream ID)

  return {
    // These would be parsed from the actual operation parameters
    streamId: undefined,
    amount: undefined,
    recipient: undefined,
    sender: record.source_account as string,
  };
}
