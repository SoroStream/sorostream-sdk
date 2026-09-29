# SoroStream SDK Architecture

This document outlines the system architecture and module dependencies of `@sorostream/sdk`.

## Overview Architecture

```mermaid
flowchart TD
  subgraph Consumer ["Application Layer"]
    App["Client App / Web Dashboard"]
    RNApp["React Native / Expo App"]
    CLIApp["CLI Tools"]
  end

  subgraph Packages ["Subpackages & Framework Adapters"]
    ReactPkg["@sorostream/react (Hooks)"]
    VuePkg["@sorostream/vue (Composables)"]
    RNPkg["@sorostream/sdk-react-native"]
    CLIPkg["@sorostream/cli"]
    ESLintPkg["@sorostream/eslint-plugin"]
  end

  subgraph CoreSDK ["@sorostream/sdk Core Engine"]
    Client["SoroStreamClient"]
    CoreModule["@sorostream/sdk/core"]
    BatchModule["@sorostream/sdk/batch"]
    WalletsModule["@sorostream/sdk/wallets"]
    Transport["RpcTransportAdapter & Transport Pool"]
    EventBus["InMemoryEventBus"]
    CacheManager["TTL Cache & Deduplicator"]
  end

  subgraph External ["External Services & Blockchain"]
    StellarRPC["Soroban RPC Server"]
    FreighterExt["Freighter Extension"]
    LedgerHW["Ledger Hardware Wallet"]
    KMS["AWS KMS / Cloud Signers"]
  end

  App --> ReactPkg
  App --> Client
  RNApp --> RNPkg
  RNPkg --> Client
  CLIApp --> CLIPkg
  CLIPkg --> Client

  ReactPkg --> Client
  VuePkg --> Client

  Client --> CoreModule
  Client --> Transport
  Client --> EventBus
  Client --> CacheManager

  WalletsModule --> FreighterExt
  WalletsModule --> LedgerHW
  WalletsModule --> KMS

  Transport --> StellarRPC
```

## Modular Layering

1. **Client & Core Engine (`SoroStreamClient`, `src/core.ts`)**:
   Handles stream creation, top-up, cancellation, withdrawals, and balance estimations. Pure utility helpers (`toStroops`, `formatUSDC`, `claimableNow`, `calculateVestingSchedule`) are decoupled from network logic and can run in any JS environment (Node, Bun, Deno, Browser).

2. **Transport & Network Layer (`src/transport.ts`)**:
   Provides `RpcTransportAdapter`, `createDefaultRpcTransport`, and `createRetryingRpcTransport`. Abstracts all RPC interactions, JSON-RPC polling, and error handling.

3. **Event System (`src/eventBus.ts`, `src/events.ts`)**:
   Exposes `IEventBus` and `InMemoryEventBus` for streaming event notifications (`stream.created`, `stream.withdrawn`, `rpc.error`) without requiring global RxJS.

4. **Wallet Adapters (`src/wallet.ts`, `@sorostream/sdk/wallets`)**:
   Decouples transaction signing from stream management. Built-in adapters support Freighter (`createFreighterAdapter`), Ledger (`createLedgerAdapter`), Lobstr (`createLobstrAdapter`), Passkey, AWS KMS, and secret keypair.

5. **Storage & Audit Logging (`src/adapters.ts`)**:
   Provides `StorageAdapter` interface for audit logging across web (`localStorage`), React Native (`AsyncStorage`), and Expo (`expo-secure-store`).
