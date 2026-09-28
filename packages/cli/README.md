# @sorostream/cli

Command-line interface for the [SoroStream](https://github.com/SoroStream/sorostream-sdk) payment streaming protocol on Stellar Soroban.

## Installation

Install globally via npm:

```bash
npm install -g @sorostream/cli
```

Or run directly with npx:

```bash
npx @sorostream/cli --help
```

## Global Options

All subcommands support the following options:

- `-c, --contract-id <address>` (required): StreamContract address
- `-s, --secret <key>` (required): Stellar secret key (or set `SOROSTREAM_SECRET` env variable)
- `-n, --network <network>`: Stellar network (`mainnet`, `testnet`, `futurenet`, default: `testnet`)
- `-r, --rpc <urls...>`: RPC URL(s) for failover support

## Commands

### `stream create`
Create a new payment stream.

```bash
sorostream stream create \
  --contract-id C... \
  --secret S... \
  --recipient G... \
  --token C... \
  --amount 100 \
  --duration 3600 \
  --json
```

### `list`
List payment streams filtered by sender, recipient, or status.

```bash
sorostream list --contract-id C... --secret S... --sender G...
```

### `get <streamId>`
Get details for a specific payment stream.

```bash
sorostream get <streamId> --contract-id C... --secret S...
```

### `withdraw <streamId>`
Withdraw claimable tokens from a stream.

```bash
sorostream withdraw <streamId> --contract-id C... --secret S...
```

### `cancel <streamId>`
Cancel an active payment stream.

```bash
sorostream cancel <streamId> --contract-id C... --secret S...
```

### `top-up <streamId>`
Add additional tokens to an existing stream.

```bash
sorostream top-up <streamId> --contract-id C... --secret S... --amount 50
```

### `claimable <streamId>`
Query current claimable balance for a stream.

```bash
sorostream claimable <streamId> --contract-id C... --secret S...
```

### `forecast <streamId>`
Get the renewal forecast for an auto-renewing stream.

```bash
sorostream forecast <streamId> --contract-id C... --secret S...
```

### `analyze <entrypoint>`
Analyze bundle size and tree-shaking coverage for an entrypoint file.

```bash
sorostream analyze src/index.ts --html
```

## License

MIT
