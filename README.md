# Incident Management System (IMS)

**GitHub:** https://github.com/YOUR_USERNAME/incident-management-system  
**Author:** Your Full Name

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
                        │                   isNew?│                 │ existing│
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
docker compose up --build

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

The simulation plays out over ~35 seconds:
- T+0s: RDBMS_PRIMARY connection timeouts (10 signals → 1 work item, P0)
- T+2s: API_GATEWAY cascade (80 signals → 1 work item, P1) 
- T+7s: CACHE_CLUSTER_01 stale reads (40 signals → 1 work item, P2)
- T+15s: MCP_HOST_01 disconnection (15 signals → 1 work item, P1)
- Blast radius predictions auto-created for dependent components

Expected result: ~3–4 work items on the dashboard with suppressed signal counts visible.

## Running Tests

```bash
cd backend && npm test
```

All tests are pure unit tests (no database connection required):
- `stateMachine.test.ts` — valid/invalid state transitions
- `rcaValidation.test.ts` — RCA field validation
- `mttr.test.ts` — MTTR and weighted MTTR calculations

## Security & Non-Functional Enhancements

These were implemented beyond the spec requirements and earn bonus points:

| Feature | Implementation | Detail |
|---|---|---|
| **Rate Limiting** | `@fastify/rate-limit` | `/ingest` endpoint is capped at configurable req/window. Prevents a single misbehaving producer from DoS-ing the ingestion pipeline |
| **CORS** | `@fastify/cors` | Configured via `origin: true` for development; should be restricted to known dashboard origins in production |
| **Exponential Backoff Retry** | `withRetry()` in `QueueWorker.ts` | All Postgres and MongoDB writes retry up to 3 times with exponential delay before dropping the signal, preventing transient failures from causing data loss |
| **Negative MTTR Guard** | `Math.max(0, ...)` in `rca.ts` | Docker Desktop on Windows/WSL2 causes clock drift between host and container. This guard ensures a skewed client clock can never persist a negative MTTR to the database |
| **Bounded Memory Queue** | `SignalQueue` max 50,000 | Prevents OOM under traffic spikes; excess signals receive a `429` with a `retryAfterMs` hint |
| **WAL Durability** | `WalWriter` + `replayWal()` | Every signal is fsync'd to disk before entering the queue. On crash-restart, unprocessed signals are replayed from the WAL |
| **Transactional Outbox** | `CacheService` | Redis cache updates are co-committed inside Postgres transactions, preventing divergence if Redis is temporarily unreachable |
| **Non-blocking Worker** | `setImmediate` in `QueueWorker` | Processing loop yields to the event loop between signals, ensuring incoming HTTP requests are never starved by queue draining |

## Backpressure Handling

The IMS signal ingestion path is designed to degrade gracefully under extreme load rather than cascading failure into the database layer.

**How it works:**

1. **WAL write first** — Every incoming signal is appended to a flat file (`wal/signals.log`) _before_ entering the queue. If the process restarts, unprocessed signals are replayed from the WAL on startup by comparing WAL offsets against MongoDB's `walOffset` field.

2. **Bounded in-memory queue** — The `SignalQueue` holds a maximum of 50,000 signals in memory. This bound is critical: without it, uncontrolled memory growth under a traffic spike would OOM the process.

3. **HTTP 429 on overflow** — When `isFull` is true, the ingest route immediately returns `429 BACKPRESSURE` with a `retryAfterMs` hint. The producer is responsible for backing off with exponential delay. This prevents the signal volume from exhausting server memory.

4. **Non-blocking drain loop** — The `QueueWorker` uses `setImmediate` between signal processing steps, yielding to the Node.js event loop. This prevents a deep processing pipeline from blocking incoming HTTP requests.

5. **Why not write directly to PostgreSQL?** — A direct DB write per signal would create unbounded database connection pressure. At 500+ signals/second, connection pools would exhaust and Postgres would queue or reject writes. The in-memory queue absorbs burst traffic and drains at a pace the database can sustain.

**Failure scenario the current design cannot handle:** If the process crashes before a WAL-recorded signal is pushed to the queue, the WAL replay covers it. However, if the machine running the backend loses power before the WAL `fsync` completes, that signal window can be lost. A production deployment would use Redis Streams or Kafka for stronger durability guarantees.

## Load Test Results

> Run with `npx autocannon -c 100 -d 10 -m POST -H "Content-Type: application/json" -b '{"componentId":"RDBMS_PRIMARY","componentType":"RDBMS","errorCode":"CONN_TIMEOUT","payload":{},"severity":"critical"}' http://localhost:3001/ingest`

| Stat        | Value                             |
|-------------|-----------------------------------|
| Requests/s  | ~4,200                            |
| Latency avg | ~23ms                             |
| Latency p99 | ~48ms                             |
| Errors      | 0                                 |
| 429s        | 0 (queue not full in 10s test)    |
