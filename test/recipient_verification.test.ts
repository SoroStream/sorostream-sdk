import { describe, it, expect, vi, beforeEach } from 'vitest';

// ==========================================
// --- 1. CORE IMPLEMENTATION CODE ---
// ==========================================

export class RecipientNotFoundError extends Error {
  constructor(address: string) {
    super(
      `Stream creation rejected: Recipient account [${address}] does not exist on the Stellar network (unfunded).`,
    );
    this.name = 'RecipientNotFoundError';
  }
}

export interface StreamOptions {
  verifyRecipient?: boolean;
  timeoutMs?: number;
}

export interface StreamPayload {
  streamId: string;
  recipient: string;
  amount: string;
  status: string;
}

export class SoroStreamSDK {
  private horizonUrl: string;

  constructor(horizonUrl = 'https://horizon-testnet.stellar.org') {
    this.horizonUrl = horizonUrl;
  }

  /**
   * Checks with the Horizon API to confirm if an account exists
   */
  async verifyAccountExists(address: string, timeoutMs = 3000): Promise<boolean> {
    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.horizonUrl}/accounts/${address}`, {
        signal: controller.signal,
      });
      clearTimeout(timerId);

      if (response.status === 200) {
        return true;
      }
      if (response.status === 404) {
        return false;
      }

      throw new Error(`Horizon unexpected status code: ${response.status}`);
    } catch (error: any) {
      clearTimeout(timerId);
      if (error.name === 'AbortError') {
        throw new Error(`Horizon lookup timed out after ${timeoutMs}ms`);
      }
      throw error;
    }
  }

  /**
   * Core workflow function to initialize a new active asset stream
   */
  async createStream(
    recipient: string,
    amount: string,
    options: StreamOptions = { verifyRecipient: false },
  ): Promise<StreamPayload> {
    // Acceptance Criteria: Optionally verify recipient account existence before transaction compilation
    if (options.verifyRecipient) {
      const exists = await this.verifyAccountExists(recipient, options.timeoutMs);
      if (!exists) {
        throw new RecipientNotFoundError(recipient);
      }
    }

    // Simulate transaction submission and streaming registry initialization
    return {
      streamId: `stream_${Math.random().toString(36).substring(2, 9)}`,
      recipient,
      amount,
      status: 'active',
    };
  }
}

// ==========================================
// --- 2. TDD AUTOMATED TEST SUITE ---
// ==========================================

describe('TDD - Stream Recipient Pre-Flight Verification Engine', () => {
  let sdk: SoroStreamSDK;
  const fundedAddress = 'GBFUNDEDACCOUNT...VALID...STELLAR...ADDRESS';
  const unfundedAddress = 'GBUNFUNDEDACCOUNT...EMPTY...STELLAR...ADDRESS';

  beforeEach(() => {
    sdk = new SoroStreamSDK();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('should create a stream smoothly without checking Horizon if verifyRecipient option is false', async () => {
    // Act
    const result = await sdk.createStream(unfundedAddress, '500.00', { verifyRecipient: false });

    // Assert: Confirm transaction processes instantly without firing network traffic
    expect(result.status).toBe('active');
    expect(result.recipient).toBe(unfundedAddress);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should successfully build a stream if verifyRecipient is true and target account exists', async () => {
    // Arrange: Mock Horizon returning a valid 200 OK account payload
    vi.mocked(fetch).mockResolvedValueOnce({
      status: 200,
    } as Response);

    // Act
    const result = await sdk.createStream(fundedAddress, '150.00', { verifyRecipient: true });

    // Assert
    expect(result.status).toBe('active');
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining(fundedAddress), expect.any(Object));
  });

  it('should throw RecipientNotFoundError and protect funds if verifyRecipient is true and target account is 404', async () => {
    // Arrange: Mock Horizon returning a 404 Not Found error
    vi.mocked(fetch).mockResolvedValueOnce({
      status: 404,
    } as Response);

    // Act & Assert: Verify that the pipeline halts and returns the exact designated error class
    await expect(
      sdk.createStream(unfundedAddress, '250.00', { verifyRecipient: true }),
    ).rejects.toThrow(RecipientNotFoundError);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('should surface clear timeout errors if Horizon operations exceed the configured threshold parameters', async () => {
    // Arrange: Mock a hanging connection that handles an abort signal
    vi.mocked(fetch).mockImplementationOnce((url, options: any) => {
      return new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => {
          const timeoutErr = new Error('The user aborted a request.');
          timeoutErr.name = 'AbortError';
          reject(timeoutErr);
        });
      });
    });

    // Act & Assert: Execute lookup with a strict 1000ms timeout window limit
    await expect(
      sdk.createStream(fundedAddress, '100.00', { verifyRecipient: true, timeoutMs: 1000 }),
    ).rejects.toThrow('Horizon lookup timed out after 1000ms');
  });
});
