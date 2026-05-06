// backend/src/routes/workItems.ts
import { FastifyInstance } from 'fastify'
import { prisma } from '../db/postgres'
import { Signal } from '../db/mongo'
import { stateFromLabel, WorkItemStateLabel } from '../patterns/WorkItemStateMachine'
import { CacheService } from '../services/CacheService'

// Fix for Fastify/JSON stringify not knowing how to serialize BigInts
if (!(BigInt.prototype as any).toJSON) {
  (BigInt.prototype as any).toJSON = function () {
    return Number(this)
  }
}

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

  // GET /work-items/metrics/mttr — weighted MTTR across all closed incidents
  // NOTE: This must be registered BEFORE /work-items/:id to avoid route conflicts
  app.get('/work-items/metrics/mttr', async (_req, reply) => {
    const result = await prisma.$queryRaw<any[]>`
      SELECT
        COALESCE(AVG(mttr_seconds) FILTER (WHERE priority = 'P0'), 0)::float as p0_mttr,
        COALESCE(AVG(mttr_seconds) FILTER (WHERE priority = 'P1'), 0)::float as p1_mttr,
        COALESCE(AVG(mttr_seconds) FILTER (WHERE priority = 'P2'), 0)::float as p2_mttr,
        COALESCE(AVG(mttr_seconds), 0)::float as overall_mttr,
        COALESCE((SUM(mttr_seconds * CASE priority WHEN 'P0' THEN 3 WHEN 'P1' THEN 2 ELSE 1 END)::float
          / NULLIF(SUM(CASE priority WHEN 'P0' THEN 3 WHEN 'P1' THEN 2 ELSE 1 END)::float, 0)), 0)::float as weighted_mttr,
        COUNT(*)::int as total_closed
      FROM work_items
      WHERE state = 'CLOSED' AND mttr_seconds IS NOT NULL
    `
    return reply.send(result[0] ?? {})
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

    const updated = await prisma.$transaction(async (tx: any) => {
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
}
