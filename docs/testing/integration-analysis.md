# Claude Swarm Integration Analysis

This document provides a comprehensive analysis of end-to-end integration flows and cross-module interactions in the Claude Swarm system.

## Table of Contents

1. [Session Lifecycle Flow](#session-lifecycle-flow)
2. [Agent Communication Flow](#agent-communication-flow)
3. [Error Recovery Flow](#error-recovery-flow)
4. [Cleanup Flow](#cleanup-flow)
5. [Cross-Module Issues](#cross-module-issues)
6. [Harmful Scenarios](#harmful-scenarios)
7. [Recommendations](#recommendations)

---

## Session Lifecycle Flow

**Path:** CLI -> Orchestrator -> TmuxManager -> WorktreeManager -> MessageBus -> Database

### Flow Analysis

#### 1. CLI Entry (`swarm.ts`)

The session begins at the CLI when `handleStart()` is invoked:

```typescript
// src/swarm.ts:746-822
const orchestrator = createOrchestrator(orchestratorConfig);
activeOrchestrator = orchestrator;
subscribeToEvents(orchestrator);
const result = await orchestrator.startWorkflow(workflow, goal);
```

**Handoff Points:**
- CLI validates workflow type against `VALID_WORKFLOWS`
- CLI checks for existing swarm sessions via `tmux.listSwarmSessions()`
- Creates `OrchestratorConfig` and passes to `createOrchestrator()`

**Potential Issues:**
- **CRITICAL**: No atomic check-and-create for sessions - race condition if two CLIs start simultaneously
- The `activeOrchestrator` global variable only tracks one orchestrator per process

#### 2. Orchestrator Initialization (`orchestrator.ts`)

```typescript
// src/orchestrator.ts:329-486
async startWorkflow(type: string, goal: string): Promise<Result<Session, OrchestratorError>>
```

**Sequence:**
1. Validates no session already running (`this.session?.status === 'running'`)
2. Validates workflow template exists via `getWorkflowTemplate(type)`
3. Generates session ID if not provided
4. Creates workflow instance via `createWorkflowInstance()`
5. Calls `initializeResources()` - creates directories, initializes message bus
6. Stores session in database via `db.createSession()`
7. Creates tmux session via `tmux.createSession()`
8. Gets active agents via `getActiveAgents()`
9. Creates worktrees via `worktree.createWorktrees()`
10. Spawns agents via `spawnAgent()` for each role
11. Creates initial task message via `createInitialTaskMessage()`
12. Sends task to entry agent via `messageBus.sendMessage()`
13. Updates session status to 'running'
14. Starts monitoring loop

**Potential Issues:**
- **HIGH**: Partial initialization can leave orphaned resources. If step 9 fails after step 7 succeeds, tmux session remains.
- **MEDIUM**: Database session created before tmux/worktrees - DB shows session that never fully initialized
- **LOW**: `initializeResources()` is called before tmux session but creates MessageBus directories - timing dependency

#### 3. Tmux Session Creation (`managers/tmux.ts`)

```typescript
// src/managers/tmux.ts:268-286
export async function createSession(name: string): Promise<Result<void, TmuxError>>
```

**Handoff Points:**
- Session name validated against `SESSION_NAME_PATTERN`
- Checks for existing session via `sessionExists()`
- Creates detached session with `tmux new-session -d -s`

**Potential Issues:**
- **MEDIUM**: `sessionExists()` calls `listSessions()` - separate call from creation, race condition window
- **LOW**: No locking mechanism on session name

#### 4. Worktree Creation (`managers/worktree.ts`)

```typescript
// src/managers/worktree.ts:465-494
export async function createWorktrees(
  roles: AgentRole[],
  options: { sessionId: string; baseBranch?: string }
): Promise<Result<Map<AgentRole, string>, WorktreeError>>
```

**Handoff Points:**
- Creates worktrees atomically for all roles
- On failure, rolls back all previously created worktrees
- Copies CLAUDE.md role config to each worktree

**Potential Issues:**
- **MEDIUM**: Rollback via `removeWorktree()` with `force: true` - could fail silently
- **LOW**: Branch name generation uses `sessionId` - collisions if same sessionId reused

#### 5. Agent Spawning (`orchestrator.ts`)

```typescript
// src/orchestrator.ts:594-626
async spawnAgent(role: AgentRole): Promise<Result<ManagedAgent, OrchestratorError>>
```

**Sequence:**
1. Uses `withRetry()` for resilient spawning (max 2 retries)
2. Creates tmux pane via `tmux.createPane()`
3. Starts Claude Code via `tmux.startClaudeCode()`
4. Waits for ready state via `waitForAgentReady()`
5. Initializes outbox state tracking

**Potential Issues:**
- **HIGH**: `waitForAgentReady()` polls for ready indicators but Claude Code may not match patterns
- **MEDIUM**: Retry mechanism doesn't clean up partial spawn (pane created but Claude not started)

#### 6. Message Bus Initialization (`message-bus.ts`)

```typescript
// src/message-bus.ts:141-155
export function initializeAgentQueues(): void
```

**Handoff Points:**
- Creates inbox/outbox JSON files for all valid agents
- Called from `orchestrator.initializeResources()`

**Potential Issues:**
- **MEDIUM**: File-based queue - not atomic, possible corruption with concurrent writers
- **LOW**: `VALID_AGENTS` includes 'orchestrator' which doesn't have a spawned agent

#### 7. Database Session Storage (`db.ts`)

```typescript
// src/db.ts:492-512
export function createSession(input: CreateSessionInput): SwarmSession
```

**Handoff Points:**
- Creates session record with 'initializing' status
- Uses SQLite with WAL mode

**Potential Issues:**
- **LOW**: Session created before full initialization - orphan records possible
- **LOW**: `agents` Map is runtime-only, not persisted

### Failure Modes

| Step | Failure | State Left Behind | Recovery |
|------|---------|-------------------|----------|
| tmux.createSession | Session exists | None | User must `tmux kill-session` |
| worktree.createWorktrees | Git error | Partial worktrees | Manual `git worktree remove` |
| spawnAgent | Pane creation fails | tmux session, worktrees | `orchestrator.cleanup()` |
| spawnAgent | Claude Code fails | Pane exists, worktrees | Retry then cleanup |
| messageBus.sendMessage | File write fails | Partial initialization | Session fails to start |

---

## Agent Communication Flow

**Path:** Agent A -> MessageBus -> Orchestrator -> WorkflowEngine -> Agent B

### Flow Analysis

#### 1. Agent Message Production

Agents write to their outbox via the message bus:

```typescript
// src/message-bus.ts:383-422
export function sendMessage(input: SendMessageInput, options?: SendOptions): AgentMessage
```

**Sequence:**
1. Creates message with unique ID and timestamp
2. Adds to sender's outbox file
3. Routes to recipient's inbox (or all inboxes for broadcast)
4. Optionally persists to database

**Potential Issues:**
- **HIGH**: No ordering guarantees - messages written to separate files
- **HIGH**: Write is not atomic - `readMessagesFile()` + `push()` + `writeMessagesFile()` race condition
- **MEDIUM**: Broadcast sends to all agents including sender's own inbox excluded - off-by-one logic

#### 2. Orchestrator Outbox Monitoring

```typescript
// src/orchestrator.ts:1409-1434
private async checkOutboxes(): Promise<void>
```

**Sequence:**
1. For each agent, check outbox for new messages since last read timestamp
2. Update agent message count and activity timestamp
3. Route each new message via `routeMessage()`
4. Update outbox state with last processed timestamp

**Potential Issues:**
- **CRITICAL**: `getNewOutboxMessages()` filters by timestamp, but clock skew between processes could cause missed messages
- **HIGH**: No message acknowledgment - if routing fails, message is lost
- **MEDIUM**: Polling interval (`monitorInterval`) is configurable but defaults to 5 seconds - latency

#### 3. Message Routing (`orchestrator.ts`)

```typescript
// src/orchestrator.ts:829-917
async routeMessage(from: AgentRole, message: AgentMessage): Promise<Result<void, OrchestratorError>>
```

**Sequence:**
1. Logs message to database
2. Completes current workflow step via `completeStep()`
3. Gets routing decision from engine via `engineRouteMessage()`
4. Applies routing decisions (sends to target inbox)
5. Transitions workflow if needed
6. Creates checkpoint on stage transition
7. Checks for workflow completion

**Potential Issues:**
- **HIGH**: `completeStep()` called before routing decision - step marked complete even if routing fails
- **MEDIUM**: Multiple routing decisions possible but processed sequentially
- **LOW**: Checkpoint creation is async but not awaited in error path

#### 4. Workflow Engine Routing (`workflows/engine.ts`)

```typescript
// src/workflows/engine.ts:521-603
export function routeMessage(
  instance: WorkflowInstance,
  message: AgentMessage
): Result<RoutingDecision[], WorkflowError>
```

**Sequence:**
1. Gets template and current step definition
2. Extracts verdict from message metadata
3. Determines next step via `getNextStep()`
4. Creates routing decision with transformed message
5. Returns array of routing decisions

**Potential Issues:**
- **MEDIUM**: Verdict extraction relies on `message.content.metadata?.verdict` - no validation
- **LOW**: Creates new message ID for routed message - original ID lost

#### 5. Target Agent Message Delivery

```typescript
// src/orchestrator.ts:1439-1481
private async applyRoutingDecision(from: AgentRole, decision: RoutingDecision): Promise<void>
```

**Sequence:**
1. Finds target agent in session
2. Sends message to target inbox via `messageBus.sendMessage()`
3. Emits `message_routed` event

**Potential Issues:**
- **HIGH**: If target agent not found, error is recorded but processing continues
- **MEDIUM**: No retry mechanism for delivery failures

### Message Ordering Guarantees

**Current State:** No strict ordering guarantees exist.

1. **Within an agent's inbox:** Messages are appended to a JSON array - insertion order preserved
2. **Cross-agent:** No guarantee - dependent on orchestrator polling order
3. **After recovery:** Messages replayed from checkpoint may duplicate or miss messages

### Failure Modes

| Component | Failure | Impact | Detection |
|-----------|---------|--------|-----------|
| Outbox write | File lock/permission | Message lost | Error in agent |
| Inbox read | JSON parse error | Queue corruption | `console.warn` only |
| Routing | Target agent missing | Message orphaned | `SessionError` logged |
| Workflow transition | Invalid step | Workflow stuck | `WorkflowError` |

---

## Error Recovery Flow

**Path:** Error -> ErrorHandling -> Orchestrator -> Checkpoint -> Recovery

### Flow Analysis

#### 1. Error Detection

Errors are detected at multiple points:

```typescript
// src/orchestrator.ts:975-1048
async checkAgentHealth(role: AgentRole): Promise<AgentStatus>
```

**Detection Points:**
- Agent timeout (no activity beyond `agentTimeout`)
- Routing failures
- Workflow transition failures
- System errors (tmux, worktree, database)

#### 2. SwarmError Creation (`error-handling.ts`)

```typescript
// src/error-handling.ts:322-378
export function createSwarmError(
  code: string,
  options: { message?: string; details?: string; component: string; ... }
): SwarmError
```

**Error Properties:**
- Code (from `ALL_ERROR_CODES`)
- Category, severity
- Recoverable and retryable flags
- Context information

**Potential Issues:**
- **LOW**: Unknown error codes create generic 'SYSTEM_ERROR' - may lose specificity

#### 3. Recovery Strategy Selection

```typescript
// src/error-handling.ts:947-993
export function selectStrategy(
  error: SwarmError,
  context: RecoveryContext
): RecoveryPlan
```

**Strategy Selection:**
1. Matches error code against `RECOVERY_STRATEGIES`
2. Evaluates condition if present
3. Returns plan with actions and fallback
4. Defaults to retry/escalate/abort based on error properties

**Potential Issues:**
- **MEDIUM**: Strategy conditions not extensively used - most match on code alone
- **LOW**: Fallback strategy creates synthetic error code (`FALLBACK_${code}`)

#### 4. Recovery Execution

```typescript
// src/error-handling.ts:1121-1192
export async function executeRecovery(
  error: SwarmError,
  plan: RecoveryPlan,
  context: RecoveryContext
): Promise<RecoveryOutcome>
```

**Sequence:**
1. Updates attempt history
2. Executes each action in plan
3. On failure, tries fallback strategy if available
4. Returns outcome with success/failure and actions executed

**Potential Issues:**
- **HIGH**: Many action executors not registered - `execute` and `cleanup` types just log intent
- **MEDIUM**: No rollback if partial action execution fails
- **LOW**: Fallback plan actions may not be appropriate for original error

#### 5. Checkpointing

```typescript
// src/error-handling.ts:1734-1757
export async function checkpointOnStage(
  sessionId: string,
  stageName: string,
  state: { ... }
): Promise<void>
```

**Checkpoint Contents:**
- Workflow state (current step, status)
- Agent states (role, status, message count)
- Message queue state (inbox/outbox counts)
- Completed/pending stages
- Errors and recovery attempts

**Potential Issues:**
- **MEDIUM**: Map serialization converts to object - deserialization must reconstruct Map
- **LOW**: `SwarmError` context may contain non-serializable values

#### 6. Session Recovery

```typescript
// src/error-handling.ts:1828-1940
export async function recoverSession(
  sessionId: string,
  options: RecoveryOptions
): Promise<SessionRecoveryResult>
```

**Recovery Options:**
- `checkpointId`: Specific checkpoint to restore from
- `skipFailedStage`: Skip the stage that caused failure
- `resetAgents`: Fresh restart all agents
- `preserveMessages`: Keep or clear message queues

**Potential Issues:**
- **CRITICAL**: No actual agent respawn implemented - returns restoration info only
- **HIGH**: Message queue state is count-based, not message-based - can't replay
- **MEDIUM**: `processedMessageIds` not populated in checkpoints

### End-to-End Recovery Verification

**Current State:** Recovery is partially implemented.

| Aspect | Implemented | Gap |
|--------|-------------|-----|
| Checkpoint creation | Yes | Called on stage transitions |
| Checkpoint storage | Yes | SQLite with JSON serialization |
| Checkpoint loading | Yes | Latest or by ID |
| State restoration | Partial | Returns restoration info, doesn't execute |
| Agent respawn | No | Must be done by orchestrator |
| Message replay | No | Only counts preserved |
| Workflow resume | No | Would need state reconstruction |

---

## Cleanup Flow

**Path:** Stop/Kill -> Orchestrator -> (Tmux + Worktree + MessageBus + DB)

### Flow Analysis

#### 1. Graceful Stop (`orchestrator.ts`)

```typescript
// src/orchestrator.ts:491-528
async stop(): Promise<Result<SessionResult, OrchestratorError>>
```

**Sequence:**
1. Stop monitoring loop
2. Mark session as 'cancelled'
3. Synthesize results from current state
4. Cleanup if `autoCleanup` enabled

#### 2. Force Kill (`orchestrator.ts`)

```typescript
// src/orchestrator.ts:533-541
async kill(): Promise<void>
```

**Sequence:**
1. Stop monitoring
2. Mark session as 'failed'
3. Execute cleanup

#### 3. Cleanup Implementation

```typescript
// src/orchestrator.ts:1190-1225
async cleanup(): Promise<void>
```

**Operation Order:**
1. Stop monitoring loop
2. Terminate all agents gracefully
3. Kill tmux session
4. Remove all worktrees
5. Prune worktree references
6. Clear message queues (if `autoCleanup`)
7. Emit `session_ended` event

**Potential Issues:**
- **HIGH**: No error handling - if `terminateAgentGracefully()` throws, subsequent cleanup skipped
- **MEDIUM**: `killSession()` is idempotent but subsequent steps assume it succeeded
- **MEDIUM**: Database session not updated to final status in cleanup

#### 4. Agent Termination

```typescript
// src/orchestrator.ts:1341-1362
private async terminateAgentGracefully(agent: ManagedAgent): Promise<void>
```

**Sequence:**
1. Send Ctrl+C interrupt
2. Wait 1 second
3. Check if terminated
4. Send second Ctrl+C if needed
5. Kill the pane

**Potential Issues:**
- **MEDIUM**: Relies on shell prompt detection (`$`) - may not work for all shells
- **LOW**: Fixed 1 second wait - may be too short for complex operations

#### 5. Worktree Removal (`managers/worktree.ts`)

```typescript
// src/managers/worktree.ts:639-657
export async function removeAllWorktrees(
  options?: { force?: boolean; deleteBranches?: boolean }
): Promise<Result<number, WorktreeError>>
```

**Potential Issues:**
- **MEDIUM**: Individual removal failures continue - returns count of successful removals
- **LOW**: Branches may linger if worktree removal succeeds but branch deletion fails

#### 6. Message Queue Cleanup

```typescript
// src/message-bus.ts:160-170
export function clearAllQueues(): void
```

**Potential Issues:**
- **LOW**: Files cleared but not deleted - empty JSON arrays remain

### Partial Cleanup Scenarios

| Interruption Point | Orphaned Resources |
|--------------------|--------------------|
| After step 2, before step 3 | Agents terminated, tmux session exists, worktrees exist |
| After step 3, before step 4 | Tmux gone, worktrees exist, branches exist |
| After step 4, before step 5 | Worktrees gone, git references may be stale |
| During agent termination | Some agents running, some terminated |

---

## Cross-Module Issues

### 1. Type Mismatches Between Modules

| Module A | Module B | Mismatch | Severity |
|----------|----------|----------|----------|
| `types.ts` | `orchestrator.ts` | `AgentStatus` redefined (5 vs 8 states) | MEDIUM |
| `types.ts` | `message-bus.ts` | `StatusType` different from `AgentStatus` | LOW |
| `types.ts` | `db.ts` | `WorkflowType` doesn't include all template names | LOW |
| `templates.ts` | `role-loader.ts` | `VALID_ROLES` vs template roles inconsistent | MEDIUM |

**Details:**

`types.ts` defines:
```typescript
export type AgentStatus = 'starting' | 'running' | 'complete' | 'error' | 'idle';
```

`orchestrator.ts` defines:
```typescript
export type AgentStatus = 'spawning' | 'starting' | 'ready' | 'working' | 'complete' | 'blocked' | 'error' | 'terminated';
```

### 2. Inconsistent Error Handling Patterns

| Module | Pattern | Issue |
|--------|---------|-------|
| `swarm.ts` | Throws `CLIError` objects | Custom error type, different from `SwarmError` |
| `orchestrator.ts` | Returns `Result<T, OrchestratorError>` | Different error type from `SwarmError` |
| `managers/tmux.ts` | Returns `Result<T, TmuxError>` | Yet another error type |
| `managers/worktree.ts` | Returns `Result<T, WorktreeError>` | Another error type |
| `workflows/templates.ts` | Returns `Result<T, WorkflowError>` | Another error type |
| `error-handling.ts` | Uses `SwarmError` | Unified error type not used elsewhere |

**Impact:** Error conversion is required at module boundaries. `wrapError()` exists but is rarely used.

### 3. Shared State Race Conditions

#### Message Bus File Access

```typescript
// src/message-bus.ts:76-93
function readMessagesFile(path: string): AgentMessage[] {
  const content = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(content);
  // ...
}
```

**Race Condition:** Multiple agents reading/writing same inbox file simultaneously.

**Scenario:**
1. Agent A reads inbox (5 messages)
2. Agent B adds message to same inbox
3. Agent A writes modified inbox (still 5 messages)
4. Agent B's message lost

#### Orchestrator Session State

```typescript
// src/orchestrator.ts:288-298
private session: Session | null = null;
```

**Race Condition:** Session state modified from multiple async paths (monitoring loop, message routing, cleanup).

### 4. Circular Dependencies

No direct circular imports detected, but conceptual coupling exists:

- `orchestrator.ts` imports from `error-handling.ts`
- `error-handling.ts` logs to `db.ts`
- `db.ts` is used by `orchestrator.ts`

This creates a tight coupling where changes to one module ripple through others.

### 5. Module Initialization Order Dependencies

**Required Order:**
1. `db.ts` must be initialized before any database operations
2. `message-bus.ts` directories must exist before message operations
3. Git repository must be valid before worktree operations
4. tmux must be available before session creation

**Potential Issues:**
- No explicit initialization sequence validation
- `getDb()` is lazy - may fail late in execution
- `ensureMessageDirs()` called in `sendMessage()` but not in read operations

### 6. Configuration Inconsistencies

| Configuration | Location | Default | Issue |
|---------------|----------|---------|-------|
| `agentTimeout` | `orchestrator.ts` | 300000ms | Different from step-level timeouts |
| `workflowTimeout` | `orchestrator.ts` | 1800000ms | May conflict with template `maxDuration` |
| `maxAgents` | `orchestrator.ts` | 4 | Not enforced against workflow roles |
| `monitorInterval` | `orchestrator.ts` | 5000ms | Fixed polling, not adaptive |

---

## Harmful Scenarios

### 1. System Crash Mid-Operation

**Scenario:** Process crashes during `orchestrator.startWorkflow()`.

**State Left:**
- Database session in 'initializing' status
- Tmux session may exist (if created before crash)
- Worktrees may partially exist
- Message queue files may be corrupted (mid-write)
- Git branches created but orphaned

**Detection:**
- Session with 'initializing' status older than reasonable startup time
- Orphan tmux sessions with `swarm_` prefix
- Orphan worktrees in `.worktrees/` directory
- Orphan branches with `swarm/` prefix

**Mitigation:**
```bash
# Manual cleanup steps
tmux kill-session -t swarm_*
git worktree prune
git branch -D swarm/*
rm -rf .worktrees .swarm/messages
```

### 2. Disk Fills Up

**Scenario:** Disk space exhausted during operation.

**Affected Operations:**
- SQLite WAL file growth (can be significant)
- Message queue JSON files
- Worktree creation
- Log files

**State Left:**
- Corrupted SQLite database (partial write)
- Truncated JSON message files
- Incomplete worktree (git corruption possible)

**Detection:**
```typescript
// Check for SQLite corruption
const db = getDb();
const result = db.query('PRAGMA integrity_check').get();
// Should return "ok"
```

**Mitigation:**
- Implement disk space check before operations
- Use temp files with atomic rename (already done for messages)
- Set SQLite page size and cache limits

### 3. Multiple Swarm Instances Running

**Scenario:** User runs `bun swarm.ts start` twice simultaneously.

**Issues:**
- Session ID collision (timestamp-based, millisecond resolution)
- tmux session name conflict (race condition)
- Worktree path conflicts
- Message queue file contention

**Detection:**
```typescript
// In handleStart()
const swarmSessions = await tmux.listSwarmSessions();
if (swarmSessions.length > 0 && !args.options['force']) {
  // Error handling
}
```

**Gap:** Check is not atomic with session creation.

**Mitigation:**
- Use file lock or SQLite lock for exclusive session creation
- Generate truly unique session IDs (UUID instead of timestamp)

### 4. Network Filesystem Usage

**Scenario:** Repository on NFS or other network filesystem.

**Issues:**
- File locking not reliable on NFS
- Atomic rename may not be truly atomic
- Git worktree operations may fail
- SQLite may corrupt on network filesystems

**Detection:**
```bash
# Check filesystem type
df -T /path/to/repo
```

**State Left:**
- Split-brain scenarios with stale NFS cache
- Git lock files persisting incorrectly
- SQLite WAL file corruption

**Mitigation:**
- Detect network filesystem and warn
- Use SQLite with `PRAGMA locking_mode=EXCLUSIVE`
- Avoid file-based message bus on network filesystems

### 5. Agent Process Becomes Zombie

**Scenario:** Claude Code hangs or becomes unresponsive.

**Detection:**
```typescript
// In checkAgentHealth()
const lastActivity = new Date(agent.lastActivityAt).getTime();
if (Date.now() - lastActivity > this._config.agentTimeout) {
  // Timeout handling
}
```

**State Left:**
- Zombie tmux pane consuming resources
- Locked worktree files
- Incomplete message in outbox

**Current Behavior:**
- Timeout triggers recovery strategy selection
- Agent marked as 'error'
- Recovery execution mostly logs intent

**Gap:** No actual agent restart implemented.

### 6. Concurrent Worktree Operations

**Scenario:** Multiple agents try to commit to their worktrees simultaneously.

**Issues:**
- Git index lock contention
- Potential merge conflicts if sharing branches (shouldn't happen with isolation)
- Race in `hasUncommittedChanges()` check

**Detection:**
```bash
# Look for stale lock files
find .worktrees -name "*.lock"
```

**Mitigation:**
- Each agent has isolated worktree and branch
- Git operations are per-worktree
- Lock files should be cleaned up on git operation completion

---

## Recommendations

### Critical Priority

1. **Implement atomic session creation**
   - Use SQLite transaction to reserve session ID
   - Create tmux session with unique name derived from DB ID
   - Rollback DB if tmux creation fails

2. **Complete recovery implementation**
   - Register action executors for all recovery actions
   - Implement actual agent respawn in recovery
   - Add message replay capability

3. **Fix message bus race conditions**
   - Use file locking for queue operations
   - Or migrate to SQLite-based message queue

### High Priority

4. **Unify error types**
   - Convert all module errors to `SwarmError`
   - Use `wrapError()` at module boundaries
   - Standardize error codes across modules

5. **Add cleanup transaction**
   - Wrap cleanup in try/catch per resource
   - Track cleanup state for resume on failure
   - Update database with cleanup status

6. **Implement health monitoring**
   - Active process checking for agents
   - Heartbeat mechanism for long-running operations
   - Adaptive polling based on activity

### Medium Priority

7. **Standardize type definitions**
   - Single source of truth for `AgentStatus`
   - Align `WorkflowType` with template names
   - Export all shared types from `types.ts`

8. **Add initialization validation**
   - Check prerequisites before operations
   - Validate module dependencies on startup
   - Fail fast with clear error messages

9. **Improve checkpoint completeness**
   - Store actual messages, not just counts
   - Include `processedMessageIds` in checkpoints
   - Add checkpoint verification

### Low Priority

10. **Configuration consolidation**
    - Single config source for timeouts
    - Environment variable overrides documented
    - Runtime config validation

11. **Add observability**
    - Structured logging with correlation IDs
    - Metrics for operation durations
    - Distributed tracing for agent interactions

12. **Documentation improvements**
    - API documentation for each module
    - Sequence diagrams for main flows
    - Failure mode documentation

---

## Appendix: File References

| File | Lines | Purpose |
|------|-------|---------|
| `src/swarm.ts` | 1657 | CLI entry point |
| `src/orchestrator.ts` | 1679 | Session and agent coordination |
| `src/types.ts` | 374 | Shared type definitions |
| `src/db.ts` | 994 | SQLite database layer |
| `src/message-bus.ts` | 706 | File-based IPC |
| `src/managers/tmux.ts` | 923 | tmux wrapper |
| `src/managers/worktree.ts` | 962 | Git worktree management |
| `src/error-handling.ts` | 2375 | Error and recovery system |
| `src/workflows/engine.ts` | 797 | Workflow execution |
| `src/workflows/templates.ts` | 1009 | Workflow definitions |
| `src/agents/role-loader.ts` | 456 | Role configuration loading |

---

*Analysis generated: 2025-12-29*
