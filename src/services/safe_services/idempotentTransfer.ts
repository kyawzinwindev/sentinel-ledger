import { redis } from "../../config/redis.js";
import { executeLedgerTransfer, LedgerTransferInput, TransferResult } from "./ledgerTransfer.js";

export class DuplicateRequestInProgressError extends Error {
    constructor(key: string){
        super(`Request with idempotency key "${key}" is currently being processed`);
        this.name = 'DuplicateRequestInProgressError';
    }
}

export interface IdempotentTransferInput extends LedgerTransferInput{
    idempotencyKey: string;
}

interface CachedIdempotencyRecord {
    status: 'IN_PROGRESS' | 'COMPLETED',
    response?: {
        transactionId: string;
        sourceBalance: string;
        targetBalance: string;
    }
}

export async function executeIdempotentTransfer(
    input: IdempotentTransferInput
): Promise<{result: TransferResult; isCachedReplay: boolean}> {
    const redisKey = `idempotency:transfer:${input.idempotencyKey}`;
    const TTL_SECONDS = 86400; //24hours

    const initialRecord: CachedIdempotencyRecord = { status: 'IN_PROGRESS'};

    //check the key whether existed or not
    const acquired = await redis.set(
        redisKey,
        JSON.stringify(initialRecord),
        'EX',
        TTL_SECONDS,
        'NX'
    )

    //return result from the cache for duplicate request
    if(!acquired) {
        const existingRaw = await redis.get(redisKey);
        if(existingRaw) {
            const existing: CachedIdempotencyRecord = JSON.parse(existingRaw);

            if(existing.status === 'IN_PROGRESS'){
                throw new DuplicateRequestInProgressError(input.idempotencyKey);
            }

            if(existing.status === 'COMPLETED' && existing.response){
                return {
                    result: {
                        transactionId: existing.response.transactionId,
                        sourceBalance: BigInt(existing.response.sourceBalance),
                        targetBalance: BigInt(existing.response.targetBalance)
                    },
                    isCachedReplay: true,
                }
            }
        }
    }

    //if key or request is new, do the postgreSql ledger transfer
    try {
        const transferResult = await executeLedgerTransfer(input);

        const completedRecord: CachedIdempotencyRecord = {
            status: 'COMPLETED',
            response: {
                transactionId: transferResult.transactionId,
                sourceBalance: transferResult.sourceBalance.toString(),
                targetBalance: transferResult.targetBalance.toString()
            }
        }

        await redis.set(
            redisKey,
            JSON.stringify(completedRecord),
            'EX',
            TTL_SECONDS
        )

        return {
            result: transferResult,
            isCachedReplay: false,
        }
    } catch (error) {
        await redis.del(redisKey);
        throw error;
    }
}