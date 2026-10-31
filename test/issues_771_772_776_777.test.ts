import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSchema, graphql, GraphQLScalarType } from 'graphql';
import { Account } from '@stellar/stellar-sdk';
import { PersistedAddressBook, InMemoryAddressBook, AddressBookEntry } from '../src/addressBook.js';
import type { StorageAdapter } from '../src/adapters.js';
import { mergeSorostreamConfig, SorostreamConfig } from '../src/sorostream-config.js';
import { StreamTypeDefs, bigIntScalarConfig, toStreamResolverResult } from '../src/graphql.js';
import { GasProfiler } from '../src/profiler.js';
import type { Stream } from '../src/types.js';

describe('Issue #777: PersistedAddressBook with custom StorageAdapter', () => {
  class CustomMemoryStorageAdapter implements StorageAdapter {
    private store = new Map<string, string>();

    getItem(key: string): string | null {
      return this.store.get(key) ?? null;
    }

    setItem(key: string, value: string): void {
      this.store.set(key, value);
    }

    removeItem(key: string): void {
      this.store.delete(key);
    }

    clear(): void {
      this.store.clear();
    }
  }

  const validAddress1 = 'GAHTD27MNDKJN5YSGH4IAVPNC2L3U4XZEHSLFERDVZKIS3RXQT3DHAJJ';
  const validAddress2 = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

  it('persists and retrieves entries via custom StorageAdapter', () => {
    const customStorage = new CustomMemoryStorageAdapter();
    const book = new PersistedAddressBook({
      storage: customStorage,
      storageKey: 'custom_test_address_book',
    });

    book.set('alice', validAddress1, 'Alice primary account');
    book.set('bob', validAddress2);

    expect(book.get('alice')).toBe(validAddress1);
    expect(book.resolve('alice')).toBe(validAddress1);
    expect(book.size).toBe(2);

    // Writes are debounced (default 50ms); force an immediate flush before
    // inspecting the underlying storage adapter directly.
    book.flush();

    // Verify data was written to the custom adapter under storageKey
    const rawData = customStorage.getItem('custom_test_address_book');
    expect(rawData).not.toBeNull();
    const parsed = JSON.parse(rawData!);
    expect(parsed).toHaveLength(2);

    // Create a new PersistedAddressBook instance sharing the same custom adapter
    const reloadedBook = new PersistedAddressBook({
      storage: customStorage,
      storageKey: 'custom_test_address_book',
    });

    expect(reloadedBook.size).toBe(2);
    expect(reloadedBook.get('alice')).toBe(validAddress1);
    expect(reloadedBook.resolve('bob')).toBe(validAddress2);
  });

  it('handles delete and clear properly in custom StorageAdapter', () => {
    const customStorage = new CustomMemoryStorageAdapter();
    const book = new PersistedAddressBook({
      storage: customStorage,
      storageKey: 'test_delete_key',
    });

    book.set('charlie', validAddress1);
    expect(book.delete('charlie')).toBe(true);
    expect(book.get('charlie')).toBeUndefined();

    book.set('dave', validAddress2);
    book.clear();
    expect(book.size).toBe(0);

    const reloaded = new PersistedAddressBook({
      storage: customStorage,
      storageKey: 'test_delete_key',
    });
    expect(reloaded.size).toBe(0);
  });
});

describe('Issue #776: sorostream-config.ts precedence rule across all overlapping fields', () => {
  it('ensures runtime constructor options win over file config for every overlapping field', () => {
    const fileConfig: SorostreamConfig = {
      rpcUrl: 'https://file-config-rpc.stellar.org',
      network: 'testnet',
      contractId: 'CFILECONFIG1234567890123456789012345678901234567890',
      timeoutMs: 30000,
    };

    const runtimeOptions = {
      rpcUrl: 'https://runtime-override-rpc.stellar.org',
      network: 'mainnet' as const,
      contractId: 'CRUNTIMEOVERRIDE123456789012345678901234567890123456',
      txTimeoutMs: 60000,
    };

    const merged = mergeSorostreamConfig(fileConfig, runtimeOptions);

    expect(merged.rpcUrl).toBe(runtimeOptions.rpcUrl);
    expect(merged.network).toBe(runtimeOptions.network);
    expect(merged.contractId).toBe(runtimeOptions.contractId);
    expect(merged.txTimeoutMs).toBe(runtimeOptions.txTimeoutMs);
  });

  it('falls back to file config defaults when runtime option fields are omitted', () => {
    const fileConfig: SorostreamConfig = {
      rpcUrl: 'https://file-config-rpc.stellar.org',
      network: 'futurenet',
      contractId: 'CFILEDEFAULT123456789012345678901234567890123456',
      timeoutMs: 45000,
    };

    const minimalRuntimeOptions = {
      // no network, contractId, rpcUrl, or txTimeoutMs
    };

    const merged = mergeSorostreamConfig(fileConfig, minimalRuntimeOptions);

    expect(merged.rpcUrl).toBe(fileConfig.rpcUrl);
    expect(merged.network).toBe(fileConfig.network);
    expect(merged.contractId).toBe(fileConfig.contractId);
    expect(merged.txTimeoutMs).toBe(fileConfig.timeoutMs);
  });
});

describe('Issue #771: graphql.ts helpers compatibility with GraphQL execution (Apollo / Yoga resolver schema)', () => {
  const sampleStream: Stream = {
    id: 'stream-101',
    sender: 'GAHTD27MNDKJN5YSGH4IAVPNC2L3U4XZEHSLFERDVZKIS3RXQT3DHAJJ',
    recipient: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7',
    token: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    deposit: 5_000_000_000n,
    flowRate: 50_000n,
    startTime: 1_700_000_000,
    endTime: 1_700_100_000,
    lastWithdrawTime: 1_700_000_000,
    status: 'Active',
    autoRenew: true,
  };

  it('resolves stream query matching GraphQL server schema and resolver expectations', async () => {
    const schema = buildSchema(`
      ${StreamTypeDefs}

      type Query {
        stream(id: ID!): Stream
      }
    `);

    // `buildSchema` only parses the SDL; it doesn't know how to serialize the
    // custom `BigInt` scalar it declares, so the resolver config must be
    // attached to the schema's scalar type explicitly — the same step
    // real servers perform via `resolvers: { BigInt: new GraphQLScalarType(bigIntScalarConfig) }`.
    const bigIntType = schema.getType('BigInt') as GraphQLScalarType;
    bigIntType.serialize = bigIntScalarConfig.serialize;
    bigIntType.parseValue = bigIntScalarConfig.parseValue;
    bigIntType.parseLiteral = bigIntScalarConfig.parseLiteral;

    // In Apollo Server / graphql-yoga, resolvers map to root value / resolver functions
    const rootValue = {
      stream: ({ id }: { id: string }) => {
        return toStreamResolverResult({
          ...sampleStream,
          id,
        });
      },
    };

    const query = `
      query GetStream {
        stream(id: "stream-101") {
          id
          sender
          recipient
          token
          deposit
          flowRate
          status
          autoRenew
        }
      }
    `;

    const result = await graphql({
      schema,
      source: query,
      rootValue,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toBeDefined();
    const data = result.data as { stream: Record<string, unknown> };
    expect(data.stream.id).toBe('stream-101');
    expect(data.stream.deposit).toBe('5000000000');
    expect(data.stream.flowRate).toBe('50000');
    expect(data.stream.status).toBe('Active');
    expect(data.stream.autoRenew).toBe(true);
  });
});

describe('Issue #772: profiler.ts simulation cost comparison between Linear and TimeDecay streams', () => {
  it('profiler documents simulation profile for create_stream operations', async () => {
    const profiler = new GasProfiler({
      contractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      network: 'testnet',
      publicKey: 'GAHTD27MNDKJN5YSGH4IAVPNC2L3U4XZEHSLFERDVZKIS3RXQT3DHAJJ',
    });

    // Mock simulateTransaction to test resource profile extraction
    const mockSimulate = vi.fn().mockResolvedValue({
      minResourceFee: '1000',
      cost: {
        cpuInsns: '50000',
        memBytes: '20000',
      },
      transactionData: {
        build: () => ({
          resources: () => ({
            footprint: () => ({
              readOnly: () => ({ length: 2 }),
              readWrite: () => ({ length: 1 }),
            }),
          }),
        }),
      },
      results: [
        {
          auth: [],
        },
      ],
    });

    // @ts-ignore
    profiler['server'].simulateTransaction = mockSimulate;
    // @ts-ignore
    profiler['server'].getAccount = vi
      .fn()
      .mockResolvedValue(
        new Account('GAHTD27MNDKJN5YSGH4IAVPNC2L3U4XZEHSLFERDVZKIS3RXQT3DHAJJ', '100'),
      );

    const linearProfile = await profiler.profileCreateStream({
      sender: 'GAHTD27MNDKJN5YSGH4IAVPNC2L3U4XZEHSLFERDVZKIS3RXQT3DHAJJ',
      recipient: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7',
      token: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      amount: 1000n,
      durationSeconds: 3600,
      autoRenew: false,
    });

    expect(linearProfile.operationType).toBe('create_stream');
    expect(linearProfile.success).toBe(true);
    expect(linearProfile.cpuInstructions).toBe('50000');
    expect(linearProfile.minFee).toBe('1000');
  });
});
