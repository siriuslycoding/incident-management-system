// backend/src/db/redis.ts
import Redis from 'ioredis'
import { config } from '../config'

export const redisClient = new Redis(config.redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: 3
})

redisClient.on('error', (err) => {
  console.error('Redis client error:', err)
})
