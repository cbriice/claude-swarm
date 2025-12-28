# Step 2: Database Layer (SQLite)

## Overview & Purpose

### What This Component Does
The database layer provides persistent storage for all swarm session data using Bun's native SQLite support (`bun:sqlite`). It stores research findings, code artifacts, tasks, decisions, messages, and session metadata in a structured, queryable format.

### How It Fits Into the System
```
┌─────────────────────────────────────────────────────────────┐
│                     ORCHESTRATOR                             │
│  - Creates sessions                                          │
│  - Queries task status                                       │
│  - Retrieves findings for synthesis                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    DATABASE LAYER (db.ts)                    │
│  - Singleton connection management                           │
│  - Schema initialization                                     │
│  - CRUD operations for all entity types                      │
│  - Session-scoped queries                                    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  .swarm/memory.db (SQLite)                   │
│  Tables: sessions, findings, artifacts, decisions,          │
│          tasks, messages, checkpoints, error_log,           │
│          agent_activity                                      │
└─────────────────────────────────────────────────────────────┘
```

### Problems It Solves
- **Persistence**: Data survives process restarts and agent failures
- **Isolation**: Session-scoped queries prevent data leakage between swarm runs
- **Auditability**: Full history of findings, decisions, and messages
- **Recovery**: Sessions can be resumed after interruption
- **Querying**: Structured data enables filtering, aggregation, and reporting

---

## Prerequisites & Dependencies

### Required Before Starting
- Step 1 (Project Scaffolding) completed
- `src/types.ts` exists with all type definitions
- Bun runtime installed (provides native SQLite)

### External Dependencies
None. Bun provides `bun:sqlite` natively with zero configuration.

### Internal Dependencies
Imports from `src/types.ts`:
- `Confidence`, `TaskStatus`, `ReviewStatus`, `WorkflowType`, `SessionStatus`
- `generateId()`, `now()` utility functions

---

## Database Schema

### Entity Relationship Diagram
```
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│   sessions   │◄──────│   findings   │       │  artifacts   │
│──────────────│       │──────────────│       │──────────────│
│ id (PK)      │       │ id (PK)      │       │ id (PK)      │
│ workflow_type│       │ session_id   │───────│ session_id   │
│ goal         │       │ agent        │       │ agent        │
│ status       │       │ claim        │       │ artifact_type│
│ created_at   │       │ confidence   │       │ filepath     │
│ updated_at   │       │ sources      │       │ content      │
│ completed_at │       │ verified_by  │       │ version      │
└──────────────┘       │ verified_at  │       │ review_status│
       │               │ created_at   │       │ created_at   │
       │               └──────────────┘       └──────────────┘
       │
       ├───────────────┬───────────────┐
       ▼               ▼               ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  decisions   │ │    tasks     │ │   messages   │
│──────────────│ │──────────────│ │──────────────│
│ id (PK)      │ │ id (PK)      │ │ id (PK)      │
│ session_id   │ │ session_id   │ │ session_id   │
│ agent        │ │ parent_id    │ │ thread_id    │
│ decision     │ │ assigned_to  │ │ from_agent   │
│ rationale    │ │ status       │ │ to_agent     │
│ alternatives │ │ priority     │ │ message_type │
│ created_at   │ │ description  │ │ priority     │
└──────────────┘ │ input_data   │ │ content      │
                 │ output_data  │ │ created_at   │
                 │ created_at   │ └──────────────┘
                 │ updated_at   │
                 └──────────────┘
```

### Table Definitions

All tables use TEXT for IDs (UUID v4 format) and TEXT for timestamps (ISO 8601 format). JSON data is stored as TEXT and parsed by the application.

#### sessions
Primary table tracking swarm session lifecycle.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | TEXT | PRIMARY KEY | UUID v4 |
| workflow_type | TEXT | NOT NULL | 'research', 'development', 'architecture' |
| goal | TEXT | NOT NULL | User-provided objective |
| status | TEXT | NOT NULL, CHECK | 'initializing', 'running', 'paused', 'complete', 'failed' |
| created_at | TEXT | NOT NULL, DEFAULT | ISO 8601 timestamp |
| updated_at | TEXT | NOT NULL, DEFAULT | ISO 8601 timestamp |
| completed_at | TEXT | NULL | Set when status becomes 'complete' or 'failed' |

#### findings
Research discoveries from researcher agents.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | TEXT | PRIMARY KEY | UUID v4 |
| session_id | TEXT | NOT NULL, FK→sessions | Parent session |
| agent | TEXT | NOT NULL | Agent that created this (usually 'researcher') |
| claim | TEXT | NOT NULL | The assertion being made |
| confidence | TEXT | NOT NULL, CHECK | 'high', 'medium', 'low' |
| sources | TEXT | NOT NULL | JSON array of source URLs |
| contradicting_evidence | TEXT | NULL | Notes on conflicting information |
| verified_by | TEXT | NULL | Agent that verified (usually 'reviewer') |
| verified_at | TEXT | NULL | ISO 8601 verification timestamp |
| created_at | TEXT | NOT NULL, DEFAULT | ISO 8601 timestamp |

#### artifacts
Code, documents, and other deliverables.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | TEXT | PRIMARY KEY | UUID v4 |
| session_id | TEXT | NOT NULL, FK→sessions | Parent session |
| agent | TEXT | NOT NULL | Creator agent |
| artifact_type | TEXT | NOT NULL | 'code', 'test', 'documentation', 'diagram', 'config' |
| filepath | TEXT | NOT NULL | Relative path in worktree |
| content | TEXT | NULL | File content (may be large) |
| summary | TEXT | NULL | Brief description |
| version | INTEGER | NOT NULL, DEFAULT 1 | Incremented on updates |
| review_status | TEXT | NOT NULL, CHECK, DEFAULT 'pending' | Review workflow state |
| created_at | TEXT | NOT NULL, DEFAULT | ISO 8601 timestamp |

#### decisions
Recorded choices made during workflow execution.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | TEXT | PRIMARY KEY | UUID v4 |
| session_id | TEXT | NOT NULL, FK→sessions | Parent session |
| agent | TEXT | NOT NULL | Agent that made the decision |
| decision | TEXT | NOT NULL | The choice made |
| rationale | TEXT | NOT NULL | Explanation of why |
| alternatives_considered | TEXT | NULL | JSON array of alternatives |
| created_at | TEXT | NOT NULL, DEFAULT | ISO 8601 timestamp |

#### tasks
Work assignments and their status.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | TEXT | PRIMARY KEY | UUID v4 |
| session_id | TEXT | NOT NULL, FK→sessions | Parent session |
| parent_task_id | TEXT | NULL, FK→tasks | For subtask hierarchy |
| assigned_to | TEXT | NOT NULL | Target agent role |
| status | TEXT | NOT NULL, CHECK, DEFAULT 'created' | Task lifecycle state |
| priority | TEXT | NOT NULL, CHECK, DEFAULT 'normal' | Urgency level |
| description | TEXT | NOT NULL | What needs to be done |
| input_data | TEXT | NULL | JSON input parameters |
| output_data | TEXT | NULL | JSON result data |
| created_at | TEXT | NOT NULL, DEFAULT | ISO 8601 timestamp |
| updated_at | TEXT | NOT NULL, DEFAULT | ISO 8601 timestamp |

#### messages
Agent-to-agent communication history.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | TEXT | PRIMARY KEY | UUID v4 |
| session_id | TEXT | NOT NULL, FK→sessions | Parent session |
| thread_id | TEXT | NULL | Groups related messages |
| from_agent | TEXT | NOT NULL | Sender agent role |
| to_agent | TEXT | NOT NULL | Recipient agent role |
| message_type | TEXT | NOT NULL | Message category |
| priority | TEXT | NOT NULL, DEFAULT 'normal' | Urgency level |
| content | TEXT | NOT NULL | JSON message content |
| created_at | TEXT | NOT NULL, DEFAULT | ISO 8601 timestamp |

#### checkpoints
Session state snapshots for recovery (used by Error Handling - Step 10).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | TEXT | PRIMARY KEY | UUID v4 |
| session_id | TEXT | NOT NULL, FK→sessions | Parent session |
| type | TEXT | NOT NULL | 'session_start', 'stage_complete', 'periodic', 'before_retry', 'error_recovery', 'manual' |
| created_at | TEXT | NOT NULL, DEFAULT | ISO 8601 timestamp |
| created_by | TEXT | NOT NULL | 'auto', 'manual', 'error' |
| workflow_state_json | TEXT | NOT NULL | JSON serialized workflow state |
| agent_states_json | TEXT | NOT NULL | JSON serialized agent states |
| message_queue_json | TEXT | NOT NULL | JSON serialized message queue state |
| completed_stages_json | TEXT | NOT NULL | JSON array of completed stages |
| pending_stages_json | TEXT | NOT NULL | JSON array of pending stages |
| errors_json | TEXT | NULL | JSON array of errors |
| notes | TEXT | NULL | Optional notes |

#### error_log
Error tracking and debugging (used by Error Handling - Step 10).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | TEXT | PRIMARY KEY | UUID v4 |
| session_id | TEXT | NULL, FK→sessions | Associated session (if any) |
| code | TEXT | NOT NULL | Error code (e.g., 'AGENT_TIMEOUT') |
| category | TEXT | NOT NULL | 'AGENT_ERROR', 'WORKFLOW_ERROR', 'SYSTEM_ERROR', 'EXTERNAL_ERROR', 'USER_ERROR' |
| severity | TEXT | NOT NULL | 'fatal', 'error', 'warning', 'info' |
| message | TEXT | NOT NULL | Human-readable error message |
| details | TEXT | NULL | Technical details |
| component | TEXT | NULL | Which component failed |
| agent_role | TEXT | NULL | Associated agent role |
| recoverable | INTEGER | NOT NULL | Boolean: 1 if recoverable, 0 otherwise |
| recovered | INTEGER | NOT NULL, DEFAULT 0 | Boolean: 1 if successfully recovered |
| recovery_strategy | TEXT | NULL | Recovery strategy used |
| stack | TEXT | NULL | Stack trace |
| context_json | TEXT | NULL | JSON additional context |
| created_at | TEXT | NOT NULL, DEFAULT | ISO 8601 timestamp |

#### agent_activity
Agent activity log for monitoring and debugging (used by Orchestrator - Step 8).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | Auto-increment ID |
| session_id | TEXT | NOT NULL, FK→sessions | Parent session |
| agent_role | TEXT | NOT NULL | Agent role |
| event_type | TEXT | NOT NULL | 'spawned', 'ready', 'message', 'complete', 'error' |
| details_json | TEXT | NULL | JSON event details |
| timestamp | TEXT | NOT NULL, DEFAULT | ISO 8601 timestamp |

### Indexes

Create these indexes for common query patterns:

| Index Name | Table | Columns | Rationale |
|------------|-------|---------|-----------|
| idx_findings_session | findings | session_id | Filter by session |
| idx_artifacts_session | artifacts | session_id | Filter by session |
| idx_artifacts_review | artifacts | session_id, review_status | Find pending reviews |
| idx_tasks_session | tasks | session_id | Filter by session |
| idx_tasks_status | tasks | session_id, status | Find active tasks |
| idx_tasks_assigned | tasks | session_id, assigned_to | Find agent's tasks |
| idx_messages_session | messages | session_id | Filter by session |
| idx_messages_thread | messages | thread_id | Thread conversation |
| idx_decisions_session | decisions | session_id | Filter by session |
| idx_checkpoints_session | checkpoints | session_id | Filter checkpoints by session |
| idx_checkpoints_created | checkpoints | created_at | Sort by creation time |
| idx_errors_session | error_log | session_id | Filter errors by session |
| idx_errors_code | error_log | code | Find specific error types |
| idx_errors_severity | error_log | severity | Filter by severity |
| idx_agent_activity_session | agent_activity | session_id | Filter activity by session |
| idx_agent_activity_role | agent_activity | agent_role | Filter activity by agent |

---

## Public API Design

### Module Structure
```typescript
// src/db.ts

// Connection Management
export function getDb(): Database;
export function closeDb(): void;

// Session Operations
export function createSession(input: CreateSessionInput): string;
export function getSession(id: string): SessionRow | null;
export function updateSessionStatus(id: string, status: SessionStatus): void;
export function listSessions(status?: SessionStatus): SessionRow[];

// Finding Operations
export function createFinding(input: CreateFindingInput): string;
export function getFinding(id: string): FindingRow | null;
export function getSessionFindings(sessionId: string): FindingRow[];
export function getUnverifiedFindings(sessionId: string): FindingRow[];
export function verifyFinding(id: string, verifiedBy: string): void;

// Artifact Operations
export function createArtifact(input: CreateArtifactInput): string;
export function getArtifact(id: string): ArtifactRow | null;
export function getSessionArtifacts(sessionId: string): ArtifactRow[];
export function getArtifactsByStatus(sessionId: string, status: ReviewStatus): ArtifactRow[];
export function updateArtifactReviewStatus(id: string, status: ReviewStatus): void;
export function updateArtifactContent(id: string, content: string): void;

// Decision Operations
export function createDecision(input: CreateDecisionInput): string;
export function getDecision(id: string): DecisionRow | null;
export function getSessionDecisions(sessionId: string): DecisionRow[];

// Task Operations
export function createTask(input: CreateTaskInput): string;
export function getTask(id: string): TaskRow | null;
export function getSessionTasks(sessionId: string): TaskRow[];
export function getTasksByStatus(sessionId: string, status: TaskStatus): TaskRow[];
export function getAgentTasks(sessionId: string, agent: string): TaskRow[];
export function updateTaskStatus(id: string, status: TaskStatus, outputData?: Record<string, unknown>): void;

// Message Operations
export function createMessage(input: CreateMessageInput): string;
export function getSessionMessages(sessionId: string): MessageRow[];
export function getThreadMessages(threadId: string): MessageRow[];
export function getAgentMessages(sessionId: string, agent: string): MessageRow[];

// Utility Operations
export function deleteSession(sessionId: string): void;
export function getSessionStats(sessionId: string): SessionStats;

// Type Mapping Functions (Row types → Domain types)
export function sessionRowToSwarmSession(row: SessionRow): Omit<SwarmSession, 'agents'>;
export function findingRowToFinding(row: FindingRow): Finding;
export function artifactRowToArtifact(row: ArtifactRow): Artifact;
export function decisionRowToDecision(row: DecisionRow): Decision;
export function taskRowToTask(row: TaskRow): Task;
export function messageRowToAgentMessage(row: MessageRow): AgentMessage;
```

### Input Types

```typescript
export interface CreateSessionInput {
  workflowType: WorkflowType;
  goal: string;
}

export interface CreateFindingInput {
  sessionId: string;
  agent: string;
  claim: string;
  confidence: Confidence;
  sources: string[];
  contradictingEvidence?: string;
}

export interface CreateArtifactInput {
  sessionId: string;
  agent: string;
  artifactType: string;
  filepath: string;
  content?: string;
  summary?: string;
}

export interface CreateDecisionInput {
  sessionId: string;
  agent: string;
  decision: string;
  rationale: string;
  alternativesConsidered?: Array<{ name: string; pros: string[]; cons: string[] }>;
}

export interface CreateTaskInput {
  sessionId: string;
  assignedTo: string;
  description: string;
  priority?: 'critical' | 'high' | 'normal' | 'low';
  parentTaskId?: string;
  inputData?: Record<string, unknown>;
}

export interface CreateMessageInput {
  sessionId: string;
  threadId?: string;
  fromAgent: string;
  toAgent: string;
  messageType: string;
  priority?: string;
  content: Record<string, unknown>;
}
```

### Row Types (Database Results)

**IMPORTANT: Relationship Between Row Types and Domain Types**

Row types are **intentionally different** from the domain types defined in Plan 01 (`src/types.ts`):

- **Domain Types** (from Plan 01): Use camelCase properties, follow TypeScript conventions, include rich metadata structures
  - Examples: `Task`, `Finding`, `Artifact`, `Decision`, `SwarmSession`
  - Purpose: Application logic, type safety, API contracts between modules

- **Row Types** (this step): Use snake_case properties, match SQLite column naming conventions
  - Examples: `TaskRow`, `FindingRow`, `ArtifactRow`, `DecisionRow`, `SessionRow`
  - Purpose: Database persistence layer, direct mapping to SQLite schema

**Design Rationale**:
1. SQLite columns use snake_case by convention (matches most SQL databases)
2. TypeScript domain types use camelCase by convention (matches JavaScript/TypeScript)
3. Separating these concerns keeps the database schema clean and the application API idiomatic
4. Conversion utilities (see below) bridge the gap between the two representations

Row types use snake_case to match SQLite column names:

```typescript
export interface SessionRow {
  id: string;
  workflow_type: string;
  goal: string;
  status: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface FindingRow {
  id: string;
  session_id: string;
  agent: string;
  claim: string;
  confidence: string;
  sources: string;  // JSON string - parse with JSON.parse()
  contradicting_evidence: string | null;
  verified_by: string | null;
  verified_at: string | null;
  created_at: string;
}

export interface ArtifactRow {
  id: string;
  session_id: string;
  agent: string;
  artifact_type: string;
  filepath: string;
  content: string | null;
  summary: string | null;
  version: number;
  review_status: string;
  created_at: string;
}

export interface DecisionRow {
  id: string;
  session_id: string;
  agent: string;
  decision: string;
  rationale: string;
  alternatives_considered: string | null;  // JSON string
  created_at: string;
}

export interface TaskRow {
  id: string;
  session_id: string;
  parent_task_id: string | null;
  assigned_to: string;
  status: string;
  priority: string;
  description: string;
  input_data: string | null;  // JSON string
  output_data: string | null;  // JSON string
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  session_id: string;
  thread_id: string | null;
  from_agent: string;
  to_agent: string;
  message_type: string;
  priority: string;
  content: string;  // JSON string
  created_at: string;
}

export interface SessionStats {
  findings: { total: number; verified: number };
  artifacts: { total: number; approved: number; pending: number; rejected: number };
  tasks: { total: number; complete: number; in_progress: number; failed: number };
  messages: number;
  decisions: number;
}
```

### Type Mapping Utilities

These functions convert between database Row types (snake_case) and domain types (camelCase):

```typescript
/**
 * Convert database SessionRow to domain SwarmSession type
 */
export function sessionRowToSwarmSession(row: SessionRow): Omit<SwarmSession, 'agents'> {
  return {
    id: row.id,
    workflowType: row.workflow_type as WorkflowType,
    goal: row.goal,
    status: row.status as SessionStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
    // Note: 'agents' field must be populated separately as it's not stored in the sessions table
  };
}

/**
 * Convert database FindingRow to domain Finding type
 */
export function findingRowToFinding(row: FindingRow): Finding {
  return {
    id: row.id,
    sessionId: row.session_id,
    agent: row.agent,
    claim: row.claim,
    confidence: row.confidence as Confidence,
    sources: JSON.parse(row.sources),
    contradictingEvidence: row.contradicting_evidence ?? undefined,
    verifiedBy: row.verified_by ?? undefined,
    verifiedAt: row.verified_at ?? undefined,
    createdAt: row.created_at,
  };
}

/**
 * Convert database ArtifactRow to domain Artifact type
 */
export function artifactRowToArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    sessionId: row.session_id,
    agent: row.agent,
    artifactType: row.artifact_type as ArtifactType,
    filepath: row.filepath,
    content: row.content ?? undefined,
    summary: row.summary ?? undefined,
    version: row.version,
    reviewStatus: row.review_status as ReviewStatus,
    createdAt: row.created_at,
  };
}

/**
 * Convert database DecisionRow to domain Decision type
 */
export function decisionRowToDecision(row: DecisionRow): Decision {
  return {
    id: row.id,
    sessionId: row.session_id,
    agent: row.agent,
    decision: row.decision,
    rationale: row.rationale,
    alternativesConsidered: row.alternatives_considered
      ? JSON.parse(row.alternatives_considered)
      : [],
    createdAt: row.created_at,
  };
}

/**
 * Convert database TaskRow to domain Task type
 */
export function taskRowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    sessionId: row.session_id,
    parentTaskId: row.parent_task_id ?? undefined,
    assignedTo: row.assigned_to as AgentRole,
    status: row.status as TaskStatus,
    priority: row.priority as Priority,
    description: row.description,
    inputData: row.input_data ? JSON.parse(row.input_data) : undefined,
    outputData: row.output_data ? JSON.parse(row.output_data) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Convert database MessageRow to domain AgentMessage type
 */
export function messageRowToAgentMessage(row: MessageRow): AgentMessage {
  const content = JSON.parse(row.content);
  return {
    id: row.id,
    timestamp: row.created_at,
    from: row.from_agent,
    to: row.to_agent,
    type: row.message_type as MessageType,
    priority: row.priority as Priority,
    content: content,
    threadId: row.thread_id ?? undefined,
    requiresResponse: content.requiresResponse ?? false,
    deadline: content.deadline,
  };
}
```

**Usage Pattern**:
```typescript
// Querying and converting
const taskRow = getTask(taskId);
if (taskRow) {
  const task: Task = taskRowToTask(taskRow);
  // Use task with camelCase properties in application logic
}

// Batch conversion
const taskRows = getSessionTasks(sessionId);
const tasks: Task[] = taskRows.map(taskRowToTask);
```

---

## Detailed Behavior Specifications

### Connection Management

#### getDb()
**Purpose**: Return the singleton database connection, initializing if needed.

**Behavior**:
1. If connection already exists, return it immediately
2. If connection is null:
   a. Check if `.swarm/` directory exists
   b. If not, create it with `mkdir -p` semantics
   c. Open database at `.swarm/memory.db`
   d. Enable WAL mode: `PRAGMA journal_mode = WAL`
   e. Enable foreign keys: `PRAGMA foreign_keys = ON`
   f. Call internal `initSchema()` to create tables
   g. Store connection in module-level variable
3. Return the connection

**Side Effects**:
- Creates `.swarm/` directory if missing
- Creates `.swarm/memory.db` file if missing
- Creates `.swarm/memory.db-wal` and `.swarm/memory.db-shm` (WAL files)

**Error Conditions**:
- Directory creation fails (permissions) → throws
- Database file locked by another process → throws
- Schema initialization fails → throws

#### closeDb()
**Purpose**: Close the database connection and reset singleton.

**Behavior**:
1. If connection exists, call `db.close()`
2. Set connection variable to null
3. Safe to call multiple times (idempotent)

**When to Call**:
- Application shutdown
- Before deleting database file
- In test cleanup

### Session Operations

#### createSession(input)
**Purpose**: Create a new swarm session record.

**Parameters**:
- `input.workflowType`: Must be 'research', 'development', or 'architecture'
- `input.goal`: Non-empty string describing the objective

**Returns**: UUID v4 string identifying the new session

**Behavior**:
1. Generate new UUID via `generateId()`
2. Insert row with status = 'initializing'
3. created_at and updated_at set to current time by database default
4. Return the generated ID

**Validation**: None at database level. Invalid workflow_type will be stored but may cause issues in orchestrator.

#### getSession(id)
**Purpose**: Retrieve a single session by ID.

**Returns**: SessionRow object or null if not found

**Behavior**:
1. Query sessions table with exact ID match
2. Return first result or null

#### updateSessionStatus(id, status)
**Purpose**: Update session lifecycle state.

**Parameters**:
- `id`: Session UUID
- `status`: New status value

**Behavior**:
1. Update status column
2. Update updated_at to current timestamp
3. If status is 'complete' or 'failed', also set completed_at
4. No-op if ID doesn't exist (no error thrown)

#### listSessions(status?)
**Purpose**: List sessions, optionally filtered by status.

**Returns**: Array of SessionRow, ordered by created_at descending (newest first)

**Behavior**:
1. If status provided, filter by exact match
2. If status omitted, return all sessions
3. Always order by created_at DESC

### Finding Operations

#### createFinding(input)
**Purpose**: Record a research discovery.

**Parameters**:
- `input.sessionId`: Must reference existing session (FK constraint)
- `input.agent`: Agent role that made the finding
- `input.claim`: The assertion (non-empty)
- `input.confidence`: 'high', 'medium', or 'low'
- `input.sources`: Array of URLs (will be JSON-stringified)
- `input.contradictingEvidence`: Optional notes

**Returns**: UUID of created finding

**Behavior**:
1. Generate UUID
2. JSON-stringify sources array
3. Insert row
4. Return ID

**Error Conditions**:
- Invalid session_id → foreign key violation → throws

#### verifyFinding(id, verifiedBy)
**Purpose**: Mark a finding as verified by a reviewer.

**Behavior**:
1. Set verified_by to the agent name
2. Set verified_at to current timestamp
3. No-op if ID doesn't exist

**Idempotency**: Calling multiple times updates the timestamp but is otherwise safe.

### Artifact Operations

#### createArtifact(input)
**Purpose**: Record a code or document deliverable.

**Parameters**:
- `input.filepath`: Relative path (e.g., "src/utils.ts")
- `input.content`: Optional file content (may be large)
- `input.summary`: Optional brief description

**Returns**: UUID of created artifact

**Behavior**:
1. Generate UUID
2. Insert with version = 1, review_status = 'pending'
3. Return ID

#### updateArtifactContent(id, content)
**Purpose**: Update artifact content and increment version.

**Behavior**:
1. Set content to new value
2. Increment version by 1
3. No-op if ID doesn't exist

**Use Case**: When an agent revises code based on review feedback.

#### updateArtifactReviewStatus(id, status)
**Purpose**: Update review workflow state.

**Valid Status Values**: 'pending', 'approved', 'needs_revision', 'rejected'

### Task Operations

#### createTask(input)
**Purpose**: Create a work assignment.

**Parameters**:
- `input.parentTaskId`: Optional, for subtask relationships
- `input.inputData`: Optional JSON-serializable object

**Returns**: UUID of created task

**Behavior**:
1. Generate UUID
2. Set status = 'created', priority defaults to 'normal'
3. JSON-stringify inputData if provided
4. Return ID

#### updateTaskStatus(id, status, outputData?)
**Purpose**: Update task progress and optionally store results.

**Parameters**:
- `status`: New lifecycle state
- `outputData`: Optional result data (JSON-serializable)

**Behavior**:
1. Update status column
2. Update updated_at to current timestamp
3. If outputData provided, JSON-stringify and store
4. No-op if ID doesn't exist

#### getAgentTasks(sessionId, agent)
**Purpose**: Get all tasks assigned to a specific agent.

**Use Case**: Agent checking its workload.

### Message Operations

#### createMessage(input)
**Purpose**: Record an inter-agent message for audit trail.

**Note**: This is for historical record. Actual message passing uses the file-based message bus (Step 3). The database provides persistence and queryability.

**Behavior**:
1. Generate UUID
2. JSON-stringify content
3. Insert row
4. Return ID

#### getThreadMessages(threadId)
**Purpose**: Get all messages in a conversation thread.

**Returns**: Messages ordered by created_at ascending (oldest first)

### Utility Operations

#### deleteSession(sessionId)
**Purpose**: Remove a session and ALL related data.

**Behavior** (order matters for foreign keys):
1. DELETE FROM messages WHERE session_id = ?
2. DELETE FROM tasks WHERE session_id = ?
3. DELETE FROM decisions WHERE session_id = ?
4. DELETE FROM artifacts WHERE session_id = ?
5. DELETE FROM findings WHERE session_id = ?
6. DELETE FROM sessions WHERE id = ?

**Warning**: This is destructive and irreversible.

#### getSessionStats(sessionId)
**Purpose**: Get aggregate statistics for a session.

**Returns**: SessionStats object with counts for each entity type

**Behavior**:
1. Run aggregate query for each table
2. Use CASE expressions for status breakdowns
3. Return compiled statistics object

**Example Output**:
```json
{
  "findings": { "total": 5, "verified": 3 },
  "artifacts": { "total": 2, "approved": 1, "pending": 1, "rejected": 0 },
  "tasks": { "total": 4, "complete": 2, "in_progress": 1, "failed": 0 },
  "messages": 12,
  "decisions": 3
}
```

---

## Internal Architecture

### Module-Level State
```
┌─────────────────────────────────────────┐
│              Module Scope               │
│                                         │
│  const DB_PATH = '.swarm/memory.db'     │
│  let db: Database | null = null         │
│                                         │
└─────────────────────────────────────────┘
```

The singleton pattern ensures:
- Only one database connection exists
- Schema is initialized exactly once
- Connection can be shared across imports

### Schema Initialization Flow
```
getDb() called
    │
    ▼
db === null? ──No──► return db
    │
    Yes
    │
    ▼
Create .swarm/ directory
    │
    ▼
Open Database connection
    │
    ▼
PRAGMA journal_mode = WAL
    │
    ▼
PRAGMA foreign_keys = ON
    │
    ▼
CREATE TABLE IF NOT EXISTS (for each table)
    │
    ▼
CREATE INDEX IF NOT EXISTS (for each index)
    │
    ▼
Store in module variable
    │
    ▼
return db
```

### Data Flow for Create Operations
```
Input object
    │
    ▼
generateId() → UUID
    │
    ▼
JSON.stringify() for arrays/objects
    │
    ▼
db.run() with parameterized query
    │
    ▼
Return UUID
```

### Data Flow for Read Operations
```
Query parameters
    │
    ▼
db.query().get() or db.query().all()
    │
    ▼
Cast result to Row type
    │
    ▼
Return (caller must JSON.parse any JSON fields)
```

---

## Error Handling

### Error Categories

| Category | Cause | Handling |
|----------|-------|----------|
| Connection | File locked, permissions | Throw immediately, let caller handle |
| Schema | Syntax error in CREATE | Throw, indicates code bug |
| Foreign Key | Invalid session_id | Throw SQLITE_CONSTRAINT |
| Check Constraint | Invalid status/confidence | Throw SQLITE_CONSTRAINT |
| Not Found | Query returns no rows | Return null (not an error) |

### SQLite Error Codes
- `SQLITE_CONSTRAINT`: Foreign key or check constraint violated
- `SQLITE_BUSY`: Database locked (shouldn't happen with WAL)
- `SQLITE_CORRUPT`: Database file corrupted

### Recovery Strategies

**Foreign Key Violation**:
- Indicates programming error (invalid session_id)
- Caller should ensure session exists before creating child records

**Database Locked**:
- Retry with exponential backoff
- Maximum 3 attempts, then fail

**Corrupted Database**:
- Delete `.swarm/memory.db*` files
- Session is lost, must restart
- Log for debugging

---

## Edge Cases & Boundary Conditions

### Empty Session
- Session with no findings, tasks, or artifacts is valid
- getSessionStats returns zeros for all counts

### Large Content Fields
- artifacts.content can be very large (megabytes)
- No size limit at database level
- Consider streaming for very large files (future enhancement)

### JSON Field Handling
- sources, content, inputData, outputData, alternativesConsidered are JSON
- Always stored as TEXT
- Always returned as string, caller must parse
- Invalid JSON is stored as-is (no validation)

### Concurrent Access
- WAL mode allows concurrent reads during writes
- Multiple agents can query simultaneously
- Writes are serialized (SQLite limitation)
- For this use case, contention is minimal

### Null vs Empty
- Empty array `[]` is stored as `"[]"` (valid JSON)
- Null is stored as SQL NULL
- Code should handle both cases

### Timestamp Format
- All timestamps are ISO 8601: `2025-01-15T10:30:00.000Z`
- SQLite's `datetime('now')` returns: `2025-01-15 10:30:00`
- For consistency, use `now()` from types.ts which returns ISO 8601

---

## Testing Strategy

### Unit Tests

**Connection Management**:
- getDb() creates database on first call
- getDb() returns same instance on subsequent calls
- closeDb() allows re-initialization
- Schema is created correctly

**CRUD Operations** (for each entity type):
- Create returns valid UUID
- Get by ID returns correct row
- Get by ID with nonexistent ID returns null
- Update modifies correct fields
- List queries return correct results
- Delete removes all related data

**Session Stats**:
- Returns zeros for empty session
- Counts are accurate after insertions
- Handles mixed statuses correctly

### Test Setup/Teardown

```
beforeEach:
  1. Initialize database
  2. Create test session

afterEach:
  1. Close database
  2. Delete .swarm/memory.db*
```

### Test Data Examples

**Finding**:
```json
{
  "sessionId": "<test-session-id>",
  "agent": "researcher",
  "claim": "TypeScript adoption increased 40% in 2024",
  "confidence": "high",
  "sources": ["https://stateofjs.com/2024"]
}
```

**Artifact**:
```json
{
  "sessionId": "<test-session-id>",
  "agent": "developer",
  "artifactType": "code",
  "filepath": "src/utils.ts",
  "content": "export function add(a: number, b: number): number { return a + b; }",
  "summary": "Math utility functions"
}
```

**Task**:
```json
{
  "sessionId": "<test-session-id>",
  "assignedTo": "developer",
  "description": "Implement rate limiter middleware",
  "priority": "high",
  "inputData": { "maxRequests": 100, "windowMs": 60000 }
}
```

### Manual Verification

Use SQLite CLI to inspect:
```bash
sqlite3 .swarm/memory.db

-- List tables
.tables

-- Check schema
.schema findings

-- Query data
SELECT * FROM sessions;
SELECT COUNT(*) FROM findings WHERE session_id = 'xxx';

-- Check indexes
.indexes
```

---

## Configuration

### Database Location
Fixed at `.swarm/memory.db`. Not configurable.

Rationale: Simplicity. Configuration adds complexity for little benefit.

### SQLite PRAGMAs

| PRAGMA | Value | Rationale |
|--------|-------|-----------|
| journal_mode | WAL | Better concurrent read performance |
| foreign_keys | ON | Enforce referential integrity |

### Not Configured
- Page size (use SQLite default)
- Cache size (use SQLite default)
- Synchronous mode (use SQLite default: FULL for safety)

---

## Integration Points

### Used By

| Module | Usage |
|--------|-------|
| orchestrator.ts | Creates sessions, tracks tasks, synthesizes results |
| message-bus.ts | Persists messages for audit trail |
| workflows/*.ts | Query task status, store findings |
| CLI (swarm.ts) | Display session status, cleanup old sessions |

### Dependencies

| Dependency | Purpose |
|------------|---------|
| types.ts | Type definitions, generateId(), now() |
| bun:sqlite | Database driver (built into Bun) |
| fs | Directory creation (existsSync, mkdirSync) |

---

## Open Questions & Decisions

### Decided
- **SQLite vs PostgreSQL**: SQLite chosen for zero-config, file-based simplicity
- **WAL Mode**: Enabled for better read concurrency
- **Snake_case Columns**: SQLite convention, matches Row types
- **JSON as TEXT**: Simple, no special handling needed
- **No ORM**: Direct SQL for transparency and control

### Trade-offs Made
- **No transactions for creates**: Single inserts don't need transactions. Batch operations could benefit but aren't in current design.
- **No connection pooling**: Single connection is sufficient for this use case
- **No migrations**: Schema changes require database deletion and recreation

### Future Considerations
- Add full-text search for findings/decisions
- Add database backup/export functionality
- Consider SQLite extensions for JSON querying (json1)

---

## Implementation Checklist

- [ ] Create `src/db.ts` with all functions
- [ ] Verify schema creation with `sqlite3` CLI
- [ ] Write unit tests in `src/db.test.ts`
- [ ] Run `bun test src/db.test.ts` - all tests pass
- [ ] Verify WAL mode: `PRAGMA journal_mode` returns 'wal'
- [ ] Test foreign key constraint enforcement
- [ ] Verify getSessionStats returns correct counts
- [ ] Test deleteSession removes all related data
- [ ] Confirm indexes are created

---

## Next Step

After completing the database layer, proceed to **Step 3: Message Bus** which builds on this layer for message persistence while providing file-based inter-agent communication.
