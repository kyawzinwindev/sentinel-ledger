import { Hono } from "hono";
import { pool } from "./config/database.js";
import {
  executeIdempotentTransfer,
  DuplicateRequestInProgressError,
} from "./services/productions/idempotentTransfer.js";
import {
  InsufficientFundsError,
  AccountNotFoundError,
} from "./domain/errors.js";

export const app = new Hono();

// to check the health of endpoint/ hello, testing
app.get("/health", (c) => {
  return c.json({ status: "ok", service: "sentinel-ledger" }, 200);
});

// to get the account balance of the owner
app.get("/api/v1/accounts/:id", async (c) => {
  const id = c.req.param("id");
  const res = await pool.query<{
    id: string;
    owner_name: string;
    balance: string;
  }>(`SELECT id, owner_name, balance FROM accounts WHERE id = $1`, [id]);

  if (res.rows.length === 0) {
    return c.json({ error: "Account not found" }, 404);
  }

  return c.json({
      id: res.rows[0].id,
      owner_name: res.rows[0].owner_name,
      balance: res.rows[0].balance,
    },200);
});

//perform the idempotent double-entry transfer
app.post("/api/v1/transfers", async (c) => {
  //to check idempotency key is existed or not
  const idempotencyKey = c.req.header("Idempotency-Key");
  if (!idempotencyKey || idempotencyKey.trim() === "") {
    return c.json({ error: "Missing required header: Idempotency-Key" }, 400);
  }

  //to check body formatting is valid or not
  let body: {
    sourceAccountId?: string;
    targetAccountId?: string;
    amount?: string | number;
  };
  try {
    body = await c.req.json();
  } catch (error) {
    return c.json({ error: "Invalid JSON payload" }, 400);
  }

  //to check the required fields are existed or not
  if (
    !body.sourceAccountId ||
    !body.targetAccountId ||
    body.amount === undefined
  ) {
    return c.json(
      { error: "sourceAccountId, targetAccountId, and amount are required." },
      400,
    );
  }

  //to check the amount is valid and positive
  let amountBigInt: bigint;
  try {
    amountBigInt = BigInt(body.amount);
    if (amountBigInt <= 0n) throw new Error();
  } catch (error) {
    return c.json({ error: "amount must be a positive integer" }, 400);
  }

  //finally perform the idempotent transfer
  try {
    const { result, isCachedReplay } = await executeIdempotentTransfer({
      sourceAccountId: body.sourceAccountId,
      targetAccountId: body.targetAccountId,
      amount: amountBigInt,
      idempotencyKey,
    });

    if (isCachedReplay) {
      c.header("X-Idempotent-Replay", "true");
    }

    return c.json(
      {
        transactionId: result.transactionId,
        sourceBalance: result.sourceBalance.toString(),
        targetBalance: result.targetBalance.toString(),
        replayed: isCachedReplay,
      },
      isCachedReplay ? 200 : 201,
    );
  } catch (error) {
    if(error instanceof DuplicateRequestInProgressError){
        return c.json({error: error.message}, 409);
    }

    if(error instanceof AccountNotFoundError){
        return c.json({error: error.message}, 404);
    }

    if(error instanceof InsufficientFundsError){
        return c.json({error: error.message}, 422);
    }

    console.error('Unhandled Transfer Error:', error);
    return c.json({error: 'Internal server error'}, 500);
  }
});
