/**
 * Tests for issue #214: optional GraphQL resolver helpers for SDK stream
 * data types, exported from the `@sorostream/sdk/graphql` sub-path.
 */
import { describe, it, expect } from 'vitest';
import { buildSchema, graphql, GraphQLScalarType } from 'graphql';
import { StreamTypeDefs, bigIntScalarConfig, toStreamResolverResult } from '../src/graphql.js';
import type { Stream } from '../src/types.js';

const sampleStream: Stream = {
  id: '1',
  sender: 'GSENDER',
  recipient: 'GRECIPIENT',
  token: 'GTOKEN',
  deposit: 1_000_000_000n,
  flowRate: 1_000n,
  startTime: 1_700_000_000,
  endTime: 1_700_003_600,
  lastWithdrawTime: 1_700_000_000,
  status: 'Active',
  autoRenew: false,
};

describe('StreamTypeDefs', () => {
  it('is a usable StreamType definition string', () => {
    expect(StreamTypeDefs).toContain('type Stream');
    expect(StreamTypeDefs).toContain('scalar BigInt');
  });

  it('compiles as valid GraphQL SDL alongside a Query type', () => {
    const schema = buildSchema(`
      ${StreamTypeDefs}
      type Query {
        stream: Stream
      }
    `);
    expect(schema.getType('Stream')).toBeDefined();
    expect(schema.getType('BigInt')).toBeDefined();
  });
});

describe('bigIntScalarConfig', () => {
  it('is defined and documented', () => {
    expect(bigIntScalarConfig.name).toBe('BigInt');
    expect(bigIntScalarConfig.description).toBeTruthy();
  });

  it('serializes bigint values to strings', () => {
    expect(bigIntScalarConfig.serialize(1_000_000_000n)).toBe('1000000000');
  });

  it('parses string/number values back to bigint', () => {
    expect(bigIntScalarConfig.parseValue('1000000000')).toBe(1_000_000_000n);
    expect(bigIntScalarConfig.parseValue(42)).toBe(42n);
  });

  it('parses string and int literals', () => {
    expect(bigIntScalarConfig.parseLiteral({ kind: 'StringValue', value: '500' })).toBe(500n);
    expect(bigIntScalarConfig.parseLiteral({ kind: 'IntValue', value: '500' })).toBe(500n);
  });

  it('rejects unsupported literal kinds', () => {
    expect(() => bigIntScalarConfig.parseLiteral({ kind: 'BooleanValue', value: 'true' })).toThrow(
      TypeError,
    );
  });
});

describe('toStreamResolverResult', () => {
  it('returns a plain object matching the Stream fields, without toJSON', () => {
    const result = toStreamResolverResult(sampleStream);
    expect(result.id).toBe('1');
    expect(result.deposit).toBe(1_000_000_000n);
    expect((result as Partial<Stream>).toJSON).toBeUndefined();
  });
});

describe('resolver return types execute against a real GraphQL schema', () => {
  it('resolves a Stream query end-to-end, including BigInt scalar serialization', async () => {
    const schema = buildSchema(`
      ${StreamTypeDefs}
      type Query {
        stream: Stream
      }
    `);

    // Attach our framework-agnostic scalar config the same way a consumer's
    // Apollo/graphql-yoga server would.
    const bigIntType = schema.getType('BigInt');
    expect(bigIntType).toBeInstanceOf(GraphQLScalarType);
    Object.assign(bigIntType as GraphQLScalarType, bigIntScalarConfig);

    const result = await graphql({
      schema,
      source: `query { stream { id deposit flowRate status } }`,
      rootValue: {
        stream: () => toStreamResolverResult(sampleStream),
      },
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      stream: {
        id: '1',
        deposit: '1000000000',
        flowRate: '1000',
        status: 'Active',
      },
    });
  });
});
