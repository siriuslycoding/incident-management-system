// backend/src/services/FingerprintService.ts
// Computes a lightweight hash of (componentType + errorCode + hourOfDayBucket).
// When a new work item is created, checks if any CLOSED work item has the same fingerprint.
// If so, surfaces the previous RCA as a suggestion in the UI.
// This solves the problem of engineers repeatedly investigating the same root causes.

import crypto from 'crypto'
import { prisma } from '../db/postgres'

export class FingerprintService {
  compute(componentType: string, errorCode: string, ts: Date): string {
    // Hour bucket: 0-23 grouped into 4 buckets (0-5, 6-11, 12-17, 18-23)
    // Same error recurring at 2am and 3am gets same fingerprint
    const hourBucket = Math.floor(ts.getHours() / 6)
    const raw = `${componentType}:${errorCode}:${hourBucket}`
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)
  }

  async findPreviousIncident(fingerprint: string): Promise<string | null> {
    const previous = await prisma.workItem.findFirst({
      where: { fingerprint, state: 'CLOSED' },
      orderBy: { closedAt: 'desc' },
      select: { id: true }
    })
    return previous?.id ?? null
  }
}

export const fingerprintService = new FingerprintService()
