// frontend/src/components/MetricsBar.tsx
// MTTR + throughput numbers

import React from 'react'
import { usePolling } from '../hooks/usePolling'
import { api, MttrMetrics, HealthStatus } from '../api/client'

function formatMttr(seconds: number | null | undefined): string {
  if (seconds == null) return '—'
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${(seconds / 3600).toFixed(1)}h`
}

export default function MetricsBar() {
  const { data: mttr } = usePolling<MttrMetrics>(
    ['metrics', 'mttr'],
    api.getMttrMetrics,
    { refetchInterval: 30000 }
  )

  const { data: health } = usePolling<HealthStatus>(
    ['health'],
    api.getHealth,
    { refetchInterval: 5000 }
  )

  const p0Count = 0 // derived from work items — passed via context or re-queried

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 mb-6">
      <div className="metric-card">
        <span className="metric-label">Weighted MTTR</span>
        <span className="metric-value text-indigo-400">
          {formatMttr(mttr?.weighted_mttr)}
        </span>
        <span className="metric-sub">across all priorities</span>
      </div>

      <div className="metric-card">
        <span className="metric-label">P0 MTTR</span>
        <span className="metric-value text-red-400">
          {formatMttr(mttr?.p0_mttr)}
        </span>
        <span className="metric-sub">critical incidents</span>
      </div>

      <div className="metric-card">
        <span className="metric-label">P1 MTTR</span>
        <span className="metric-value text-amber-400">
          {formatMttr(mttr?.p1_mttr)}
        </span>
        <span className="metric-sub">high priority</span>
      </div>

      <div className="metric-card">
        <span className="metric-label">P2 MTTR</span>
        <span className="metric-value text-gray-300">
          {formatMttr(mttr?.p2_mttr)}
        </span>
        <span className="metric-sub">standard priority</span>
      </div>

      <div className="metric-card">
        <span className="metric-label">Queue Depth</span>
        <span className={`metric-value ${(health?.queueDepth ?? 0) > 10000 ? 'text-red-400' : 'text-emerald-400'}`}>
          {health?.queueDepth?.toLocaleString() ?? '—'}
        </span>
        <span className="metric-sub">signals pending</span>
      </div>

      <div className="metric-card">
        <span className="metric-label">Total Closed</span>
        <span className="metric-value text-gray-300">
          {mttr?.total_closed ? parseInt(String(mttr.total_closed)).toLocaleString() : '0'}
        </span>
        <span className="metric-sub">incidents resolved</span>
      </div>
    </div>
  )
}
