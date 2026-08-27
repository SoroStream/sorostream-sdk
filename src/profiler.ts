import {
  Contract,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import type { Network } from './types.js';

const NETWORK_PASSPHRASES: Record<Network, string> = {
  mainnet: 'Public Global Stellar Network ; September 2015',
  testnet: 'Test SDF Network ; September 2015',
  futurenet: 'Test SDF Future Network ; October 2022',
};

const RPC_URLS: Record<Network, string> = {
  mainnet: 'https://soroban.stellar.org',
  testnet: 'https://soroban-testnet.stellar.org',
  futurenet: 'https://rpc-futurenet.stellar.org',
};

export interface SimulationProfile {
  operationType: string;
  params: Record<string, unknown>;
  cpuInstructions: string;
  minFee: string;
  ledgerReads: number;
  ledgerWrites: number;
  contractEntryBytesRead: number;
  contractEntryBytesWritten: number;
  success: boolean;
  error?: string;
}

export interface ProfileReport {
  profiles: SimulationProfile[];
  summary: {
    totalCpuInstructions: bigint;
    totalMinFee: bigint;
    totalLedgerReads: number;
    totalLedgerWrites: number;
    averageCpuInstructions: bigint;
    averageMinFee: bigint;
  };
}

export interface ProfilerConfig {
  rpcUrl?: string;
  contractId: string;
  network: Network;
  publicKey: string;
}

export class GasProfiler {
  private readonly server: rpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;
  private readonly publicKey: string;

  constructor(config: ProfilerConfig) {
    this.server = new rpc.Server(config.rpcUrl ?? RPC_URLS[config.network], { allowHttp: false });
    this.contract = new Contract(config.contractId);
    this.networkPassphrase = NETWORK_PASSPHRASES[config.network];
    this.publicKey = config.publicKey;
  }

  async profileCreateStream(params: {
    sender: string;
    recipient: string;
    token: string;
    amount: bigint;
    durationSeconds: number;
    autoRenew: boolean;
  }): Promise<SimulationProfile> {
    return this.simulateAndProfile(
      'create_stream',
      {
        sender: params.sender,
        recipient: params.recipient,
        token: params.token,
        amount: params.amount.toString(),
        durationSeconds: params.durationSeconds,
        autoRenew: params.autoRenew,
      },
      () => {
        return this.contract.call(
          'create_stream',
          nativeToScVal(params.sender, { type: 'address' }),
          nativeToScVal(params.recipient, { type: 'address' }),
          nativeToScVal(params.token, { type: 'address' }),
          nativeToScVal(params.amount, { type: 'i128' }),
          nativeToScVal(params.durationSeconds, { type: 'u64' }),
          nativeToScVal(params.autoRenew, { type: 'bool' }),
        );
      },
    );
  }

  async profileWithdraw(params: {
    streamId: string;
    recipient: string;
  }): Promise<SimulationProfile> {
    return this.simulateAndProfile(
      'withdraw',
      {
        streamId: params.streamId,
        recipient: params.recipient,
      },
      () => {
        return this.contract.call(
          'withdraw',
          nativeToScVal(BigInt(params.streamId), { type: 'u64' }),
          nativeToScVal(params.recipient, { type: 'address' }),
        );
      },
    );
  }

  async profileCancelStream(params: {
    streamId: string;
    sender: string;
  }): Promise<SimulationProfile> {
    return this.simulateAndProfile(
      'cancel_stream',
      {
        streamId: params.streamId,
        sender: params.sender,
      },
      () => {
        return this.contract.call(
          'cancel_stream',
          nativeToScVal(BigInt(params.streamId), { type: 'u64' }),
          nativeToScVal(params.sender, { type: 'address' }),
        );
      },
    );
  }

  async profileTopUp(params: {
    streamId: string;
    sender: string;
    amount: bigint;
  }): Promise<SimulationProfile> {
    return this.simulateAndProfile(
      'top_up',
      {
        streamId: params.streamId,
        sender: params.sender,
        amount: params.amount.toString(),
      },
      () => {
        return this.contract.call(
          'top_up',
          nativeToScVal(BigInt(params.streamId), { type: 'u64' }),
          nativeToScVal(params.sender, { type: 'address' }),
          nativeToScVal(params.amount, { type: 'i128' }),
        );
      },
    );
  }

  async profileGetStream(streamId: string): Promise<SimulationProfile> {
    return this.simulateAndProfile('get_stream', { streamId }, () => {
      return this.contract.call('get_stream', nativeToScVal(BigInt(streamId), { type: 'u64' }));
    });
  }

  async profileGetClaimable(streamId: string): Promise<SimulationProfile> {
    return this.simulateAndProfile('get_claimable', { streamId }, () => {
      return this.contract.call('get_claimable', nativeToScVal(BigInt(streamId), { type: 'u64' }));
    });
  }

  async profileGetStreamsBySender(sender: string): Promise<SimulationProfile> {
    return this.simulateAndProfile('get_streams_by_sender', { sender }, () => {
      return this.contract.call(
        'get_streams_by_sender',
        nativeToScVal(sender, { type: 'address' }),
      );
    });
  }

  async profileGetStreamsByRecipient(recipient: string): Promise<SimulationProfile> {
    return this.simulateAndProfile('get_streams_by_recipient', { recipient }, () => {
      return this.contract.call(
        'get_streams_by_recipient',
        nativeToScVal(recipient, { type: 'address' }),
      );
    });
  }

  /**
   * Run multiple profiles and return a combined report.
   */
  async batchProfile(profiles: Array<() => Promise<SimulationProfile>>): Promise<ProfileReport> {
    const results = await Promise.all(profiles.map((p) => p()));
    return this.buildReport(results);
  }

  private buildReport(profiles: SimulationProfile[]): ProfileReport {
    const totalCpu = profiles.reduce(
      (sum, p) => sum + (p.success ? BigInt(p.cpuInstructions) : 0n),
      0n,
    );
    const totalFee = profiles.reduce((sum, p) => sum + (p.success ? BigInt(p.minFee) : 0n), 0n);
    const totalReads = profiles.reduce((sum, p) => sum + (p.success ? p.ledgerReads : 0), 0);
    const totalWrites = profiles.reduce((sum, p) => sum + (p.success ? p.ledgerWrites : 0), 0);
    const successCount = profiles.filter((p) => p.success).length;

    return {
      profiles,
      summary: {
        totalCpuInstructions: totalCpu,
        totalMinFee: totalFee,
        totalLedgerReads: totalReads,
        totalLedgerWrites: totalWrites,
        averageCpuInstructions: successCount > 0 ? totalCpu / BigInt(successCount) : 0n,
        averageMinFee: successCount > 0 ? totalFee / BigInt(successCount) : 0n,
      },
    };
  }

  private async simulateAndProfile(
    operationType: string,
    params: Record<string, unknown>,
    buildOp: () => xdr.Operation | Promise<xdr.Operation>,
  ): Promise<SimulationProfile> {
    try {
      const account = await this.server.getAccount(this.publicKey);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(await buildOp())
        .setTimeout(30)
        .build();

      const result = await this.server.simulateTransaction(tx);

      if (rpc.Api.isSimulationError(result)) {
        return {
          operationType,
          params,
          cpuInstructions: '0',
          minFee: '0',
          ledgerReads: 0,
          ledgerWrites: 0,
          contractEntryBytesRead: 0,
          contractEntryBytesWritten: 0,
          success: false,
          error: (result as rpc.Api.SimulateTransactionErrorResponse).error ?? 'Simulation error',
        };
      }

      const success = result as rpc.Api.SimulateTransactionSuccessResponse;
      // `cost` and `footprint` are not part of the typed interface in SDK v13;
      // access them defensively via `any` for backwards compatibility.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = success as any;
      const cost = raw.cost ?? {
        cpuInsns: '0',
        memBytes: '0',
        minFee: success.minResourceFee ?? '0',
      };
      const footprint = raw.footprint ?? {
        readOnly: [] as xdr.LedgerKey[],
        readWrite: [] as xdr.LedgerKey[],
      };

      const readOnlyKeys = footprint.readOnly ?? [];
      const readWriteKeys = footprint.readWrite ?? [];

      const ledgerReads = readOnlyKeys.length + readWriteKeys.length;
      const ledgerWrites = readWriteKeys.length;
      const minFee = cost.minFee ?? success.minResourceFee ?? '0';

      return {
        operationType,
        params,
        cpuInstructions: '0',
        minFee,
        ledgerReads,
        ledgerWrites,
        contractEntryBytesRead: 0,
        contractEntryBytesWritten: 0,
        success: true,
      };
    } catch (err) {
      return {
        operationType,
        params,
        cpuInstructions: '0',
        minFee: '0',
        ledgerReads: 0,
        ledgerWrites: 0,
        contractEntryBytesRead: 0,
        contractEntryBytesWritten: 0,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
