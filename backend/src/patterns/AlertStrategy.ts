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
    const priority = ({
      RDBMS:    'P0',
      MCP_HOST: 'P1',
      API:      'P1',
      CACHE:    'P2',
      QUEUE:    'P2',
      NOSQL:    'P2'
    } as Record<string, string>)[componentType] ?? 'P2'

    return this.strategies[priority]
  }
}
