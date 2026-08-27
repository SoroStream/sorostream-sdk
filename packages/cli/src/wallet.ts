import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import type { WalletAdapter, Network } from '@sorostream/sdk';

const NETWORK_PASSPHRASES: Record<Network, string> = {
  mainnet: 'Public Global Stellar Network ; September 2015',
  testnet: 'Test SDF Network ; September 2015',
  futurenet: 'Test SDF Future Network ; October 2022',
};

/**
 * Creates a WalletAdapter backed by a Stellar secret key.
 * Suitable for CLI usage.
 */
export function createKeypairAdapter(secretKey: string): WalletAdapter {
  const keypair = Keypair.fromSecret(secretKey);

  return {
    async getPublicKey(): Promise<string> {
      return keypair.publicKey();
    },
    async isConnected(): Promise<boolean> {
      return true;
    },
    async signTransaction(xdr: string, network: Network): Promise<string> {
      const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASES[network]!);
      tx.sign(keypair);
      return tx.toXDR();
    },
  };
}
