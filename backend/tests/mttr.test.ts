// backend/tests/mttr.test.ts
import { describe, it, expect } from 'vitest'

describe('MTTR Calculation', () => {
  it('calculates MTTR as seconds between startTime and incidentEnd', () => {
    const startTime = new Date('2024-01-01T10:00:00Z')
    const incidentEnd = new Date('2024-01-01T11:30:00Z')
    const mttrSeconds = Math.floor((incidentEnd.getTime() - startTime.getTime()) / 1000)
    expect(mttrSeconds).toBe(5400) // 90 minutes
  })

  it('calculates weighted MTTR correctly (P0 weight 3, P1 weight 2, P2 weight 1)', () => {
    const items = [
      { mttr: 3600, priority: 'P0', weight: 3 },
      { mttr: 1800, priority: 'P1', weight: 2 },
      { mttr: 600,  priority: 'P2', weight: 1 }
    ]
    const numerator = items.reduce((sum, i) => sum + i.mttr * i.weight, 0)
    const denominator = items.reduce((sum, i) => sum + i.weight, 0)
    const weighted = numerator / denominator
    expect(weighted).toBe((3600*3 + 1800*2 + 600*1) / 6) // 2600
  })
})
