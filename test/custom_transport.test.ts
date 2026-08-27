import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { createDefaultRpcTransport } from '../src/transport.js';

const repoRoot = resolve(__dirname, '..');

describe('CUSTOM_TRANSPORT.md', () => {
  const doc = readFileSync(resolve(repoRoot, 'CUSTOM_TRANSPORT.md'), 'utf8');

  it('documents the RpcTransportAdapter interface with TypeScript types', () => {
    expect(doc).toContain('interface RpcTransportAdapter');
    for (const method of [
      'init?(context: RpcTransportInitContext)',
      'getAccount(address: string): Promise<Account>',
      'getHealth(): Promise<rpc.Api.GetHealthResponse>',
      'getLatestLedger(): Promise<rpc.Api.GetLatestLedgerResponse>',
      'getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse>',
      'simulateTransaction(tx: Transaction | FeeBumpTransaction): Promise<rpc.Api.SimulateTransactionResponse>',
      'prepareTransaction(tx: Transaction | FeeBumpTransaction): Promise<Transaction | FeeBumpTransaction>',
      'sendTransaction(tx: Transaction | FeeBumpTransaction): Promise<rpc.Api.SendTransactionResponse>',
      'getEvents(request: RpcTransportGetEventsRequest): Promise<rpc.Api.GetEventsResponse>',
      'teardown?(): Promise<void> | void',
    ]) {
      expect(doc).toContain(method);
    }
  });

  it('documents the adapter lifecycle: initialization, request, and teardown', () => {
    expect(doc).toMatch(/##\s*Adapter Lifecycle/);
    expect(doc).toMatch(/\*\*Initialization\*\*/);
    expect(doc).toMatch(/\*\*Request\*\*/);
    expect(doc).toMatch(/\*\*Teardown\*\*/);
  });

  it('documents the error handling contract', () => {
    expect(doc).toMatch(/##\s*Error Handling/);
    expect(doc.toLowerCase()).toContain('reject');
    expect(doc).toContain('SoroStreamTransportError');
  });

  it('includes a minimal, complete working adapter example', () => {
    expect(doc).toMatch(/##\s*Walkthrough: Implementing a Minimal Adapter/);
    expect(doc).toContain('createLoggingRpcTransport');
    expect(doc).toContain('import { createDefaultRpcTransport } from "@sorostream/sdk"');
  });

  it('links to related reference documentation', () => {
    expect(doc).toMatch(/\]\(\.\/CUSTOM_WALLET_ADAPTERS\.md\)/);
    expect(doc).toMatch(/\]\(\.\/src\/ERRORS\.md\)/);
    expect(doc).toMatch(/\]\(\.\/docs\/rate-limiting\.md\)/);
  });

  it('the minimal adapter example is syntactically valid TypeScript', () => {
    const match = doc.match(/```typescript\nimport \{ createDefaultRpcTransport \}[\s\S]*?\n```/);
    expect(match).not.toBeNull();
    const snippet = match![0].replace(/^```typescript\n/, '').replace(/```$/, '');
    const result = ts.transpileModule(snippet, {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
    });
    const errors = (result.diagnostics ?? []).filter(
      (d) => d.category === ts.DiagnosticCategory.Error,
    );
    expect(errors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, '\n'))).toEqual([]);
  });
});

describe('createDefaultRpcTransport', () => {
  it('returns an object implementing every required RpcTransportAdapter method', () => {
    const transport = createDefaultRpcTransport('https://soroban-testnet.stellar.org');
    for (const method of [
      'getAccount',
      'getHealth',
      'getLatestLedger',
      'getTransaction',
      'simulateTransaction',
      'prepareTransaction',
      'sendTransaction',
      'getEvents',
    ] as const) {
      expect(typeof transport[method]).toBe('function');
    }
  });
});
