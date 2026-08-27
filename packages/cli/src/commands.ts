import { SoroStreamClient, toStroops, formatUSDC } from '@sorostream/sdk';
import { createKeypairAdapter } from './wallet.js';

export interface GlobalOptions {
  network: 'mainnet' | 'testnet' | 'futurenet';
  contractId: string;
  rpc: string[];
  secret: string;
}

function createClient(options: GlobalOptions): SoroStreamClient {
  const adapter = createKeypairAdapter(options.secret);
  return new SoroStreamClient({
    network: options.network,
    contractId: options.contractId,
    walletAdapter: adapter,
    rpcUrl: options.rpc.length > 0 ? options.rpc : undefined,
  });
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
