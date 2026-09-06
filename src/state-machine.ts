import { SoroStreamError } from './errors.js';
import type { Stream } from './types.js';

export type StreamState = 'Active' | 'Cancelled' | 'Completed' | 'Paused';

export type StreamAction =
  'withdraw' | 'cancel' | 'topUp' | 'updateFlowRate' | 'pause' | 'resume' | 'transfer' | 'split';

/**
 * Thrown when an operation is requested on a stream in a state where that operation is invalid (issue #429).
 */
export class InvalidStateTransitionError extends SoroStreamError {
  public readonly currentState: StreamState;
  public readonly action: StreamAction;

  constructor(currentState: StreamState, action: StreamAction, details?: string) {
    const msg = `Stream is not active: cannot perform '${action}' on stream in '${currentState}' state${
      details ? `. ${details}` : ''
    }`;
    super(msg);
    this.name = 'InvalidStateTransitionError';
    this.currentState = currentState;
    this.action = action;
  }
}

const TRANSITION_RULES: Record<StreamState, Set<StreamAction>> = {
  Active: new Set<StreamAction>([
    'withdraw',
    'cancel',
    'topUp',
    'updateFlowRate',
    'pause',
    'transfer',
    'split',
  ]),
  Paused: new Set<StreamAction>(['resume', 'cancel', 'withdraw']),
  Cancelled: new Set<StreamAction>(),
  Completed: new Set<StreamAction>(),
};

/**
 * Typed Finite State Machine for stream lifecycles with transition guards (issue #429).
 */
export class StreamStateMachine {
  /**
   * Returns whether an action is valid for the given stream state.
   */
  static canTransition(currentState: StreamState, action: StreamAction): boolean {
    const allowed = TRANSITION_RULES[currentState];
    return allowed ? allowed.has(action) : false;
  }

  /**
   * Asserts that an action can be performed on a stream state.
   * Throws `InvalidStateTransitionError` if invalid.
   */
  static assertValidTransition(currentState: StreamState, action: StreamAction): void {
    if (!StreamStateMachine.canTransition(currentState, action)) {
      throw new InvalidStateTransitionError(currentState, action);
    }
  }

  /**
   * Computes the next state resulting from an action.
   */
  static getNextState(
    currentState: StreamState,
    action: StreamAction,
    context?: { isFullyWithdrawn?: boolean; isExpired?: boolean },
  ): StreamState {
    StreamStateMachine.assertValidTransition(currentState, action);

    switch (action) {
      case 'cancel':
        return 'Cancelled';
      case 'pause':
        return 'Paused';
      case 'resume':
        return 'Active';
      case 'withdraw':
        if (context?.isFullyWithdrawn || context?.isExpired) {
          return 'Completed';
        }
        return currentState;
      case 'topUp':
      case 'updateFlowRate':
      case 'transfer':
      case 'split':
        return 'Active';
      default:
        return currentState;
    }
  }

  /**
   * Returns all valid actions for a given stream state.
   */
  static getValidActions(currentState: StreamState): StreamAction[] {
    const allowed = TRANSITION_RULES[currentState];
    return allowed ? Array.from(allowed) : [];
  }
}
