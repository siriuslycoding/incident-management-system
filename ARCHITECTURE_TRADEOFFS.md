# Architecture Tradeoffs

## In-Memory Queue vs Redis Streams

The `SignalQueue` is a bounded in-memory array with a configurable maximum size (default 50,000 signals). This is intentional and acceptable for the following reasons:

**Why in-memory is acceptable here:**
- The WAL provides crash durability. If the process dies, unprocessed signals are replayed from `wal/signals.log` on restart.
- Memory queues have microsecond enqueue/dequeue latency with zero serialization overhead, making them ideal for the high-throughput ingest path.
- The Node.js event loop ensures the drain loop and HTTP handlers share the same thread — there is no concurrent access issue.

**What we would change in production:**
In a production environment with multiple backend replicas, the in-memory queue cannot be shared across processes. A signal accepted by replica A cannot be drained by replica B. We would replace `SignalQueue` with Redis Streams (`XADD`/`XREADGROUP`), which provides at-least-once delivery across multiple consumers, persistent storage, and consumer group rebalancing. We would also replace the flat-file WAL with a more structured log (Kafka topic or Redis Stream itself) to avoid filesystem coupling.

**What failure scenario the current design cannot handle:**
If the machine running the backend experiences a power failure between the WAL `write()` call and the OS kernel flushing the buffer to disk, the WAL entry may be lost. Node.js's `fs.WriteStream.write()` is not synchronous to disk — it's buffered at the OS level. A production WAL implementation would call `fsync()` after each write (available via `fd.datasync()` in Node.js) or use a journaling filesystem with `O_DSYNC`. The performance cost of `fsync` per signal (~200-500μs) would cap throughput at roughly 2,000-5,000 signals/second, which is acceptable for most infrastructure monitoring workloads.

---

## TimescaleDB Decision

TimescaleDB was explicitly evaluated as the timeseries storage backend for raw signals, in place of MongoDB's native timeseries collections.

**Why we did not use TimescaleDB:**
The primary benefit of TimescaleDB is automatic chunk management, continuous aggregate materialization, and columnar compression for extremely high cardinality timeseries. At the volume this system targets (hundreds to low thousands of signals per second), MongoDB's native timeseries collection provides comparable compression and sufficient query performance with simpler operational overhead — MongoDB is already in the stack. Adding TimescaleDB would require a second Postgres connection, additional schema management, and a separate migration path.

**What volume would justify TimescaleDB:**
If the signal volume exceeded approximately 100,000 signals/second sustained, or if there were analytical requirements (e.g., "show me the P99 latency across all RDBMS components in the last 7 days grouped by 5-minute windows"), TimescaleDB's continuous aggregate materialization would provide orders-of-magnitude better query performance than MongoDB aggregation pipelines. At that scale, we would also want to separate the PostgreSQL instance from the TimescaleDB instance to prevent analytical query pressure from affecting transaction throughput.

---

## Per-Component Debounce Windows

The debounce engine reads window sizes from `config.debounceWindows` rather than using a hardcoded 10-second value for all components.

**Why hardcoding 10 seconds would be wrong:**
Different component types have fundamentally different signal recovery characteristics. An RDBMS failure produces error signals in rapid bursts (connection pool exhaustion creates hundreds of simultaneous failures) and typically recovers quickly once engineers intervene — a short 5-second window is appropriate. A cache cluster degradation (`STALE_READ` errors) accumulates gradually over 15-20 seconds as TTLs expire across the cluster — a 15-second window groups these signals correctly into one incident rather than creating a new work item for every wave. An async message queue may produce sporadic errors over 12+ seconds before the backlog becomes visible — a 12-second window prevents false alarm splitting.

**How config-driven windows improve the system:**
Adding a new component type (e.g., `CDN`, `DNS`) requires only a new key in `config.debounceWindows`. No code in `DebounceEngine`, `QueueWorker`, or any route handler needs to change. This is the Open/Closed Principle applied to operational configuration: the system is open for extension (new component types) and closed for modification (no source changes needed).

---

## Outbox Pattern: Why Direct Redis Writes Inside Transactions Are Dangerous

A naive implementation might write to Redis directly inside a Prisma transaction:

```typescript
// DANGEROUS — do not do this
await prisma.$transaction(async (tx) => {
  await tx.workItem.update({ where: { id }, data: { state: 'RESOLVED' } })
  await redisClient.set('dashboard:state:dirty', 'true')  // This is OUTSIDE the transaction
})
```

If the Prisma transaction commits but the Redis write fails (network partition, Redis restart), the dashboard cache is stale indefinitely — it shows the old state until the next full cache miss. If the transaction rolls back (e.g., a constraint violation on a subsequent write), the Redis write has already succeeded and now contains a key pointing to a state transition that never happened.

**How the outbox solves consistency without distributed transactions:**
The `CacheService.scheduleUpdate` method creates a `CacheOutbox` row inside the Prisma transaction. If the transaction commits, the row exists and the outbox worker will apply it to Redis. If the transaction rolls back, the row is also rolled back — Redis is never touched. The outbox worker applies Redis updates asynchronously with retry logic, achieving eventual consistency without two-phase commit or distributed locks.

**The tradeoff:** There is a brief window between transaction commit and outbox worker execution (up to `cacheOutboxPollMs: 200ms`) during which the Redis cache may be stale. For a dashboard polling at 5-second intervals, a 200ms inconsistency window is completely acceptable. For a system requiring sub-millisecond consistency (e.g., financial ledgers), a different consistency model would be needed.
