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
    tx: any,
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
