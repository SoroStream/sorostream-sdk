import { SoroStreamClient, toStroops, formatUSDC, assertStellarAddress } from '@sorostream/sdk';
import { createKeypairAdapter } from './wallet.js';
import * as readline from 'node:readline';
import { printOutput, type OutputFormat } from './output.js';

export const SECRET_FLAG_DEPRECATION_WARNING =
  'Warning: Passing a Stellar secret key via -s/--secret is deprecated because CLI arguments are exposed in shell history and process listings (ps / /proc/<pid>/cmdline). Use the SOROSTREAM_SECRET environment variable or the interactive masked prompt instead.';

export interface GlobalOptions {
  network: 'mainnet' | 'testnet' | 'futurenet';
  contractId: string;
  rpc: string[];
  secret?: string;
  /** True when --secret was explicitly supplied as a command-line flag. */
  secretFromCliFlag?: boolean;
  transport?: any;
  /** Output format for command results (default: json). */
  output?: OutputFormat;
}

export async function resolveSecret(opts: {
  secret?: string;
  secretFromCliFlag?: boolean;
}): Promise<string> {
  if (opts.secretFromCliFlag && opts.secret) {
    console.warn(SECRET_FLAG_DEPRECATION_WARNING);
  }
  if (opts.secret && opts.secret.trim().length > 0) {
    return opts.secret.trim();
  }
  const envSecret = process.env.SOROSTREAM_SECRET?.trim();
  if (envSecret) {
    return envSecret;
  }
  const prompted = await promptMasked('Stellar secret key: ');
  if (!prompted) {
    throw new Error(
      'Missing Stellar secret key: set the SOROSTREAM_SECRET environment variable or enter it at the interactive prompt.',
    );
  }
  return prompted;
}

async function createClient(options: GlobalOptions): Promise<SoroStreamClient> {
  const secret = await resolveSecret(options);
  options.secret = secret;
  const adapter = createKeypairAdapter(secret);
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

export function promptMasked(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  }) as readline.Interface & { _writeToOutput?: (s: string) => void; stdoutMuted?: boolean };

  rl._writeToOutput = function _writeToOutput(stringToWrite: string) {
    if (rl.stdoutMuted) {
      if (stringToWrite.includes('\n') || stringToWrite.includes('\r')) {
        process.stdout.write('\n');
      } else {
        process.stdout.write('*');
      }
    } else {
      process.stdout.write(stringToWrite);
    }
  };

  return new Promise<string>((resolve, reject) => {
    rl.stdoutMuted = false;
    rl.question(question, (answer: string) => {
      rl.stdoutMuted = false;
      rl.close();
      resolve(answer.trim());
    });
    rl.stdoutMuted = true;
    rl.on('error', reject);
  });
}

export async function cmdStreamCreate(opts: StreamCreateOptions): Promise<void> {
  const client = await createClient(opts);

  const params = await resolveCreateParams(opts);

  const result = await client.createStream({
    recipient: assertStellarAddress(params.recipient),
    token: assertStellarAddress(params.token),
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
  printOutput({ streamId: result.streamId, txHash: result.txHash }, opts.output);
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
  const client = await createClient(opts);

  const result = await client.createStream({
    recipient: assertStellarAddress(opts.recipient),
    token: assertStellarAddress(opts.token),
    amount: toStroops(opts.amount),
    durationSeconds: opts.duration,
    autoRenew: opts.autoRenew,
  });

  printOutput(result, opts.output);
}

export async function cmdGet(opts: GlobalOptions, streamId: string): Promise<void> {
  const client = await createClient(opts);
  const stream = await client.getStream(streamId);
  printOutput(stream, opts.output);
}

export async function cmdWithdraw(opts: GlobalOptions, streamId: string): Promise<void> {
  const client = await createClient(opts);
  const result = await client.withdraw({ streamId });
  printOutput(result, opts.output);
}

export async function cmdCancel(opts: GlobalOptions, streamId: string): Promise<void> {
  const client = await createClient(opts);
  const result = await client.cancelStream({ streamId });
  printOutput(result, opts.output);
}

export async function cmdTopUp(
  opts: GlobalOptions & { amount: string },
  streamId: string,
): Promise<void> {
  const client = await createClient(opts);
  const result = await client.topUp({
    streamId,
    amount: toStroops(opts.amount),
  });
  printOutput({ ...result, newEndTime: result.newEndTime.toISOString() }, opts.output);
}

export async function cmdClaimable(opts: GlobalOptions, streamId: string): Promise<void> {
  const client = await createClient(opts);
  const claimable = await client.getClaimable(streamId);
  printOutput({ claimable: claimable.toString(), usdc: formatUSDC(claimable) }, opts.output);
}

export async function cmdForecast(opts: GlobalOptions, streamId: string): Promise<void> {
  const client = await createClient(opts);
  const forecast = await client.getRenewalForecast(streamId);
  if (!forecast) {
    printOutput(
      { forecast: null, message: 'Stream does not auto-renew or is cancelled' },
      opts.output,
    );
    return;
  }
  printOutput(
    {
      nextRenewalDate: forecast.nextRenewalDate.toISOString(),
      amount: forecast.amount.toString(),
      usdc: formatUSDC(forecast.amount),
      nextEndTime: forecast.nextEndTime.toISOString(),
    },
    opts.output,
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
  const client = await createClient(opts);
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
    const keypairAdapter = createKeypairAdapter(opts.secret!);
    const publicKey = await keypairAdapter.getPublicKey();
    result = await client.getStreamsBySender(publicKey, {
      limit: opts.limit,
      cursor: opts.cursor,
      activeOnly: opts.status === 'active',
    });
  }

  printOutput(result, opts.output);
}
