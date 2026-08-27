/**
 * Optional GraphQL resolver helpers for SoroStream's `Stream` type.
 *
 * Import this from `@sorostream/sdk/graphql` — it is a separate entry point
 * so that consumers who don't build GraphQL APIs never pull in anything
 * GraphQL-related. `graphql` itself is intentionally NOT a dependency of
 * this package; these helpers are plain data/strings that work with any
 * GraphQL server built on top of the `graphql` package (Apollo Server,
 * graphql-yoga, etc.).
 *
 * Issue #214.
 */
import type { Stream } from './types.js';

/**
 * GraphQL SDL type definitions for a SoroStream `Stream`, including the
 * custom `BigInt` scalar used for stroop-denominated amounts. Merge this
 * string into your schema's typeDefs.
 *
 * @example
 * ```ts
 * import { makeExecutableSchema } from "@graphql-tools/schema";
 * import { StreamTypeDefs, bigIntScalarConfig } from "@sorostream/sdk/graphql";
 * import { GraphQLScalarType } from "graphql";
 *
 * const schema = makeExecutableSchema({
 *   typeDefs: [StreamTypeDefs, `type Query { stream(id: ID!): Stream }`],
 *   resolvers: {
 *     BigInt: new GraphQLScalarType(bigIntScalarConfig),
 *     Query: { stream: (_, { id }) => toStreamResolverResult(await client.getStream(id)) },
 *   },
 * });
 * ```
 */
export const StreamTypeDefs = `
  "Arbitrary-precision integer, serialized as a string on the wire. Used for stream amounts in stroops."
  scalar BigInt

  enum StreamStatus {
    Active
    Cancelled
    Completed
    Paused
  }

  type Stream {
    id: ID!
    sender: String!
    recipient: String!
    token: String!
    deposit: BigInt!
    flowRate: BigInt!
    startTime: Int!
    endTime: Int!
    lastWithdrawTime: Int!
    status: StreamStatus!
    autoRenew: Boolean!
    pausedAt: Int
    lockUntil: Int
  }
`;

/**
 * The shape a GraphQL resolver should return for a `Stream` field. Matches
 * the SDK's {@link Stream} type minus the non-serializable `toJSON` helper —
 * `bigint` fields are returned as-is and converted to strings on the wire by
 * {@link bigIntScalarConfig}.
 */
export type StreamGraphQLResult = Omit<Stream, 'toJSON'>;

/**
 * Converts an SDK {@link Stream} into the shape a GraphQL resolver should
 * return, stripping the non-serializable `toJSON` helper method.
 */
export function toStreamResolverResult(stream: Stream): StreamGraphQLResult {
  const { toJSON: _toJSON, ...rest } = stream;
  return rest;
}

/**
 * Framework-agnostic config for a `BigInt` custom scalar, matching the shape
 * `graphql`'s `GraphQLScalarType` constructor expects
 * (`new GraphQLScalarType(bigIntScalarConfig)`). Serializes and parses
 * stream amounts (`deposit`, `flowRate`) as strings, since GraphQL has no
 * native arbitrary-precision integer type.
 */
export const bigIntScalarConfig = {
  name: 'BigInt',
  description:
    'Arbitrary-precision integer, serialized as a string. Used for stream amounts in stroops (deposit, flowRate).',
  serialize(value: unknown): string {
    if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'string') {
      return BigInt(value).toString();
    }
    throw new TypeError(`BigInt scalar cannot serialize value of type ${typeof value}`);
  },
  parseValue(value: unknown): bigint {
    if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'string') {
      return BigInt(value);
    }
    throw new TypeError(`BigInt scalar cannot parse value of type ${typeof value}`);
  },
  parseLiteral(ast: { kind: string; value: string }): bigint {
    if (ast.kind === 'StringValue' || ast.kind === 'IntValue') {
      return BigInt(ast.value);
    }
    throw new TypeError(`BigInt scalar cannot parse literal of kind ${ast.kind}`);
  },
};
