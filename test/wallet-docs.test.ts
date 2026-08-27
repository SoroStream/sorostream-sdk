import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('wallet adapter documentation', () => {
  it('documents freighter, ledger, and server-side examples in the README', () => {
    const readme = readFileSync(resolve(__dirname, '../README.md'), 'utf8');

    expect(readme).toContain('### Wallet adapter examples');
    expect(readme).toContain('#### Freighter adapter');
    expect(readme).toContain('#### Ledger adapter');
    expect(readme).toContain('#### Server-side keypair adapter');
  });

  it('includes a minimal WalletAdapter example in the public interface docs', () => {
    const types = readFileSync(resolve(__dirname, '../src/types.ts'), 'utf8');

    expect(types).toContain('@example');
    expect(types).toContain('const serverKeypairAdapter: WalletAdapter = {');
  });
});
