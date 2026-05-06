// frontend/src/components/RcaForm.tsx
// Full RCA submission form — all fields required, client-side validation

import React, { useState } from 'react'
import { api, RcaSubmission } from '../api/client'

interface RcaFormProps {
  workItemId: string
  startTime: string
  onSuccess: (mttrSeconds: number) => void
  onError: (message: string) => void
}

const CATEGORIES = [
  { value: 'infrastructure', label: 'Infrastructure' },
  { value: 'code_bug', label: 'Code Bug' },
  { value: 'configuration', label: 'Configuration' },
  { value: 'capacity', label: 'Capacity' },
  { value: 'dependency', label: 'Dependency' },
  { value: 'human_error', label: 'Human Error' },
  { value: 'unknown', label: 'Unknown' }
]

export default function RcaForm({ workItemId, startTime, onSuccess, onError }: RcaFormProps) {
  const defaultStart = new Date(startTime).toISOString().slice(0, 16)
  const defaultEnd = new Date().toISOString().slice(0, 16)

  const [form, setForm] = useState<RcaSubmission>({
    rootCauseCategory: '',
    rootCauseDetail: '',
    fixApplied: '',
    preventionSteps: '',
    incidentStart: defaultStart,
    incidentEnd: defaultEnd,
    submittedBy: 'engineer'
  })

  const [errors, setErrors] = useState<Partial<Record<keyof RcaSubmission, string>>>({})
  const [submitting, setSubmitting] = useState(false)

  function validate(): boolean {
    const errs: Partial<Record<keyof RcaSubmission, string>> = {}
    if (!form.rootCauseCategory) errs.rootCauseCategory = 'Select a root cause category'
    if (form.rootCauseDetail.length < 10) errs.rootCauseDetail = 'Minimum 10 characters required'
    if (form.fixApplied.length < 10) errs.fixApplied = 'Minimum 10 characters required'
    if (form.preventionSteps.length < 10) errs.preventionSteps = 'Minimum 10 characters required'
    if (!form.incidentStart) errs.incidentStart = 'Required'
    if (!form.incidentEnd) errs.incidentEnd = 'Required'
    if (form.incidentStart && form.incidentEnd && new Date(form.incidentEnd) <= new Date(form.incidentStart)) {
      errs.incidentEnd = 'End time must be after start time'
    }
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  function parseServerError(msg: string): Partial<Record<keyof RcaSubmission, string>> {
    const errs: Partial<Record<keyof RcaSubmission, string>> = {}
    if (msg.includes('rootCauseCategory')) errs.rootCauseCategory = 'Root cause category is required'
    if (msg.includes('rootCauseDetail')) errs.rootCauseDetail = 'Root cause detail is incomplete'
    if (msg.includes('fixApplied')) errs.fixApplied = 'Fix applied description is incomplete'
    if (msg.includes('preventionSteps')) errs.preventionSteps = 'Prevention steps are incomplete'
    if (msg.includes('incidentEnd must be after')) errs.incidentEnd = 'End time must be after start time'
    if (Object.keys(errs).length === 0) errs.rootCauseDetail = msg
    return errs
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!validate()) return

    setSubmitting(true)
    try {
      const result = await api.submitRca(workItemId, {
        ...form,
        incidentStart: new Date(form.incidentStart).toISOString(),
        incidentEnd: new Date(form.incidentEnd).toISOString()
      })
      onSuccess(result.mttrSeconds ?? 0)
    } catch (err: any) {
      const msg = err?.data?.error || err?.message || 'Submission failed'
      if (msg.includes('RCA_')) {
        setErrors(parseServerError(msg))
      } else {
        onError(msg)
      }
    } finally {
      setSubmitting(false)
    }
  }

  const set = (field: keyof RcaSubmission) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) => {
    setForm(f => ({ ...f, [field]: e.target.value }))
    setErrors(errs => ({ ...errs, [field]: undefined }))
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Time range */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Incident Start *</label>
          <input
            type="datetime-local"
            className={`input ${errors.incidentStart ? 'border-red-500/60 focus:ring-red-500/50' : ''}`}
            value={form.incidentStart}
            onChange={set('incidentStart')}
          />
          {errors.incidentStart && <p className="text-xs text-red-400 mt-1">{errors.incidentStart}</p>}
        </div>
        <div>
          <label className="label">Incident End *</label>
          <input
            type="datetime-local"
            className={`input ${errors.incidentEnd ? 'border-red-500/60 focus:ring-red-500/50' : ''}`}
            value={form.incidentEnd}
            onChange={set('incidentEnd')}
          />
          {errors.incidentEnd && <p className="text-xs text-red-400 mt-1">{errors.incidentEnd}</p>}
        </div>
      </div>

      {/* Root cause category */}
      <div>
        <label className="label">Root Cause Category *</label>
        <select
          className={`input ${errors.rootCauseCategory ? 'border-red-500/60' : ''}`}
          value={form.rootCauseCategory}
          onChange={set('rootCauseCategory')}
        >
          <option value="">Select a category...</option>
          {CATEGORIES.map(c => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
        {errors.rootCauseCategory && <p className="text-xs text-red-400 mt-1">{errors.rootCauseCategory}</p>}
      </div>

      {/* Root cause detail */}
      <div>
        <label className="label">Root Cause Detail *</label>
        <textarea
          rows={3}
          className={`textarea ${errors.rootCauseDetail ? 'border-red-500/60' : ''}`}
          placeholder="Describe what specifically failed..."
          value={form.rootCauseDetail}
          onChange={set('rootCauseDetail')}
        />
        <div className="flex justify-between mt-1">
          {errors.rootCauseDetail
            ? <p className="text-xs text-red-400">{errors.rootCauseDetail}</p>
            : <span />}
          <span className="text-xs text-gray-600">{form.rootCauseDetail.length} chars</span>
        </div>
      </div>

      {/* Fix applied */}
      <div>
        <label className="label">Fix Applied *</label>
        <textarea
          rows={3}
          className={`textarea ${errors.fixApplied ? 'border-red-500/60' : ''}`}
          placeholder="What was done to restore service..."
          value={form.fixApplied}
          onChange={set('fixApplied')}
        />
        {errors.fixApplied && <p className="text-xs text-red-400 mt-1">{errors.fixApplied}</p>}
      </div>

      {/* Prevention steps */}
      <div>
        <label className="label">Prevention Steps *</label>
        <textarea
          rows={3}
          className={`textarea ${errors.preventionSteps ? 'border-red-500/60' : ''}`}
          placeholder="What will prevent this recurring..."
          value={form.preventionSteps}
          onChange={set('preventionSteps')}
        />
        {errors.preventionSteps && <p className="text-xs text-red-400 mt-1">{errors.preventionSteps}</p>}
      </div>

      {/* Submitted by */}
      <div>
        <label className="label">Submitted By</label>
        <input
          type="text"
          className="input"
          placeholder="engineer"
          value={form.submittedBy}
          onChange={set('submittedBy')}
        />
      </div>

      <button
        type="submit"
        disabled={submitting}
        className="btn-primary w-full justify-center py-3 text-base disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting ? (
          <>
            <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin"></div>
            Submitting RCA...
          </>
        ) : (
          '✓ Submit RCA & Close Incident'
        )}
      </button>
    </form>
  )
}
