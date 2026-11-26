# Sentinel Ledger

A high-concurrency, double-entry financial transaction engine built with **TypeScript**, **PostgreSQL**, **Redis**, and **Hono**.

Sentinel Ledger demonstrates how to evolve a naive fund-transfer implementation into an ACID-compliant, fault-tolerant FinTech ledger capable of preventing double-spend race conditions, PostgreSQL deadlocks (`40P01`), floating-point rounding drift, and duplicate network retries under high concurrent load.

---

## Core Architectural Guarantees

| Problem Domain | Failure Mode in Naive Systems | Sentinel Ledger Solution |
| :--- | :--- | :--- |
| **Concurrent Double-Spend** | Lost updates (`read-modify-write` race conditions) leading to negative balances. | **Pessimistic Row-Level Locking** (`SELECT ... FOR UPDATE`) inside explicit SQL transactions. |
| **Bidirectional Deadlocks** | Circular wait (`40P01`) when Account A and Account B transfer to each other simultaneously. | **Canonical Deterministic Lock Ordering** (`ORDER BY id ASC FOR UPDATE`) to enforce a global lock acquisition hierarchy. |
| **Accounting Integrity** | Mutable balance updates leave no audit trail and risk silent state corruption. | **Immutable Double-Entry Bookkeeping** (`DEBIT` + `CREDIT` pairs) enforcing a strict zero-sum invariant ($\sum \text{DEBIT} - \sum \text{CREDIT} = 0$) alongside materialized balances. |
| **Precision Loss** | IEEE 754 floating-point errors (`0.1 + 0.2 !== 0.3`) corrupting monetary calculations. | **Integer Minor-Unit Arithmetic** storing all balances and ledger entries as `BIGINT` cents. |
| **Network Retries & Double-Clicks** | Client timeouts or duplicate submissions charging the sender multiple times. | **Two-Layer Distributed Idempotency** using atomic Redis `SET ... NX EX` state locks backed by a PostgreSQL `UNIQUE` constraint. |

---

## System Architecture

```text
POST /api/v1/transfers (Header: Idempotency-Key: <uuid>)
  │
  ▼
┌─────────────────────────────────────────────────────────────────┐
│ 1. HTTP & Validation Layer (Hono)                               │
│    • Validates Idempotency-Key header & positive BIGINT amount  │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. Distributed Idempotency Gate (Redis)                         │
│    • SET idempotency:transfer:<key> "IN_PROGRESS" EX 86400 NX   │
│    ├── Already COMPLETED ──► Return cached 200 OK replay (<5ms) │
│    ├── Already IN_PROGRESS ─► Reject with 409 Conflict          │
│    └── New Key ────────────► Proceed to PostgreSQL Transaction  │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. ACID Double-Entry Execution Engine (PostgreSQL)              │
│    • BEGIN                                                      │
│    • SELECT id, balance FROM accounts                           │
│      WHERE id IN ($1, $2) ORDER BY id ASC FOR UPDATE            │
│    • Verify sufficient funds (BIGINT comparison)                │
│    • INSERT INTO transactions (idempotency_key, status, amount) │
│    • INSERT INTO ledger_entries (DEBIT & CREDIT pair)           │
│    • UPDATE accounts SET balance = ... (Materialized Balances)  │
│    • COMMIT                                                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Performance & Concurrency Benchmarks

Verified via automated chaos and concurrency test suites (`Vitest`) running against PostgreSQL and Redis:

* **Throughput:** **460.8 tx/sec** under 50 simultaneous bidirectional HTTP transfer requests (`108.51ms` total batch execution).
* **Concurrency Safety:** **0 deadlocks (`40P01`)** and **0 race-condition overdrafts** across bidirectional stress tests.
* **Idempotent Replay Latency:** **~5ms** response time (`200 OK` + `X-Idempotent-Replay: true`) for duplicate retry requests without hitting PostgreSQL.
* **Financial Invariant Audit:** Verified `COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) = 0` across all test runs.

---

## Project Structure

```text
sentinel-ledger/
├── src/
│   ├── config/
│   │   ├── database.ts               # PostgreSQL connection pool
│   │   └── redis.ts                  # ioredis client configuration
│   ├── domain/
│   │   └── errors.ts                 # Typed domain exceptions (InsufficientFunds, AccountNotFound)
│   ├── services/
│   │   ├── vulnerable/               # Reference exploit demos (Race conditions & Deadlocks)
│   │   └── productions/            # Production-hardened transfer & idempotency services
│   │       ├── ledgerTransfer.ts     # Deterministic locking + Double-entry ledger engine
│   │       └── idempotentTransfer.ts # Redis atomic lock + result caching wrapper
│   ├── sql/
│   │   └── schema.sql                # PostgreSQL tables, constraints, and indexes
│   ├── app.ts                        # Hono REST API routes & HTTP status mapping
│   └── server.ts                     # HTTP server entry point
└── tests/
    ├── deadlock.test.ts              # Bidirectional concurrency & 40P01 deadlock verification
    ├── ledgerInvariant.test.ts       # Zero-sum double-entry & balance reconciliation audit
    ├── idempotency.test.ts           # Retry replay & concurrent double-click storm tests
    └── apiStress.test.ts             # End-to-end HTTP stress benchmark
```

---

## API Reference

### `POST /api/v1/transfers`
Executes an atomic, idempotent transfer between two accounts.

**Headers**
* `Content-Type: application/json`
* `Idempotency-Key: <unique-uuid-v4>` *(Required)*

**Request Body**
```json
{
  "sourceAccountId": "a1b2c3d4-...",
  "targetAccountId": "e5f6g7h8-...",
  "amount": "2500"
}
```
*(Note: `amount` is denominated in cents as an integer string—`"2500"` = `$25.00`)*

**Responses**
* `201 Created` — Transfer executed and committed to ledger.
* `200 OK` (`X-Idempotent-Replay: true`) — Cached response returned for an already-completed `Idempotency-Key`.
* `400 Bad Request` — Missing `Idempotency-Key` or invalid monetary amount.
* `404 Not Found` — Source or target account does not exist.
* `409 Conflict` — Duplicate request with the same `Idempotency-Key` is currently in flight.
* `422 Unprocessable Entity` — Source account has insufficient funds.

---

## Local Setup & Testing

### Prerequisites
* Node.js 20+ & `pnpm`
* PostgreSQL 15+
* Redis 7+

### Installation
```bash
git clone [https://github.com/kyawzinwindev/sentinel-ledger.git](https://github.com/kyawzinwindev/sentinel-ledger.git)
cd sentinel-ledger
pnpm install
```

### Environment Configuration
Create a `.env` file in the root directory:
```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/sentinel_ledger
REDIS_URL=redis://localhost:6379
PORT=3000
```

### Database Initialization
```bash
psql "$DATABASE_URL" -f src/sql/schema.sql
```

### Run Verification & Benchmark Suite
```bash
# Type-check entire codebase
pnpm tsc --noEmit

# Run all concurrency, invariant, and HTTP stress tests
pnpm vitest run
```