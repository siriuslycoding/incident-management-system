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
