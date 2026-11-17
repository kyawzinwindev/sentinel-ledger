import { randomUUID } from "node:crypto";
import { pool } from "../../config/database.js";
import { InsufficientFundsError, AccountNotFoundError } from "../../domain/errors.js";

export interface LedgerTransferInput {
    sourceAccountId: string,
    targetAccountId: string,
    amount: bigint
}

export interface TransferResult {
    transactionId: string,
    sourceBalance: bigint,
    targetBalance: bigint
}

export async function executeLedgerTransfer(input: LedgerTransferInput): Promise<TransferResult>{
    if(input.amount <= 0n){
        throw new Error('Transfer amount must be positive');
    }

    if(input.sourceAccountId === input.targetAccountId){
        throw new Error('Cannot transfer to the same account');
    }

    const client = await pool.connect();

    try {
        client.query('BEGIN');

        //Step: 1 deterministic row-level locking & prevent race condition
        const lockedRes = await client.query<{ id: string; balance: string }>(
            'SELECT id, balance FROM accounts WHERE id IN ($1,$2) ORDER BY id ASC FOR UPDATE',
            [input.sourceAccountId, input.targetAccountId]
        )

        if(lockedRes.rows.length !== 2){
            throw new AccountNotFoundError('One or both accounts not found')
        }

        const sourceRow = lockedRes.rows.find((r) => r.id === input.sourceAccountId);
        const targetRow = lockedRes.rows.find((r) => r.id === input.targetAccountId)

        if(!sourceRow || !targetRow){
            throw new AccountNotFoundError('Account Mapping Failed!');
        }

        const currentSourceBalance = BigInt(sourceRow.balance);
        const currentTargetBalance = BigInt(targetRow.balance);

        if(currentSourceBalance < input.amount){
            throw new InsufficientFundsError(currentSourceBalance, input.amount)
        }

        //Step 2 : create and insert transaction record
        const transactionRes = await client.query<{id: string}>(
            `INSERT INTO transactions (idempotency_key, status, amount) VALUES ($1, 'COMPLETED', $2)
            RETURNING id`,
            [randomUUID(), input.amount.toString()]
        )

        const transactionId = transactionRes.rows[0].id;

        //Step 3 : create and insert double-entry ledger (debit,credit)
        await client.query(
            `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount) 
            VALUES ($1, $2, 'DEBIT', $4), ($1, $3, 'CREDIT', $4)`,
            [transactionId, input.sourceAccountId, input.targetAccountId, input.amount.toString()]
        )

        //Step 4 : update both source and target account's balance
        const newSourceBalance = currentSourceBalance - input.amount;
        const newTargetBalance = currentTargetBalance + input.amount;

        await client.query(
            `UPDATE accounts SET balance = $1 WHERE id = $2`,
            [newSourceBalance.toString(), input.sourceAccountId]
        )

        await client.query(
            `UPDATE accounts SET balance = $1 WHERE id = $2`,
            [newTargetBalance.toString(), input.targetAccountId]
        )

        client.query('COMMIT');   

        return {
            transactionId,
            sourceBalance: newSourceBalance,
            targetBalance: newTargetBalance
        }
    } catch (error) {
        client.query('ROLLBACK');
        throw error;
    }finally{
        client.release()
    }
}