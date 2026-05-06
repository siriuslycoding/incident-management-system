# Design Document

## Storage Rationale

### PostgreSQL — Incident lifecycle and RCA records

PostgreSQL is the authoritative store for `WorkItem`, `Rca`, `CacheOutbox`, and `SignalMetric` records. We chose it over alternatives (DynamoDB, CockroachDB, MongoDB for this layer) because the data is inherently relational: an RCA belongs to exactly one WorkItem, the CacheOutbox is a transactional sibling of state changes, and the weighted MTTR query is a multi-column aggregate that benefits from SQL's `FILTER` clause and native window functions. MongoDB was evaluated but rejected for this layer because schema-free documents add complexity where a well-defined schema enforces business rules (e.g., an RCA cannot exist without a WorkItem). DynamoDB was rejected because the system requires complex joins for recurrence detection (fingerprint lookup across CLOSED items) that would require expensive scan operations.

### MongoDB — Raw signal timeseries

MongoDB is used exclusively for raw signal storage because signals are immutable append-only events with no relational joins required after write. MongoDB's native **timeseries collection** (configured with `timeField: ts`, `metaField: componentId`) stores time-ordered measurements in columnar format internally, yielding 20–40% better compression and faster range scans than a standard collection. PostgreSQL's `TIMESTAMP` columns were considered but rejected because they lack the columnar compression benefit for high-cardinality timeseries data. TimescaleDB was explicitly evaluated — see `ARCHITECTURE_TRADEOFFS.md` for the decision.

### Redis — Debounce coordination and dashboard cache

Redis is used for two separate concerns. First, the debounce engine uses `SET NX EX` (set-if-not-exists with TTL) as an atomic primitive to guarantee that only one worker creates a WorkItem for a given component in a given debounce window, even under concurrent signal ingestion. This cannot be replicated with Postgres advisory locks at the required throughput without degrading DB performance. Second, Redis caches the dashboard state (`dashboard:state`) with a 30-second TTL, reducing read pressure on Postgres for the most frequently accessed endpoint. Memcached was rejected because it does not support atomic conditional-set, which the debounce engine requires.

---

## Design Patterns

### Strategy Pattern — Alert escalation

The `AlertStrategy` interface defines a single `execute` method. Three implementations — `P0SynchronousStrategy`, `P1DelayedStrategy`, and `P2BatchedStrategy` — each exhibit **structurally different behavior**, not just different log messages. P0 blocks the calling code and writes an audit record synchronously to prove the alert fired. P1 schedules a `setTimeout` so engineers have 30 seconds to self-resolve before the alert pages anyone. P2 batches multiple alerts for the same component over 60 seconds to avoid alert fatigue for non-urgent degradations.

Without the Strategy Pattern, this logic would live in a `switch` statement inside `QueueWorker`, coupling the worker to every alert behavior. Adding a new priority tier (e.g., P3 for informational) would require modifying `QueueWorker`. With the pattern, adding P3 means creating a new class and registering it in `AlertStrategyFactory` — zero changes to the worker.

### State Pattern — Work item lifecycle

The `WorkItemState` hierarchy (`OpenState`, `InvestigatingState`, `ResolvedState`, `ClosedState`) enforces the legal state machine at the type level. Each state class explicitly lists which transitions it allows via `canTransitionTo`, and its `transitionTo` method throws a descriptive error for invalid transitions. `ResolvedState.transitionTo` additionally validates the RCA object structure before allowing the `CLOSED` transition, making it **impossible to close an incident without a complete RCA** — not just by convention, but by code path.

Without the State Pattern, route handlers would contain `if/else` chains comparing string values like `if (currentState === 'RESOLVED' && nextState === 'CLOSED' && rca != null)`. These chains are brittle, easy to bypass, and difficult to test. The State Pattern centralizes all transition logic in one place, makes illegal transitions throw descriptively, and allows the test suite to verify each state's behavior in isolation without any database fixtures.

---

## Novel Features

### Signal Fingerprinting (Recurrence Detection)

The `FingerprintService` computes a 16-character SHA-256 hash of `(componentType, errorCode, hourOfDayBucket)` for each new incident. The hour bucket collapses the 24-hour day into four 6-hour windows, so the same error occurring at 2am and 4am produces the same fingerprint. When a new WorkItem is created, the system checks whether any CLOSED WorkItem has the same fingerprint. If so, the previous WorkItem's ID is stored as `suggestedRcaId`, and the dashboard surfaces a "Recurring — seen before" indicator. This prevents engineers from re-investigating root causes they've already documented, reducing mean time to diagnosis on recurring incidents.

### Blast Radius Inference

When a P0 incident is created for a component, `BlastRadiusService` traverses a static dependency graph (defined in `config.ts`, not hardcoded). It pre-creates `INVESTIGATING` WorkItems for all dependent components with `isPredicted: true`. If real signals arrive for those components within their debounce window, they link to the predicted WorkItem. If no signals arrive within 2 minutes, the predicted WorkItem is auto-closed with `mttrSeconds: 0`. This gives on-call engineers an immediate view of potential blast radius before alarms start firing, and surfaces cascade relationships that might otherwise require manual correlation.

### Transactional Outbox Pattern (Cache Consistency)

Direct Redis writes inside a Postgres transaction are dangerous: if the transaction rolls back after the Redis write has already been applied, the cache contains data that no longer exists in the database. The Outbox Pattern solves this by writing cache update instructions (`CacheOutbox` records) into Postgres as part of the same transaction. A background worker polls the outbox table and applies the instructions to Redis, marking each as processed. If Redis is unavailable, the worker retries on the next poll cycle without losing the instruction. If Postgres rolls back, no `CacheOutbox` record is created, and Redis is never touched. This achieves eventual consistency without distributed transactions or two-phase commit.
