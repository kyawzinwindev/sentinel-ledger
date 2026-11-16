import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool } from '../src/config/database.js';
import { executeSafeTransfer } from '../src/services/safe_services/safeTransfer.js';
import { InsufficientFundsError } from '../src/domain/errors.js';

describe('Double Spend Concurrency Test', () => {
  let aliceId: string;
  let bobId: string;

  beforeEach(async () => {
    await pool.query('DELETE FROM ledger_entries;');
    await pool.query('DELETE FROM transactions;');
    await pool.query('DELETE FROM accounts;');

    const aliceRes = await pool.query<{ id: string }>(
      'INSERT INTO accounts (owner_name, balance) VALUES ($1, $2) RETURNING id;',
      ['Alice', 10000]
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
  });

  it('should prevent double spending under 15 concurrent transfer requests of $100.00', async () => {
    const transferPromises = Array.from({ length: 15 }, () =>
      executeSafeTransfer({sourceAccountId: aliceId, targetAccountId: bobId, amount: 1000n})
    );

    const results = await Promise.allSettled(transferPromises);

    const fulfilledCount = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

    const balancesRes = await pool.query<{ owner_name: string; balance: string }>(
      'SELECT owner_name, balance FROM accounts WHERE id IN ($1, $2);',
      [aliceId, bobId]
    );

    const aliceBalance = Number(
      balancesRes.rows.find((r) => r.owner_name === 'Alice')?.balance ?? 0
    );
    const bobBalance = Number(
      balancesRes.rows.find((r) => r.owner_name === 'Bob')?.balance ?? 0
    );

    console.log('--- Concurrent Transfer Results ---');
    console.log(`Fulfilled: ${fulfilledCount} | Rejected: ${rejected.length}`);
    if (rejected.length > 0){
      console.log('Sample Error:', rejected[0].reason.message)
    }
    console.log(`Alice Final Balance: ${aliceBalance} | Bob Final Balance: ${bobBalance}`);

    expect(fulfilledCount).toBe(10);
    expect(rejected.length).toBe(5);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(InsufficientFundsError);
    }
  });
});
