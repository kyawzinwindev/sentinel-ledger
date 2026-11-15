import { pool } from "../config/database.js";
import { InsufficientFundsError } from "../domain/errors.js";

export interface TransferInput {
    sourceAccountId: string;
    targetAccountId: string;
    amount: bigint
}

export async function executeSafeTransfer(input: TransferInput):Promise<void> {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        //Step: 1
        //To check the balance first
        const sourceRes = await client.query(
            'SELECT balance FROM accounts WHERE id = $1 FOR UPDATE',
            [input.sourceAccountId]
        )

        if(sourceRes.rows.length === 0){
            throw new Error('Source account not found')
        }

        //Query the balance
        const currentBalance = BigInt(sourceRes.rows[0].balance);
        
        //Validate the balance with the amount
        if(currentBalance < input.amount){
            throw new InsufficientFundsError(currentBalance, input.amount)
        }

        //Funcy Delay to increase the race condition
        await new Promise(resolve => setTimeout(resolve, 50));

        //Step: 2
        //Decrease Balance from Source
        await client.query(
            'UPDATE accounts SET balance = balance - $1 WHERE id = $2',
            [input.amount, input.sourceAccountId]
        );

        //Step: 3
        //Increase Balance to Target
        await client.query(
            'UPDATE accounts SET balance = balance + $1 WHERE id = $2',
            [input.amount, input.targetAccountId]
        );

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally{
        client.release();
    }
}