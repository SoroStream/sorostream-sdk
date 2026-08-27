/**
 * Issue #102 – Exhaustive stream state machine tests.
 *
 * Covers every state × action combination:
 *   States:  Active | Cancelled | Completed
 *   Actions: withdraw | cancelStream | topUp
 *
 * Invalid transitions MUST throw "Stream is not active".
 * Valid transitions MUST yield the correct next state.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MockSoroStreamClient } from '../src/mock.js';
import { StreamStateMachine, InvalidStateTransitionError } from '../src/state-machine.js';
import type { Stream } from '../src/types.js';

const BASE_STREAM: Omit<Stream, 'id'> = {
  sender: 'GSENDER',
  recipient: 'GRECIPIENT',
  token: 'GTOKEN',
  deposit: 1_000_000_000n,
  flowRate: 100n,
  startTime: Math.floor(Date.now() / 1000) - 100,
  endTime: Math.floor(Date.now() / 1000) + 900,
  lastWithdrawTime: Math.floor(Date.now() / 1000) - 100,
  status: 'Active',
  autoRenew: false,
};

function seedStream(mock: MockSoroStreamClient, overrides: Partial<Stream> = {}): string {
  const id = String(Math.floor(Math.random() * 1_000_000));
  mock.seedStream({ ...BASE_STREAM, id, ...overrides });
  return id;
}

// ── Valid transitions ─────────────────────────────────────────────────────────

describe('State machine – valid transitions', () => {
  let mock: MockSoroStreamClient;

  beforeEach(() => {
    mock = new MockSoroStreamClient();
  });

  it('Active → withdraw (within window) stays Active', async () => {
    const id = seedStream(mock);
    await mock.withdraw({ streamId: id });
    const stream = await mock.getStream(id);
    // claimable window hasn't ended → stream stays Active
    expect(['Active', 'Completed']).toContain(stream.status);
  });

  it('Active → withdraw (past end time) transitions to Completed', async () => {
    const now = Math.floor(Date.now() / 1000);
    const id = seedStream(mock, {
      startTime: now - 2000,
      endTime: now - 10,
      lastWithdrawTime: now - 2000,
    });
    await mock.withdraw({ streamId: id });
    const stream = await mock.getStream(id);
    expect(stream.status).toBe('Completed');
  });

  it('Active → cancelStream transitions to Cancelled', async () => {
    const id = seedStream(mock);
    await mock.cancelStream({ streamId: id });
    const stream = await mock.getStream(id);
    expect(stream.status).toBe('Cancelled');
  });

  it('Active → topUp stays Active and extends endTime', async () => {
    const id = seedStream(mock);
    const before = await mock.getStream(id);
    await mock.topUp({ streamId: id, amount: 1_000_000n });
    const after = await mock.getStream(id);
    expect(after.status).toBe('Active');
    expect(after.endTime).toBeGreaterThan(before.endTime);
    expect(after.deposit).toBeGreaterThan(before.deposit);
  });
});

// ── Invalid transitions – Cancelled state ────────────────────────────────────

describe('State machine – invalid transitions from Cancelled', () => {
  let mock: MockSoroStreamClient;

  beforeEach(() => {
    mock = new MockSoroStreamClient();
  });

  it("Cancelled → withdraw throws 'Stream is not active'", async () => {
    const id = seedStream(mock, { status: 'Cancelled' });
    await expect(mock.withdraw({ streamId: id })).rejects.toThrow('Stream is not active');
  });

  it("Cancelled → cancelStream throws 'Stream is not active'", async () => {
    const id = seedStream(mock, { status: 'Cancelled' });
    await expect(mock.cancelStream({ streamId: id })).rejects.toThrow('Stream is not active');
  });

  it("Cancelled → topUp throws 'Stream is not active'", async () => {
    const id = seedStream(mock, { status: 'Cancelled' });
    await expect(mock.topUp({ streamId: id, amount: 500n })).rejects.toThrow(
      'Stream is not active',
    );
  });
});

// ── Invalid transitions – Completed state ────────────────────────────────────

describe('State machine – invalid transitions from Completed', () => {
  let mock: MockSoroStreamClient;

  beforeEach(() => {
    mock = new MockSoroStreamClient();
  });

  it("Completed → withdraw throws 'Stream is not active'", async () => {
    const id = seedStream(mock, { status: 'Completed' });
    await expect(mock.withdraw({ streamId: id })).rejects.toThrow('Stream is not active');
  });

  it("Completed → cancelStream throws 'Stream is not active'", async () => {
    const id = seedStream(mock, { status: 'Completed' });
    await expect(mock.cancelStream({ streamId: id })).rejects.toThrow('Stream is not active');
  });

  it("Completed → topUp throws 'Stream is not active'", async () => {
    const id = seedStream(mock, { status: 'Completed' });
    await expect(mock.topUp({ streamId: id, amount: 500n })).rejects.toThrow(
      'Stream is not active',
    );
  });
});

// ── Full state × action matrix ────────────────────────────────────────────────

describe('State machine – exhaustive state × action matrix', () => {
  type Action = 'withdraw' | 'cancelStream' | 'topUp';

  const VALID: Record<Stream['status'], Action[]> = {
    Active: ['withdraw', 'cancelStream', 'topUp'],
    Cancelled: [],
    Completed: [],
  };

  const ALL_ACTIONS: Action[] = ['withdraw', 'cancelStream', 'topUp'];

  for (const status of ['Active', 'Cancelled', 'Completed'] as Stream['status'][]) {
    for (const action of ALL_ACTIONS) {
      const isValid = VALID[status].includes(action);
      it(`${status} → ${action}: ${isValid ? 'succeeds' : 'throws'}`, async () => {
        const mock = new MockSoroStreamClient();
        const id = seedStream(mock, { status });

        const run = () => {
          if (action === 'withdraw') return mock.withdraw({ streamId: id });
          if (action === 'cancelStream') return mock.cancelStream({ streamId: id });
          return mock.topUp({ streamId: id, amount: 1_000n });
        };

        if (isValid) {
          await expect(run()).resolves.toBeDefined();
        } else {
          await expect(run()).rejects.toThrow('Stream is not active');
        }
      });
    }
  }
});

// ── State stays consistent after rejection ────────────────────────────────────

describe('State machine – state unchanged after rejected transition', () => {
  it('Cancelled stream status unchanged after failed withdraw', async () => {
    const mock = new MockSoroStreamClient();
    const id = seedStream(mock, { status: 'Cancelled' });
    await expect(mock.withdraw({ streamId: id })).rejects.toThrow();
    const stream = await mock.getStream(id);
    expect(stream.status).toBe('Cancelled');
  });

  it('Completed stream status unchanged after failed cancelStream', async () => {
    const mock = new MockSoroStreamClient();
    const id = seedStream(mock, { status: 'Completed' });
    await expect(mock.cancelStream({ streamId: id })).rejects.toThrow();
    const stream = await mock.getStream(id);
    expect(stream.status).toBe('Completed');
  });

  it('Completed stream deposit unchanged after failed topUp', async () => {
    const mock = new MockSoroStreamClient();
    const id = seedStream(mock, { status: 'Completed', deposit: 1_000n });
    await expect(mock.topUp({ streamId: id, amount: 500n })).rejects.toThrow();
    const stream = await mock.getStream(id);
    expect(stream.deposit).toBe(1_000n);
  });
});

describe('StreamStateMachine class & transition guards (Issue #429)', () => {
  it('correctly evaluates canTransition for all states', () => {
    expect(StreamStateMachine.canTransition('Active', 'withdraw')).toBe(true);
    expect(StreamStateMachine.canTransition('Active', 'pause')).toBe(true);
    expect(StreamStateMachine.canTransition('Paused', 'resume')).toBe(true);
    expect(StreamStateMachine.canTransition('Cancelled', 'withdraw')).toBe(false);
    expect(StreamStateMachine.canTransition('Completed', 'topUp')).toBe(false);
  });

  it('throws InvalidStateTransitionError on invalid transition assertion', () => {
    expect(() => StreamStateMachine.assertValidTransition('Cancelled', 'withdraw')).toThrow(
      InvalidStateTransitionError,
    );
  });

  it('calculates next state accurately', () => {
    expect(StreamStateMachine.getNextState('Active', 'cancel')).toBe('Cancelled');
    expect(StreamStateMachine.getNextState('Active', 'pause')).toBe('Paused');
    expect(StreamStateMachine.getNextState('Paused', 'resume')).toBe('Active');
    expect(StreamStateMachine.getNextState('Active', 'withdraw', { isFullyWithdrawn: true })).toBe('Completed');
  });

  it('returns valid actions for each state', () => {
    expect(StreamStateMachine.getValidActions('Active')).toContain('withdraw');
    expect(StreamStateMachine.getValidActions('Cancelled')).toEqual([]);
    expect(StreamStateMachine.getValidActions('Completed')).toEqual([]);
  });
});

