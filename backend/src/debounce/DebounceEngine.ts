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
