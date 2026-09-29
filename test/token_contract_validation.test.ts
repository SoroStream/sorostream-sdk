import { describe, it, expect } from 'vitest';
import { InvalidTokenContractError } from '../src/errors.js';

describe('InvalidTokenContractError (issue #611)', () => {
  it('includes the token address in the message', () => {
    const err = new InvalidTokenContractError('CABC123');
    expect(err.message).toContain('CABC123');
    expect(err.message).toContain('SAC token interface');
    expect(err.token).toBe('CABC123');
  });

  it('has the correct name', () => {
    const err = new InvalidTokenContractError('CXYZ');
    expect(err.name).toBe('InvalidTokenContractError');
  });

  it('is an instance of SoroStreamError and Error', () => {
    const err = new InvalidTokenContractError('CADDR');
    expect(err).toBeInstanceOf(Error);
    expect(err.constructor.name).toBe('InvalidTokenContractError');
  });

  it('can be caught with instanceof', () => {
    try {
      throw new InvalidTokenContractError('CFAKE');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidTokenContractError);
      if (e instanceof InvalidTokenContractError) {
        expect(e.token).toBe('CFAKE');
      }
    }
  });
});
