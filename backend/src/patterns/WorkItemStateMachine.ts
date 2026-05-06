// backend/src/patterns/WorkItemStateMachine.ts
// Each state class defines exactly which transitions are valid.
// Invalid transitions throw — they cannot be caught and ignored.
// CLOSED state is impossible without a complete, validated RCA object.

export type WorkItemStateLabel = 'OPEN' | 'INVESTIGATING' | 'RESOLVED' | 'CLOSED'

export interface RcaInput {
  rootCauseCategory: string
  rootCauseDetail: string
  fixApplied: string
  preventionSteps: string
  incidentStart: Date
  incidentEnd: Date
}

export abstract class WorkItemState {
  abstract readonly label: WorkItemStateLabel
  abstract transitionTo(next: WorkItemStateLabel, rca?: RcaInput): WorkItemState
  abstract canTransitionTo(next: WorkItemStateLabel): boolean
}

export class OpenState extends WorkItemState {
  readonly label = 'OPEN' as const

  canTransitionTo(next: WorkItemStateLabel): boolean {
    return next === 'INVESTIGATING'
  }

  transitionTo(next: WorkItemStateLabel): WorkItemState {
    if (next !== 'INVESTIGATING') throw new Error(`Invalid transition: OPEN → ${next}`)
    return new InvestigatingState()
  }
}

export class InvestigatingState extends WorkItemState {
  readonly label = 'INVESTIGATING' as const

  canTransitionTo(next: WorkItemStateLabel): boolean {
    return next === 'RESOLVED'
  }

  transitionTo(next: WorkItemStateLabel): WorkItemState {
    if (next !== 'RESOLVED') throw new Error(`Invalid transition: INVESTIGATING → ${next}`)
    return new ResolvedState()
  }
}

export class ResolvedState extends WorkItemState {
  readonly label = 'RESOLVED' as const

  canTransitionTo(next: WorkItemStateLabel): boolean {
    return next === 'CLOSED'
  }

  transitionTo(next: WorkItemStateLabel, rca?: RcaInput): WorkItemState {
    if (next !== 'CLOSED') throw new Error(`Invalid transition: RESOLVED → ${next}`)
    this.validateRca(rca)
    return new ClosedState()
  }

  private validateRca(rca?: RcaInput): void {
    if (!rca) throw new Error('RCA_REQUIRED: Cannot close incident without RCA')
    if (!rca.rootCauseCategory?.trim())
      throw new Error('RCA_INCOMPLETE: rootCauseCategory is required')
    if (!rca.rootCauseDetail?.trim() || rca.rootCauseDetail.trim().length < 10)
      throw new Error('RCA_INCOMPLETE: rootCauseDetail must be at least 10 characters')
    if (!rca.fixApplied?.trim() || rca.fixApplied.trim().length < 10)
      throw new Error('RCA_INCOMPLETE: fixApplied must be at least 10 characters')
    if (!rca.preventionSteps?.trim() || rca.preventionSteps.trim().length < 10)
      throw new Error('RCA_INCOMPLETE: preventionSteps must be at least 10 characters')
    if (!rca.incidentStart || !rca.incidentEnd)
      throw new Error('RCA_INCOMPLETE: incidentStart and incidentEnd are required')
    if (rca.incidentEnd <= rca.incidentStart)
      throw new Error('RCA_INVALID: incidentEnd must be after incidentStart')
  }
}

export class ClosedState extends WorkItemState {
  readonly label = 'CLOSED' as const

  canTransitionTo(_next: WorkItemStateLabel): boolean {
    return false // Terminal state
  }

  transitionTo(next: WorkItemStateLabel): WorkItemState {
    throw new Error(`Invalid transition: CLOSED is a terminal state. Cannot transition to ${next}`)
  }
}

// Factory
export function stateFromLabel(label: WorkItemStateLabel): WorkItemState {
  switch (label) {
    case 'OPEN':          return new OpenState()
    case 'INVESTIGATING': return new InvestigatingState()
    case 'RESOLVED':      return new ResolvedState()
    case 'CLOSED':        return new ClosedState()
    default: throw new Error(`Unknown state label: ${label}`)
  }
}
