import { createKmsWalletAdapter } from "../src/index.js";
// In real usage, import from "@aws-sdk/client-kms"
// import { KMSClient, SignCommand } from "@aws-sdk/client-kms";

/**
 * AWS KMS Example Integration for SoroStream SDK (issue #306).
 *
 * Security Model:
 * 1. Private key material is generated and securely held within AWS KMS HSMs.
 * 2. Key material NEVER leaves AWS KMS and is NEVER exposed to local application memory.
 * 3. Signing requests are transmitted to AWS KMS via HTTPS with IAM authentication.
 *
 * Key Rotation Procedure:
 * - Update the `kmsKeyId` or the `sign` function reference dynamically.
 * - Because `createKmsWalletAdapter` accepts an async `sign` function closure, key rotation
 *   or credential refresh can occur in real time without restarting the application process.
 */

export function createAwsKmsWalletAdapter(config: {
  publicKey: string;
  kmsKeyId: string;
  kmsClient: any; // KMSClient instance
}) {
  return createKmsWalletAdapter({
    publicKey: config.publicKey,
    async sign(payload: Uint8Array): Promise<Uint8Array> {
      // Send raw payload to AWS KMS Sign API
      /*
      const command = new SignCommand({
        KeyId: config.kmsKeyId,
        Message: payload,
        MessageType: "RAW",
        SigningAlgorithm: "ECDSA_SHA_256",
      });
      const response = await config.kmsClient.send(command);
      return new Uint8Array(response.Signature!);
      */
      
      // Demonstration mock response for example compilation:
      return new Uint8Array(64);
    },
  });
}
