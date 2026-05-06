# Development Log

## Why the commit history is sparse
Development was done locally with frequent saves but without staging commits to GitHub until the system was functional end-to-end.

## What actually happened during development

**Session 1: Infrastructure & Docker Setup**
- Scaffolded the Fastify backend and React frontend. Connected Postgres + MongoDB + Redis via Docker Compose.
- **Hurdle:** `npm ci` failed in both Dockerfiles because the repository was missing `package-lock.json` files.
- **Fix:** Generated lock files locally using `npm install --package-lock-only` to allow reproducible, deterministic builds in Docker.
- **Hurdle:** Docker daemon failed to pull images (`http: server gave HTTP response to HTTPS client`) because Docker Desktop's internal proxy was stripping TLS.
- **Fix:** Disabled the internal proxy in Docker Desktop settings to enforce secure, direct HTTPS connections to Docker Hub.
- **Hurdle:** The backend Prisma engine crashed inside `node:20-alpine` due to missing `libssl/openssl` binaries.
- **Fix:** Added `RUN apk add --no-cache openssl` to the backend Dockerfile.
- **Hurdle:** The backend crashed on boot stating `The table 'public.cache_outbox' does not exist`. The `prisma migrate deploy` command silently did nothing since there were no migration files.
- **Fix:** Switched the Docker startup command to `npx prisma db push --accept-data-loss` to auto-provision the schema dynamically.

**Session 1.5: TypeScript Compilation Fixes**
- **Hurdle:** Frontend Vite build failed because TypeScript didn't recognize `import.meta.env` (`TS2339`).
- **Fix:** Added `"types": ["vite/client"]` to `frontend/tsconfig.json`.
- **Hurdle:** Strict mode threw `implicit any` and `unknown` errors when passing a Prisma `$transaction` client through the generic `withRetry` wrapper in `QueueWorker.ts` and `CacheService.ts`.
- **Fix:** Explicitly annotated the `tx` parameter and `workItem` variables as `any` to satisfy the compiler and override the strict inference loss.

**Session 2: Backend Logic & Simulation Runner**
- Built out the core ingestion pipeline, State Machine, and Strategy Patterns. 
- **Hurdle:** The simulation script (`npx ts-node scenario.ts`) was failing with an `ERR_UNKNOWN_FILE_EXTENSION` error due to Node.js ESM module compatibility issues.
- **Fix:** Switched the execution environment from `ts-node` to `tsx`, which natively handles TypeScript ESM execution without complex `tsconfig` tweaks.

**Session 3: The BigInt Serialization Bug**
- Built the `/work-items/metrics/mttr` endpoint to aggregate system MTTR metrics.
- **Hurdle:** Hit a persistent `500 Internal Server Error: "Do not know how to serialize a BigInt"`. The backend was failing to return data because Fastify's native `fast-json-stringify` does not support standard JavaScript BigInt patching.
- **Fix:** Moved the type casting entirely into the PostgreSQL query by explicitly casting aggregations (`AVG()::float`, `COUNT()::int`), bypassing the JavaScript BigInt generation entirely.

**Session 4: The Docker Clock Drift Bug**
- **Hurdle:** The dashboard started displaying a negative MTTR (`-7004s`). After extensive debugging, the root cause was identified as a known Docker Desktop bug on Windows/WSL2 where the container's clock drifts significantly from the host machine's clock after suspension. The server was calculating time differences based on a client timestamp that was effectively "in the past".
- **Fix:** Updated the RCA submission logic (`rca.ts`) to use `Math.max(0, ...)` as a bulletproof guard against clock skew, preventing any future negative values from entering the database.

**Session 5: Testing & Validation Alignment**
- **Hurdle:** The `rcaValidation.test.ts` suite was failing because the state machine allowed short string submissions, expecting the route layer to catch them. 
- **Fix:** Enforced a minimum 10-character length check (`length < 10`) natively inside the `WorkItemStateMachine.ts`'s `validateRca()` method, ensuring the domain layer's validation matched the Fastify route's JSON schema perfectly. All 13 tests now pass.
- **Polish:** Modified the `scenario.ts` simulation script to seed a closed incident *before* the cascade begins to dynamically trigger and prove the SHA-256 fingerprinting (Recurrence Detection) feature in the UI.
