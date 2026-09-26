import { SoroStreamClient, toStroops, formatUSDC } from '@sorostream/sdk';
import { createKeypairAdapter } from './wallet.js';
import * as readline from 'node:readline';

export interface GlobalOptions {
  network: 'mainnet' | 'testnet' | 'futurenet';
  contractId: string;
  rpc: string[];
  secret: string;
  transport?: any;
}

function createClient(options: GlobalOptions): SoroStreamClient {
  const adapter = createKeypairAdapter(options.secret);
  return new SoroStreamClient({
    network: options.network,
    contractId: options.contractId,
    walletAdapter: adapter,
    rpcUrl: options.rpc.length > 0 ? options.rpc[0] : undefined,
    transport: options.transport,
  });
}

export interface StreamCreateOptions extends GlobalOptions {
  recipient?: string;
  token?: string;
  amount?: string;
  duration?: number;
  autoRenew?: boolean;
  /** When true, all params must come from flags (CI use); no interactive prompts. */
  json?: boolean;
}

/**
 * Resolved, validated stream-creation parameters ready for the SDK.
 */
interface ResolvedCreateParams {
  recipient: string;
  token: string;
  amount: string;
  duration: number;
  autoRenew: boolean;
}

/**
 * Prompts the user for the fields required to create a stream, using
 * Node's built-in `readline` so no extra dependency is needed.
 *
 * When `opts.json` is true, every field must already be supplied via flags —
 * missing values throw an error instead of prompting, so the command is
 * safe to run non-interactively in CI.
 */
export async function resolveCreateParams(
  opts: StreamCreateOptions,
): Promise<ResolvedCreateParams> {
  const recipient = opts.recipient ?? (opts.json ? undefined : await prompt('Recipient address: '));
  const token = opts.token ?? (opts.json ? undefined : await prompt('Token contract address: '));
  const amount = opts.amount ?? (opts.json ? undefined : await prompt('Amount in USDC: '));
  const durationStr =
    opts.duration !== undefined
      ? String(opts.duration)
      : opts.json
        ? undefined
        : await prompt('Duration in seconds: ');
  const autoRenew = opts.autoRenew ?? false;

  if (!recipient || !token || !amount || durationStr === undefined) {
    throw new Error(
      'stream create: --json requires --recipient, --token, --amount, and --duration',
    );
  }

  const duration = Number(durationStr);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`stream create: invalid duration "${durationStr}"`);
  }

  return { recipient, token, amount, duration, autoRenew };
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise<string>((resolve, reject) => {
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
    rl.on('error', reject);
  });
}

export async function cmdStreamCreate(opts: StreamCreateOptions): Promise<void> {
  const client = createClient(opts);

  const params = await resolveCreateParams(opts);

  const result = await client.createStream({
    recipient: params.recipient,
    token: params.token,
    amount: toStroops(params.amount),
    durationSeconds: params.duration,
    autoRenew: params.autoRenew,
  });

  // createStream can return a dry-run description when dryRun is opted into;
  // the CLI never opts in, so narrow to the { streamId, txHash } shape.
  if (!result || typeof (result as { streamId?: string }).streamId !== 'string') {
    throw new Error('stream create: unexpected createStream result shape');
  }

  // Surface the new stream ID and transaction hash prominently.
  console.log(JSON.stringify({ streamId: result.streamId, txHash: result.txHash }, null, 2));
}

export async function cmdCreate(
  opts: GlobalOptions & {
    recipient: string;
    token: string;
    amount: string;
    duration: number;
    autoRenew: boolean;
  },
): Promise<void> {
  const client = createClient(opts);

  const result = await client.createStream({
    recipient: opts.recipient,
    token: opts.token,
    amount: toStroops(opts.amount),
    durationSeconds: opts.duration,
    autoRenew: opts.autoRenew,
  });

  console.log(JSON.stringify(result, null, 2));
}

export async function cmdGet(opts: GlobalOptions, streamId: string): Promise<void> {
  const client = createClient(opts);
  const stream = await client.getStream(streamId);
  console.log(JSON.stringify(stream, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
}

export async function cmdWithdraw(opts: GlobalOptions, streamId: string): Promise<void> {
  const client = createClient(opts);
  const result = await client.withdraw({ streamId });
  console.log(JSON.stringify(result, null, 2));
}

export async function cmdCancel(opts: GlobalOptions, streamId: string): Promise<void> {
  const client = createClient(opts);
  const result = await client.cancelStream({ streamId });
  console.log(JSON.stringify(result, null, 2));
}

export async function cmdTopUp(
  opts: GlobalOptions & { amount: string },
  streamId: string,
): Promise<void> {
  const client = createClient(opts);
  const result = await client.topUp({
    streamId,
    amount: toStroops(opts.amount),
  });
  console.log(JSON.stringify({ ...result, newEndTime: result.newEndTime.toISOString() }, null, 2));
}

export async function cmdClaimable(opts: GlobalOptions, streamId: string): Promise<void> {
  const client = createClient(opts);
  const claimable = await client.getClaimable(streamId);
  console.log(
    JSON.stringify({ claimable: claimable.toString(), usdc: formatUSDC(claimable) }, null, 2),
  );
}

export async function cmdForecast(opts: GlobalOptions, streamId: string): Promise<void> {
  const client = createClient(opts);
  const forecast = await client.getRenewalForecast(streamId);
  if (!forecast) {
    console.log(
      JSON.stringify(
        { forecast: null, message: 'Stream does not auto-renew or is cancelled' },
        null,
        2,
      ),
    );
    return;
  }
  console.log(
    JSON.stringify(
      {
        nextRenewalDate: forecast.nextRenewalDate.toISOString(),
        amount: forecast.amount.toString(),
        usdc: formatUSDC(forecast.amount),
        nextEndTime: forecast.nextEndTime.toISOString(),
      },
      null,
      2,
    ),
  );
}

export async function cmdList(
  opts: GlobalOptions & {
    sender?: string;
    recipient?: string;
    status?: 'active' | 'cancelled' | 'completed';
    limit?: number;
    cursor?: string;
  },
): Promise<void> {
  const client = createClient(opts);
  let result: any = [];

  if (opts.sender) {
    result = await client.getStreamsBySender(opts.sender, {
      limit: opts.limit,
      cursor: opts.cursor,
      activeOnly: opts.status === 'active',
    });
  } else if (opts.recipient) {
    result = await client.getStreamsByRecipient(
      opts.recipient,
      { limit: opts.limit, cursor: opts.cursor },
      { activeOnly: opts.status === 'active' },
    );
  } else {
    const keypairAdapter = createKeypairAdapter(opts.secret);
    const publicKey = await keypairAdapter.getPublicKey();
    result = await client.getStreamsBySender(publicKey, {
      limit: opts.limit,
      cursor: opts.cursor,
      activeOnly: opts.status === 'active',
    });
  }

  console.log(JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
}
