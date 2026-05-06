// backend/src/routes/ingest.ts
import { FastifyInstance } from 'fastify'
import { walWriter } from '../server'
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
