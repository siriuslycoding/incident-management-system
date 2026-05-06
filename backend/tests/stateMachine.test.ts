// backend/tests/stateMachine.test.ts
import { describe, it, expect } from 'vitest'
import {
  OpenState, InvestigatingState, ResolvedState, ClosedState,
  stateFromLabel
} from '../src/patterns/WorkItemStateMachine'

const validRca = {
  rootCauseCategory: 'infrastructure',
  rootCauseDetail: 'Primary RDBMS disk filled to 100%',
  fixApplied: 'Cleared old WAL files, expanded disk volume to 500GB',
  preventionSteps: 'Add disk usage alert at 80%, implement log rotation',
  incidentStart: new Date('2024-01-01T10:00:00Z'),
  incidentEnd: new Date('2024-01-01T12:00:00Z')
}

describe('WorkItem State Machine', () => {
  it('allows OPEN → INVESTIGATING', () => {
    const state = new OpenState()
    const next = state.transitionTo('INVESTIGATING')
    expect(next.label).toBe('INVESTIGATING')
  })

  it('rejects OPEN → RESOLVED (skipping INVESTIGATING)', () => {
    const state = new OpenState()
    expect(() => state.transitionTo('RESOLVED')).toThrow('Invalid transition')
  })

  it('rejects OPEN → CLOSED', () => {
    const state = new OpenState()
    expect(() => state.transitionTo('CLOSED')).toThrow('Invalid transition')
  })

  it('allows INVESTIGATING → RESOLVED', () => {
    const state = new InvestigatingState()
    const next = state.transitionTo('RESOLVED')
    expect(next.label).toBe('RESOLVED')
  })

  it('rejects RESOLVED → CLOSED without RCA', () => {
    const state = new ResolvedState()
    expect(() => state.transitionTo('CLOSED')).toThrow('RCA_REQUIRED')
  })

  it('rejects RESOLVED → CLOSED with incomplete RCA', () => {
    const state = new ResolvedState()
    expect(() => state.transitionTo('CLOSED', {
      ...validRca,
      fixApplied: '' // missing
    })).toThrow('RCA_INCOMPLETE')
  })

  it('rejects RCA where end is before start', () => {
    const state = new ResolvedState()
    expect(() => state.transitionTo('CLOSED', {
      ...validRca,
      incidentEnd: new Date('2024-01-01T09:00:00Z') // before start
    })).toThrow('RCA_INVALID')
  })

  it('allows RESOLVED → CLOSED with complete RCA', () => {
    const state = new ResolvedState()
    const next = state.transitionTo('CLOSED', validRca)
    expect(next.label).toBe('CLOSED')
  })

  it('rejects any transition from CLOSED (terminal state)', () => {
    const state = new ClosedState()
    expect(() => state.transitionTo('OPEN')).toThrow('terminal')
    expect(state.canTransitionTo('INVESTIGATING')).toBe(false)
  })
})
