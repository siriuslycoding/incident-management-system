// backend/src/observability/metrics.ts
import { signalQueue } from '../queue/SignalQueue'
import { prisma } from '../db/postgres'

let signalsInWindow = 0
export function recordSignal() { signalsInWindow++ }

export function startMetricsLogger(): void {
  setInterval(async () => {
    const perSec = Math.round(signalsInWindow / 5)
    signalsInWindow = 0

    const openCount = await prisma.workItem.count({ where: { state: 'OPEN' } })

    console.info(JSON.stringify({
      event: 'THROUGHPUT_METRICS',
      signals_per_sec: perSec,
      queue_depth: signalQueue.size,
      open_incidents: openCount,
      ts: new Date().toISOString()
    }))
  }, 5000)
}
