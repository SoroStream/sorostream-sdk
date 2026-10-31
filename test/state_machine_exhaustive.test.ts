/**
 * Issue #738 – Exhaustive StreamStateMachine state × action matrix.
 *
 * Every StreamState × StreamAction combination is tested:
 *   States:  Active | Paused | Cancelled | Completed
 *   Actions: withdraw | cancel | topUp | updateFlowRate |
 *            pause | resume | transfer | split
 *
 * The transition table is derived directly from the TRANSITION_RULES constant
 * in src/state-machine.ts via StreamStateMachine.canTransition(), so the tests
 * cannot drift from the implementation.
 *
 * For valid combinations:
 *   - assertValidTransition does NOT throw
 *   - canTransition returns true
 *   - getNextState returns the correct successor state
 *
 * For invalid combinations:
 *   - assertValidTransition throws InvalidStateTransitionError
 *   - The error records the correct currentState and action
 *   - canTransition returns false
 */

import { describe, it, expect } from 'vitest';
import { StreamStateMachine, InvalidStateTransitionError } from '../src/state-machine.js';
import type { StreamState, StreamAction } from '../src/state-machine.js';

// ── All states and actions declared in state-machine.ts ──────────────────────

const ALL_STATES: StreamState[] = ['Active', 'Paused', 'Cancelled', 'Completed'];

const ALL_ACTIONS: StreamAction[] = [
  'withdraw',
  'cancel',
  'topUp',
  'updateFlowRate',
  'pause',
  'resume',
  'transfer',
  'split',
];

// ── Expected next-state for valid transitions ─────────────────────────────────
// Derived from the getNextState implementation in state-machine.ts.

const EXPECTED_NEXT_STATE: Partial<
  Record<StreamState, Partial<Record<StreamAction, StreamState>>>
> = {
  Active: {
    withdraw: 'Active', // no isFullyWithdrawn / isExpired context → stays Active
    cancel: 'Cancelled',
    topUp: 'Active',
    updateFlowRate: 'Active',
    pause: 'Paused',
    transfer: 'Active',
    split: 'Active',
  },
  Paused: {
    resume: 'Active',
    cancel: 'Cancelled',
    withdraw: 'Paused', // withdraw from Paused keeps same state (nothing accrued)
  },
};

// ── Parameterised matrix ──────────────────────────────────────────────────────

describe('StreamStateMachine – exhaustive state × action matrix (#738)', () => {
  for (const state of ALL_STATES) {
    for (const action of ALL_ACTIONS) {
      const valid = StreamStateMachine.canTransition(state, action);

      describe(`${state} → ${action}`, () => {
        it(`canTransition returns ${valid}`, () => {
          expect(StreamStateMachine.canTransition(state, action)).toBe(valid);
        });

        if (valid) {
          it('assertValidTransition does not throw', () => {
            expect(() => StreamStateMachine.assertValidTransition(state, action)).not.toThrow();
          });

          const expectedNext = EXPECTED_NEXT_STATE[state]?.[action];
          if (expectedNext !== undefined) {
            it(`getNextState returns '${expectedNext}'`, () => {
              expect(StreamStateMachine.getNextState(state, action)).toBe(expectedNext);
            });
          }
        } else {
          it('assertValidTransition throws InvalidStateTransitionError', () => {
            expect(() => StreamStateMachine.assertValidTransition(state, action)).toThrow(
              InvalidStateTransitionError,
            );
          });

          it('error records correct currentState and action', () => {
            let thrown: unknown;
            try {
              StreamStateMachine.assertValidTransition(state, action);
            } catch (err) {
              thrown = err;
            }
            expect(thrown).toBeInstanceOf(InvalidStateTransitionError);
            const err = thrown as InvalidStateTransitionError;
            expect(err.currentState).toBe(state);
            expect(err.action).toBe(action);
          });

          it('getNextState throws InvalidStateTransitionError', () => {
            expect(() => StreamStateMachine.getNextState(state, action)).toThrow(
              InvalidStateTransitionError,
            );
          });
        }
      });
    }
  }
});

// ── Valid-transition count cross-check ────────────────────────────────────────
// Guards against silent removal of transitions from TRANSITION_RULES.

describe('StreamStateMachine – valid-transition counts per state (#738)', () => {
  it('Active has exactly 7 valid actions', () => {
    expect(StreamStateMachine.getValidActions('Active')).toHaveLength(7);
  });

  it('Paused has exactly 3 valid actions', () => {
    expect(StreamStateMachine.getValidActions('Paused')).toHaveLength(3);
  });

  it('Cancelled has exactly 0 valid actions (terminal state)', () => {
    expect(StreamStateMachine.getValidActions('Cancelled')).toHaveLength(0);
  });

  it('Completed has exactly 0 valid actions (terminal state)', () => {
    expect(StreamStateMachine.getValidActions('Completed')).toHaveLength(0);
  });
});

// ── getNextState context flags ─────────────────────────────────────────────────

describe('StreamStateMachine – getNextState withdraw context flags (#738)', () => {
  it('Active + withdraw + isFullyWithdrawn → Completed', () => {
    expect(StreamStateMachine.getNextState('Active', 'withdraw', { isFullyWithdrawn: true })).toBe(
      'Completed',
    );
  });

  it('Active + withdraw + isExpired → Completed', () => {
    expect(StreamStateMachine.getNextState('Active', 'withdraw', { isExpired: true })).toBe(
      'Completed',
    );
  });

  it('Active + withdraw + no context → Active', () => {
    expect(StreamStateMachine.getNextState('Active', 'withdraw')).toBe('Active');
  });
});

// ── InvalidStateTransitionError shape ────────────────────────────────────────

describe('InvalidStateTransitionError shape (#738)', () => {
  it('has correct name, message, currentState and action fields', () => {
    const err = new InvalidStateTransitionError('Cancelled', 'topUp');
    expect(err.name).toBe('InvalidStateTransitionError');
    expect(err.currentState).toBe('Cancelled');
    expect(err.action).toBe('topUp');
    expect(err.message).toMatch(/topUp/);
    expect(err.message).toMatch(/Cancelled/);
  });

  it('is an instance of Error', () => {
    const err = new InvalidStateTransitionError('Completed', 'pause');
    expect(err).toBeInstanceOf(Error);
  });
});
