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
  await redisClient.connect()

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
