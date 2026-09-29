---
"@sorostream/sdk": minor
---

feat(#515): multi-network client support for Mainnet, Testnet, and Futurenet

Adds MultiNetworkClient that wraps multiple SoroStreamClient instances and fans
read operations across all configured networks. Exports MultiNetworkClient,
MultiNetworkConfigError, and MultiNetworkNotFoundError from the main entry point.
