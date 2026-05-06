// backend/src/workers/QueueWorker.ts
import { signalQueue } from '../queue/SignalQueue'
import { Signal } from '../db/mongo'
import { debounceEngine } from '../debounce/DebounceEngine'
import { prisma } from '../db/postgres'
import { AlertStrategyFactory } from '../patterns/AlertStrategy'
import { fingerprintService } from '../services/FingerprintService'
import { blastRadiusService } from '../services/BlastRadiusService'
import { CacheService } from '../services/CacheService'
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
        const workItem: any = await withRetry(() =>
          prisma.$transaction(async (tx: any) => {
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
