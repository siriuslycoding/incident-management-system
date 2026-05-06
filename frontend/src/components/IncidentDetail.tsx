// frontend/src/components/IncidentDetail.tsx
// Detail view: left panel = metadata + state controls, right panel = signal feed

import React, { useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { usePolling } from '../hooks/usePolling'
import { api, WorkItem, Signal } from '../api/client'
import { PriorityBadge, StateBadge, SeverityBadge } from './StatusBadge'
import RcaForm from './RcaForm'

const VALID_TRANSITIONS: Record<string, string[]> = {
  OPEN: ['INVESTIGATING'],
  INVESTIGATING: ['RESOLVED'],
  RESOLVED: ['CLOSED'],
  CLOSED: []
}

function formatTime(ts: string): string {
  return new Date(ts).toLocaleString()
}

function formatMttr(sec: number): string {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.round(sec / 60)}m ${sec % 60}s`
  return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`
}

function PayloadViewer({ payload }: { payload: Record<string, unknown> }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        onClick={() => setOpen(o => !o)}
        className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
      >
        {open ? '▼ Hide payload' : '▶ Show payload'}
      </button>
      {open && (
        <pre className="mt-2 text-xs bg-gray-950/80 rounded-lg p-3 overflow-x-auto text-gray-300 font-mono border border-gray-800">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </div>
  )
}

export default function IncidentDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [transitioning, setTransitioning] = useState(false)
  const [transitionError, setTransitionError] = useState<string | null>(null)
  const [mttrResult, setMttrResult] = useState<number | null>(null)
  const [rcaError, setRcaError] = useState<string | null>(null)

  const { data, isLoading, isError } = usePolling<{ workItem: WorkItem; signals: Signal[] }>(
    ['work-item', id!],
    () => api.getWorkItem(id!)
  )

  const workItem = data?.workItem
  const signals = data?.signals ?? []

  async function handleTransition(state: string) {
    if (!id) return
    setTransitioning(true)
    setTransitionError(null)
    try {
      await api.updateStatus(id, state)
      queryClient.invalidateQueries({ queryKey: ['work-item', id] })
      queryClient.invalidateQueries({ queryKey: ['work-items'] })
    } catch (err: any) {
      const msg = err?.data?.message || err?.message || 'Transition failed'
      setTransitionError(msg)
    } finally {
      setTransitioning(false)
    }
  }

  async function handleRcaSuccess(mttrSeconds: number) {
    setMttrResult(mttrSeconds)
    queryClient.invalidateQueries({ queryKey: ['work-item', id] })
    queryClient.invalidateQueries({ queryKey: ['work-items'] })
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-gray-500">
          <div className="w-8 h-8 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin"></div>
          <span className="text-sm">Loading incident...</span>
        </div>
      </div>
    )
  }

  if (isError || !workItem) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-400 font-medium">Incident not found</p>
          <button onClick={() => navigate('/')} className="btn-ghost mt-4">← Back to Dashboard</button>
        </div>
      </div>
    )
  }

  const availableTransitions = VALID_TRANSITIONS[workItem.state] ?? []

  return (
    <div className="min-h-screen bg-gray-950 p-4 lg:p-8">
      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <button onClick={() => navigate('/')} className="btn-ghost text-xs">← Dashboard</button>
        <span className="text-gray-700">/</span>
        <span className="text-xs font-mono text-gray-500">{id}</span>
      </div>

      {/* Banners */}
      {workItem.isPredicted && (
        <div className="mb-4 p-4 rounded-xl bg-violet-500/10 border border-violet-500/30 text-violet-300 text-sm flex items-start gap-3">
          <span className="text-xl">⚡</span>
          <div>
            <p className="font-semibold">Blast radius prediction</p>
            <p className="text-violet-400/70 text-xs mt-0.5">
              This work item was pre-created automatically - no manual alert triggered this. It may cascade from another incident.
            </p>
          </div>
        </div>
      )}

      {workItem.suggestedRcaId && !workItem.isPredicted && (
        <div className="mb-4 p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-sm flex items-start gap-3">
          <span className="text-xl">🔁</span>
          <div>
            <p className="font-semibold">Previous similar incident detected</p>
            <p className="text-amber-400/70 text-xs mt-1">
              A closed incident with the same error fingerprint exists.{' '}
              <Link to={`/incident/${workItem.suggestedRcaId}`} className="underline hover:text-amber-200 transition-colors">
                View previous incident →
              </Link>
            </p>
          </div>
        </div>
      )}

      {mttrResult !== null && (
        <div className="mb-4 p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-sm flex items-center gap-3">
          <span className="text-xl">✅</span>
          <div>
            <p className="font-semibold">Incident closed successfully</p>
            <p className="text-emerald-400/70 text-xs mt-0.5">
              MTTR: <span className="font-mono font-bold">{formatMttr(mttrResult)}</span>
            </p>
          </div>
        </div>
      )}

      <div className="grid lg:grid-cols-5 gap-6">
        {/* Left panel — metadata + state + RCA */}
        <div className="lg:col-span-2 space-y-5">
          {/* Work item info */}
          <div className="card">
            <div className="flex items-start justify-between mb-5">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <PriorityBadge priority={workItem.priority as any} />
                  <StateBadge state={workItem.state as any} />
                </div>
                <h2 className="text-lg font-bold text-gray-100 font-mono">{workItem.componentId}</h2>
                <p className="text-sm text-gray-500">{workItem.componentType}</p>
              </div>
            </div>

            <dl className="space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-gray-500">Signal count</dt>
                <dd className="font-mono font-semibold text-gray-200">{workItem.signalCount.toLocaleString()}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Started</dt>
                <dd className="text-gray-300 text-xs">{formatTime(workItem.startTime)}</dd>
              </div>
              {workItem.resolvedAt && (
                <div className="flex justify-between">
                  <dt className="text-gray-500">Resolved at</dt>
                  <dd className="text-gray-300 text-xs">{formatTime(workItem.resolvedAt)}</dd>
                </div>
              )}
              {workItem.closedAt && (
                <div className="flex justify-between">
                  <dt className="text-gray-500">Closed at</dt>
                  <dd className="text-gray-300 text-xs">{formatTime(workItem.closedAt)}</dd>
                </div>
              )}
              {workItem.mttrSeconds != null && (
                <div className="flex justify-between">
                  <dt className="text-gray-500">MTTR</dt>
                  <dd className="font-mono font-bold text-indigo-400">{formatMttr(workItem.mttrSeconds)}</dd>
                </div>
              )}
            </dl>
          </div>

          {/* State machine controls */}
          {workItem.state !== 'CLOSED' && (
            <div className="card">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
                State Transitions
              </h3>

              {transitionError && (
                <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
                  {transitionError}
                </div>
              )}

              <div className="space-y-2">
                {(['INVESTIGATING', 'RESOLVED', 'CLOSED'] as const).map(state => {
                  const canDo = availableTransitions.includes(state)
                  const isClosed = state === 'CLOSED'

                  if (isClosed) return null // CLOSED only via RCA form

                  return (
                    <button
                      key={state}
                      onClick={() => canDo && handleTransition(state)}
                      disabled={!canDo || transitioning}
                      title={canDo ? `Transition to ${state}` : `Cannot transition from ${workItem.state} to ${state}`}
                      className={`w-full text-left px-4 py-3 rounded-lg border text-sm font-medium transition-all
                        ${canDo
                          ? state === 'RESOLVED'
                            ? 'btn-success border-emerald-700/40'
                            : 'btn-warning border-amber-700/40'
                          : 'opacity-30 cursor-not-allowed bg-gray-800/30 border-gray-700/30 text-gray-500'
                        }`}
                    >
                      <div className="flex items-center justify-between">
                        <span>→ Mark as {state}</span>
                        {!canDo && <span className="text-xs">Not available</span>}
                        {canDo && transitioning && <div className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />}
                      </div>
                    </button>
                  )
                })}
              </div>

              <p className="text-xs text-gray-600 mt-3">
                Transitions are enforced by the state machine. Invalid transitions are rejected.
              </p>
            </div>
          )}

          {/* RCA form (if RESOLVED) */}
          {workItem.state === 'RESOLVED' && !workItem.rca && (
            <div className="card border-amber-700/30">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-amber-400">📋</span>
                <h3 className="text-sm font-semibold text-amber-300">Root Cause Analysis Required</h3>
              </div>
              <p className="text-xs text-gray-500 mb-5">
                Complete and submit the RCA to close this incident. All fields are mandatory.
              </p>
              {rcaError && (
                <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
                  {rcaError}
                </div>
              )}
              <RcaForm
                workItemId={workItem.id}
                startTime={workItem.startTime}
                onSuccess={handleRcaSuccess}
                onError={setRcaError}
              />
            </div>
          )}

          {/* Show submitted RCA if closed */}
          {workItem.rca && (
            <div className="card border-emerald-700/30">
              <h3 className="text-xs font-semibold text-emerald-400 uppercase tracking-wider mb-4">
                Root Cause Analysis
              </h3>
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="text-gray-500 text-xs mb-1">Category</dt>
                  <dd className="text-gray-200 capitalize">{workItem.rca.rootCauseCategory.replace('_', ' ')}</dd>
                </div>
                <div>
                  <dt className="text-gray-500 text-xs mb-1">Root Cause</dt>
                  <dd className="text-gray-200 text-xs leading-relaxed">{workItem.rca.rootCauseDetail}</dd>
                </div>
                <div>
                  <dt className="text-gray-500 text-xs mb-1">Fix Applied</dt>
                  <dd className="text-gray-200 text-xs leading-relaxed">{workItem.rca.fixApplied}</dd>
                </div>
                <div>
                  <dt className="text-gray-500 text-xs mb-1">Prevention Steps</dt>
                  <dd className="text-gray-200 text-xs leading-relaxed">{workItem.rca.preventionSteps}</dd>
                </div>
                <div>
                  <dt className="text-gray-500 text-xs mb-1">Submitted by</dt>
                  <dd className="text-gray-300">{workItem.rca.submittedBy}</dd>
                </div>
              </dl>
            </div>
          )}
        </div>

        {/* Right panel — signal feed */}
        <div className="lg:col-span-3">
          <div className="card h-full p-0 overflow-hidden flex flex-col">
            <div className="px-5 py-4 border-b border-gray-800/60 flex items-center justify-between">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Signal Feed
              </h3>
              <span className="text-xs text-gray-600">{signals.length} signals (latest 200)</span>
            </div>

            <div className="overflow-y-auto flex-1 divide-y divide-gray-800/40">
              {signals.length === 0 && (
                <div className="flex items-center justify-center py-16 text-gray-600 text-sm">
                  No signals recorded yet
                </div>
              )}
              {signals.map((signal, i) => (
                <div key={signal._id ?? i} className="px-5 py-4 hover:bg-gray-800/20 transition-colors">
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-semibold text-gray-200">
                        {signal.errorCode}
                      </span>
                      <SeverityBadge severity={signal.severity} />
                    </div>
                    <span className="text-xs text-gray-600 whitespace-nowrap">
                      {new Date(signal.ts).toLocaleTimeString()}
                    </span>
                  </div>
                  <PayloadViewer payload={signal.payload} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
