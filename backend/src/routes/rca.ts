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

    // Use Math.max to prevent negative MTTR if client and server clocks drift
    // (Extremely common in Docker Desktop on Windows/WSL2)
    const mttrSeconds = Math.max(0, Math.floor(
      (rcaInput.incidentEnd.getTime() - workItem.startTime.getTime()) / 1000
    ))

    const updated = await prisma.$transaction(async (tx: any) => {
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
