import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { pool } from "../src/config/database.js";
import { executeNaiveTwoLockTransfer } from "../src/services/vulnerabilities/deadlockTransfer.js";
import { executeDeadLockFreeTransfer } from "../src/services/productions/deadlockFreeTransfer.js";

describe("Bidirectional Transfer Deadlock Test", () => {
  let aliceId: string;
  let bobId: string;

  beforeEach(async () => {
    await pool.query("DELETE FROM ledger_entries;");
    await pool.query("DELETE FROM transactions");
    await pool.query("DELETE FROM accounts");

    const aliceRes = await pool.query(
      "INSERT INTO accounts (owner_name, balance) VALUES ($1,$2) RETURNING id;",
      ["Alice", 10000],
    );
    aliceId = aliceRes.rows[0].id;

    const bobREs = await pool.query(
      "INSERT INTO accounts (owner_name, balance) VALUES ($1,$2) RETURNING id;",
      ["Bob", 10000],
    );
    bobId = bobREs.rows[0].id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("expose PostgreSQL deadlock (40P01) during concurrent bidirectional transfers", async () => {
    const aliceToBob = Array.from({ length: 5 }, () =>
      executeDeadLockFreeTransfer({
        sourceAccountId: aliceId,
        targetAccountId: bobId,
        amount: 1000n,
      }),
    );

    const bobToAlice = Array.from({ length: 5 }, () =>
      executeDeadLockFreeTransfer({
        sourceAccountId: bobId,
        targetAccountId: aliceId,
        amount: 1000n,
      }),
    );

    const results = await Promise.allSettled([...aliceToBob, ...bobToAlice]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult[];

    console.log("\n--- Deadlock Concurrency Results ---");
    console.log(
      `Fulfilled: ${fulfilled.length} | Rejected: ${rejected.length}`,
    );

    const deadlockErrors = rejected.filter(
        (r) => r.reason?.code === '40P01' || r.reason?.message?.includes('deadlock')
    );

    if (deadlockErrors.length > 0) {
      console.log(`DEADLOCK DETECTED (${deadlockErrors.length} times):`, deadlockErrors[0].reason.message);
    }

    // In a healthy system, ALL 10 transfers should succeed without deadlocking!
    expect(fulfilled.length).toBe(10);
    expect(deadlockErrors.length).toBe(0);
  });
});
