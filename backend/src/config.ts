// backend/src/config.ts
export const config = {
  port: parseInt(process.env.PORT || '3001'),
  databaseUrl: process.env.DATABASE_URL!,
  mongoUrl: process.env.MONGO_URL!,
  redisUrl: process.env.REDIS_URL!,
  queueMaxSize: parseInt(process.env.QUEUE_MAX_SIZE || '50000'),
  walPath: process.env.WAL_PATH || './wal/signals.log',

  // Per-component debounce windows in seconds
  // Configurable so adding a new component type requires no code change
  debounceWindows: {
    RDBMS: 5,
    CACHE: 15,
    MCP_HOST: 10,
    API: 8,
    QUEUE: 12,
    NOSQL: 10,
    DEFAULT: 10
  } as Record<string, number>,

  // Dependency graph for blast radius inference
  // key = component that failed, value = components that may cascade
  dependencyGraph: {
    RDBMS_PRIMARY: ['API_GATEWAY', 'CACHE_CLUSTER_01', 'MCP_HOST_01'],
    CACHE_CLUSTER_01: ['API_GATEWAY'],
    MCP_HOST_01: ['API_GATEWAY'],
    API_GATEWAY: [],
    ASYNC_QUEUE_01: ['API_GATEWAY', 'MCP_HOST_01']
  } as Record<string, string[]>,

  // Alert strategy priority per component type
  componentPriority: {
    RDBMS: 'P0',
    MCP_HOST: 'P1',
    API: 'P1',
    CACHE: 'P2',
    QUEUE: 'P2',
    NOSQL: 'P2'
  } as Record<string, string>,

  rateLimitMax: 500,         // requests per second per IP
  rateLimitWindow: 1000,     // ms
  metricsIntervalMs: 5000,   // print throughput every 5s
  cacheOutboxPollMs: 200,    // how often outbox worker runs
  retryAttempts: 3,
  retryBaseDelayMs: 100
}
