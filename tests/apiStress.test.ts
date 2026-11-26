import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { app } from "../src/app.js";
import { pool } from "../src/config/database.js";
import { redis } from "../src/config/redis.js";

interface AccountResponse {
    id: string;
    ownerName: string;
    balance: string;
}

interface TransferResponse {
    transactionId: string;
    sourceBalance: string;
    targetBalance: string;
    replayed: boolean;
}

describe("Sentinel Ledger HTTP API & Stress Benchmark", () => {
  let aliceId: string;
  let bobId: string;

  beforeEach(async () => {
    await pool.query(`DELETE FROM ledger_entries;`);
    await pool.query(`DELETE FROM transactions;`);
    await pool.query(`DELETE FROM accounts;`);
    await redis.flushdb();

    const aliceRes = await pool.query<{ id: string }>(
      `INSERT INTO accounts (owner_name, balance) VALUES ($1,$2) RETURNING id;`,
      ["Alice", 100000], //$1,000.00
    );
    aliceId = aliceRes.rows[0].id;

    const bobRes = await pool.query<{ id: string }>(
      `INSERT INTO accounts (owner_name, balance) VALUES ($1,$2) RETURNING id;`,
      ["Bob", 100000], //$1,000.00
    );
    bobId = bobRes.rows[0].id;
  });

  afterAll(async () => {
    await pool.end();
    await redis.quit();
  });

  it("handles 50 concurrent HTTP transfers with strict financial invariants and proper status codes", async () => {
    const startTime = performance.now();

    const requests = [
      ...Array.from({ length: 25 }, () =>
        app.request("/api/v1/transfers", {
          method: `POST`,
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": randomUUID(),
          },
          body: JSON.stringify({
            sourceAccountId: aliceId,
            targetAccountId: bobId,
            amount: "1000",
          }),
        }),
      ),
      ...Array.from({ length: 25 }, () =>
        app.request("/api/v1/transfers", {
          method: `POST`,
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": randomUUID(),
          },
          body: JSON.stringify({
            sourceAccountId: bobId,
            targetAccountId: aliceId,
            amount: "1000",
          }),
        }),
      ),
    ];

    const responses = await Promise.all(requests);
    const durationMs = performance.now() - startTime;

    const status201Count = responses.filter((r) => r.status === 201).length;
    expect(status201Count).toBe(50);

    //final zero-sum & balance audit
    const zeroSumRes = await pool.query<{net_sum: string}>(
        `SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) AS net_sum FROM ledger_entries;`
    )
    expect(BigInt(zeroSumRes.rows[0].net_sum)).toBe(0n);

    //check the balance of Alice after finishing transfer process
    const aliceRes = await app.request(`/api/v1/accounts/${aliceId}`);
    const aliceData = await aliceRes.json() as AccountResponse;
    expect(aliceData.balance).toBe('100000');

    console.log(`\n HTTP Stress Benchmark Completed:`);
    console.log(`50 Concurrent Transfers | 100% HTTP 201 | Duration: ${durationMs.toFixed(2)}ms`);
    console.log(`   Throughput: ${(50 / (durationMs / 1000)).toFixed(1)} tx/sec | Zero-Sum Audit: 0`);
  });

  it('returns 200 OK with X-Idempotent-Replay header on HTTP retry', async () => {
    const key = randomUUID();
    const payload = JSON.stringify({
        sourceAccountId: aliceId,
        targetAccountId: bobId,
        amount: '2500',
    });

    const res1 = await app.request('/api/v1/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: payload,
    });
    expect(res1.status).toBe(201);

    const res2 = await app.request('/api/v1/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: payload,
    });
    expect(res2.status).toBe(200);
    expect(res2.headers.get('X-Idempotent-Replay')).toBe('true');

    const body1 = await res1.json() as TransferResponse;
    const body2 = await res2.json() as TransferResponse;
    expect(body2.transactionId).toBe(body1.transactionId);
  });
});
