# IMS Master Build Spec
## Incident Management System — Complete Agent Instructions

> This document is the single source of truth for building the Incident Management System.
> Every architectural decision, file structure, data schema, API contract, design pattern,
> and implementation detail is specified here. Follow it exactly. Do not improvise.

---
n 
## 0. Project identity

**What this is:** A production-grade Incident Management System that ingests high-volume
error signals from distributed infrastructure, deduplicates them into work items, manages
their lifecycle through a state machine, enforces mandatory RCA before closure, and
displays everything on a live React dashboard.

**What it must demonstrate:** Backpressure handling, the Strategy Pattern, the State
Pattern, the Transactional Outbox Pattern, signal fingerprinting for recurrence detection,
blast radius inference, per-component debounce windows, weighted MTTR, and a
write-ahead log for signal durability.

**Stack:** TypeScript throughout. Fastify backend. React + Vite + TailwindCSS frontend.
PostgreSQL + MongoDB + Redis. Docker Compose for all infrastructure.

---

## 1. Repository structure

```
/
├── backend/
│   ├── src/
│   │   ├── server.ts                  # Fastify app bootstrap
│   │   ├── config.ts                  # All env vars and constants
│   │   ├── queue/
│   │   │   ├── SignalQueue.ts         # Bounded in-memory async queue
│   │   │   └── WalWriter.ts          # Write-ahead log appender
│   │   ├── workers/
│   │   │   └── QueueWorker.ts        # Background drain loop
│   │   ├── debounce/
│   │   │   └── DebounceEngine.ts     # Redis-backed atomic debounce
│   │   ├── patterns/
│   │   │   ├── AlertStrategy.ts      # Strategy interface + all implementations
│   │   │   └── WorkItemStateMachine.ts # State pattern implementation
│   │   ├── services/
│   │   │   ├── SignalService.ts       # Signal ingestion logic
│   │   │   ├── WorkItemService.ts     # Work item CRUD + transitions
│   │   │   ├── RcaService.ts          # RCA validation + MTTR calculation
│   │   │   ├── FingerprintService.ts  # Signal fingerprinting + recurrence
│   │   │   ├── BlastRadiusService.ts  # Dependency graph + cascade prediction
│   │   │   └── CacheService.ts        # Redis dashboard cache + outbox worker
│   │   ├── routes/
│   │   │   ├── ingest.ts              # POST /ingest
│   │   │   ├── workItems.ts           # CRUD + state transitions
│   │   │   ├── rca.ts                 # POST /work-items/:id/rca
│   │   │   └── health.ts              # GET /health
│   │   ├── db/
│   │   │   ├── postgres.ts            # Prisma client singleton
│   │   │   ├── mongo.ts               # Mongoose connection
│   │   │   └── redis.ts               # ioredis client singleton
│   │   └── observability/
│   │       └── metrics.ts             # Throughput logger every 5s
│   ├── prisma/
│   │   └── schema.prisma
│   ├── tests/
│   │   ├── stateMachine.test.ts
│   │   ├── rcaValidation.test.ts
│   │   └── mttr.test.ts
│   ├── wal/                           # Write-ahead log files (gitignored)
│   ├── Dockerfile
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── api/
│   │   │   └── client.ts              # All API calls, typed
│   │   ├── components/
│   │   │   ├── Dashboard.tsx          # Live incident feed
│   │   │   ├── IncidentDetail.tsx     # Signals + state + RCA form
│   │   │   ├── RcaForm.tsx            # Full RCA submission form
│   │   │   ├── MetricsBar.tsx         # MTTR + throughput numbers
│   │   │   └── StatusBadge.tsx        # Reusable severity/state badge
│   │   └── hooks/
│   │       └── usePolling.ts          # React Query polling hook
│   ├── Dockerfile
│   ├── package.json
│   └── vite.config.ts
├── simulate/
│   └── scenario.ts                    # Narrative incident simulation script
├── docker-compose.yml
├── README.md
├── DESIGN.md
└── ARCHITECTURE_TRADEOFFS.md
```

---

## 2. Docker Compose — infrastructure

```yaml
# docker-compose.yml
version: "3.9"
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ims
      POSTGRES_PASSWORD: ims
      POSTGRES_DB: ims
    ports:
      - "5432:5432"
    volumes:
      - pg_data:/var/lib/postgresql/data

  mongo:
    image: mongo:7
    ports:
      - "27017:27017"
    volumes:
      - mongo_data:/data/db

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  backend:
    build: ./backend
    ports:
      - "3001:3001"
    environment:
      DATABASE_URL: postgresql://ims:ims@postgres:5432/ims
      MONGO_URL: mongodb://mongo:27017/ims
      REDIS_URL: redis://redis:6379
      PORT: 3001
      QUEUE_MAX_SIZE: 50000
      WAL_PATH: /app/wal/signals.log
    depends_on:
      - postgres
      - mongo
      - redis
    volumes:
      - wal_data:/app/wal

  frontend:
    build: ./frontend
    ports:
      - "3000:3000"
    environment:
      VITE_API_URL: http://localhost:3001
    depends_on:
      - backend

volumes:
  pg_data:
  mongo_data:
  wal_data:
```

---

## 3. Environment config

```typescript
// backend/src/config.ts
export const config = {
  port: parseInt(process.env.PORT || '3001'),
  databaseUrl: process.env.DATABASE_URL!,
  mongoUrl: process.env.MONGO_URL!,
  redisUrl: process.env.REDIS_URL!,
  queueMaxSize: parseInt(process.env.QUEUE_MAX_SIZE || '50000'),
  walPath: process.env.WAL_PATH || './wal/signals.log',

  // Per-component debounce windows in seconds
  // Configurable so adding a new component type requires no code change
  debounceWindows: {
    RDBMS: 5,
    CACHE: 15,
    MCP_HOST: 10,
    API: 8,
    QUEUE: 12,
    NOSQL: 10,
    DEFAULT: 10
  } as Record<string, number>,

  // Dependency graph for blast radius inference
  // key = component that failed, value = components that may cascade
  dependencyGraph: {
    RDBMS_PRIMARY: ['API_GATEWAY', 'CACHE_CLUSTER_01', 'MCP_HOST_01'],
    CACHE_CLUSTER_01: ['API_GATEWAY'],
    MCP_HOST_01: ['API_GATEWAY'],
    API_GATEWAY: [],
    ASYNC_QUEUE_01: ['API_GATEWAY', 'MCP_HOST_01']
  } as Record<string, string[]>,

  // Alert strategy priority per component type
  componentPriority: {
    RDBMS: 'P0',
    MCP_HOST: 'P1',
    API: 'P1',
    CACHE: 'P2',
    QUEUE: 'P2',
    NOSQL: 'P2'
  } as Record<string, string>,

  rateLimitMax: 500,         // requests per second per IP
  rateLimitWindow: 1000,     // ms
  metricsIntervalMs: 5000,   // print throughput every 5s
  cacheOutboxPollMs: 200,    // how often outbox worker runs
  retryAttempts: 3,
  retryBaseDelayMs: 100
}
```

---

## 4. Postgres schema (Prisma)

```prisma
// backend/prisma/schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model WorkItem {
  id              String      @id @default(uuid())
  componentId     String      @map("component_id")
  componentType   String      @map("component_type")
  priority        String      // P0 | P1 | P2
  state           String      @default("OPEN") // OPEN | INVESTIGATING | RESOLVED | CLOSED
  fingerprint     String?     // hash for recurrence detection
  suggestedRcaId  String?     @map("suggested_rca_id")
  isPredicted     Boolean     @default(false) @map("is_predicted") // blast radius prediction
  signalCount     Int         @default(1) @map("signal_count")
  startTime       DateTime    @default(now()) @map("start_time")
  resolvedAt      DateTime?   @map("resolved_at")
  closedAt        DateTime?   @map("closed_at")
  mttrSeconds     Int?        @map("mttr_seconds")
  createdAt       DateTime    @default(now()) @map("created_at")
  updatedAt       DateTime    @updatedAt @map("updated_at")
  rca             Rca?
  relatedTo       WorkItem?   @relation("RelatedIncidents", fields: [suggestedRcaId], references: [id])
  relatedFrom     WorkItem[]  @relation("RelatedIncidents")

  @@index([componentId])
  @@index([state])
  @@index([fingerprint])
  @@index([createdAt])
  @@map("work_items")
}

model Rca {
  id               String    @id @default(uuid())
  workItemId       String    @unique @map("work_item_id")
  rootCauseCategory String   @map("root_cause_category")
  rootCauseDetail  String    @map("root_cause_detail")
  fixApplied       String    @map("fix_applied")
  preventionSteps  String    @map("prevention_steps")
  incidentStart    DateTime  @map("incident_start")
  incidentEnd      DateTime  @map("incident_end")
  submittedBy      String    @default("engineer") @map("submitted_by")
  createdAt        DateTime  @default(now()) @map("created_at")
  workItem         WorkItem  @relation(fields: [workItemId], references: [id])

  @@map("rca_records")
}

model CacheOutbox {
  id        Int       @id @default(autoincrement())
  redisKey  String    @map("redis_key")
  value     String    // JSON stringified
  operation String    @default("SET") // SET | DELETE
  processed Boolean   @default(false)
  createdAt DateTime  @default(now()) @map("created_at")

  @@index([processed, createdAt])
  @@map("cache_outbox")
}

model SignalMetric {
  id          Int       @id @default(autoincrement())
  ts          DateTime  @default(now())
  count       Int
  componentId String    @map("component_id")

  @@index([ts])
  @@index([componentId, ts])
  @@map("signal_metrics")
}
```

---

## 5. MongoDB schema

```typescript
// backend/src/db/mongo.ts
import mongoose, { Schema, Document } from 'mongoose'

export interface ISignal extends Document {
  workItemId: string | null    // null until debounce resolves
  componentId: string
  componentType: string
  errorCode: string
  payload: Record<string, unknown>
  severity: string
  ts: Date
  processed: boolean
  walOffset: number            // byte offset in WAL file for replay
}

const SignalSchema = new Schema<ISignal>({
  workItemId:    { type: String, default: null, index: true },
  componentId:   { type: String, required: true, index: true },
  componentType: { type: String, required: true },
  errorCode:     { type: String, required: true },
  payload:       { type: Schema.Types.Mixed, required: true },
  severity:      { type: String, required: true },
  ts:            { type: Date, default: Date.now, index: true },
  processed:     { type: Boolean, default: false },
  walOffset:     { type: Number, required: true }
}, {
  timeseries: {   // MongoDB native timeseries collection
    timeField: 'ts',
    metaField: 'componentId',
    granularity: 'seconds'
  }
})

export const Signal = mongoose.model<ISignal>('Signal', SignalSchema)
```

---

## 6. Write-ahead log (WAL)

```typescript
// backend/src/queue/WalWriter.ts
// Signals are appended to a flat file BEFORE entering the in-memory queue.
// On process restart, unprocessed signals are replayed from the WAL.
// This ensures no signal is silently lost during a deploy or crash.

import fs from 'fs'
import readline from 'readline'
import path from 'path'
import { config } from '../config'

export class WalWriter {
  private stream: fs.WriteStream
  private offset = 0

  constructor() {
    const dir = path.dirname(config.walPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    this.stream = fs.createWriteStream(config.walPath, { flags: 'a' })
    // Get current file size as starting offset
    try {
      this.offset = fs.statSync(config.walPath).size
    } catch { this.offset = 0 }
  }

  // Returns the byte offset of this entry (stored in MongoDB for replay)
  append(signal: unknown): number {
    const line = JSON.stringify({ signal, ts: Date.now() }) + '\n'
    const currentOffset = this.offset
    this.stream.write(line)
    this.offset += Buffer.byteLength(line)
    return currentOffset
  }

  // Called on startup: yields signals whose walOffset is not in processedOffsets
  async *replay(processedOffsets: Set<number>): AsyncGenerator<{ signal: unknown, offset: number }> {
    if (!fs.existsSync(config.walPath)) return
    const rl = readline.createInterface({
      input: fs.createReadStream(config.walPath),
      crlfDelay: Infinity
    })
    let offset = 0
    for await (const line of rl) {
      if (line.trim()) {
        if (!processedOffsets.has(offset)) {
          const parsed = JSON.parse(line)
          yield { signal: parsed.signal, offset }
        }
        offset += Buffer.byteLength(line + '\n')
      }
    }
  }

  close() { this.stream.close() }
}
```

---

## 7. In-memory signal queue with backpressure

```typescript
// backend/src/queue/SignalQueue.ts
import { EventEmitter } from 'events'
import { config } from '../config'

export interface RawSignal {
  componentId: string
  componentType: string
  errorCode: string
  payload: Record<string, unknown>
  severity: string
  walOffset: number
}

export class SignalQueue extends EventEmitter {
  private queue: RawSignal[] = []
  private draining = false

  get size() { return this.queue.length }
  get isFull() { return this.queue.length >= config.queueMaxSize }

  // Returns false if queue is full (caller should return 429)
  push(signal: RawSignal): boolean {
    if (this.isFull) return false
    this.queue.push(signal)
    if (!this.draining) this.emit('drain')
    return true
  }

  shift(): RawSignal | undefined {
    return this.queue.shift()
  }

  setDraining(v: boolean) { this.draining = v }
}

export const signalQueue = new SignalQueue()
```

---

## 8. Debounce engine

```typescript
// backend/src/debounce/DebounceEngine.ts
// Uses Redis SET NX (atomic set-if-not-exists) to prevent race conditions.
// Per-component debounce windows from config — not hardcoded 10 seconds.

import { redisClient } from '../db/redis'
import { config } from '../config'

export class DebounceEngine {
  private getWindow(componentType: string): number {
    return config.debounceWindows[componentType] ?? config.debounceWindows.DEFAULT
  }

  private key(componentId: string): string {
    return `debounce:${componentId}`
  }

  // Returns: { isNew: true } if this is the first signal in the window (create work item)
  // Returns: { isNew: false, workItemId: string } if window is active (link to existing)
  async check(componentId: string, componentType: string): Promise<
    { isNew: true } | { isNew: false; workItemId: string }
  > {
    const k = this.key(componentId)
    const window = this.getWindow(componentType)

    // Atomic: set key to placeholder only if it does not exist
    const acquired = await redisClient.set(k, 'PENDING', 'EX', window, 'NX')

    if (acquired === 'OK') {
      // We are first — caller will create work item and call register()
      return { isNew: true }
    }

    // Key exists — get the work item ID
    const workItemId = await redisClient.get(k)
    if (!workItemId || workItemId === 'PENDING') {
      // Race: another worker just set PENDING but hasn't registered yet
      // Wait 20ms and retry once
      await new Promise(r => setTimeout(r, 20))
      const retried = await redisClient.get(k)
      if (!retried || retried === 'PENDING') {
        // Still pending — treat as new to avoid infinite wait
        return { isNew: true }
      }
      return { isNew: false, workItemId: retried }
    }

    return { isNew: false, workItemId }
  }

  // Called after work item is created — replaces PENDING with actual ID
  async register(componentId: string, componentType: string, workItemId: string): Promise<void> {
    const k = this.key(componentId)
    const window = this.getWindow(componentType)
    await redisClient.set(k, workItemId, 'EX', window)
  }

  // Increment signal count on the debounce key's associated work item
  async incrementCount(workItemId: string): Promise<void> {
    await redisClient.incr(`signal_count:${workItemId}`)
  }
}

export const debounceEngine = new DebounceEngine()
```

---

## 9. Strategy Pattern — alert strategies

```typescript
// backend/src/patterns/AlertStrategy.ts
// Each strategy does something STRUCTURALLY different, not just logs differently.
// P0: fires synchronously, blocks, writes to audit table.
// P1: fires with 30s delay (gives on-call time to self-resolve).
// P2: batches alerts for same component over 60s before firing.

import { prisma } from '../db/postgres'

export interface AlertStrategy {
  readonly priority: string
  execute(workItem: { id: string; componentId: string; componentType: string }): Promise<void>
}

// P0 — RDBMS failures. Synchronous. Never batched. Never delayed.
export class P0SynchronousStrategy implements AlertStrategy {
  readonly priority = 'P0'

  async execute(workItem: { id: string; componentId: string; componentType: string }): Promise<void> {
    // In production: PagerDuty API call, SMS, phone call
    // Here: structured log + audit record in DB (proves it fired)
    console.error(JSON.stringify({
      level: 'CRITICAL',
      alert: 'P0_FIRED',
      workItemId: workItem.id,
      componentId: workItem.componentId,
      ts: new Date().toISOString(),
      message: `P0 INCIDENT: ${workItem.componentId} is down. Paging all on-call engineers.`
    }))

    // Write to DB so the audit trail exists — this is what makes P0 structurally different
    await prisma.signalMetric.create({
      data: { componentId: workItem.componentId, count: 1 }
    })
  }
}

// P1 — MCP hosts, APIs. Fires after 30s delay.
export class P1DelayedStrategy implements AlertStrategy {
  readonly priority = 'P1'

  async execute(workItem: { id: string; componentId: string; componentType: string }): Promise<void> {
    // Delay gives engineer who caused the incident time to self-resolve before paging
    setTimeout(() => {
      console.warn(JSON.stringify({
        level: 'WARNING',
        alert: 'P1_FIRED',
        workItemId: workItem.id,
        componentId: workItem.componentId,
        ts: new Date().toISOString(),
        message: `P1 INCIDENT: ${workItem.componentId} degraded. Notifying on-call.`
      }))
    }, 30_000)
  }
}

// P2 — Caches, queues. Batches alerts for same component over 60s.
export class P2BatchedStrategy implements AlertStrategy {
  readonly priority = 'P2'
  private batches = new Map<string, NodeJS.Timeout>()

  async execute(workItem: { id: string; componentId: string; componentType: string }): Promise<void> {
    if (this.batches.has(workItem.componentId)) return // Already scheduled

    const timer = setTimeout(() => {
      console.info(JSON.stringify({
        level: 'INFO',
        alert: 'P2_FIRED',
        workItemId: workItem.id,
        componentId: workItem.componentId,
        ts: new Date().toISOString(),
        message: `P2 NOTICE: ${workItem.componentId} has ongoing issues. Non-urgent.`
      }))
      this.batches.delete(workItem.componentId)
    }, 60_000)

    this.batches.set(workItem.componentId, timer)
  }
}

// Factory — maps component type to strategy
export class AlertStrategyFactory {
  private static strategies: Record<string, AlertStrategy> = {
    P0: new P0SynchronousStrategy(),
    P1: new P1DelayedStrategy(),
    P2: new P2BatchedStrategy()
  }

  static getForComponent(componentType: string): AlertStrategy {
    const priority = {
      RDBMS:    'P0',
      MCP_HOST: 'P1',
      API:      'P1',
      CACHE:    'P2',
      QUEUE:    'P2',
      NOSQL:    'P2'
    }[componentType] ?? 'P2'

    return this.strategies[priority]
  }
}
```

---

## 10. State Pattern — work item lifecycle

```typescript
// backend/src/patterns/WorkItemStateMachine.ts
// Each state class defines exactly which transitions are valid.
// Invalid transitions throw — they cannot be caught and ignored.
// CLOSED state is impossible without a complete, validated RCA object.

export type WorkItemStateLabel = 'OPEN' | 'INVESTIGATING' | 'RESOLVED' | 'CLOSED'

export interface RcaInput {
  rootCauseCategory: string
  rootCauseDetail: string
  fixApplied: string
  preventionSteps: string
  incidentStart: Date
  incidentEnd: Date
}

export abstract class WorkItemState {
  abstract readonly label: WorkItemStateLabel
  abstract transitionTo(next: WorkItemStateLabel, rca?: RcaInput): WorkItemState
  abstract canTransitionTo(next: WorkItemStateLabel): boolean
}

export class OpenState extends WorkItemState {
  readonly label = 'OPEN' as const

  canTransitionTo(next: WorkItemStateLabel): boolean {
    return next === 'INVESTIGATING'
  }

  transitionTo(next: WorkItemStateLabel): WorkItemState {
    if (next !== 'INVESTIGATING') throw new Error(`Invalid transition: OPEN → ${next}`)
    return new InvestigatingState()
  }
}

export class InvestigatingState extends WorkItemState {
  readonly label = 'INVESTIGATING' as const

  canTransitionTo(next: WorkItemStateLabel): boolean {
    return next === 'RESOLVED'
  }

  transitionTo(next: WorkItemStateLabel): WorkItemState {
    if (next !== 'RESOLVED') throw new Error(`Invalid transition: INVESTIGATING → ${next}`)
    return new ResolvedState()
  }
}

export class ResolvedState extends WorkItemState {
  readonly label = 'RESOLVED' as const

  canTransitionTo(next: WorkItemStateLabel): boolean {
    return next === 'CLOSED'
  }

  transitionTo(next: WorkItemStateLabel, rca?: RcaInput): WorkItemState {
    if (next !== 'CLOSED') throw new Error(`Invalid transition: RESOLVED → ${next}`)
    this.validateRca(rca)
    return new ClosedState()
  }

  private validateRca(rca?: RcaInput): void {
    if (!rca) throw new Error('RCA_REQUIRED: Cannot close incident without RCA')
    if (!rca.rootCauseCategory?.trim())
      throw new Error('RCA_INCOMPLETE: rootCauseCategory is required')
    if (!rca.rootCauseDetail?.trim())
      throw new Error('RCA_INCOMPLETE: rootCauseDetail is required')
    if (!rca.fixApplied?.trim())
      throw new Error('RCA_INCOMPLETE: fixApplied is required')
    if (!rca.preventionSteps?.trim())
      throw new Error('RCA_INCOMPLETE: preventionSteps is required')
    if (!rca.incidentStart || !rca.incidentEnd)
      throw new Error('RCA_INCOMPLETE: incidentStart and incidentEnd are required')
    if (rca.incidentEnd <= rca.incidentStart)
      throw new Error('RCA_INVALID: incidentEnd must be after incidentStart')
  }
}

export class ClosedState extends WorkItemState {
  readonly label = 'CLOSED' as const

  canTransitionTo(_next: WorkItemStateLabel): boolean {
    return false // Terminal state
  }

  transitionTo(next: WorkItemStateLabel): WorkItemState {
    throw new Error(`Invalid transition: CLOSED is a terminal state. Cannot transition to ${next}`)
  }
}

// Factory
export function stateFromLabel(label: WorkItemStateLabel): WorkItemState {
  switch (label) {
    case 'OPEN':          return new OpenState()
    case 'INVESTIGATING': return new InvestigatingState()
    case 'RESOLVED':      return new ResolvedState()
    case 'CLOSED':        return new ClosedState()
    default: throw new Error(`Unknown state label: ${label}`)
  }
}
```

---

## 11. Signal fingerprinting (recurrence detection)

```typescript
// backend/src/services/FingerprintService.ts
// Computes a lightweight hash of (componentType + errorCode + hourOfDayBucket).
// When a new work item is created, checks if any CLOSED work item has the same fingerprint.
// If so, surfaces the previous RCA as a suggestion in the UI.
// This solves the problem of engineers repeatedly investigating the same root causes.

import crypto from 'crypto'
import { prisma } from '../db/postgres'

export class FingerprintService {
  compute(componentType: string, errorCode: string, ts: Date): string {
    // Hour bucket: 0-23 grouped into 4 buckets (0-5, 6-11, 12-17, 18-23)
    // Same error recurring at 2am and 3am gets same fingerprint
    const hourBucket = Math.floor(ts.getHours() / 6)
    const raw = `${componentType}:${errorCode}:${hourBucket}`
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)
  }

  async findPreviousIncident(fingerprint: string): Promise<string | null> {
    const previous = await prisma.workItem.findFirst({
      where: { fingerprint, state: 'CLOSED' },
      orderBy: { closedAt: 'desc' },
      select: { id: true }
    })
    return previous?.id ?? null
  }
}

export const fingerprintService = new FingerprintService()
```

---

## 12. Blast radius inference

```typescript
// backend/src/services/BlastRadiusService.ts
// When a P0 work item is created, traverses the dependency graph.
// Pre-creates INVESTIGATING work items for dependent components with isPredicted=true.
// If signals arrive for those components within the debounce window, they link automatically.
// If no signals arrive, predicted work items are auto-closed after 2 minutes.

import { config } from '../config'
import { prisma } from '../db/postgres'

export class BlastRadiusService {
  async predictCascades(
    failedComponentId: string,
    triggerWorkItemId: string
  ): Promise<void> {
    const dependents = config.dependencyGraph[failedComponentId] ?? []
    if (dependents.length === 0) return

    console.info(JSON.stringify({
      event: 'BLAST_RADIUS_PREDICTED',
      source: failedComponentId,
      predicted: dependents,
      triggerWorkItemId
    }))

    for (const dep of dependents) {
      const componentType = dep.split('_')[0] // e.g. 'API' from 'API_GATEWAY'

      const predicted = await prisma.workItem.create({
        data: {
          componentId: dep,
          componentType,
          priority: config.componentPriority[componentType] ?? 'P2',
          state: 'INVESTIGATING', // Pre-set to investigating since we know why
          isPredicted: true,
          suggestedRcaId: triggerWorkItemId
        }
      })

      // Auto-close after 2 minutes if no real signals arrive
      setTimeout(async () => {
        const current = await prisma.workItem.findUnique({
          where: { id: predicted.id },
          select: { state: true, signalCount: true }
        })
        if (current?.state === 'INVESTIGATING' && current.signalCount <= 1) {
          await prisma.workItem.update({
            where: { id: predicted.id },
            data: {
              state: 'CLOSED',
              closedAt: new Date(),
              mttrSeconds: 0
            }
          })
        }
      }, 120_000)
    }
  }
}

export const blastRadiusService = new BlastRadiusService()
```

---

## 13. Transactional outbox (cache consistency)

```typescript
// backend/src/services/CacheService.ts
// Problem: if Postgres write succeeds and Redis update fails, they diverge.
// Solution: write cache update instructions INTO Postgres as part of the same transaction.
// A background worker reads the outbox and applies to Redis.
// If Redis fails, worker retries. If Postgres fails, nothing was committed.
// This is the Transactional Outbox Pattern.

import { prisma } from '../db/postgres'
import { redisClient } from '../db/redis'
import { config } from '../config'

export class CacheService {
  // Called within a Prisma transaction — schedules a Redis update
  // without directly touching Redis inside the transaction
  static async scheduleUpdate(
    tx: typeof prisma,
    key: string,
    value: unknown
  ): Promise<void> {
    await (tx as any).cacheOutbox.create({
      data: {
        redisKey: key,
        value: JSON.stringify(value),
        operation: 'SET'
      }
    })
  }

  // Background worker — polls outbox and applies to Redis
  static startOutboxWorker(): void {
    setInterval(async () => {
      const pending = await prisma.cacheOutbox.findMany({
        where: { processed: false },
        orderBy: { createdAt: 'asc' },
        take: 100
      })

      for (const entry of pending) {
        try {
          if (entry.operation === 'SET') {
            await redisClient.set(entry.redisKey, entry.value, 'EX', 30)
          } else if (entry.operation === 'DELETE') {
            await redisClient.del(entry.redisKey)
          }
          await prisma.cacheOutbox.update({
            where: { id: entry.id },
            data: { processed: true }
          })
        } catch (err) {
          // Redis is down — will retry on next poll cycle
          console.error('Outbox worker Redis error:', err)
        }
      }
    }, config.cacheOutboxPollMs)
  }

  static async getDashboardState(): Promise<unknown | null> {
    const cached = await redisClient.get('dashboard:state')
    return cached ? JSON.parse(cached) : null
  }
}
```

---

## 14. Queue worker (background drain loop)

```typescript
// backend/src/workers/QueueWorker.ts
import { signalQueue } from '../queue/SignalQueue'
import { Signal } from '../db/mongo'
import { debounceEngine } from '../debounce/DebounceEngine'
import { prisma } from '../db/postgres'
import { AlertStrategyFactory } from '../patterns/AlertStrategy'
import { fingerprintService } from './FingerprintService'
import { blastRadiusService } from './BlastRadiusService'
import { CacheService } from './CacheService'
import { config } from '../config'

async function withRetry<T>(fn: () => Promise<T>, attempts = config.retryAttempts): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try { return await fn() }
    catch (err) {
      if (i === attempts - 1) throw err
      await new Promise(r => setTimeout(r, config.retryBaseDelayMs * Math.pow(2, i)))
    }
  }
  throw new Error('unreachable')
}

export function startQueueWorker(): void {
  signalQueue.setDraining(true)

  const processNext = async () => {
    const signal = signalQueue.shift()
    if (!signal) {
      signalQueue.setDraining(false)
      signalQueue.once('drain', () => {
        signalQueue.setDraining(true)
        setImmediate(processNext)
      })
      return
    }

    try {
      const now = new Date()

      // 1. Debounce check
      const debounceResult = await debounceEngine.check(signal.componentId, signal.componentType)

      if (debounceResult.isNew) {
        // Compute fingerprint for recurrence detection
        const fingerprint = fingerprintService.compute(signal.componentType, signal.errorCode, now)
        const previousId = await fingerprintService.findPreviousIncident(fingerprint)
        const priority = AlertStrategyFactory.getForComponent(signal.componentType).priority

        // Create work item in Postgres + schedule cache update atomically
        const workItem = await withRetry(() =>
          prisma.$transaction(async (tx) => {
            const wi = await tx.workItem.create({
              data: {
                componentId: signal.componentId,
                componentType: signal.componentType,
                priority,
                fingerprint,
                suggestedRcaId: previousId,
                signalCount: 1
              }
            })
            // Schedule dashboard cache update inside the transaction
            await CacheService.scheduleUpdate(tx, 'dashboard:state:dirty', 'true')
            return wi
          })
        )

        // Register work item ID in Redis debounce key
        await debounceEngine.register(signal.componentId, signal.componentType, workItem.id)

        // Store signal in MongoDB with workItemId
        await withRetry(() => Signal.create({
          ...signal,
          workItemId: workItem.id,
          ts: now,
          processed: true
        }))

        // Fire alert strategy
        await AlertStrategyFactory.getForComponent(signal.componentType).execute(workItem)

        // Blast radius prediction for P0 only
        if (priority === 'P0') {
          await blastRadiusService.predictCascades(signal.componentId, workItem.id)
        }

      } else {
        // Link signal to existing work item
        const { workItemId } = debounceResult

        await withRetry(() => Promise.all([
          Signal.create({ ...signal, workItemId, ts: now, processed: true }),
          prisma.workItem.update({
            where: { id: workItemId },
            data: { signalCount: { increment: 1 } }
          })
        ]))
      }

    } catch (err) {
      console.error('Worker error processing signal:', err)
      // Signal is dropped after retries exhausted — logged for WAL replay analysis
    }

    setImmediate(processNext) // Non-blocking: yield to event loop between signals
  }

  setImmediate(processNext)
}
```

---

## 15. Ingest route

```typescript
// backend/src/routes/ingest.ts
import { FastifyInstance } from 'fastify'
import { walWriter } from '../queue/WalWriter'
import { signalQueue } from '../queue/SignalQueue'

const signalSchema = {
  type: 'object',
  required: ['componentId', 'componentType', 'errorCode', 'payload', 'severity'],
  properties: {
    componentId:   { type: 'string', minLength: 1, maxLength: 100 },
    componentType: { type: 'string', enum: ['RDBMS', 'CACHE', 'MCP_HOST', 'API', 'QUEUE', 'NOSQL'] },
    errorCode:     { type: 'string', minLength: 1, maxLength: 50 },
    payload:       { type: 'object' },
    severity:      { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }
  }
}

export async function ingestRoutes(app: FastifyInstance) {
  app.post('/ingest', {
    schema: { body: signalSchema },
    config: { rateLimit: { max: 500, timeWindow: 1000 } }
  }, async (req, reply) => {
    const body = req.body as any

    // 1. Write to WAL first (durability guarantee)
    const walOffset = walWriter.append(body)

    // 2. Push to in-memory queue (backpressure check)
    const accepted = signalQueue.push({ ...body, walOffset })

    if (!accepted) {
      return reply.code(429).send({
        error: 'BACKPRESSURE',
        message: 'Signal queue at capacity. Retry with exponential backoff.',
        queueSize: signalQueue.size,
        retryAfterMs: 100
      })
    }

    return reply.code(202).send({
      status: 'ACCEPTED',
      queueDepth: signalQueue.size
    })
  })
}
```

---

## 16. Work items routes

```typescript
// backend/src/routes/workItems.ts
import { FastifyInstance } from 'fastify'
import { prisma } from '../db/postgres'
import { Signal } from '../db/mongo'
import { stateFromLabel, WorkItemStateLabel, RcaInput } from '../patterns/WorkItemStateMachine'
import { CacheService } from '../services/CacheService'

export async function workItemRoutes(app: FastifyInstance) {

  // GET /work-items — active incidents sorted by severity then recency
  app.get('/work-items', async (req, reply) => {
    // Try cache first
    const cached = await CacheService.getDashboardState()
    if (cached) return reply.send(cached)

    const items = await prisma.workItem.findMany({
      where: { state: { not: 'CLOSED' } },
      include: { rca: false },
      orderBy: [
        { priority: 'asc' },   // P0 first
        { createdAt: 'asc' }
      ]
    })

    await CacheService.scheduleUpdate(prisma as any, 'dashboard:state', items)
    return reply.send(items)
  })

  // GET /work-items/:id — detail with MongoDB signals
  app.get('/work-items/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const [workItem, signals] = await Promise.all([
      prisma.workItem.findUnique({ where: { id }, include: { rca: true } }),
      Signal.find({ workItemId: id }).sort({ ts: -1 }).limit(200).lean()
    ])
    if (!workItem) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send({ workItem, signals })
  })

  // PATCH /work-items/:id/status — state transitions
  app.patch('/work-items/:id/status', {
    schema: {
      body: {
        type: 'object',
        required: ['state'],
        properties: {
          state: { type: 'string', enum: ['INVESTIGATING', 'RESOLVED', 'CLOSED'] }
        }
      }
    }
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { state: nextLabel } = req.body as { state: WorkItemStateLabel }

    const workItem = await prisma.workItem.findUnique({ where: { id } })
    if (!workItem) return reply.code(404).send({ error: 'NOT_FOUND' })

    const currentState = stateFromLabel(workItem.state as WorkItemStateLabel)

    if (!currentState.canTransitionTo(nextLabel)) {
      return reply.code(400).send({
        error: 'INVALID_TRANSITION',
        message: `Cannot transition from ${workItem.state} to ${nextLabel}`,
        current: workItem.state,
        requested: nextLabel
      })
    }

    const updated = await prisma.$transaction(async (tx) => {
      const wi = await tx.workItem.update({
        where: { id },
        data: {
          state: nextLabel,
          resolvedAt: nextLabel === 'RESOLVED' ? new Date() : undefined
        }
      })
      await CacheService.scheduleUpdate(tx, 'dashboard:state:dirty', 'true')
      return wi
    })

    return reply.send(updated)
  })

  // GET /work-items/metrics/mttr — weighted MTTR across all closed incidents
  app.get('/work-items/metrics/mttr', async (_req, reply) => {
    const result = await prisma.$queryRaw<any[]>`
      SELECT
        AVG(mttr_seconds) FILTER (WHERE priority = 'P0') as p0_mttr,
        AVG(mttr_seconds) FILTER (WHERE priority = 'P1') as p1_mttr,
        AVG(mttr_seconds) FILTER (WHERE priority = 'P2') as p2_mttr,
        AVG(mttr_seconds) as overall_mttr,
        SUM(mttr_seconds * CASE priority WHEN 'P0' THEN 3 WHEN 'P1' THEN 2 ELSE 1 END)::float
          / NULLIF(SUM(CASE priority WHEN 'P0' THEN 3 WHEN 'P1' THEN 2 ELSE 1 END), 0) as weighted_mttr,
        COUNT(*) as total_closed
      FROM work_items
      WHERE state = 'CLOSED' AND mttr_seconds IS NOT NULL
    `
    return reply.send(result[0] ?? {})
  })
}
```

---

## 17. RCA route

```typescript
// backend/src/routes/rca.ts
import { FastifyInstance } from 'fastify'
import { prisma } from '../db/postgres'
import { stateFromLabel, RcaInput } from '../patterns/WorkItemStateMachine'
import { CacheService } from '../services/CacheService'

export async function rcaRoutes(app: FastifyInstance) {
  app.post('/work-items/:id/rca', {
    schema: {
      body: {
        type: 'object',
        required: ['rootCauseCategory', 'rootCauseDetail', 'fixApplied', 'preventionSteps', 'incidentStart', 'incidentEnd'],
        properties: {
          rootCauseCategory: { type: 'string', enum: ['infrastructure', 'code_bug', 'configuration', 'capacity', 'dependency', 'human_error', 'unknown'] },
          rootCauseDetail:   { type: 'string', minLength: 10 },
          fixApplied:        { type: 'string', minLength: 10 },
          preventionSteps:   { type: 'string', minLength: 10 },
          incidentStart:     { type: 'string', format: 'date-time' },
          incidentEnd:       { type: 'string', format: 'date-time' },
          submittedBy:       { type: 'string' }
        }
      }
    }
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as any

    const workItem = await prisma.workItem.findUnique({ where: { id } })
    if (!workItem) return reply.code(404).send({ error: 'NOT_FOUND' })

    // Must be in RESOLVED state to submit RCA
    if (workItem.state !== 'RESOLVED') {
      return reply.code(400).send({
        error: 'INVALID_STATE',
        message: `Work item must be in RESOLVED state to submit RCA. Current state: ${workItem.state}`
      })
    }

    const rcaInput: RcaInput = {
      rootCauseCategory: body.rootCauseCategory,
      rootCauseDetail:   body.rootCauseDetail,
      fixApplied:        body.fixApplied,
      preventionSteps:   body.preventionSteps,
      incidentStart:     new Date(body.incidentStart),
      incidentEnd:       new Date(body.incidentEnd)
    }

    // Validate via state machine (throws with descriptive error if invalid)
    try {
      const resolvedState = stateFromLabel('RESOLVED')
      resolvedState.transitionTo('CLOSED', rcaInput)
    } catch (err: any) {
      return reply.code(400).send({ error: err.message })
    }

    const mttrSeconds = Math.floor(
      (rcaInput.incidentEnd.getTime() - workItem.startTime.getTime()) / 1000
    )

    const updated = await prisma.$transaction(async (tx) => {
      await tx.rca.create({
        data: {
          workItemId:        id,
          rootCauseCategory: rcaInput.rootCauseCategory,
          rootCauseDetail:   rcaInput.rootCauseDetail,
          fixApplied:        rcaInput.fixApplied,
          preventionSteps:   rcaInput.preventionSteps,
          incidentStart:     rcaInput.incidentStart,
          incidentEnd:       rcaInput.incidentEnd,
          submittedBy:       body.submittedBy ?? 'engineer'
        }
      })

      const wi = await tx.workItem.update({
        where: { id },
        data: {
          state:       'CLOSED',
          closedAt:    new Date(),
          mttrSeconds
        },
        include: { rca: true }
      })

      await CacheService.scheduleUpdate(tx, 'dashboard:state:dirty', 'true')
      return wi
    })

    return reply.code(201).send(updated)
  })
}
```

---

## 18. Health route and observability

```typescript
// backend/src/routes/health.ts
import { FastifyInstance } from 'fastify'
import { prisma } from '../db/postgres'
import { redisClient } from '../db/redis'
import { mongoose } from '../db/mongo'
import { signalQueue } from '../queue/SignalQueue'

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (_req, reply) => {
    const [pgOk, redisOk, mongoOk] = await Promise.all([
      prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
      redisClient.ping().then(r => r === 'PONG').catch(() => false),
      Promise.resolve(mongoose.connection.readyState === 1)
    ])

    const healthy = pgOk && redisOk && mongoOk
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'healthy' : 'degraded',
      uptime: process.uptime(),
      queueDepth: signalQueue.size,
      queueCapacity: process.env.QUEUE_MAX_SIZE,
      services: { postgres: pgOk, redis: redisOk, mongodb: mongoOk }
    })
  })
}

// backend/src/observability/metrics.ts
import { signalQueue } from '../queue/SignalQueue'
import { prisma } from '../db/postgres'

let signalsInWindow = 0
export function recordSignal() { signalsInWindow++ }

export function startMetricsLogger(): void {
  setInterval(async () => {
    const perSec = Math.round(signalsInWindow / 5)
    signalsInWindow = 0

    const openCount = await prisma.workItem.count({ where: { state: 'OPEN' } })

    console.info(JSON.stringify({
      event: 'THROUGHPUT_METRICS',
      signals_per_sec: perSec,
      queue_depth: signalQueue.size,
      open_incidents: openCount,
      ts: new Date().toISOString()
    }))
  }, 5000)
}
```

---

## 19. Server bootstrap

```typescript
// backend/src/server.ts
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import cors from '@fastify/cors'
import { config } from './config'
import { prisma } from './db/postgres'
import { connectMongo } from './db/mongo'
import { redisClient } from './db/redis'
import { WalWriter } from './queue/WalWriter'
import { Signal } from './db/mongo'
import { signalQueue } from './queue/SignalQueue'
import { startQueueWorker } from './workers/QueueWorker'
import { CacheService } from './services/CacheService'
import { startMetricsLogger } from './observability/metrics'
import { ingestRoutes } from './routes/ingest'
import { workItemRoutes } from './routes/workItems'
import { rcaRoutes } from './routes/rca'
import { healthRoutes } from './routes/health'

export let walWriter: WalWriter

async function replayWal(): Promise<void> {
  // Find all WAL offsets already processed (stored in MongoDB)
  const processed = await Signal.distinct('walOffset', { processed: true })
  const processedSet = new Set<number>(processed)

  let replayed = 0
  for await (const { signal, offset } of walWriter.replay(processedSet)) {
    const raw = signal as any
    signalQueue.push({ ...raw, walOffset: offset })
    replayed++
  }

  if (replayed > 0) {
    console.info(`WAL replay: re-enqueued ${replayed} unprocessed signals`)
  }
}

async function start() {
  const app = Fastify({ logger: true })

  await app.register(cors, { origin: true })
  await app.register(rateLimit, {
    global: false,
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindow
  })

  await connectMongo(config.mongoUrl)
  await prisma.$connect()

  walWriter = new WalWriter()
  await replayWal()

  startQueueWorker()
  CacheService.startOutboxWorker()
  startMetricsLogger()

  await app.register(ingestRoutes)
  await app.register(workItemRoutes)
  await app.register(rcaRoutes)
  await app.register(healthRoutes)

  await app.listen({ port: config.port, host: '0.0.0.0' })
  console.info(`IMS backend running on port ${config.port}`)
}

start().catch(err => {
  console.error('Fatal startup error:', err)
  process.exit(1)
})
```

---

## 20. Frontend — complete component spec

### App.tsx
```typescript
// Two views: Dashboard (list) and IncidentDetail (single work item)
// React Router with routes: / → Dashboard, /incident/:id → IncidentDetail
// Global React Query provider with default staleTime: 0, refetchInterval: 5000
```

### Dashboard.tsx
```typescript
// Polls GET /work-items every 5 seconds via React Query
// Columns: Priority badge | Component ID | State badge | Signal count
//          Suppressed signals info | Recurrence indicator | Created at | Action button
// Color coding: P0 = red row highlight, P1 = amber, P2 = neutral
// Show "Predicted cascade" label for isPredicted=true items
// Show "Recurring — seen before" indicator if suggestedRcaId is set
// MetricsBar at top: weighted MTTR, open P0 count, signals/sec (from /health queueDepth trend)
// Clicking any row navigates to /incident/:id
```

### IncidentDetail.tsx
```typescript
// Fetches GET /work-items/:id (includes signals array from MongoDB)
// Left panel: work item metadata, state machine controls
//   - Buttons only show valid next transitions (use canTransitionTo)
//   - Disabled with tooltip if transition not allowed
// Right panel: scrollable list of raw signals (latest 200), each showing
//   errorCode, severity, payload (collapsible JSON), timestamp
// If state === 'RESOLVED': show RCA form inline
// If suggestedRcaId is set: show "Previous similar incident" banner with link
// If isPredicted: show "Blast radius prediction — no manual action started this" banner
```

### RcaForm.tsx
```typescript
// Fields (all required):
//   incidentStart: datetime-local input
//   incidentEnd: datetime-local input (must be after start, validated client-side)
//   rootCauseCategory: <select> with options:
//     infrastructure | code_bug | configuration | capacity | dependency | human_error | unknown
//   rootCauseDetail: <textarea> minLength 10, placeholder "Describe what specifically failed..."
//   fixApplied: <textarea> minLength 10, placeholder "What was done to restore service..."
//   preventionSteps: <textarea> minLength 10, placeholder "What will prevent this recurring..."
//   submittedBy: <input> text
//
// On submit: POST /work-items/:id/rca
// On success: show calculated MTTR in seconds/minutes, navigate back to dashboard
// On error (RCA_INCOMPLETE): show field-level validation messages from server error string
```

### usePolling.ts
```typescript
// Wraps React Query's useQuery with refetchInterval
// Exposes: data, isLoading, isError, lastUpdated timestamp
// Shows "Live" green dot when polling is active, "Paused" when tab is hidden
```

---

## 21. Simulation script

```typescript
// simulate/scenario.ts
// Run with: npx ts-node simulate/scenario.ts
// Plays out a realistic cascading failure narrative.
// Shows debounce working, blast radius firing, signals suppressed counter climbing.

const API = 'http://localhost:3001'

async function send(signal: object) {
  await fetch(`${API}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(signal)
  })
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

async function simulate() {
  console.log('=== IMS Incident Simulation: RDBMS Cascade ===\n')

  // T+0: RDBMS starts throwing connection timeouts
  console.log('T+0s: RDBMS_PRIMARY connection timeouts begin...')
  for (let i = 0; i < 10; i++) {
    await send({
      componentId: 'RDBMS_PRIMARY',
      componentType: 'RDBMS',
      errorCode: 'CONNECTION_TIMEOUT',
      payload: { query: 'SELECT', duration_ms: 30000 + i * 100 },
      severity: 'critical'
    })
    await sleep(100)
  }

  await sleep(2000)

  // T+2s: Burst — dependent APIs start failing (cascade begins)
  console.log('T+2s: Cascade — API_GATEWAY starts failing...')
  for (let i = 0; i < 80; i++) {
    await send({
      componentId: 'API_GATEWAY',
      componentType: 'API',
      errorCode: 'UPSTREAM_UNAVAILABLE',
      payload: { upstream: 'RDBMS_PRIMARY', status: 502 },
      severity: 'high'
    })
    await sleep(50)
  }

  await sleep(3000)

  // T+7s: Cache starts getting stale (another cascade)
  console.log('T+7s: CACHE_CLUSTER_01 stale reads...')
  for (let i = 0; i < 40; i++) {
    await send({
      componentId: 'CACHE_CLUSTER_01',
      componentType: 'CACHE',
      errorCode: 'STALE_READ',
      payload: { miss_rate: 0.95 },
      severity: 'medium'
    })
    await sleep(80)
  }

  await sleep(3000)

  // T+15s: MCP Host loses connection
  console.log('T+15s: MCP_HOST_01 disconnected...')
  for (let i = 0; i < 15; i++) {
    await send({
      componentId: 'MCP_HOST_01',
      componentType: 'MCP_HOST',
      errorCode: 'CONNECTION_LOST',
      payload: { tool: 'database_connector', last_ping_ms: 5000 + i * 200 },
      severity: 'high'
    })
    await sleep(200)
  }

  await sleep(3000)

  // T+22s: Signals slow down — engineers are on the incident
  console.log('T+22s: Signal rate dropping — team is investigating...')
  for (let i = 0; i < 5; i++) {
    await send({
      componentId: 'RDBMS_PRIMARY',
      componentType: 'RDBMS',
      errorCode: 'CONNECTION_TIMEOUT',
      payload: { query: 'INSERT', duration_ms: 15000 },
      severity: 'critical'
    })
    await sleep(2000)
  }

  console.log('\n=== Simulation complete ===')
  console.log('Check the dashboard at http://localhost:3000')
  console.log('Expected: ~3-4 work items, suppressed signal counts, blast radius predictions')
}

simulate().catch(console.error)
```

---

## 22. Unit tests

```typescript
// backend/tests/stateMachine.test.ts
import { describe, it, expect } from 'vitest'
import {
  OpenState, InvestigatingState, ResolvedState, ClosedState,
  stateFromLabel
} from '../src/patterns/WorkItemStateMachine'

const validRca = {
  rootCauseCategory: 'infrastructure',
  rootCauseDetail: 'Primary RDBMS disk filled to 100%',
  fixApplied: 'Cleared old WAL files, expanded disk volume to 500GB',
  preventionSteps: 'Add disk usage alert at 80%, implement log rotation',
  incidentStart: new Date('2024-01-01T10:00:00Z'),
  incidentEnd: new Date('2024-01-01T12:00:00Z')
}

describe('WorkItem State Machine', () => {
  it('allows OPEN → INVESTIGATING', () => {
    const state = new OpenState()
    const next = state.transitionTo('INVESTIGATING')
    expect(next.label).toBe('INVESTIGATING')
  })

  it('rejects OPEN → RESOLVED (skipping INVESTIGATING)', () => {
    const state = new OpenState()
    expect(() => state.transitionTo('RESOLVED')).toThrow('Invalid transition')
  })

  it('rejects OPEN → CLOSED', () => {
    const state = new OpenState()
    expect(() => state.transitionTo('CLOSED')).toThrow('Invalid transition')
  })

  it('allows INVESTIGATING → RESOLVED', () => {
    const state = new InvestigatingState()
    const next = state.transitionTo('RESOLVED')
    expect(next.label).toBe('RESOLVED')
  })

  it('rejects RESOLVED → CLOSED without RCA', () => {
    const state = new ResolvedState()
    expect(() => state.transitionTo('CLOSED')).toThrow('RCA_REQUIRED')
  })

  it('rejects RESOLVED → CLOSED with incomplete RCA', () => {
    const state = new ResolvedState()
    expect(() => state.transitionTo('CLOSED', {
      ...validRca,
      fixApplied: '' // missing
    })).toThrow('RCA_INCOMPLETE')
  })

  it('rejects RCA where end is before start', () => {
    const state = new ResolvedState()
    expect(() => state.transitionTo('CLOSED', {
      ...validRca,
      incidentEnd: new Date('2024-01-01T09:00:00Z') // before start
    })).toThrow('RCA_INVALID')
  })

  it('allows RESOLVED → CLOSED with complete RCA', () => {
    const state = new ResolvedState()
    const next = state.transitionTo('CLOSED', validRca)
    expect(next.label).toBe('CLOSED')
  })

  it('rejects any transition from CLOSED (terminal state)', () => {
    const state = new ClosedState()
    expect(() => state.transitionTo('OPEN')).toThrow('terminal')
    expect(state.canTransitionTo('INVESTIGATING')).toBe(false)
  })
})

// backend/tests/rcaValidation.test.ts
describe('RCA Validation', () => {
  it('rejects rootCauseDetail under 10 characters', () => {
    const state = new ResolvedState()
    expect(() => state.transitionTo('CLOSED', { ...validRca, rootCauseDetail: 'short' }))
      .toThrow('RCA_INCOMPLETE')
  })

  it('accepts all seven root cause categories', () => {
    const categories = ['infrastructure','code_bug','configuration','capacity','dependency','human_error','unknown']
    categories.forEach(cat => {
      const state = new ResolvedState()
      expect(() => state.transitionTo('CLOSED', { ...validRca, rootCauseCategory: cat }))
        .not.toThrow()
    })
  })
})

// backend/tests/mttr.test.ts
describe('MTTR Calculation', () => {
  it('calculates MTTR as seconds between startTime and incidentEnd', () => {
    const startTime = new Date('2024-01-01T10:00:00Z')
    const incidentEnd = new Date('2024-01-01T11:30:00Z')
    const mttrSeconds = Math.floor((incidentEnd.getTime() - startTime.getTime()) / 1000)
    expect(mttrSeconds).toBe(5400) // 90 minutes
  })

  it('calculates weighted MTTR correctly (P0 weight 3, P1 weight 2, P2 weight 1)', () => {
    const items = [
      { mttr: 3600, priority: 'P0', weight: 3 },
      { mttr: 1800, priority: 'P1', weight: 2 },
      { mttr: 600,  priority: 'P2', weight: 1 }
    ]
    const numerator = items.reduce((sum, i) => sum + i.mttr * i.weight, 0)
    const denominator = items.reduce((sum, i) => sum + i.weight, 0)
    const weighted = numerator / denominator
    expect(weighted).toBe((3600*3 + 1800*2 + 600*1) / 6) // 2600
  })
})
```

---

## 23. package.json files

```json
// backend/package.json
{
  "name": "ims-backend",
  "version": "1.0.0",
  "scripts": {
    "dev": "ts-node-dev --respawn src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "test": "vitest run",
    "db:migrate": "prisma migrate deploy",
    "db:generate": "prisma generate"
  },
  "dependencies": {
    "@fastify/cors": "^9.0.0",
    "@fastify/rate-limit": "^9.0.0",
    "@prisma/client": "^5.0.0",
    "fastify": "^4.0.0",
    "ioredis": "^5.0.0",
    "mongoose": "^8.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "prisma": "^5.0.0",
    "ts-node-dev": "^2.0.0",
    "typescript": "^5.0.0",
    "vitest": "^1.0.0"
  }
}
```

```json
// frontend/package.json
{
  "name": "ims-frontend",
  "version": "1.0.0",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.0.0",
    "react": "^18.0.0",
    "react-dom": "^18.0.0",
    "react-router-dom": "^6.0.0"
  },
  "devDependencies": {
    "@types/react": "^18.0.0",
    "@types/react-dom": "^18.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    "autoprefixer": "^10.0.0",
    "postcss": "^8.0.0",
    "tailwindcss": "^3.0.0",
    "typescript": "^5.0.0",
    "vite": "^5.0.0"
  }
}
```

---

## 24. Dockerfiles

```dockerfile
# backend/Dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
RUN npm run build
EXPOSE 3001
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
```

```dockerfile
# frontend/Dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 3000
```

---

## 25. Documents to write (content guidance)

### README.md — must contain:
1. One-paragraph project description
2. Architecture diagram (ASCII or linked image)
3. Quick start: `docker compose up --build` then open `localhost:3000`
4. How to run the simulation: `cd simulate && npx ts-node scenario.ts`
5. How to run tests: `cd backend && npm test`
6. **Section titled "Backpressure handling"**: explain the bounded in-memory queue,
   HTTP 429 response on overflow, the WAL for durability, and why this design
   prevents cascading failures into the DB layer
7. Load test results table (run autocannon against /ingest and paste results)

### DESIGN.md — must contain:
1. Storage rationale: one paragraph per technology explaining why it was chosen
   over alternatives (explicitly mention what you rejected and why)
2. Design patterns: explain Strategy and State with a one-paragraph "why this pattern
   solves this specific problem" for each
3. Novel features: fingerprinting, blast radius, outbox pattern — one paragraph each

### ARCHITECTURE_TRADEOFFS.md — must contain:
1. In-memory queue vs Redis Streams: why in-memory is acceptable here, what you
   would change in production, what failure scenario it cannot handle
2. TimescaleDB decision: explicitly state you evaluated it and chose not to use it,
   and what volume would justify it
3. Per-component debounce: why hardcoding 10s would be wrong, how config-driven
   windows improve the system
4. Outbox pattern: why direct Redis writes inside transactions are dangerous, how
   the outbox solves consistency without distributed transactions

---

## 26. API contract summary (for frontend to consume)

```
POST   /ingest                          → 202 ACCEPTED | 400 VALIDATION | 429 BACKPRESSURE
GET    /work-items                      → WorkItem[] (active only, sorted P0 first)
GET    /work-items/:id                  → { workItem, signals: Signal[] }
PATCH  /work-items/:id/status           → WorkItem | 400 INVALID_TRANSITION
POST   /work-items/:id/rca              → WorkItem (with rca included) | 400 RCA errors
GET    /work-items/metrics/mttr         → { p0_mttr, p1_mttr, p2_mttr, weighted_mttr, total_closed }
GET    /health                          → { status, uptime, queueDepth, services }
```

---

## 27. Critical implementation rules for the agent

1. **Never write a migration manually** — use `prisma migrate dev --name <description>`
2. **Never hardcode the 10-second debounce window** — always read from `config.debounceWindows`
3. **Never update Redis directly inside a Prisma transaction** — always use `CacheService.scheduleUpdate`
4. **Never allow state transitions to be validated in a route handler** — always delegate to the state machine class
5. **Never return 500 for a state transition error** — return 400 with a structured error body
6. **Never skip the WAL write** — it must happen before the queue push, not after
7. **All DB writes must use `withRetry`** — 3 attempts, exponential backoff, base 100ms
8. **The simulate script must be runnable independently** — no imports from backend src
9. **Frontend must never show raw error messages** — parse server error strings into user-readable text
10. **Tests must run without a DB connection** — all pattern tests are pure unit tests with no DB dependency

---

*End of spec. Total implementation surface: ~2,500 lines of code across backend and frontend.*
*Estimated build time with this spec: 2-3 focused days.*
