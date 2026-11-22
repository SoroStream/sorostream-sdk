/**
 * Issue #890: getNextState 'withdraw' from 'Active' only completes when
 * isFullyWithdrawn or isExpired is set.
 */
import { describe, it, expect } from 'vitest';
import { StreamStateMachine } from '../src/state-machine.js';

describe("StreamStateMachine.getNextState('Active', 'withdraw')", () => {
  it('leaves the state unchanged with no context', () => {
    expect(StreamStateMachine.getNextState('Active', 'withdraw')).toBe('Active');
    expect(StreamStateMachine.getNextState('Active', 'withdraw', {})).toBe('Active');
  });

  it('returns Completed when isFullyWithdrawn is true', () => {
    expect(StreamStateMachine.getNextState('Active', 'withdraw', { isFullyWithdrawn: true })).toBe(
      'Completed',
    );
  });

  it('returns Completed when isExpired is true', () => {
    expect(StreamStateMachine.getNextState('Active', 'withdraw', { isExpired: true })).toBe(
      'Completed',
    );
  });
});
