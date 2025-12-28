# Step 1: Project Scaffolding & Configuration

## Overview & Purpose

### What This Component Does
Project scaffolding establishes the foundational structure for Claude Swarm. It creates the directory layout, configuration files, and shared type definitions that all other components depend on. This is the first step in implementation and must be completed before any other work begins.

### How It Fits Into the System
- Provides the directory structure that tmux-manager, worktree-manager, message-bus, and orchestrator all rely on
- Defines TypeScript types that create contracts between all modules
- Establishes configuration standards (Bun runtime, ES modules, strict TypeScript)
- Creates runtime directories (`.swarm/`) that hold session state

### Problems It Solves
- Ensures consistent project structure across development
- Provides type safety through shared interfaces
- Establishes the `.swarm/` runtime directory pattern used for isolation
- Sets up the toolchain (Bun, TypeScript) that all modules use

---

## Prerequisites & Dependencies

### System Prerequisites
Verify before starting:

| Tool | Minimum Version | Verification Command | Purpose |
|------|-----------------|---------------------|---------|
| Bun | 1.0+ | `bun --version` | Runtime, native TypeScript, SQLite |
| tmux | 2.0+ | `tmux -V` | Session management (used later) |
| git | 2.20+ | `git --version` | Worktrees feature |
| Claude Code CLI | Any | `claude --version` | The agents themselves |

### External Dependencies
**None at runtime.** Bun provides all runtime capabilities natively:
- TypeScript transpilation
- SQLite via `bun:sqlite`
- Shell execution via `Bun.$`
- File I/O via Node-compatible APIs

### Dev Dependencies
| Package | Purpose |
|---------|---------|
| `bun-types` | TypeScript definitions for Bun APIs |
| `typescript` | Type checking only (Bun transpiles natively) |

---

## Directory Structure Specification

### Root Layout
```
claude-swarm/
├── package.json              # Project manifest
├── tsconfig.json             # TypeScript configuration
├── .gitignore                # Version control exclusions
├── swarm.ts                  # CLI entry point (created in Step 9)
│
├── src/                      # Source code
│   ├── types.ts              # Shared type definitions
│   └── workflows/            # Workflow templates (Step 7)
│
├── roles/                    # Agent persona definitions
│   ├── researcher/
│   │   └── CLAUDE.md
│   ├── developer/
│   │   └── CLAUDE.md
│   ├── reviewer/
│   │   └── CLAUDE.md
│   └── architect/
│       └── CLAUDE.md
│
├── .swarm/                   # Runtime state (gitignored)
│   ├── memory.db             # SQLite database
│   ├── messages/
│   │   ├── inbox/            # Per-agent incoming
│   │   └── outbox/           # Per-agent outgoing
│   └── sessions/             # Session metadata
│
├── .worktrees/               # Git worktrees (gitignored)
│
├── outputs/                  # Final deliverables (gitignored)
│
└── logs/                     # Session logs (gitignored)
```

### Directory Purpose Map

| Directory | Purpose | Created By | Gitignored |
|-----------|---------|------------|------------|
| `src/` | All TypeScript source code | Scaffolding | No |
| `src/workflows/` | Workflow template modules | Scaffolding | No |
| `roles/` | Agent CLAUDE.md personas | Scaffolding | No |
| `roles/{role}/` | Individual role configs | Step 6 | No |
| `.swarm/` | Runtime state root | db.ts on first run | Yes |
| `.swarm/messages/inbox/` | Agent inbox files | message-bus.ts | Yes |
| `.swarm/messages/outbox/` | Agent outbox files | message-bus.ts | Yes |
| `.swarm/sessions/` | Session metadata JSON | orchestrator.ts | Yes |
| `.worktrees/` | Git worktree checkouts | worktree-manager.ts | Yes |
| `outputs/` | Synthesized deliverables | orchestrator.ts | Yes |
| `logs/` | Session execution logs | orchestrator.ts | Yes |

---

## Configuration Files

### package.json Specification

**Required fields:**
- `name`: `"claude-swarm"`
- `version`: `"1.0.0"` (semver)
- `type`: `"module"` (ES modules required for Bun)

**Scripts:**
| Script | Command | Purpose |
|--------|---------|---------|
| `start` | `bun swarm.ts` | Run CLI |
| `dev` | `bun --watch swarm.ts` | Development with hot reload |
| `test` | `bun test` | Run test suite |
| `typecheck` | `bun run tsc --noEmit` | Type verification only |

**Dev Dependencies:**
- `bun-types`: `"latest"` - Bun TypeScript definitions
- `typescript`: `"^5.0.0"` - Type checker

**No runtime dependencies.** This is intentional - Bun provides everything.

### tsconfig.json Specification

**Compiler Options:**

| Option | Value | Rationale |
|--------|-------|-----------|
| `target` | `"ESNext"` | Bun supports latest JS features |
| `module` | `"ESNext"` | ES modules for Bun compatibility |
| `moduleResolution` | `"bundler"` | Required for Bun's resolution |
| `types` | `["bun-types"]` | Bun API type definitions |
| `strict` | `true` | Full type safety |
| `skipLibCheck` | `true` | Faster compilation |
| `noEmit` | `true` | Bun handles transpilation |
| `esModuleInterop` | `true` | CommonJS interop |
| `allowSyntheticDefaultImports` | `true` | Import flexibility |
| `resolveJsonModule` | `true` | Import JSON files |
| `isolatedModules` | `true` | Per-file transpilation |
| `noUnusedLocals` | `true` | Catch dead code |
| `noUnusedParameters` | `true` | Catch dead parameters |
| `noImplicitReturns` | `true` | Explicit returns |
| `noFallthroughCasesInSwitch` | `true` | Prevent switch bugs |

**Include patterns:** `["src/**/*.ts", "swarm.ts"]`
**Exclude patterns:** `["node_modules", ".worktrees"]`

### .gitignore Specification

**Must exclude:**
- `.swarm/` - Runtime state, regenerated each session
- `.worktrees/` - Git worktrees, managed by git
- `outputs/` - Generated output, not source
- `logs/` - Execution logs
- `.env`, `.env.local` - Environment secrets
- `node_modules/` - Dependencies
- `bun.lockb` - Lock file (optional to include)
- IDE directories: `.idea/`, `.vscode/`
- Editor temp files: `*.swp`, `*.swo`, `*~`
- OS files: `.DS_Store`, `Thumbs.db`
- TypeScript build info: `*.tsbuildinfo`

---

## Type Definitions (src/types.ts)

This file defines all shared TypeScript interfaces. Types are contracts - they belong in the architectural plan in full.

### Message Types

```typescript
/**
 * Base message for all inter-agent communication.
 * Messages flow through the file-based message bus.
 */
export interface AgentMessage {
  /** UUID v4 identifier */
  id: string;
  /** ISO 8601 timestamp of creation */
  timestamp: string;
  /** Agent role that sent this message */
  from: string;
  /** Target agent role or "broadcast" for all */
  to: string;
  /** Categorization for routing logic */
  type: MessageType;
  /** Urgency level for processing order */
  priority: Priority;
  /** The actual message payload */
  content: MessageContent;
  /** Optional: links related messages together */
  threadId?: string;
  /** Whether sender expects a response */
  requiresResponse: boolean;
  /** Optional: ISO 8601 deadline for response */
  deadline?: string;
}

export type MessageType =
  | 'task'      // Assignment from orchestrator
  | 'result'    // Completed work output
  | 'question'  // Clarification request
  | 'feedback'  // Review comments
  | 'status'    // Progress/completion signal
  | 'finding'   // Research discovery
  | 'artifact'  // Code/document produced
  | 'review'    // Review verdict
  | 'design';   // Architecture proposal

export type Priority = 'critical' | 'high' | 'normal' | 'low';

export interface MessageContent {
  /** Brief description (for logging/display) */
  subject: string;
  /** Full message content */
  body: string;
  /** Optional: file paths or inline content */
  artifacts?: string[];
  /** Optional: extensible metadata */
  metadata?: Record<string, unknown>;
}
```

### Agent Types

```typescript
/**
 * Runtime information about a spawned agent.
 * Tracked by the orchestrator during session lifecycle.
 */
export interface AgentInfo {
  /** The role this agent is playing */
  role: AgentRole;
  /** tmux pane identifier (e.g., "%3") */
  paneId: string;
  /** Absolute path to agent's worktree */
  worktreePath: string;
  /** Current lifecycle state */
  status: AgentStatus;
  /** ISO 8601 timestamp when spawned */
  spawnedAt: string;
  /** ISO 8601 timestamp of last detected activity */
  lastActivity?: string;
}

/** The four defined agent roles */
export type AgentRole = 'researcher' | 'developer' | 'reviewer' | 'architect';

/** Agent lifecycle states */
export type AgentStatus =
  | 'starting'  // Worktree created, Claude launching
  | 'running'   // Actively processing
  | 'complete'  // Sent completion signal
  | 'error'     // Encountered fatal error
  | 'idle';     // Waiting for work
```

### Task Types

```typescript
/**
 * A discrete unit of work assigned to an agent.
 * Tasks are persisted in SQLite for tracking and recovery.
 */
export interface Task {
  /** UUID v4 identifier */
  id: string;
  /** Session this task belongs to */
  sessionId: string;
  /** Optional: parent task for subtask hierarchy */
  parentTaskId?: string;
  /** Agent role responsible for this task */
  assignedTo: AgentRole;
  /** Current progress state */
  status: TaskStatus;
  /** Processing urgency */
  priority: Priority;
  /** Human-readable task description */
  description: string;
  /** Optional: structured input data */
  inputData?: Record<string, unknown>;
  /** Optional: structured output data (set on completion) */
  outputData?: Record<string, unknown>;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** ISO 8601 last update timestamp */
  updatedAt: string;
}

/** Task lifecycle states following the defined flow */
export type TaskStatus =
  | 'created'     // Just created, not yet assigned
  | 'assigned'    // Sent to agent
  | 'in_progress' // Agent actively working
  | 'review'      // Submitted for review
  | 'revision'    // Returned for changes
  | 'complete'    // Successfully finished
  | 'failed';     // Unrecoverable error
```

### Finding Types

```typescript
/**
 * A research finding from the researcher agent.
 * Findings require verification before being considered reliable.
 */
export interface Finding {
  id: string;
  sessionId: string;
  /** Agent that discovered this (usually "researcher") */
  agent: string;
  /** The specific assertion being made */
  claim: string;
  /** Self-assessed reliability level */
  confidence: Confidence;
  /** URLs or references supporting the claim */
  sources: string[];
  /** Optional: evidence that contradicts the claim */
  contradictingEvidence?: string;
  /** Agent that verified this finding */
  verifiedBy?: string;
  /** ISO 8601 verification timestamp */
  verifiedAt?: string;
  createdAt: string;
}

export type Confidence = 'high' | 'medium' | 'low';
```

### Artifact Types

```typescript
/**
 * A code, document, or other artifact created by an agent.
 * Artifacts go through a review cycle before approval.
 */
export interface Artifact {
  id: string;
  sessionId: string;
  /** Agent that created this artifact */
  agent: string;
  /** Category of artifact */
  artifactType: ArtifactType;
  /** Relative path within worktree */
  filepath: string;
  /** Optional: file content (may be large) */
  content?: string;
  /** Optional: brief description of what this does */
  summary?: string;
  /** Revision number, increments on updates */
  version: number;
  /** Review workflow state */
  reviewStatus: ReviewStatus;
  createdAt: string;
}

export type ArtifactType =
  | 'code'          // Source code files
  | 'test'          // Test files
  | 'documentation' // Docs, READMEs
  | 'diagram'       // Architecture diagrams
  | 'config';       // Configuration files

export type ReviewStatus =
  | 'pending'        // Awaiting review
  | 'approved'       // Passed review
  | 'needs_revision' // Changes requested
  | 'rejected';      // Not acceptable
```

### Decision Types

```typescript
/**
 * A recorded decision made during the workflow.
 * Provides audit trail and rationale for choices.
 */
export interface Decision {
  id: string;
  sessionId: string;
  /** Agent that made the decision */
  agent: string;
  /** The choice that was made */
  decision: string;
  /** Why this choice was made */
  rationale: string;
  /** Other options that were considered */
  alternativesConsidered: Alternative[];
  createdAt: string;
}

export interface Alternative {
  name: string;
  pros: string[];
  cons: string[];
}
```

### Workflow Types

```typescript
/**
 * Configuration for a multi-stage workflow.
 * Defines which agents participate and in what order.
 */
export interface WorkflowConfig {
  /** Unique workflow identifier */
  name: string;
  /** Human-readable description */
  description: string;
  /** Agent roles involved in this workflow */
  agents: AgentRole[];
  /** Ordered stages of execution */
  stages: WorkflowStage[];
  /** Max times to repeat the full workflow */
  maxIterations?: number;
  /** Max revision cycles for individual stages */
  maxRevisions?: number;
}

export interface WorkflowStage {
  /** Stage identifier */
  name: string;
  /** Agent responsible for this stage */
  agent: AgentRole;
  /** Input from previous stage(s) */
  input?: string | string[];
  /** Output key for next stages */
  output: string;
  /** Optional: condition expression for running this stage */
  condition?: string;
  /** Max times to repeat this specific stage */
  maxIterations?: number;
}

export type WorkflowType = 'research' | 'development' | 'architecture';
```

### Session Types

```typescript
/**
 * A swarm session represents one run of a workflow.
 * Sessions are persisted for recovery and reporting.
 */
export interface SwarmSession {
  /** UUID v4 identifier */
  id: string;
  /** Type of workflow being executed */
  workflowType: WorkflowType;
  /** User-provided objective */
  goal: string;
  /** Current session state */
  status: SessionStatus;
  /** Map of role -> agent runtime info */
  agents: Map<AgentRole, AgentInfo>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export type SessionStatus =
  | 'initializing' // Setting up agents
  | 'running'      // Workflow in progress
  | 'paused'       // User-requested pause
  | 'complete'     // All stages done
  | 'failed';      // Unrecoverable error
```

### Configuration Types

```typescript
/**
 * Global swarm configuration options.
 * Can be loaded from config.json or use defaults.
 */
export interface SwarmConfig {
  /** Maximum concurrent agents */
  maxAgents: number;
  /** Default operation timeout in ms */
  defaultTimeout: number;
  /** How often agents check for messages (ms) */
  messagePollingInterval: number;
  /** tmux-specific settings */
  tmux: TmuxConfig;
  /** Worktree-specific settings */
  worktrees: WorktreeConfig;
  /** Per-workflow settings */
  workflows: Record<WorkflowType, WorkflowConfig>;
}

export interface TmuxConfig {
  /** Prefix for tmux session names */
  sessionPrefix: string;
}

export interface WorktreeConfig {
  /** Base directory for worktrees */
  basePath: string;
}
```

### Utility Types and Functions

```typescript
/**
 * Result type for operations that can fail.
 * Use instead of throwing exceptions for expected failures.
 */
export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

/** Create a success result */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Create an error result */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Generate a UUID v4 identifier */
export function generateId(): string {
  return crypto.randomUUID();
}

/** Get current timestamp in ISO 8601 format */
export function now(): string {
  return new Date().toISOString();
}
```

---

## Implementation Steps

### Step 1.1: Initialize Bun Project
1. Create project directory
2. Run `bun init -y` to generate initial package.json
3. The generated file will be replaced in next step

### Step 1.2: Create Configuration Files
1. Write package.json with specified content
2. Write tsconfig.json with specified compiler options
3. Write .gitignore with specified exclusion patterns

### Step 1.3: Install Dev Dependencies
Run: `bun add -d bun-types typescript`

### Step 1.4: Create Directory Structure
Create all directories in the specification:
- `src/workflows/` for workflow modules
- `roles/{researcher,developer,reviewer,architect}/` for agent configs
- Runtime directories are created at execution time, not scaffolding

### Step 1.5: Create src/types.ts
Write the complete type definitions file as specified above.

### Step 1.6: Initialize Git Repository
1. Run `git init`
2. Stage all files: `git add -A`
3. Initial commit: `git commit -m "Initial project scaffolding"`

This is important because git worktrees (used by agents) require a git repository.

### Step 1.7: Verify Setup
1. Run `bun run typecheck` - should pass with no errors
2. Run `bun -e "import { AgentRole } from './src/types.ts'; console.log('Types loaded')"` - should print successfully

---

## Error Handling

### Potential Errors During Scaffolding

| Error | Cause | Resolution |
|-------|-------|------------|
| `bun: command not found` | Bun not installed | Install via `curl -fsSL https://bun.sh/install \| bash` |
| `git init` fails | Already a git repo | Skip if `.git/` exists |
| `bun add` network error | No internet | Retry, or manually create package.json |
| TypeScript errors in types.ts | Typos or version mismatch | Verify typescript version, check syntax |

### Recovery Strategies
- Scaffolding is idempotent - can be re-run safely
- If partial failure, delete project directory and restart
- Each step is independent after package.json exists

---

## Edge Cases & Boundary Conditions

### Directory Already Exists
- Check before creating each directory
- Use `mkdir -p` equivalent (recursive: true) for idempotency
- Do not error if directory already exists

### Git Repository Already Initialized
- Check for `.git/` directory before `git init`
- Skip initialization if already a repo
- Verify git version supports worktrees (2.20+)

### Previous Installation Exists
- If `node_modules/` exists, `bun add` will update
- If package.json differs, it will be overwritten
- Types.ts should be overwritten with canonical version

---

## Verification Checklist

After completing scaffolding, verify:

- [ ] `bun run typecheck` passes with no errors
- [ ] All directories exist as specified
- [ ] `package.json` has correct scripts and devDependencies
- [ ] `tsconfig.json` uses Bun-compatible settings (`moduleResolution: "bundler"`)
- [ ] `.gitignore` excludes runtime directories
- [ ] `src/types.ts` exports all required types
- [ ] Git repository initialized with initial commit
- [ ] `bun add -d` successfully installed dev dependencies
- [ ] Can import types: `bun -e "import * as t from './src/types.ts'"`

---

## Integration Points

### Used By Other Steps
| Step | Dependency |
|------|------------|
| Step 2 (Database) | Imports types from `src/types.ts` |
| Step 3 (Message Bus) | Uses `.swarm/messages/` directory pattern |
| Step 4 (tmux Manager) | Uses session naming from types |
| Step 5 (Worktree Manager) | Uses `.worktrees/` directory |
| Step 6 (Agent Roles) | Creates files in `roles/` directories |
| All steps | Use `bun run typecheck` for verification |

### Types Export Summary
The `src/types.ts` file exports:
- 13 interfaces (AgentMessage, AgentInfo, Task, Finding, Artifact, Decision, WorkflowConfig, WorkflowStage, SwarmSession, SwarmConfig, TmuxConfig, WorktreeConfig, Alternative, MessageContent)
- 11 type aliases (MessageType, Priority, AgentRole, AgentStatus, TaskStatus, Confidence, ArtifactType, ReviewStatus, WorkflowType, SessionStatus, Result)
- 4 utility functions (ok, err, generateId, now)

---

## Configuration Defaults

When `config.json` is not provided, these defaults apply:

| Setting | Default | Rationale |
|---------|---------|-----------|
| `maxAgents` | 4 | Typical workflow uses 4 roles |
| `defaultTimeout` | 300000 (5 min) | Long enough for complex tasks |
| `messagePollingInterval` | 5000 (5 sec) | Balance responsiveness vs load |
| `tmux.sessionPrefix` | "swarm" | Identifies swarm sessions |
| `worktrees.basePath` | ".worktrees" | Hidden, in project root |

---

## Open Questions & Decisions

### Decided
- **Bun vs Node**: Bun chosen for native SQLite, TypeScript, and fast startup
- **ES Modules**: Required for Bun compatibility
- **Strict TypeScript**: Enabled for type safety
- **Runtime directories gitignored**: Ensures clean state on fresh clone

### Implementation Notes
- The `roles/` subdirectories are created empty during scaffolding; CLAUDE.md files are added in Step 6
- The `.swarm/` directory is created by db.ts on first database access, not during scaffolding
- The `swarm.ts` CLI entry point is created in Step 9, not scaffolding

---

## Next Step

After completing project scaffolding, proceed to **Step 2: Database Layer** which implements the SQLite persistence layer using the types defined here.
