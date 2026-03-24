# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-03-24

### Added

- **Pod-per-repo architecture** — long-lived Kubernetes pods with git worktrees for concurrent task execution per repository
- **Task orchestration** — full task lifecycle with state machine (pending, queued, provisioning, running, pr_opened, completed, failed, cancelled, needs_attention)
- **Priority queue with concurrency limits** — global and per-repo concurrency controls, priority-based scheduling, and task reordering
- **Subtask system** — child, step, and review subtask types with parent blocking and completion tracking
- **Code review agent** — automatic PR review as a blocking subtask, configurable triggers (on CI pass or PR open), and dedicated review prompts
- **PR watcher** — polls GitHub PRs for CI status, review status, merge/close events; auto-completes on merge, auto-fails on close
- **Auto-resume on review** — re-queues tasks with reviewer comments when changes are requested
- **Auto-resume on CI failure and merge conflicts** — detects failures and re-queues the agent to fix them
- **Auto-merge** — merges PRs automatically when CI passes and reviews are approved
- **Auto-close linked GitHub issues** — closes the originating GitHub issue when a task completes
- **GitHub Issues integration** — browse issues across repos, one-click assign to create tasks, bulk assign all
- **Linear ticket provider** — sync tasks from Linear projects
- **Structured log streaming** — real-time NDJSON parsing of Claude Code output with typed log entries (text, tool_use, tool_result, thinking, system, error, info)
- **WebSocket event streaming** — live task state and log updates pushed to the web UI via Redis pub/sub
- **Web UI** — Next.js 15 app with task list, task detail with log viewer, repo management, cluster health, secrets management, and setup wizard
- **Cluster health dashboard** — expandable resource usage graphs, pod health monitoring, and stale task detection
- **Pod health monitoring** — automatic detection of crashed/OOM-killed pods, auto-restart, orphan worktree cleanup, and idle pod cleanup
- **Secrets management** — AES-256-GCM encrypted secrets with global and repo-scoped support
- **Prompt templates** — configurable system prompts with template variables and conditional blocks; per-repo overrides
- **Per-repo agent settings** — configurable Claude model, context window, thinking mode, effort level, and max turns
- **Auto-detect image preset** — detects project language (Node, Python, Go, Rust) from repo files and selects the appropriate container image
- **Agent adapters** — pluggable adapter interface with Claude Code and OpenAI Codex implementations
- **Container runtimes** — Docker and Kubernetes runtime backends
- **Authentication** — API key and Max Subscription (OAuth) modes for Claude Code
- **Error classification** — pattern-matching error classifier with human-readable titles, descriptions, and remediation suggestions
- **Helm chart** — full Kubernetes deployment with configurable Postgres, Redis, ingress, RBAC, and secrets
- **Pre-commit hooks** — Husky with lint-staged, Prettier formatting, ESLint, typecheck, and conventional commit enforcement
- **CI pipeline** — GitHub Actions for format checking, typechecking, testing, web build, and Docker image build
