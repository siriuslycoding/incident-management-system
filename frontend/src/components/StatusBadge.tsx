// frontend/src/components/StatusBadge.tsx
// Reusable severity/state badge

import React from 'react'

interface PriorityBadgeProps {
  priority: 'P0' | 'P1' | 'P2'
}

export function PriorityBadge({ priority }: PriorityBadgeProps) {
  const cls = {
    P0: 'badge-p0',
    P1: 'badge-p1',
    P2: 'badge-p2'
  }[priority]

  return <span className={cls}>{priority}</span>
}

interface StateBadgeProps {
  state: 'OPEN' | 'INVESTIGATING' | 'RESOLVED' | 'CLOSED'
}

export function StateBadge({ state }: StateBadgeProps) {
  const cls = {
    OPEN: 'state-open',
    INVESTIGATING: 'state-investigating',
    RESOLVED: 'state-resolved',
    CLOSED: 'state-closed'
  }[state]

  const dot = {
    OPEN: '●',
    INVESTIGATING: '◐',
    RESOLVED: '◑',
    CLOSED: '○'
  }[state]

  return (
    <span className={cls}>
      <span className="mr-1 text-[10px]">{dot}</span>
      {state}
    </span>
  )
}

interface SeverityBadgeProps {
  severity: string
}

export function SeverityBadge({ severity }: SeverityBadgeProps) {
  const cls = {
    critical: 'badge bg-red-500/20 text-red-300 ring-1 ring-red-500/30',
    high: 'badge bg-orange-500/20 text-orange-300 ring-1 ring-orange-500/30',
    medium: 'badge bg-yellow-500/20 text-yellow-300 ring-1 ring-yellow-500/30',
    low: 'badge bg-gray-500/20 text-gray-400 ring-1 ring-gray-500/30'
  }[severity] ?? 'badge bg-gray-500/20 text-gray-400'

  return <span className={cls}>{severity}</span>
}
