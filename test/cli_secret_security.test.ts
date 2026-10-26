import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import {
  resolveSecret,
  SECRET_FLAG_DEPRECATION_WARNING,
} from '../packages/cli/src/commands.js';
import { createProgram } from '../packages/cli/src/index.js';

vi.mock('node:readline', () => {
  const answers: string[] = [];
  return {
    createInterface: () => ({
      question: (_q: string, cb: (a: string) => void) => {
        const answer = answers.shift() ?? '';
        cb(answer);
      },
      close: () => {},
      on: () => {},
    }),
    __setAnswers: (a: string[]) => {
      answers.length = 0;
      answers.push(...a);
    },
  };
});

async function setPromptAnswers(answers: string[]) {
  const rl = (await import('node:readline')) as unknown as {
    __setAnswers: (a: string[]) => void;
  };
  rl.__setAnswers(answers);
}

describe('Issue #764: CLI --secret flag deprecation and secure secret handling', () => {
  const TEST_SECRET = Keypair.random().secret();
  const originalEnv = process.env.SOROSTREAM_SECRET;

  beforeEach(() => {
    delete process.env.SOROSTREAM_SECRET;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.SOROSTREAM_SECRET = originalEnv;
    } else {
      delete process.env.SOROSTREAM_SECRET;
    }
  });

  it('resolves secret from SOROSTREAM_SECRET env var without warning', async () => {
    process.env.SOROSTREAM_SECRET = TEST_SECRET;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const resolved = await resolveSecret({});
    expect(resolved).toBe(TEST_SECRET);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('emits runtime deprecation warning when --secret is passed on the CLI', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const resolved = await resolveSecret({
      secret: TEST_SECRET,
      secretFromCliFlag: true,
    });

    expect(resolved).toBe(TEST_SECRET);
    expect(warnSpy).toHaveBeenCalledWith(SECRET_FLAG_DEPRECATION_WARNING);
  });

  it('prompts interactively when neither SOROSTREAM_SECRET nor --secret is provided', async () => {
    await setPromptAnswers([TEST_SECRET]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const resolved = await resolveSecret({});
    expect(resolved).toBe(TEST_SECRET);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('throws a clear error when interactive prompt returns empty secret', async () => {
    await setPromptAnswers(['']);
    await expect(resolveSecret({})).rejects.toThrow(/SOROSTREAM_SECRET/);
  });

  it('marks -s, --secret as [DEPRECATED] in CLI help text and does not make it requiredOption', () => {
    const program = createProgram();
    const help = program.helpInformation();
    expect(help).toContain('[DEPRECATED]');
    expect(help).toContain('SOROSTREAM_SECRET');
  });
});
