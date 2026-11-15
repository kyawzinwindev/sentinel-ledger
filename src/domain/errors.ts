export class InsufficientFundsError extends Error{
    constructor(available: bigint, requested: bigint){
        super(
            `Insufficient funds. Available: ${available}, Requested: ${requested}`
        );
        this.name = 'InsufficientFundsError';
    }
}

export class AccountNotFoundError extends Error{
    constructor(accountId: number){
        super(
            `Account not found: ${accountId}`
        );
        this.name = 'AccountNotFoundError';
    }
}