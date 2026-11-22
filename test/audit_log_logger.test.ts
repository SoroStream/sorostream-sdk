/**
 * Tests for issue #389: Enhanced audit log mode with caller-supplied logger
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import type { WalletAdapter, AuditLogger, AuditLogEntry } from '../src/types.js';
import type { StorageAdapter } from '../src/adapters.js';
import { createLogger, SanitizingLogger } from '../src/logger.js';
import type { Logger } from '../src/logger.js';

const VALID_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const SENDER_PK = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';

function makeAdapter(): WalletAdapter {
  return {
    getPublicKey: vi.fn().mockResolvedValue(SENDER_PK),
    signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
    isConnected: vi.fn().mockResolvedValue(true),
  };
}

function makeMemoryStorage(): StorageAdapter {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
  };
}

describe('Issue #389 — auditLogger (caller-supplied logger)', () => {
  it('calls auditLogger.info with a structured entry on writeAuditEntry', () => {
    const loggedEntries: AuditLogEntry[] = [];
    const logger: AuditLogger = {
      info: (entry) => loggedEntries.push(entry),
    };

    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: makeAdapter(),
      auditLogger: logger,
    });

    // Trigger directly via private method (white-box test)
    (client as any)['writeAuditEntry']({
      operation: 'createStream',
      result: 'success',
      durationMs: 42,
      txHash: 'txhash-abc',
    });

    expect(loggedEntries).toHaveLength(1);
    const entry = loggedEntries[0]!;
    expect(entry.operation).toBe('createStream');
    expect(entry.result).toBe('success');
    expect(entry.durationMs).toBe(42);
    expect(entry.txHash).toBe('txhash-abc');
    expect(entry.network).toBe('testnet');
    expect(typeof entry.timestamp).toBe('string');
  });

  it('auditLogger is called even when storage auditLog is false', () => {
    const loggedEntries: AuditLogEntry[] = [];
    const logger: AuditLogger = {
      info: (entry) => loggedEntries.push(entry),
    };

    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: makeAdapter(),
      auditLogger: logger,
      auditLog: false, // storage log disabled
    });

    (client as any)['writeAuditEntry']({
      operation: 'withdraw',
      result: 'success',
      durationMs: 10,
    });

    // Logger should still fire
    expect(loggedEntries).toHaveLength(1);
    expect(loggedEntries[0]!.operation).toBe('withdraw');
  });

  it('storage log is still written when both auditLog:true and auditLogger are set', () => {
    const storage = makeMemoryStorage();
    const loggedEntries: AuditLogEntry[] = [];
    const logger: AuditLogger = {
      info: (entry) => loggedEntries.push(entry),
    };

    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: makeAdapter(),
      auditLog: true,
      auditLogger: logger,
      adapters: { storage },
    });

    (client as any)['writeAuditEntry']({
      operation: 'topUp',
      result: 'success',
      durationMs: 25,
    });

    // Logger fired
    expect(loggedEntries).toHaveLength(1);

    // Storage log also written
    const storedLog = client.getAuditLog();
    expect(storedLog).toHaveLength(1);
    expect(storedLog[0]).toMatchObject({ operation: 'topUp', result: 'success' });
  });

  it('auditLogger receives error entries with error field', () => {
    const loggedEntries: AuditLogEntry[] = [];
    const logger: AuditLogger = {
      info: (entry) => loggedEntries.push(entry),
    };

    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: makeAdapter(),
      auditLogger: logger,
    });

    (client as any)['writeAuditEntry']({
      operation: 'cancelStream',
      result: 'error',
      error: 'Transaction failed: insufficient balance',
      durationMs: 5,
    });

    expect(loggedEntries).toHaveLength(1);
    expect(loggedEntries[0]!.result).toBe('error');
    expect(loggedEntries[0]!.error).toMatch(/insufficient balance/);
  });

  it('a throwing auditLogger never propagates its error', () => {
    const throwingLogger: AuditLogger = {
      info: () => {
        throw new Error('logger internal error');
      },
    };

    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: makeAdapter(),
      auditLogger: throwingLogger,
    });

    // Must not throw
    expect(() =>
      (client as any)['writeAuditEntry']({
        operation: 'withdraw',
        result: 'success',
        durationMs: 1,
      }),
    ).not.toThrow();
  });

  it('writeAuditEntry is a no-op when neither auditLog nor auditLogger is set', () => {
    const storage = makeMemoryStorage();
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: makeAdapter(),
      adapters: { storage },
      // auditLog: false (default), auditLogger: undefined
    });

    (client as any)['writeAuditEntry']({
      operation: 'createStream',
      result: 'success',
      durationMs: 1,
    });

    // Nothing written to storage
    expect(client.getAuditLog()).toEqual([]);
  });

  it('console satisfies AuditLogger interface (duck typing)', () => {
    // Ensure console.info can serve as the logger without type errors
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: makeAdapter(),
      // console has { info, warn, error, ... } so it satisfies AuditLogger
      auditLogger: { info: (entry) => console.info(entry) },
    });

    (client as any)['writeAuditEntry']({
      operation: 'createStream',
      result: 'success',
      durationMs: 7,
    });

    expect(infoSpy).toHaveBeenCalledTimes(1);
    infoSpy.mockRestore();
  });

  it('AuditLogEntry timestamp is an ISO 8601 string', () => {
    const loggedEntries: AuditLogEntry[] = [];
    const logger: AuditLogger = { info: (e) => loggedEntries.push(e) };

    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: makeAdapter(),
      auditLogger: logger,
    });

    (client as any)['writeAuditEntry']({
      operation: 'withdraw',
      result: 'success',
      durationMs: 3,
    });

    expect(loggedEntries[0]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe('Issue #892 — createLogger moduleLevels delegate verbosity', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('constructs the delegate at the most verbose module level so overrides are not dropped', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const logger = createLogger({
      minLevel: 'error',
      moduleLevels: { foo: 'debug' },
      sanitize: false,
    });

    logger.child('foo').debug('module-level debug message');

    expect(debugSpy).toHaveBeenCalled();
    expect(debugSpy.mock.calls.some((call) => call.some((arg) => String(arg).includes('module-level debug message')))).toBe(true);
  });

  it('still filters out debug for modules without an override', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const logger = createLogger({
      minLevel: 'error',
      moduleLevels: { foo: 'debug' },
      sanitize: false,
    });

    logger.child('bar').debug('should be filtered');

    expect(debugSpy).not.toHaveBeenCalled();
  });
});

describe('Issue #893 — SanitizingLogger.child redacts namespaced children', () => {
  const FAKE_SECRET = 'S' + 'A'.repeat(55);

  function makeSpyLogger(): Logger {
    return {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    } as unknown as Logger;
  }

  it('wraps the delegate child logger so redaction applies to namespaced children', () => {
    const childSpy = makeSpyLogger();
    const delegate = makeSpyLogger();
    (delegate.child as ReturnType<typeof vi.fn>).mockReturnValue(childSpy);

    const sanitizing = new SanitizingLogger(delegate);
    const child = sanitizing.child('ns');

    child.info(`secret is ${FAKE_SECRET}`);

    expect(delegate.child).toHaveBeenCalledWith('ns');
    expect(childSpy.info).toHaveBeenCalledTimes(1);
    const logged = String((childSpy.info as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(logged).not.toContain(FAKE_SECRET);
    expect(logged).toContain('[REDACTED]');
  });
});
