import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool } from '../src/config/database.js';
import { executeLedgerTransfer } from '../src/services/safe_services/ledgerTransfer.js';

describe('Double-Entry Ledger & Financial Invariants Test', () => {
  let aliceId: string;
  let bobId: string;

  beforeEach(async () => {
    await pool.query('DELETE FROM ledger_entries;');
    await pool.query('DELETE FROM transactions;');
    await pool.query('DELETE FROM accounts;');

    const aliceRes = await pool.query<{ id: string }>(
      'INSERT INTO accounts (owner_name, balance) VALUES ($1, $2) RETURNING id;',
      ['Alice', 50000] // $500.00
    );
    aliceId = aliceRes.rows[0].id;

    const bobRes = await pool.query<{ id: string }>(
      'INSERT INTO accounts (owner_name, balance) VALUES ($1, $2) RETURNING id;',
      ['Bob', 50000] // $500.00
    );
    bobId = bobRes.rows[0].id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('maintains strict zero-sum double-entry invariants under concurrent bidirectional load', async () => {
    // Alice -> Bob ($10 x 10 times) AND Bob -> Alice ($15 x 10 times)
    const transfers = [
      ...Array.from({ length: 10 }, () =>
        executeLedgerTransfer({ sourceAccountId: aliceId, targetAccountId: bobId, amount: 1000n })
      ),
      ...Array.from({ length: 10 }, () =>
        executeLedgerTransfer({ sourceAccountId: bobId, targetAccountId: aliceId, amount: 1500n })
      ),
    ];

    const results = await Promise.allSettled(transfers);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

    if (rejected.length > 0) {
      console.error('Sample Transfer Error:', rejected[0].reason);
    }

    expect(fulfilled.length).toBe(20);

    // 1. Audit Zero-Sum Ledger Invariant (Sum of Debits must equal Sum of Credits)
    const zeroSumRes = await pool.query<{ net_sum: string }>(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) as net_sum 
       FROM ledger_entries;`
    );
    expect(BigInt(zeroSumRes.rows[0].net_sum)).toBe(0n);

    // 2. Audit Entry Count (20 transactions = 40 double-entry rows)
    const countRes = await pool.query<{ count: string }>('SELECT COUNT(*) as count FROM ledger_entries;');
    expect(Number(countRes.rows[0].count)).toBe(40);

    // 3. Reconcile Materialized Balance vs Ledger History
    // Alice: 50000 - (10 * 1000) + (10 * 1500) = 55000
    // Bob:   50000 + (10 * 1000) - (10 * 1500) = 45000
    const accountsRes = await pool.query<{ id: string; balance: string }>('SELECT id, balance FROM accounts;');
    const aliceFinal = BigInt(accountsRes.rows.find((r) => r.id === aliceId)!.balance);
    const bobFinal = BigInt(accountsRes.rows.find((r) => r.id === bobId)!.balance);

    console.log(`--- Module 3 Audit Results ---`);
    console.log(`Alice Final: ${aliceFinal} | Bob Final: ${bobFinal} | Net Ledger Sum: ${zeroSumRes.rows[0].net_sum}`);

    expect(aliceFinal).toBe(55000n);
    expect(bobFinal).toBe(45000n);
    expect(aliceFinal + bobFinal).toBe(100000n);
  });
});