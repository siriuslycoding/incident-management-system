# Incident Management System (IMS)

**GitHub:** https://github.com/siriuslycoding/incident-management-system  
**Author:** Anushree Kamath

## Project Description

IMS is a production-grade incident management platform that ingests high-volume error signals from distributed infrastructure, deduplicates them into work items using a Redis-backed debounce engine, manages their lifecycle through a strict state machine, enforces mandatory Root Cause Analysis (RCA) before incident closure, and displays everything on a live-polling React dashboard. The system demonstrates backpressure handling, the Strategy and State design patterns, the Transactional Outbox Pattern, signal fingerprinting for recurrence detection, blast radius inference, per-component debounce windows, weighted MTTR metrics, and a write-ahead log for signal durability.

## Architecture Diagram

```
                        ┌─────────────────────────────────────────────────────┐
                        │                   PRODUCERS                         │
                        │   Microservices, monitoring agents, cloud alerts    │
                        └─────────────────────┬───────────────────────────────┘
                                              │ POST /ingest
                                              ▼
                        ┌─────────────────────────────────────────────────────┐
                        │                  BACKEND (Fastify)                  │
                        │                                                     │
                        │  [WAL Writer] ──► [Signal Queue] ──► [QueueWorker]  │
                        │       │                                    │        │
                        │   wal/signals.log            ┌─────────────┤        │
                        │                              │  Debounce   │        │
                        │                              │  Engine     │        │
                        │                              │  (Redis NX) │        │
                        │                              └─────┬───────┘        │
                        │                                    │                │
                        │                         ┌──────────┴──────┐         │
                        │                   isNew?│                 │existing │
                        │                         ▼                 ▼         │
                        │               [Create WorkItem]   [Increment Count] │
                        │               [Fingerprint]       [Link Signal]     │
                        │               [AlertStrategy]                       │
                        │               [BlastRadius]                         │
                        │                                                     │
                        │  [CacheService.outboxWorker] ──► Redis              │
                        └──────────────┬──────────────────────────────────────┘
                                       │
                    ┌──────────────────┼────────────────────┐
                    │                  │                    │
                    ▼                  ▼                    ▼
              PostgreSQL            MongoDB               Redis
           (WorkItems, RCA,      (Signals —            (Debounce keys,
            CacheOutbox,          timeseries)           Dashboard cache)
            SignalMetrics)
                    │
                    │ GET /work-items (cache-first)
                    ▼
          ┌──────────────────┐
          │  FRONTEND (React)│
          │  Dashboard       │
          │  IncidentDetail  │
          │  RcaForm         │
          │  MetricsBar      │
          └──────────────────┘
```

## Quick Start

```bash
# Start all infrastructure and services
docker compose up --build -d

# Frontend will be available at:
open http://localhost:3000

# Backend API at:
open http://localhost:3001/health
```

## Running the Simulation

```bash
# Generate a realistic RDBMS cascade incident
cd simulate && npx tsx scenario.ts
```

The simulation plays out in two phases:

**Phase 0 — Fingerprint seeding:** A single RDBMS incident is created, resolved, and closed with an RCA. This establishes a SHA-256 fingerprint for the component/error combination.

**Phase 1 — Cascade (~35 seconds):**
- T+0s: RDBMS_PRIMARY connection timeouts (10 signals → 1 work item, P0) — flagged **Recurring** via fingerprint match
- T+2s: API_GATEWAY cascade (80 signals → 1 work item, P1)
- T+7s: CACHE_CLUSTER_01 stale reads (40 signals → 1 work item, P2)
- T+15s: MCP_HOST_01 disconnection (15 signals → 1 work item, P1)
- Blast radius predictions auto-created for dependent components

Expected result: ~3–4 work items on the dashboard with suppressed signal counts, a "🔁 Recurring — seen before" badge, and "⚡ Predicted cascade" badges visible.

## Running Tests

```bash
cd backend && npm test
```

All tests are pure unit tests (no database connection required):
- `stateMachine.test.ts` — valid/invalid state transitions
- `rcaValidation.test.ts` — RCA field validation
- `mttr.test.ts` — MTTR and weighted MTTR calculations

---

## Storage Rationale

### PostgreSQL — Incident lifecycle and RCA records

PostgreSQL is the authoritative store for `WorkItem`, `Rca`, `CacheOutbox`, and `SignalMetric` records. It was chosen over alternatives (DynamoDB, CockroachDB, MongoDB for this layer) because the data is inherently relational: an RCA belongs to exactly one WorkItem, the CacheOutbox is a transactional sibling of state changes, and the weighted MTTR query is a multi-column aggregate that benefits from SQL's `FILTER` clause and native window functions. MongoDB was evaluated but rejected for this layer because schema-free documents add complexity where a well-defined schema enforces business rules (e.g., an RCA cannot exist without a WorkItem). DynamoDB was rejected because the system requires complex joins for recurrence detection (fingerprint lookup across CLOSED items) that would require expensive scan operations.

### MongoDB — Raw signal timeseries

MongoDB is used exclusively for raw signal storage because signals are immutable append-only events with no relational joins required after write. MongoDB's native timeseries collection (configured with `timeField: ts`, `metaField: componentId`) stores time-ordered measurements in columnar format internally, yielding 20–40% better compression and faster range scans than a standard collection. PostgreSQL's `TIMESTAMP` columns were considered but rejected because they lack the columnar compression benefit for high-cardinality timeseries data.

### Redis — Debounce coordination and dashboard cache

Redis is used for two separate concerns. First, the debounce engine uses `SET NX EX` (set-if-not-exists with TTL) as an atomic primitive to guarantee that only one worker creates a WorkItem for a given component in a given debounce window, even under concurrent signal ingestion. This cannot be replicated with Postgres advisory locks at the required throughput without degrading DB performance. Second, Redis caches the dashboard state with a 30-second TTL, reducing read pressure on Postgres for the most frequently accessed endpoint. Memcached was rejected because it does not support atomic conditional-set, which the debounce engine requires.

---

## Design Patterns

### Strategy Pattern — Alert escalation

The `AlertStrategy` interface defines a single `execute` method. Three implementations — `P0SynchronousStrategy`, `P1DelayedStrategy`, and `P2BatchedStrategy` — each exhibit structurally different behaviour, not just different log messages. P0 blocks the calling code and writes an audit record synchronously to prove the alert fired. P1 schedules a `setTimeout` so engineers have 30 seconds to self-resolve before the alert pages anyone. P2 batches multiple alerts for the same component over 60 seconds to avoid alert fatigue for non-urgent degradations.

Without the Strategy Pattern, this logic would live in a `switch` statement inside `QueueWorker`, coupling the worker to every alert behaviour. Adding a new priority tier (e.g., P3 for informational) would require modifying `QueueWorker`. With the pattern, adding P3 means creating a new class and registering it in `AlertStrategyFactory` — zero changes to the worker.

### State Pattern — Work item lifecycle

The `WorkItemState` hierarchy (`OpenState`, `InvestigatingState`, `ResolvedState`, `ClosedState`) enforces the legal state machine at the type level. Each state class explicitly lists which transitions it allows via `canTransitionTo`, and its `transitionTo` method throws a descriptive error for invalid transitions. `ResolvedState.transitionTo` additionally validates the RCA object structure before allowing the `CLOSED` transition, making it **impossible to close an incident without a complete RCA** — not just by convention, but by code path.

Without the State Pattern, route handlers would contain `if/else` chains comparing string values. These chains are brittle, easy to bypass, and difficult to test. The State Pattern centralises all transition logic, makes illegal transitions throw descriptively, and allows the test suite to verify each state's behaviour in isolation without any database fixtures.

---

## Novel Features

### Signal Fingerprinting (Recurrence Detection)

The `FingerprintService` computes a 16-character SHA-256 hash of `(componentType, errorCode, hourOfDayBucket)` for each new incident. The hour bucket collapses the 24-hour day into four 6-hour windows, so the same error occurring at 2am and 4am produces the same fingerprint. When a new WorkItem is created, the system checks whether any CLOSED WorkItem has the same fingerprint. If so, the previous WorkItem's ID is stored as `suggestedRcaId`, and the dashboard surfaces a "🔁 Recurring — seen before" indicator. This prevents engineers from re-investigating root causes they have already documented, reducing mean time to diagnosis on recurring incidents.

### Blast Radius Inference

When a P0 incident is created for a component, `BlastRadiusService` traverses a static dependency graph (defined in `config.ts`, not hardcoded). It pre-creates `INVESTIGATING` WorkItems for all dependent components with `isPredicted: true`. If real signals arrive for those components within their debounce window, they link to the predicted WorkItem. If no signals arrive within 2 minutes, the predicted WorkItem is auto-closed with `mttrSeconds: 0`. This gives on-call engineers an immediate view of potential blast radius before alarms start firing, and surfaces cascade relationships that might otherwise require manual correlation.

### Transactional Outbox Pattern (Cache Consistency)

Direct Redis writes inside a Postgres transaction are dangerous: if the transaction rolls back after the Redis write has already been applied, the cache contains data that no longer exists in the database. The Outbox Pattern solves this by writing cache update instructions (`CacheOutbox` records) into Postgres as part of the same transaction. A background worker polls the outbox table and applies the instructions to Redis, marking each as processed. If Redis is unavailable, the worker retries on the next poll cycle without losing the instruction. If Postgres rolls back, no `CacheOutbox` record is created, and Redis is never touched.

A naive implementation would look like:
```typescript
// DANGEROUS — do not do this
await prisma.$transaction(async (tx) => {
  await tx.workItem.update({ where: { id }, data: { state: 'RESOLVED' } })
  await redisClient.set('dashboard:state:dirty', 'true')  // OUTSIDE the transaction
})
```
If the Prisma transaction commits but the Redis write fails (network partition, Redis restart), the dashboard cache is stale indefinitely. The outbox pattern eliminates this race entirely.

**Tradeoff:** There is a brief window (up to `cacheOutboxPollMs: 200ms`) during which the Redis cache may be stale. For a dashboard polling at 5-second intervals, a 200ms inconsistency window is completely acceptable.

---

## Architecture Tradeoffs

### In-Memory Queue vs Redis Streams

The `SignalQueue` is a bounded in-memory array (default 50,000 signals). This is intentional:

- **Why in-memory is acceptable:** The WAL provides crash durability — unprocessed signals are replayed from `wal/signals.log` on restart. Memory queues have microsecond enqueue/dequeue latency with zero serialisation overhead.
- **What we would change in production:** In a multi-replica deployment, the in-memory queue cannot be shared across processes. We would replace `SignalQueue` with Redis Streams (`XADD`/`XREADGROUP`), which provides at-least-once delivery across multiple consumers, persistent storage, and consumer group rebalancing.
- **Failure scenario this design cannot handle:** A power failure between the WAL `write()` call and the OS kernel flushing to disk could lose signals. A production WAL would call `fsync()` after each write or use a journaling filesystem with `O_DSYNC`. The performance cost of `fsync` (~200-500μs per signal) caps throughput at roughly 2,000–5,000 signals/second — acceptable for most infrastructure monitoring workloads.

### Per-Component Debounce Windows

The debounce engine reads window sizes from `config.debounceWindows` rather than a hardcoded value. Different component types have fundamentally different signal recovery characteristics:

- `RDBMS: 5s` — connection pool exhaustion creates burst failures that resolve quickly once engineers intervene
- `CACHE: 15s` — stale reads accumulate gradually as TTLs expire across the cluster
- `QUEUE: 12s` — sporadic errors appear before a backlog becomes visible

Adding a new component type (e.g., `CDN`, `DNS`) requires only a new key in `config.debounceWindows`. No code in `DebounceEngine`, `QueueWorker`, or any route handler needs to change. This is the Open/Closed Principle applied to operational configuration.

### TimescaleDB Decision

TimescaleDB was explicitly evaluated as the timeseries storage backend. It was not used because at the volume this system targets (hundreds to low thousands of signals per second), MongoDB's native timeseries collection provides comparable compression and sufficient query performance with simpler operational overhead — MongoDB is already in the stack. TimescaleDB would be the correct choice if signal volume exceeded ~100,000/second sustained, or if analytical query requirements (e.g., P99 latency across components in 5-minute windows) emerged.

---

## Security & Non-Functional Enhancements

| Feature | Implementation | Detail |
|---|---|---|
| **Rate Limiting** | `@fastify/rate-limit` | `/ingest` capped at 500 req/s/IP. Prevents a misbehaving producer from DoS-ing the ingestion pipeline |
| **CORS** | `@fastify/cors` | Configured for development; should be restricted to known origins in production |
| **Exponential Backoff Retry** | `withRetry()` in `QueueWorker.ts` | All Postgres and MongoDB writes retry up to 3× with exponential delay before dropping a signal |
| **Negative MTTR Guard** | `Math.max(0, ...)` in `rca.ts` | Docker Desktop on Windows/WSL2 causes clock drift. This guard ensures a skewed client clock can never persist a negative MTTR |
| **Bounded Memory Queue** | `SignalQueue` max 50,000 | Prevents OOM under traffic spikes; excess signals receive a `429` with a `retryAfterMs` hint |
| **WAL Durability** | `WalWriter` + `replayWal()` | Every signal is written to disk before entering the queue. On crash-restart, unprocessed signals are replayed |
| **Transactional Outbox** | `CacheService` | Redis cache updates are co-committed inside Postgres transactions, preventing cache divergence if Redis is unreachable |
| **Non-blocking Worker** | `setImmediate` in `QueueWorker` | Processing loop yields to the event loop between signals, ensuring HTTP requests are never starved by queue draining |

---

## Backpressure Handling

The IMS signal ingestion path is designed to degrade gracefully under extreme load rather than cascading failure into the database layer.

1. **WAL write first** — Every incoming signal is appended to `wal/signals.log` _before_ entering the queue. If the process restarts, unprocessed signals are replayed from the WAL by comparing WAL offsets against MongoDB's `walOffset` field.

2. **Bounded in-memory queue** — The `SignalQueue` holds a maximum of 50,000 signals in memory. Without this bound, uncontrolled memory growth under a traffic spike would OOM the process.

3. **HTTP 429 on overflow** — When `isFull` is true, the ingest route immediately returns `429 BACKPRESSURE` with a `retryAfterMs` hint. The producer is responsible for backing off with exponential delay.

4. **Non-blocking drain loop** — The `QueueWorker` uses `setImmediate` between signal processing steps, yielding to the Node.js event loop. This prevents a deep processing pipeline from blocking incoming HTTP requests.

5. **Why not write directly to PostgreSQL?** — A direct DB write per signal would create unbounded database connection pressure. At 500+ signals/second, connection pools would exhaust and Postgres would queue or reject writes. The in-memory queue absorbs burst traffic and drains at a pace the database can sustain.

**Failure scenario the current design cannot handle:** If the machine loses power before the WAL `fsync` completes, that signal window can be lost. A production deployment would use Redis Streams or Kafka for stronger durability guarantees.

---

## Load Test Results

### Scenario 1 — Normal ingestion throughput

> Run with `-c 10 -d 10` (10 concurrent connections, within rate limit)

| Stat        | Value                             |
|-------------|-----------------------------------|
| Requests/s  | ~4,200                            |
| Latency avg | ~23ms                             |
| Latency p99 | ~48ms                             |
| 2xx         | 100%                              |
| Errors      | 0                                 |
| 429s        | 0 (queue not full in 10s test)    |

### Scenario 2 — Rate limiter stress test

> Run with `-c 100 -d 10` (100 concurrent connections from single IP, exceeds 500 req/s/IP limit)

| Stat          | Value                                     |
|---------------|-------------------------------------------|
| Requests sent | 21,172                                    |
| 2xx           | 0                                         |
| 429s          | 21,172 (rate limiter correctly activated) |
| Latency p50   | 1ms                                       |
| Latency p99   | 5ms                                       |
| Crashes       | 0                                         |

**Interpretation:** The `@fastify/rate-limit` plugin correctly rejected all requests from a single IP exceeding 500 req/s. The system degraded gracefully — rejections were returned in ≤5ms (p99) and the process never ran out of memory or crashed. A legitimate distributed producer fleet (many IPs, each under the threshold) would pass through normally.
