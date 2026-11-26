import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool } from '../src/config/database.js';
import { redis } from '../src/config/redis.js';
import {
  executeIdempotentTransfer,
  DuplicateRequestInProgressError,
} from '../src/services/safe_services/idempotentTransfer.js';

describe('Distributed Idempotency Test (Redis + Postgres)', () => {
  let aliceId: string;
  let bobId: string;

  beforeEach(async () => {
    await pool.query('DELETE FROM ledger_entries;');
    await pool.query('DELETE FROM transactions;');
    await pool.query('DELETE FROM accounts;');
    await redis.flushdb();

    const aliceRes = await pool.query<{ id: string }>(
      'INSERT INTO accounts (owner_name, balance) VALUES ($1, $2) RETURNING id;',
      ['Alice', 10000] // $100.00
    );
    aliceId = aliceRes.rows[0].id;

    const bobRes = await pool.query<{ id: string }>(
      'INSERT INTO accounts (owner_name, balance) VALUES ($1, $2) RETURNING id;',
      ['Bob', 0]
    );
    bobId = bobRes.rows[0].id;
  });

  afterAll(async () => {
    await pool.end();
    await redis.quit();
  });

  it('prevents duplicate charges when client retries with the same idempotency key', async () => {
    const idempotencyKey = randomUUID();

    // 1st attempt (original request)
    const first = await executeIdempotentTransfer({
      sourceAccountId: aliceId,
      targetAccountId: bobId,
      amount: 5000n,
      idempotencyKey,
    });
    expect(first.isCachedReplay).toBe(false);

    // 2nd & 3rd attempts (simulated network timeout retries)
    const retry1 = await executeIdempotentTransfer({
      sourceAccountId: aliceId,
      targetAccountId: bobId,
      amount: 5000n,
      idempotencyKey,
    });
    const retry2 = await executeIdempotentTransfer({
      sourceAccountId: aliceId,
      targetAccountId: bobId,
      amount: 5000n,
      idempotencyKey,
    });

    expect(retry1.isCachedReplay).toBe(true);
    expect(retry2.isCachedReplay).toBe(true);
    expect(retry1.result.transactionId).toBe(first.result.transactionId);

    // verify Alice was only charged once ($50)
    const aliceRes = await pool.query<{ balance: string }>('SELECT balance FROM accounts WHERE id = $1;', [aliceId]);
    expect(BigInt(aliceRes.rows[0].balance)).toBe(5000n);
  });

  it('blocks simultaneous double-click requests sharing the same idempotency key', async () => {
    const idempotencyKey = randomUUID();

    const requests = Array.from({ length: 10 }, () =>
      executeIdempotentTransfer({
        sourceAccountId: aliceId,
        targetAccountId: bobId,
        amount: 5000n,
        idempotencyKey,
      })
    );

    const results = await Promise.allSettled(requests);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(9);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(DuplicateRequestInProgressError);
    }

    // Verify Alice balance is 5000 (not 0 or negative)
    const aliceRes = await pool.query<{ balance: string }>('SELECT balance FROM accounts WHERE id = $1;', [aliceId]);
    expect(BigInt(aliceRes.rows[0].balance)).toBe(5000n);
  });
});