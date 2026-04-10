# CLAUDE.md

Context and conventions for AI assistants working on the Optio codebase.

## What is Optio?

Optio is a workflow orchestration system for AI coding agents. Think of it as "CI/CD where the build step is an AI agent." Users submit tasks (manually or from GitHub Issues, Linear, Jira, or Notion), and Optio:

1. Spins up an isolated Kubernetes pod for the repository (pod-per-repo)
2. Creates a git worktree for the task (multiple tasks can run concurrently per repo)
3. Runs Claude Code, OpenAI Codex, or GitHub Copilot with a configurable prompt
4. Streams structured logs back to a web UI in real time
5. Agent stops after opening a PR (no CI blocking)
6. PR watcher tracks CI checks, review status, and merge state
7. Auto-triggers code review agent on CI pass or PR open (if enabled)
8. Auto-resumes agent when reviewer requests changes (if enabled)
9. Auto-completes on merge, auto-fails on close

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────────┐
│   Web UI    │────→│  API Server  │────→│   K8s Pods          │
│  Next.js    │     │   Fastify    │     │                     │
│  :30310     │     │   :30400     │     │  ┌─ Repo Pod A ──┐  │
│             │←ws──│              │     │  │ clone + sleep  │  │
│             │     │ - BullMQ     │     │  │ ├─ worktree 1  │  │
│             │     │ - Drizzle    │     │  │ ├─ worktree 2  │  │
│             │     │ - WebSocket  │     │  │ └─ worktree N  │  │
│             │     │ - PR Watcher │     │  └────────────────┘  │
│             │     │ - Health Mon │     │                       │
└─────────────┘     └──────┬───────┘     └───────────────────────┘
                           │
                    ┌──────┴───────┐
                    │  Postgres    │  State, logs, secrets, config, health events
                    │  Redis       │  Job queue, pub/sub
                    └──────────────┘

All services run in Kubernetes (including API and web). Local dev uses
Docker Desktop K8s with Helm. See setup-local.sh.
```

### Pod-per-repo with worktrees

Central optimization. Instead of one pod per task (slow, wasteful), one long-lived pod per repository:

- Pod clones repo once, runs `sleep infinity`. Tasks `exec` in: `git worktree add` → run agent → cleanup
- Multiple tasks run concurrently per pod (one per worktree)
- Pods use persistent volumes; idle for 10 min (`OPTIO_REPO_POD_IDLE_MS`) before cleanup
- Entrypoints: `scripts/repo-init.sh` (pod), `scripts/agent-entrypoint.sh` (legacy)

**Multi-pod scaling**: repos can have multiple pod instances for higher throughput.

- `maxPodInstances` (default 1, max 20) — pod replicas per repo
- `maxAgentsPerPod` (default 2, max 50) — concurrent agents per pod
- Total capacity = `maxPodInstances × maxAgentsPerPod`
- Pod scheduling: same-pod retry affinity → least-loaded → dynamic scale-up → queue overflow
- LIFO scaling: higher-index pods removed first on idle cleanup

### Worktree lifecycle

Tasks track worktree state via `tasks.worktreeState`: `active`, `dirty`, `reset`, `preserved`, `removed`. `tasks.lastPodId` enables same-pod retry affinity. See `repo-cleanup-worker` for cleanup rules.

### Task lifecycle (state machine)

```
pending → queued → provisioning → running → pr_opened → completed
                                    ↓  ↑        ↓  ↑
                               needs_attention   needs_attention
                                    ↓                ↓
                                 cancelled         cancelled
                               running → failed → queued (retry)
```

State machine in `packages/shared/src/utils/state-machine.ts`. All transitions validated — invalid ones throw `InvalidTransitionError`. Always use `taskService.transitionTask()`.

### Priority queue and concurrency

Tasks have integer `priority` (lower = higher). Two concurrency limits:

1. **Global**: `OPTIO_MAX_CONCURRENT` (default 5) — total running/provisioning tasks
2. **Per-repo**: `repos.maxConcurrentTasks` (default 2) — effective limit is `max(maxConcurrentTasks, maxPodInstances × maxAgentsPerPod)`

When a limit is hit, task is re-queued with 10s delay.

### Authentication

**Web UI**: Multi-provider OAuth (GitHub, Google, GitLab). Enable by setting `<PROVIDER>_OAUTH_CLIENT_ID` + `<PROVIDER>_OAUTH_CLIENT_SECRET`. Sessions use SHA256-hashed tokens (30-day TTL). Local dev bypass: `OPTIO_AUTH_DISABLED=true`.

**Claude Code** (three modes, selected in setup wizard):

- **API Key**: `ANTHROPIC_API_KEY` env var injected into agent pods
- **OAuth Token** (recommended for k8s): `CLAUDE_CODE_OAUTH_TOKEN` encrypted secret injected into pods
- **Max Subscription** (legacy, local dev only): reads from host macOS Keychain

### Key subsystems

These are well-documented in code; read the relevant service files for details:

- **PR watcher** (`pr-watcher-worker.ts`): polls PRs every 30s, tracks CI/review, triggers reviews, auto-resumes, handles merge/close
- **Code review agent** (`review-service.ts`): launches review as blocking subtask, uses `repos.reviewModel` (defaults to sonnet)
- **Subtask system**: three types (child, step, review) via `parentTaskId`, with `blocksParent` for synchronization
- **Prompt templates**: `{{VARIABLE}}` + `{{#if VAR}}...{{/if}}` syntax. Priority: repo override → global default → hardcoded fallback
- **Shared cache directories**: per-repo persistent PVCs for tool caches (npm, pip, cargo, etc.), managed via `/api/repos/:id/shared-directories`
- **Interactive sessions**: persistent workspaces with terminal + agent chat, at `/sessions`
- **Workspaces**: multi-tenancy via `workspaceId` column. Roles (admin/member/viewer) in schema but not fully enforced
- **Task dependencies & workflows**: `task_dependencies` table + `workflow_templates`/`workflow_runs` for multi-step pipelines
- **Cost tracking**: `GET /api/analytics/costs` with daily/repo/type breakdowns, UI at `/costs`
- **Error classification**: `packages/shared/src/error-classifier.ts` pattern-matches errors into categories with remedies

## Tech Stack

| Layer      | Technology                       | Notes                                                                          |
| ---------- | -------------------------------- | ------------------------------------------------------------------------------ |
| Monorepo   | Turborepo + pnpm 10              | 6 packages, workspace protocol                                                 |
| API        | Fastify 5                        | Plugins, schema validation, WebSocket                                          |
| ORM        | Drizzle                          | PostgreSQL, migrations in `apps/api/src/db/migrations/`                        |
| Queue      | BullMQ + Redis                   | Also used for pub/sub (log streaming to WebSocket clients)                     |
| Web        | Next.js 15 App Router            | Tailwind CSS v4, Zustand, Lucide icons, sonner toasts, Recharts                |
| K8s client | @kubernetes/client-node          | Pod lifecycle, exec, log streaming, metrics                                    |
| Validation | Zod                              | API request schemas                                                            |
| Testing    | Vitest                           | Test files across shared + api                                                 |
| CI         | GitHub Actions                   | Format, typecheck, test, build-web, build-image                                |
| Deploy     | Helm                             | Chart at `helm/optio/`, local dev via `setup-local.sh`                         |
| Hooks      | Husky + lint-staged + commitlint | Pre-commit: lint-staged + format + typecheck. Commit-msg: conventional commits |

## Commands

```bash
# Setup (first time — builds everything, deploys to local k8s via Helm)
./scripts/setup-local.sh

# Update (pull + rebuild + redeploy)
./scripts/update-local.sh

# Manual rebuild + redeploy
docker build -t optio-api:latest -f Dockerfile.api .
docker build -t optio-web:latest -f Dockerfile.web .
kubectl rollout restart deployment/optio-api deployment/optio-web -n optio

# Quality (these are what CI runs, and pre-commit hooks mirror them)
pnpm format:check                     # Check formatting (Prettier)
pnpm turbo typecheck                  # Typecheck all 6 packages
pnpm turbo test                       # Run tests (Vitest)
cd apps/web && npx next build         # Verify production build

# Database
cd apps/api && npx drizzle-kit generate  # Generate migration after schema change
cd apps/api && npx tsx src/db/migrate.ts  # Apply migrations (standalone runner)
bash scripts/check-migration-prefixes.sh  # Check for duplicate prefixes

# Agent images
./images/build.sh                     # Build all presets (base, node, python, go, rust, full)

# Helm
helm lint helm/optio --set encryption.key=test
helm upgrade optio helm/optio -n optio --reuse-values

# Teardown
helm uninstall optio -n optio
```

## Conventions

- **ESM everywhere**: all packages use `"type": "module"` with `.js` extensions in imports (TypeScript resolves them to `.ts`)
- **Conventional commits**: enforced by commitlint (e.g., `feat:`, `fix:`, `refactor:`)
- **Pre-commit hooks**: lint-staged (eslint + prettier), then `pnpm format:check` and `pnpm turbo typecheck`
- **Tailwind CSS v4**: `@import "tailwindcss"` + `@theme` block in CSS, no `tailwind.config` file
- **Drizzle ORM**: schema in `apps/api/src/db/schema.ts`, run `drizzle-kit generate` after changes. **New migrations use unix-timestamp prefixes** (`migrations.prefix: "unix"` in `drizzle.config.ts`). Existing `00xx_*` files are frozen — never rename them
- **Zustand**: use `useStore.getState()` in callbacks/effects, not hook selectors (avoids infinite re-renders)
- **Next.js webpack**: `extensionAlias` in `next.config.ts` resolves `.js` → `.ts` for workspace packages
- **State transitions**: always go through `taskService.transitionTask()` — validates, updates DB, records event, publishes WebSocket
- **Secrets**: never log or return secret values. Encrypted at rest with AES-256-GCM
- **Cost tracking**: stored as string (`costUsd`) to avoid float precision issues
- **K8s RBAC**: namespace-scoped Role (pods, exec, secrets, PVCs) + ClusterRole (nodes, namespaces, metrics)

## Helm Chart

Key `values.yaml` settings:

- Image defaults point to GHCR (`ghcr.io/jonwiggins/optio-*`). Set `agent.image.prefix` to `optio-` for local dev
- `postgresql.enabled` / `redis.enabled` — set to `false` and use `externalDatabase.url` / `externalRedis.url` for managed services
- `encryption.key` — **required**, generate with `openssl rand -hex 32`
- Local dev overrides in `helm/optio/values.local.yaml` (`setup-local.sh` applies automatically)

## Troubleshooting

**Pod won't start**: check `kubectl get pods -n optio`, verify agent image exists (`docker images | grep optio-agent`), check `OPTIO_IMAGE_PULL_POLICY=Never` for local images.

**Auth errors**: verify `CLAUDE_AUTH_MODE` secret, check `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` exists, check `GET /api/auth/status`.

**Tasks stuck in `queued`**: check concurrency limits (`OPTIO_MAX_CONCURRENT`, per-repo `maxConcurrentTasks`), look for stuck provisioning/running tasks.

**WebSocket drops**: ensure Redis is running, check `REDIS_URL` and `INTERNAL_API_URL` config.

**Pod OOM/crash**: check `pod_health_events`, increase resource limits. Cleanup worker auto-detects and fails associated tasks.

**OAuth login fails**: verify `PUBLIC_URL` matches deployment URL, check provider callback URLs are registered.

**Migration errors**: migrations auto-run on startup. Historical duplicate prefixes (0016, 0018, 0019, 0026, 0039, 0042) are allowlisted. New migrations use unix-timestamp prefixes.

## Production Deployment Checklist

1. Generate encryption key: `openssl rand -hex 32`
2. Configure at least one OAuth provider (`*_CLIENT_ID` + `*_CLIENT_SECRET`)
3. Ensure `OPTIO_AUTH_DISABLED` is NOT set
4. Use managed PostgreSQL/Redis (`externalDatabase.url`, `externalRedis.url`)
5. Set `PUBLIC_URL` to actual deployment URL
6. Enable ingress with TLS
7. Set `GITHUB_TOKEN` secret for PR watching, issue sync, repo detection
8. Install `metrics-server` in cluster

## Known Issues

- Workspace RBAC roles are in schema but not fully enforced in all routes
- API container runs via `tsx` rather than compiled JS (workspace packages export `./src/index.ts`)
- OAuth tokens from `claude setup-token` have limited scopes vs Keychain-extracted tokens
