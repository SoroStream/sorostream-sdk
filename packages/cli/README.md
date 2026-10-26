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
- `-n, --network <network>`: Stellar network (`mainnet`, `testnet`, `futurenet`, default: `testnet`)
- `-r, --rpc <urls...>`: RPC URL(s) for failover support
- `-s, --secret <key>` (**deprecated**): Stellar secret key — set the `SOROSTREAM_SECRET` environment variable or use the interactive masked prompt instead

## Secret handling

Set the `SOROSTREAM_SECRET` environment variable or let the CLI prompt interactively (masked input) when running commands. Passing the key via `-s`/`--secret` is deprecated because command-line arguments are visible in shell history and process listings (`ps` / `/proc/<pid>/cmdline`). The CLI does not include the resolved secret key in stdout, stderr, or diagnostic logs.

## Commands

### `stream create`
Create a new payment stream.

```bash
SOROSTREAM_SECRET=S... sorostream stream create \
  --contract-id C... \
  --recipient G... \
  --token C... \
  --amount 100 \
  --duration 3600 \
  --json
```

### `list`
List payment streams filtered by sender, recipient, or status.

```bash
SOROSTREAM_SECRET=S... sorostream list --contract-id C... --sender G...
```

### `get <streamId>`
Get details for a specific payment stream.

```bash
SOROSTREAM_SECRET=S... sorostream get <streamId> --contract-id C...
```

### `withdraw <streamId>`
Withdraw claimable tokens from a stream.

```bash
SOROSTREAM_SECRET=S... sorostream withdraw <streamId> --contract-id C...
```

### `cancel <streamId>`
Cancel an active payment stream.

```bash
SOROSTREAM_SECRET=S... sorostream cancel <streamId> --contract-id C...
```

### `top-up <streamId>`
Add additional tokens to an existing stream.

```bash
SOROSTREAM_SECRET=S... sorostream top-up <streamId> --contract-id C... --amount 50
```

### `claimable <streamId>`
Query current claimable balance for a stream.

```bash
SOROSTREAM_SECRET=S... sorostream claimable <streamId> --contract-id C...
```

### `forecast <streamId>`
Get the renewal forecast for an auto-renewing stream.

```bash
SOROSTREAM_SECRET=S... sorostream forecast <streamId> --contract-id C...
```

### `analyze <entrypoint>`
Analyze bundle size and tree-shaking coverage for an entrypoint file.

```bash
sorostream analyze src/index.ts --html
```

## License

MIT
