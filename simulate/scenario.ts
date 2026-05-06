// simulate/scenario.ts
// Run with: cd simulate && npx tsx scenario.ts
// Plays out a realistic cascading failure narrative.
// Phase 0: Seeds a closed incident to establish a fingerprint (demonstrates recurrence detection).
// Phase 1: Triggers an identical RDBMS cascade — new incident gets flagged "Recurring — seen before".
// Shows debounce working, blast radius firing, signals suppressed counter climbing.

const API = 'http://localhost:3001'

async function send(signal: object) {
  await fetch(`${API}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(signal)
  })
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

async function simulate() {
  console.log('=== IMS Incident Simulation: RDBMS Cascade ===\n')

  console.log('--- Seeding a past closed incident to demonstrate Fingerprinting ---')
  await send({
    componentId: 'RDBMS_PRIMARY',
    componentType: 'RDBMS',
    errorCode: 'CONNECTION_TIMEOUT',
    payload: { query: 'SELECT', duration_ms: 30000 },
    severity: 'critical'
  })

  console.log('Waiting 6s for debounce window to create the work item...')
  await sleep(6000)

  const res = await fetch(`${API}/work-items`)
  const items = await res.json()
  const rdbmsItem = items.find((i: any) => i.componentId === 'RDBMS_PRIMARY' && i.state !== 'CLOSED')

  if (rdbmsItem) {
    console.log(`Transitioning ${rdbmsItem.id} to RESOLVED...`)
    await fetch(`${API}/work-items/${rdbmsItem.id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'INVESTIGATING' })
    })
    await fetch(`${API}/work-items/${rdbmsItem.id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'RESOLVED' })
    })

    console.log(`Submitting RCA to CLOSE ${rdbmsItem.id}...`)
    await fetch(`${API}/work-items/${rdbmsItem.id}/rca`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rootCauseCategory: 'capacity',
        rootCauseDetail: 'Connection pool exhausted due to sudden traffic spike.',
        fixApplied: 'Increased connection pool size from 100 to 500.',
        preventionSteps: 'Added auto-scaling rules for connection pool.',
        incidentStart: new Date(Date.now() - 3600000).toISOString(),
        incidentEnd: new Date().toISOString()
      })
    })
    console.log('Past incident closed successfully! Fingerprint established.\n')
  }

  // T+0: RDBMS starts throwing connection timeouts
  console.log('T+0s: RDBMS_PRIMARY connection timeouts begin (This will be flagged as Recurring!)...')
  for (let i = 0; i < 10; i++) {
    await send({
      componentId: 'RDBMS_PRIMARY',
      componentType: 'RDBMS',
      errorCode: 'CONNECTION_TIMEOUT',
      payload: { query: 'SELECT', duration_ms: 30000 + i * 100 },
      severity: 'critical'
    })
    await sleep(100)
  }

  await sleep(2000)

  // T+2s: Burst — dependent APIs start failing (cascade begins)
  console.log('T+2s: Cascade - API_GATEWAY starts failing...')
  for (let i = 0; i < 80; i++) {
    await send({
      componentId: 'API_GATEWAY',
      componentType: 'API',
      errorCode: 'UPSTREAM_UNAVAILABLE',
      payload: { upstream: 'RDBMS_PRIMARY', status: 502 },
      severity: 'high'
    })
    await sleep(50)
  }

  await sleep(3000)

  // T+7s: Cache starts getting stale (another cascade)
  console.log('T+7s: CACHE_CLUSTER_01 stale reads...')
  for (let i = 0; i < 40; i++) {
    await send({
      componentId: 'CACHE_CLUSTER_01',
      componentType: 'CACHE',
      errorCode: 'STALE_READ',
      payload: { miss_rate: 0.95 },
      severity: 'medium'
    })
    await sleep(80)
  }

  await sleep(3000)

  // T+15s: MCP Host loses connection
  console.log('T+15s: MCP_HOST_01 disconnected...')
  for (let i = 0; i < 15; i++) {
    await send({
      componentId: 'MCP_HOST_01',
      componentType: 'MCP_HOST',
      errorCode: 'CONNECTION_LOST',
      payload: { tool: 'database_connector', last_ping_ms: 5000 + i * 200 },
      severity: 'high'
    })
    await sleep(200)
  }

  await sleep(3000)

  // T+22s: Signals slow down — engineers are on the incident
  console.log('T+22s: Signal rate dropping - team is investigating...')
  for (let i = 0; i < 5; i++) {
    await send({
      componentId: 'RDBMS_PRIMARY',
      componentType: 'RDBMS',
      errorCode: 'CONNECTION_TIMEOUT',
      payload: { query: 'INSERT', duration_ms: 15000 },
      severity: 'critical'
    })
    await sleep(2000)
  }

  console.log('\n=== Simulation complete ===')
  console.log('Check the dashboard at http://localhost:3000')
  console.log('Expected: ~3-4 work items, suppressed signal counts, blast radius predictions')
}

simulate().catch(console.error)
