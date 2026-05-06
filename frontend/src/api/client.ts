// frontend/src/api/client.ts
// All API calls, typed

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001'

export interface WorkItem {
  id: string
  componentId: string
  componentType: string
  priority: 'P0' | 'P1' | 'P2'
  state: 'OPEN' | 'INVESTIGATING' | 'RESOLVED' | 'CLOSED'
  fingerprint: string | null
  suggestedRcaId: string | null
  isPredicted: boolean
  signalCount: number
  startTime: string
  resolvedAt: string | null
  closedAt: string | null
  mttrSeconds: number | null
  createdAt: string
  updatedAt: string
  rca?: Rca | null
}

export interface Rca {
  id: string
  workItemId: string
  rootCauseCategory: string
  rootCauseDetail: string
  fixApplied: string
  preventionSteps: string
  incidentStart: string
  incidentEnd: string
  submittedBy: string
  createdAt: string
}

export interface Signal {
  _id: string
  workItemId: string
  componentId: string
  componentType: string
  errorCode: string
  payload: Record<string, unknown>
  severity: string
  ts: string
  processed: boolean
  walOffset: number
}

export interface MttrMetrics {
  p0_mttr: number | null
  p1_mttr: number | null
  p2_mttr: number | null
  overall_mttr: number | null
  weighted_mttr: number | null
  total_closed: string
}

export interface HealthStatus {
  status: 'healthy' | 'degraded'
  uptime: number
  queueDepth: number
  queueCapacity: string
  services: { postgres: boolean; redis: boolean; mongodb: boolean }
}

export interface RcaSubmission {
  rootCauseCategory: string
  rootCauseDetail: string
  fixApplied: string
  preventionSteps: string
  incidentStart: string
  incidentEnd: string
  submittedBy?: string
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  })
  const data = await res.json()
  if (!res.ok) throw Object.assign(new Error(data.message || data.error || 'API error'), { data, status: res.status })
  return data as T
}

export const api = {
  getWorkItems: () => apiFetch<WorkItem[]>('/work-items'),

  getWorkItem: (id: string) =>
    apiFetch<{ workItem: WorkItem; signals: Signal[] }>(`/work-items/${id}`),

  updateStatus: (id: string, state: string) =>
    apiFetch<WorkItem>(`/work-items/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ state })
    }),

  submitRca: (id: string, body: RcaSubmission) =>
    apiFetch<WorkItem>(`/work-items/${id}/rca`, {
      method: 'POST',
      body: JSON.stringify(body)
    }),

  getMttrMetrics: () => apiFetch<MttrMetrics>('/work-items/metrics/mttr'),

  getHealth: () => apiFetch<HealthStatus>('/health'),

  ingest: (signal: object) =>
    apiFetch<{ status: string; queueDepth: number }>('/ingest', {
      method: 'POST',
      body: JSON.stringify(signal)
    })
}
