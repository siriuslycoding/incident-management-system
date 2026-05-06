// frontend/src/components/Dashboard.tsx
// Live incident feed — polls GET /work-items every 5 seconds via React Query

import React from 'react'
import { useNavigate } from 'react-router-dom'
import { usePolling } from '../hooks/usePolling'
import { api, WorkItem } from '../api/client'
import { PriorityBadge, StateBadge } from './StatusBadge'
import MetricsBar from './MetricsBar'

function formatTime(ts: string): string {
  const d = new Date(ts)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH}h ago`
  return d.toLocaleDateString()
}

function rowClass(priority: string): string {
  return { P0: 'p0-row', P1: 'p1-row', P2: 'p2-row' }[priority] ?? 'p2-row'
}

export default function Dashboard() {
  const navigate = useNavigate()
  const { data: workItems, isLoading, isError, lastUpdated, isLive } =
    usePolling<WorkItem[]>(['work-items'], api.getWorkItems)

  const openP0 = workItems?.filter(w => w.priority === 'P0' && w.state !== 'CLOSED').length ?? 0

  return (
    <div className="min-h-screen bg-gray-950 p-4 lg:p-8">
      {/* Header */}
      <header className="mb-8">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-100 tracking-tight">
              <span className="text-indigo-400">IMS</span> - Incident Management
            </h1>
            <p className="text-gray-500 text-sm mt-1">
              Live incident feed · State machine enforcement · RCA required for closure
            </p>
          </div>
          <div className="flex items-center gap-3">
            {openP0 > 0 && (
              <span className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-red-500/20 border border-red-500/30 text-red-300 text-sm font-medium animate-pulse">
                <span className="w-2 h-2 bg-red-400 rounded-full"></span>
                {openP0} P0 ACTIVE
              </span>
            )}
            <span className="flex items-center gap-2 text-sm text-gray-500">
              <span className={isLive ? 'live-dot' : 'paused-dot'}></span>
              {isLive ? 'Live' : 'Paused'}
              {lastUpdated && (
                <span className="text-gray-600 text-xs">· {lastUpdated.toLocaleTimeString()}</span>
              )}
            </span>
          </div>
        </div>
      </header>

      {/* Metrics Bar */}
      <MetricsBar />

      {/* Work Items Table */}
      <div className="card overflow-hidden p-0">
        <div className="px-5 py-4 border-b border-gray-800/60 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
            Active Incidents
          </h2>
          <span className="text-xs text-gray-600">
            {workItems?.length ?? 0} items · sorted by severity
          </span>
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-20 text-gray-500">
            <div className="flex flex-col items-center gap-3">
              <div className="w-8 h-8 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin"></div>
              <span className="text-sm">Loading incidents...</span>
            </div>
          </div>
        )}

        {isError && (
          <div className="flex items-center justify-center py-20">
            <div className="text-center">
              <p className="text-red-400 font-medium">Unable to reach API</p>
              <p className="text-gray-600 text-sm mt-1">Check that the backend is running on port 3001</p>
            </div>
          </div>
        )}

        {!isLoading && !isError && workItems?.length === 0 && (
          <div className="flex items-center justify-center py-20">
            <div className="text-center">
              <p className="text-5xl mb-4">✅</p>
              <p className="text-gray-400 font-medium">No active incidents</p>
              <p className="text-gray-600 text-sm mt-1">All clear - run the simulation script to generate incidents</p>
            </div>
          </div>
        )}

        {workItems && workItems.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800/60">
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Priority</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Component</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">State</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Signals</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Flags</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Created</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/40">
                {workItems.map((item) => (
                  <tr
                    key={item.id}
                    className={`${rowClass(item.priority)} hover:bg-gray-800/30 transition-colors cursor-pointer group`}
                    onClick={() => navigate(`/incident/${item.id}`)}
                  >
                    <td className="px-4 py-3.5">
                      <PriorityBadge priority={item.priority as any} />
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex flex-col">
                        <span className="font-mono text-xs font-medium text-gray-200">{item.componentId}</span>
                        <span className="text-xs text-gray-600 mt-0.5">{item.componentType}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      <StateBadge state={item.state as any} />
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex flex-col">
                        <span className="font-mono font-semibold text-gray-200">{item.signalCount.toLocaleString()}</span>
                        {item.signalCount > 1 && (
                          <span className="text-xs text-gray-600">{item.signalCount - 1} suppressed</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex flex-col gap-1">
                        {item.isPredicted && (
                          <span className="inline-flex items-center gap-1 text-xs text-violet-400">
                            <span>⚡</span> Predicted cascade
                          </span>
                        )}
                        {item.suggestedRcaId && !item.isPredicted && (
                          <span className="inline-flex items-center gap-1 text-xs text-amber-400">
                            <span>🔁</span> Recurring - seen before
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-xs text-gray-500">
                      {formatTime(item.createdAt)}
                    </td>
                    <td className="px-4 py-3.5">
                      <button
                        className="btn-ghost text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={(e) => { e.stopPropagation(); navigate(`/incident/${item.id}`) }}
                      >
                        View →
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
