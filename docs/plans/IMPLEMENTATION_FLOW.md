# Claude Swarm Implementation Flow

## Overview

This document outlines the top-level implementation flow for Claude Swarm based on the architecture specification in `docs/info/ARCHITECTURE.md`. Each step has a corresponding detailed plan in `docs/plans/steps/`.

## Implementation Order

The implementation follows a bottom-up approach, building foundational components first before the orchestration layer.

---

## Step 1: Project Scaffolding & Configuration

**Goal:** Initialize the project with proper structure, configuration files, and type definitions.

**Deliverables:**
- `package.json` with scripts
- `tsconfig.json` configured for Bun
- `.gitignore` with proper exclusions
- `src/types.ts` with all shared TypeScript types
- Directory structure as specified

**Detailed Plan:** `docs/plans/steps/01-project-scaffolding.md`

---

## Step 2: Database Layer (SQLite)

**Goal:** Create the persistent storage layer using bun:sqlite.

**Deliverables:**
- `src/db.ts` - SQLite wrapper with schema initialization
- Tables: findings, artifacts, tasks, messages, decisions
- CRUD operations for each table
- Session isolation via session_id

**Detailed Plan:** `docs/plans/steps/02-database-layer.md`

---

## Step 3: Message Bus (File-Based IPC)

**Goal:** Implement file-based inter-agent communication.

**Deliverables:**
- `src/message-bus.ts` - Message routing logic
- Inbox/outbox management per agent
- Message format validation
- Polling utilities

**Detailed Plan:** `docs/plans/steps/03-message-bus.md`

---

## Step 4: Tmux Manager

**Goal:** Wrap tmux operations for session and pane management.

**Deliverables:**
- `src/tmux-manager.ts` - Session/pane lifecycle
- Functions: createSession, createPane, sendKeys, capturePane, killSession
- Error handling for tmux failures
- Session listing and discovery

**Detailed Plan:** `docs/plans/steps/04-tmux-manager.md`

---

## Step 5: Worktree Manager

**Goal:** Manage git worktrees for agent isolation.

**Deliverables:**
- `src/worktree-manager.ts` - Worktree lifecycle
- Functions: createWorktree, removeWorktree, copyRoleConfig
- Branch naming conventions
- Cleanup utilities

**Detailed Plan:** `docs/plans/steps/05-worktree-manager.md`

---

## Step 6: Agent Role Configurations

**Goal:** Create CLAUDE.md persona files for each agent role.

**Deliverables:**
- `roles/researcher/CLAUDE.md`
- `roles/developer/CLAUDE.md`
- `roles/reviewer/CLAUDE.md`
- `roles/architect/CLAUDE.md`

**Detailed Plan:** `docs/plans/steps/06-agent-roles.md`

---

## Step 7: Workflow Templates

**Goal:** Define multi-stage workflow configurations.

**Deliverables:**
- `src/workflows/research.ts` - Research with verification
- `src/workflows/development.ts` - Code with review cycle
- `src/workflows/architecture.ts` - Design evaluation
- Workflow interface and routing logic

**Detailed Plan:** `docs/plans/steps/07-workflow-templates.md`

---

## Step 8: Orchestrator

**Goal:** Implement the central coordination logic.

**Deliverables:**
- `src/orchestrator.ts` - Main Orchestrator class
- Agent spawning and lifecycle management
- Message routing between agents
- Progress monitoring and completion detection
- Result synthesis

**Detailed Plan:** `docs/plans/steps/08-orchestrator.md`

---

## Step 9: CLI Interface

**Goal:** Create the user-facing command-line interface.

**Deliverables:**
- `swarm.ts` - CLI entry point
- Commands: start, attach, status, logs, stop, kill, clean
- Help text and usage documentation
- Error handling and user feedback

**Detailed Plan:** `docs/plans/steps/09-cli-interface.md`

---

## Step 10: Error Handling & Recovery

**Goal:** Implement robust error handling and graceful degradation.

**Deliverables:**
- Retry logic with exponential backoff
- Failure mode handling (timeout, rate limit, invalid output)
- Graceful degradation strategies
- Session state persistence for recovery

**Detailed Plan:** `docs/plans/steps/10-error-handling.md`

---

## Dependency Graph

```
Step 1 (Scaffolding)
    │
    ├──────────────────────────────────────┐
    ▼                                      ▼
Step 2 (Database)                   Step 6 (Agent Roles)
    │                                      │
    ▼                                      │
Step 3 (Message Bus)                       │
    │                                      │
    ├──────────────────────────────────────┤
    ▼                                      │
Step 4 (Tmux Manager)                      │
    │                                      │
    ▼                                      │
Step 5 (Worktree Manager)                  │
    │                                      │
    ├──────────────────────────────────────┘
    ▼
Step 7 (Workflows)
    │
    ▼
Step 8 (Orchestrator)
    │
    ▼
Step 9 (CLI)
    │
    ▼
Step 10 (Error Handling)
```

## Notes

- Steps 1-5 and Step 6 can be developed in parallel
- Each step should have working tests before proceeding
- Step 8 (Orchestrator) is the integration point where all components come together
- Step 10 should be applied retroactively to all components
