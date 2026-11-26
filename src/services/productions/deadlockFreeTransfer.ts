import { resolve } from "node:dns";
import { pool } from "../../config/database.js";
import {
  InsufficientFundsError,
  AccountNotFoundError,
} from "../../domain/errors.js";

export interface TransferInput {
  sourceAccountId: string;
  targetAccountId: string;
  amount: bigint;
}

export async function executeDeadLockFreeTransfer(
  input: TransferInput,
): Promise<void> {
  if (input.sourceAccountId === input.targetAccountId) {
    throw new Error("Cannot transfer to the same account");
  }
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const lockedRes = await client.query(
        'SELECT id, balance FROM accounts WHERE id IN ($1,$2) ORDER BY id ASC FOR UPDATE',
        [input.sourceAccountId, input.targetAccountId]
    )

    if(lockedRes.rows.length !== 2){
        throw new AccountNotFoundError('One or both accounts not found');
    }

    //dummy delay to test
    await new Promise((resolve) => setTimeout(resolve, 50));

    const sourceRow = lockedRes.rows.find((r) => r.id === input.sourceAccountId)!;
    const currentBalance = BigInt(sourceRow.balance);
    if (currentBalance < input.amount) {
      throw new InsufficientFundsError(currentBalance, input.amount);
    }

    //step:3 , execute the transaction update
    await client.query(
      "UPDATE accounts SET balance = balance - $1 WHERE id = $2",
      [input.amount.toString(), input.sourceAccountId],
    );

    await client.query(
      "UPDATE accounts SET balance = balance + $1 WHERE id = $2",
      [input.amount.toString(), input.targetAccountId],
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
