// backend/src/services/BlastRadiusService.ts
// When a P0 work item is created, traverses the dependency graph.
// Pre-creates INVESTIGATING work items for dependent components with isPredicted=true.
// If signals arrive for those components within the debounce window, they link automatically.
// If no signals arrive, predicted work items are auto-closed after 2 minutes.

import { config } from '../config'
import { prisma } from '../db/postgres'

export class BlastRadiusService {
  async predictCascades(
    failedComponentId: string,
    triggerWorkItemId: string
  ): Promise<void> {
    const dependents = config.dependencyGraph[failedComponentId] ?? []
    if (dependents.length === 0) return

    console.info(JSON.stringify({
      event: 'BLAST_RADIUS_PREDICTED',
      source: failedComponentId,
      predicted: dependents,
      triggerWorkItemId
    }))

    for (const dep of dependents) {
      const componentType = dep.split('_')[0] // e.g. 'API' from 'API_GATEWAY'

      const predicted = await prisma.workItem.create({
        data: {
          componentId: dep,
          componentType,
          priority: config.componentPriority[componentType] ?? 'P2',
          state: 'INVESTIGATING', // Pre-set to investigating since we know why
          isPredicted: true,
          suggestedRcaId: triggerWorkItemId
        }
      })

      // Auto-close after 2 minutes if no real signals arrive
      setTimeout(async () => {
        const current = await prisma.workItem.findUnique({
          where: { id: predicted.id },
          select: { state: true, signalCount: true }
        })
        if (current?.state === 'INVESTIGATING' && current.signalCount <= 1) {
          await prisma.workItem.update({
            where: { id: predicted.id },
            data: {
              state: 'CLOSED',
              closedAt: new Date(),
              mttrSeconds: 0
            }
          })
        }
      }, 120_000)
    }
  }
}

export const blastRadiusService = new BlastRadiusService()
