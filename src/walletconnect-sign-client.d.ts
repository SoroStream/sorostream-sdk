/**
 * Ambient type declarations for `@walletconnect/sign-client`.
 *
 * The WalletConnect adapter (`src/wallet.ts`) imports this package via a
 * runtime `import()` so it is never bundled into the SDK. Declaring the
 * module here lets TypeScript type-check the adapter without forcing the
 * package to be installed in every consumer (issue #367 / #453).
 *
 * Only the surface used by the adapter is modelled; the full SDK exposes
 * much more.
 */

declare module '@walletconnect/sign-client' {
  export interface WalletConnectSession {
    topic: string;
    /** Unix timestamp (seconds) at which the session expires. */
    expiry: number;
    namespaces: Record<string, { accounts: string[]; methods: string[]; events: string[] }>;
  }

  export interface WalletConnectSignClient {
    connect(params: {
      requiredNamespaces: Record<string, { methods: string[]; chains: string[]; events: string[] }>;
    }): Promise<{
      topic: string;
      namespaces: Record<string, { accounts: string[]; methods: string[]; events: string[] }>;
    }>;
    disconnect(params: { topic: string; reason: unknown }): Promise<void>;
    on(event: string, callback: (...args: unknown[]) => void): void;
    off(event: string, callback: (...args: unknown[]) => void): void;
    request(params: {
      topic: string;
      chainId: string;
      request: { method: string; params: unknown };
    }): Promise<unknown>;
    session: {
      get(topic: string): WalletConnectSession;
      getAll(): WalletConnectSession[];
    };
  }

  const SignClient: {
    init(config: {
      projectId: string;
      relayUrl?: string;
      metadata?: unknown;
    }): Promise<WalletConnectSignClient>;
  };

  export default SignClient;
}
