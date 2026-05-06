// backend/tests/rcaValidation.test.ts
import { describe, it, expect } from 'vitest'
import { ResolvedState } from '../src/patterns/WorkItemStateMachine'

const validRca = {
  rootCauseCategory: 'infrastructure',
  rootCauseDetail: 'Primary RDBMS disk filled to 100%',
  fixApplied: 'Cleared old WAL files, expanded disk volume to 500GB',
  preventionSteps: 'Add disk usage alert at 80%, implement log rotation',
  incidentStart: new Date('2024-01-01T10:00:00Z'),
  incidentEnd: new Date('2024-01-01T12:00:00Z')
}

describe('RCA Validation', () => {
  it('rejects rootCauseDetail under 10 characters', () => {
    const state = new ResolvedState()
    expect(() => state.transitionTo('CLOSED', { ...validRca, rootCauseDetail: 'short' }))
      .toThrow('RCA_INCOMPLETE')
  })

  it('accepts all seven root cause categories', () => {
    const categories = ['infrastructure','code_bug','configuration','capacity','dependency','human_error','unknown']
    categories.forEach(cat => {
      const state = new ResolvedState()
      expect(() => state.transitionTo('CLOSED', { ...validRca, rootCauseCategory: cat }))
        .not.toThrow()
    })
  })
})
