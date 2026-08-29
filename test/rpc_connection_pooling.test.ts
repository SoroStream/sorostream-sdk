import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPooledRpcTransport } from "../src/transport.js";
import { ConnectionPool } from "../src/connectionPool.js";
import { SoroStreamClient } from "../src/SoroStreamClient.js";

describe("Issue #435: RPC connection pooling for improved throughput", () => {
  const rpcUrl = "https://soroban-testnet.stellar.org";

  it("instantiates pooled transport with default and custom pool sizes", () => {
    const defaultTransport = createPooledRpcTransport(rpcUrl);
    expect(defaultTransport).toBeDefined();
    expect(defaultTransport.getPoolStats().poolSize).toBe(4);

    const customTransport = createPooledRpcTransport(rpcUrl, { poolSize: 8 });
    expect(customTransport.getPoolStats().poolSize).toBe(8);
  });

  it("exposes all RpcTransportAdapter methods", () => {
    const transport = createPooledRpcTransport(rpcUrl, { poolSize: 2 });
    expect(typeof transport.getAccount).toBe("function");
    expect(typeof transport.getHealth).toBe("function");
    expect(typeof transport.getLatestLedger).toBe("function");
    expect(typeof transport.getTransaction).toBe("function");
    expect(typeof transport.simulateTransaction).toBe("function");
    expect(typeof transport.prepareTransaction).toBe("function");
    expect(typeof transport.sendTransaction).toBe("function");
    expect(typeof transport.getEvents).toBe("function");
    expect(transport.serverURL).toBeDefined();
    expect(transport.serverURL?.toString()).toContain("soroban-testnet.stellar.org");
  });

  it("re-initializes pool on init hook when rpcUrl changes", async () => {
    const transport = createPooledRpcTransport(rpcUrl, { poolSize: 3 });
    const newUrl = "https://soroban-mainnet.stellar.org";
    await transport.init?.({ network: "mainnet", rpcUrl: newUrl });
    expect(transport.serverURL?.toString()).toContain("soroban-mainnet.stellar.org");
  });

  it("cleans up resources on teardown", async () => {
    const transport = createPooledRpcTransport(rpcUrl, { poolSize: 3 });
    await transport.teardown?.();
    expect(transport.getPoolStats().poolSize).toBe(0);
    expect(transport.getPoolStats().activeRequests).toBe(0);
  });

  it("tracks active, total, and reused requests in pool stats", async () => {
    const transport = createPooledRpcTransport(rpcUrl, { poolSize: 2 });
    expect(transport.getPoolStats()).toEqual({
      poolSize: 2,
      activeRequests: 0,
      totalRequests: 0,
      reusedConnections: 0,
    });
  });

  it("ConnectionPool allows acquiring RPC servers for request execution", () => {
    const pool = new ConnectionPool({
      poolSize: 3,
      rpcUrl,
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    });

    const { server, release } = pool.acquireServer();
    expect(server).toBeDefined();
    expect(pool.getStats().active).toBe(1);

    release();
    expect(pool.getStats().active).toBe(0);

    pool.destroy();
  });

  it("SoroStreamClient initializes with useConnectionPooling option", () => {
    const client = new SoroStreamClient({
      network: "testnet",
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      useConnectionPooling: true,
      poolSize: 5,
    });

    expect(client).toBeDefined();
    const stats = client.getConnectionStats();
    expect(stats.maxConnections).toBeDefined();
  });
});
