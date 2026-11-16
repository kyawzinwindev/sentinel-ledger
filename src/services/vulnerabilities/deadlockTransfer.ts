import { pool } from "../../config/database.js";
import { InsufficientFundsError, AccountNotFoundError } from "../../domain/errors.js";

export interface TransferInput{
    sourceAccountId: string,
    targetAccountId: string,
    amount: bigint
}

export async function executeNaiveTwoLockTransfer(input: TransferInput): Promise<void>{
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        //step: 1, lock the source account first
        const sourceRes = await client.query(
            "SELECT balance FROM accounts WHERE id = $1 FOR UPDATE",
            [input.sourceAccountId]
        )

        if(sourceRes.rows.length === 0){
            throw new AccountNotFoundError(input.sourceAccountId);
        }

        //dummy delay for concurrent testing
        await new Promise((resolve) => setTimeout(resolve, 50));

        //step: 2, lock the taret account
        const targetRes = await client.query(
            "SELECT balance FROM accounts WHERE id = $1 FOR UPDATE",
            [input.targetAccountId]
        )

        if(targetRes.rows.length === 0){
            throw new AccountNotFoundError(input.targetAccountId);
        }

        const currentBalance = BigInt(sourceRes.rows[0].balance);
        if(currentBalance < input.amount){
            throw new InsufficientFundsError(currentBalance, input.amount);
        }

        //step:3 , execute the transaction update
        await client.query(
            "UPDATE accounts SET balance = balance - $1 WHERE id = $2",
            [input.amount.toString(), input.sourceAccountId]
        )

        await client.query(
            "UPDATE accounts SET balance = balance + $1 WHERE id = $2",
            [input.amount.toString(), input.targetAccountId]
        )

        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally{
        client.release();
    }
}