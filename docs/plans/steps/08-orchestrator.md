# Step 8: Orchestrator - Architectural Plan

## 1. Overview & Purpose

### What This Component Does

The Orchestrator is the central coordination component that manages the entire lifecycle of a multi-agent workflow. It spawns agents, routes messages between them, monitors progress, detects completion, and synthesizes final results. It is the integration point where all other components (tmux, worktrees, message bus, database, workflows) come together.

**IMPORTANT: SessionID Management**
The Orchestrator is the SINGLE SOURCE of sessionId generation. It generates ONE sessionId at workflow start (using Date.now().toString()) and passes it to ALL components:
- Tmux Manager: Uses sessionId for tmux session name (swarm_{sessionId})
- Worktree Manager: Uses sessionId for branch names (swarm/{role}-{sessionId})
- Message Bus: Uses sessionId for database persistence
- Database: Uses sessionId for session tracking

This ensures all resources created for a workflow share the same consistent identifier.

### Why It Exists

Without an orchestrator:
- Agents would have no one to spawn them
- Messages wouldn't be routed between agents
- There would be no progress monitoring or completion detection
- No synthesis of final results
- No cleanup of resources after completion

The Orchestrator provides:
- Unified agent lifecycle management
- Workflow execution engine
- Real-time message routing
- Progress monitoring and health checks
- Result aggregation and synthesis
- Graceful error handling and cleanup

### How It Fits Into The Larger System

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLI (swarm.ts)                            │
│  User runs: ./swarm start research "query"                      │
│  Creates Orchestrator instance, calls startWorkflow()           │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      ORCHESTRATOR                                │
│  src/orchestrator.ts                                             │
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │   Workflow  │  │   Agent     │  │   Monitor   │              │
│  │   Engine    │  │   Manager   │  │   Loop      │              │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘              │
│         │                │                │                      │
└─────────┼────────────────┼────────────────┼──────────────────────┘
          │                │                │
          ▼                ▼                ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  Workflows   │  │ Tmux Manager │  │ Message Bus  │
│  (Step 7)    │  │ (Step 4)     │  │ (Step 3)     │
└──────────────┘  └──────────────┘  └──────────────┘
                         │
                         ▼
                  ┌──────────────┐
                  │  Worktree    │
                  │  Manager     │
                  │  (Step 5)    │
                  └──────────────┘
```

### Problems It Solves

1. **Agent Lifecycle**: Spawns, monitors, and terminates agents
2. **Workflow Execution**: Follows workflow stages and transitions
3. **Message Routing**: Routes messages between agents based on workflow rules
4. **Progress Tracking**: Monitors agent activity and workflow progress
5. **Completion Detection**: Knows when workflow is done
6. **Result Synthesis**: Aggregates outputs into final deliverable
7. **Resource Cleanup**: Ensures worktrees and tmux sessions are cleaned up

---

## 2. Prerequisites & Dependencies

### External Dependencies

| Dependency | Version | Purpose |
|------------|---------|---------|
| Bun | 1.0+ | Runtime, async handling, timers |
| tmux | 2.0+ | Via tmux-manager |
| git | 2.20+ | Via worktree-manager |

### Internal Dependencies

| Module | Purpose |
|--------|---------|
| `src/types.ts` | Shared types (`AgentRole`, `AgentMessage`, `AgentInfo`) |
| `src/tmux-manager.ts` | Session and pane management |
| `src/worktree-manager.ts` | Agent workspace creation |
| `src/message-bus.ts` | Inter-agent communication |
| `src/db.ts` | Persistent state storage |
| `src/workflows/*.ts` | Workflow definitions and routing logic |

### System State Requirements

- tmux must be available
- Git repository must exist with at least one commit
- Role configurations must exist in `roles/` directory
- `.swarm/` directory created (or creatable)

---

## 3. Public API Design

### Type Definitions

```typescript
// ============================================
// Orchestrator Configuration
// ============================================

interface OrchestratorConfig {
  // Session identification
  sessionId?: string;              // Custom session ID (auto-generated if omitted)

  // Timing configuration
  monitorInterval?: number;        // How often to check agents (ms), default 5000
  agentTimeout?: number;           // Max time for agent response (ms), default 300000
  workflowTimeout?: number;        // Max total workflow time (ms), default 1800000

  // Behavior configuration
  autoCleanup?: boolean;           // Clean up on completion, default true
  captureOutput?: boolean;         // Capture agent terminal output, default true
  verboseLogging?: boolean;        // Detailed logging, default false

  // Resource limits
  maxAgents?: number;              // Maximum concurrent agents, default 4
  maxRetries?: number;             // Retries per agent operation, default 3
}

// Default configuration values
const DEFAULT_CONFIG: Required<OrchestratorConfig> = {
  sessionId: '',                   // Generated if empty
  monitorInterval: 5000,
  agentTimeout: 300000,            // 5 minutes
  workflowTimeout: 1800000,        // 30 minutes
  autoCleanup: true,
  captureOutput: true,
  verboseLogging: false,
  maxAgents: 4,
  maxRetries: 3
};


// ============================================
// Agent Management Types
// ============================================

interface ManagedAgent {
  role: AgentRole;
  paneId: string;                  // tmux pane identifier
  worktreePath: string;            // Path to agent's worktree
  status: AgentStatus;
  spawnedAt: string;               // ISO8601
  lastActivityAt: string;          // ISO8601
  lastCapturedOutput?: string;     // Recent terminal output
  messageCount: number;            // Messages processed
  errorCount: number;              // Errors encountered
}

type AgentStatus =
  | 'spawning'      // Being created
  | 'starting'      // tmux pane created, Claude Code starting
  | 'ready'         // Claude Code running, waiting for input
  | 'working'       // Processing a task
  | 'complete'      // Signaled completion
  | 'blocked'       // Waiting on external input
  | 'error'         // Encountered an error
  | 'terminated';   // Shut down


// ============================================
// Session Types
// ============================================

interface Session {
  id: string;                      // Session identifier
  workflowType: string;            // 'research', 'development', 'architecture'
  goal: string;                    // User's goal/query
  status: SessionStatus;
  startedAt: string;
  completedAt?: string;
  agents: Map<AgentRole, ManagedAgent>;
  workflowState: WorkflowState;    // From workflows/types.ts
  result?: SessionResult;
}

type SessionStatus =
  | 'initializing'  // Setting up resources
  | 'running'       // Workflow executing
  | 'synthesizing'  // Creating final output
  | 'complete'      // Successfully finished
  | 'failed'        // Encountered fatal error
  | 'cancelled';    // User cancelled

interface SessionResult {
  success: boolean;
  summary: string;
  duration: number;                // Total time in ms
  agentSummaries: Map<AgentRole, AgentSummary>;
  artifacts: string[];             // Output file paths
  errors: SessionError[];
}

interface AgentSummary {
  role: AgentRole;
  messagesProduced: number;
  tasksCompleted: number;
  reviewsPerformed?: number;       // For reviewer
  findings?: number;               // For researcher
  artifacts?: string[];            // For developer/architect
}

interface SessionError {
  timestamp: string;
  agent?: AgentRole;
  type: 'agent_error' | 'routing_error' | 'timeout' | 'system_error';
  message: string;
  recoverable: boolean;
  recovered: boolean;
}


// ============================================
// Event Types
// ============================================

type OrchestratorEvent =
  | { type: 'session_started'; sessionId: string; workflow: string }
  | { type: 'agent_spawned'; role: AgentRole; paneId: string }
  | { type: 'agent_ready'; role: AgentRole }
  | { type: 'agent_working'; role: AgentRole; task: string }
  | { type: 'agent_complete'; role: AgentRole; summary: string }
  | { type: 'agent_error'; role: AgentRole; error: string }
  | { type: 'message_routed'; from: AgentRole; to: AgentRole; type: string }
  | { type: 'stage_transition'; from: string; to: string }
  | { type: 'workflow_complete'; success: boolean }
  | { type: 'session_ended'; result: SessionResult };

type EventHandler = (event: OrchestratorEvent) => void;
```

### Orchestrator Class Interface

```typescript
class Orchestrator {
  // ==================
  // Constructor
  // ==================

  constructor(config?: OrchestratorConfig);


  // ==================
  // Session Lifecycle
  // ==================

  // Start a new workflow session
  startWorkflow(type: string, goal: string): Promise<Session>;

  // Stop the current session gracefully
  stop(): Promise<SessionResult>;

  // Force stop (immediate termination)
  kill(): Promise<void>;

  // Get current session status
  getSession(): Session | null;

  // Check if orchestrator is running
  isRunning(): boolean;


  // ==================
  // Agent Management
  // ==================

  // Spawn a single agent
  spawnAgent(role: AgentRole): Promise<ManagedAgent>;

  // Get agent info
  getAgent(role: AgentRole): ManagedAgent | undefined;

  // List all active agents
  listAgents(): ManagedAgent[];

  // Send a message to an agent
  sendToAgent(role: AgentRole, message: AgentMessage): Promise<void>;

  // Capture agent's current terminal output
  captureAgentOutput(role: AgentRole, lines?: number): Promise<string>;

  // Terminate a specific agent
  terminateAgent(role: AgentRole): Promise<void>;


  // ==================
  // Message Handling
  // ==================

  // Route a message according to workflow rules
  routeMessage(from: AgentRole, message: AgentMessage): Promise<void>;

  // Get pending messages for an agent
  getPendingMessages(role: AgentRole): AgentMessage[];

  // Get message history for session
  getMessageHistory(): AgentMessage[];


  // ==================
  // Monitoring
  // ==================

  // Start the monitoring loop
  startMonitoring(): void;

  // Stop the monitoring loop
  stopMonitoring(): void;

  // Check agent health (called by monitor loop)
  checkAgentHealth(role: AgentRole): Promise<AgentStatus>;

  // Get workflow progress percentage
  getProgress(): number;


  // ==================
  // Results
  // ==================

  // Synthesize results from all agents
  synthesizeResults(): Promise<SessionResult>;

  // Get results for a specific agent
  getAgentResults(role: AgentRole): Promise<any>;

  // Export results to file
  exportResults(format: 'json' | 'markdown'): Promise<string>;


  // ==================
  // Cleanup
  // ==================

  // Clean up all resources
  cleanup(): Promise<void>;

  // Clean up a specific agent's resources
  cleanupAgent(role: AgentRole): Promise<void>;


  // ==================
  // Events
  // ==================

  // Subscribe to orchestrator events
  on(handler: EventHandler): void;

  // Unsubscribe from events
  off(handler: EventHandler): void;

  // Emit an event
  private emit(event: OrchestratorEvent): void;


  // ==================
  // Properties
  // ==================

  readonly sessionId: string;
  readonly config: Required<OrchestratorConfig>;
}
```

---

## 4. Detailed Behavior Specifications

### `startWorkflow(type, goal)`

**Purpose**: Initialize and start a new multi-agent workflow.

**Parameters**:
- `type`: Workflow type ('research', 'development', 'architecture')
- `goal`: User's goal or query string

**Behavior**:

```
1. VALIDATE
   ├── Check no session already running
   ├── Validate workflow type exists
   └── Validate goal is non-empty

2. INITIALIZE
   ├── Generate session ID if not provided (Date.now().toString())
   │   NOTE: This is the SINGLE SOURCE of sessionId generation
   │   The same sessionId is passed to ALL components:
   │   - tmux manager (for session name: swarm_{sessionId})
   │   - worktree manager (for branch names: swarm/{role}-{sessionId})
   │   - message bus (for database persistence)
   │   - database (for session tracking)
   ├── Load workflow definition
   ├── Create workflow state
   ├── Initialize database connection
   └── Create .swarm/messages directories

3. CREATE TMUX SESSION
   ├── Call tmux.createSession(sessionId)
   │   NOTE: sessionId is passed, not generated by tmux manager
   └── Verify session created

4. CREATE WORKTREES
   ├── Get roles from workflow.getRoles()
   ├── Call worktree.createWorktrees(roles, { sessionId })
   │   NOTE: sessionId is passed, not generated by worktree manager
   └── Handle rollback if any fail

5. SPAWN AGENTS
   ├── For each role:
   │   ├── Create tmux pane
   │   ├── CD to worktree
   │   ├── Start 'claude --resume'
   │   └── Wait for ready signal
   └── Handle spawn failures

6. SEND INITIAL TASK
   ├── Call workflow.createInitialTask(goal)
   ├── Route to entry agent
   └── Update workflow state

7. START MONITORING
   ├── Start monitor loop
   └── Emit 'session_started' event

8. RETURN
   └── Return Session object
```

**Error Handling**:
- If any step fails after partial setup, rollback previous steps
- Cleanup worktrees if tmux session fails
- Kill tmux session if agent spawn fails
- Log all errors to session state

**Side Effects**:
- Creates tmux session
- Creates git worktrees
- Creates message queue files
- Writes to database

---

### `spawnAgent(role)`

**Purpose**: Create and initialize a single agent.

**Parameters**:
- `role`: The agent role to spawn

**Behavior**:

```
1. CHECK PREREQUISITES
   ├── Verify worktree exists for role
   ├── Verify CLAUDE.md exists in worktree
   └── Check agent not already spawned

2. CREATE TMUX PANE
   ├── Split window in session
   ├── Get pane ID
   └── Set pane title to role

3. INITIALIZE AGENT
   ├── Send: cd {worktreePath}
   ├── Wait 500ms for cd
   ├── Send: claude --resume
   └── Record spawn time

4. WAIT FOR READY
   ├── Poll pane output for Claude prompt
   ├── Timeout after agentTimeout
   └── Mark agent as 'ready' when detected

5. REGISTER AGENT
   ├── Create ManagedAgent record
   ├── Add to session.agents map
   └── Emit 'agent_spawned' event

6. RETURN
   └── Return ManagedAgent
```

**Ready Detection**:
```typescript
// Look for Claude Code prompt indicators in pane output
function detectAgentReady(output: string): boolean {
  const indicators = [
    '> ',           // Claude Code prompt
    'Claude Code',  // Startup banner
    'What would'    // "What would you like to do?"
  ];
  return indicators.some(i => output.includes(i));
}
```

---

### `routeMessage(from, message)`

**Purpose**: Route a message according to workflow rules.

**Parameters**:
- `from`: Agent role that produced the message
- `message`: The message to route

**Behavior**:

```
1. LOG MESSAGE
   ├── Store in database
   └── Add to session message history

2. GET ROUTING DECISION
   ├── Call workflow.routeMessage(from, message, state)
   └── Returns: RoutingDecision

3. APPLY ROUTING
   ├── For each message in decision.messages:
   │   ├── Write to target agent's inbox
   │   └── Emit 'message_routed' event
   │
   ├── If decision.stageTransition:
   │   ├── Update workflow state
   │   └── Emit 'stage_transition' event
   │
   └── If decision.updateAgentState:
       └── Update agent status

4. CHECK COMPLETION
   ├── Call workflow.isComplete(state)
   ├── If complete:
   │   └── Trigger synthesizeResults()
   └── Emit event as appropriate

5. HANDLE ERRORS
   ├── If routing fails, log error
   └── Attempt recovery or mark session failed
```

**Message Flow Example**:
```
Researcher produces 'finding' message
    │
    ▼
routeMessage('researcher', findingMsg)
    │
    ├── Log to database
    ├── Get routing: { to: 'reviewer', ... }
    ├── Write to .swarm/messages/inbox/reviewer.json
    ├── Update state: currentStage = 'verification'
    └── Emit 'message_routed' event
```

---

### `startMonitoring()`

**Purpose**: Start the continuous monitoring loop.

**Behavior**:

```
MONITOR LOOP (runs every config.monitorInterval):

1. FOR EACH AGENT:
   ├── Capture pane output
   ├── Check for new messages in outbox
   ├── Detect status changes
   └── Update lastActivityAt

2. CHECK OUTBOXES:
   ├── For each agent:
   │   ├── Read .swarm/messages/outbox/{role}.json
   │   ├── Find new messages (by timestamp)
   │   ├── For each new message:
   │   │   └── Call routeMessage()
   │   └── Mark messages as processed

3. HEALTH CHECKS:
   ├── Check for agent timeouts
   ├── Check for stuck agents (no activity)
   └── Check for error states

4. COMPLETION CHECK:
   └── If workflow.isComplete(state):
       ├── Stop monitoring
       └── Trigger synthesis

5. TIMEOUT CHECK:
   └── If elapsed > workflowTimeout:
       ├── Stop monitoring
       └── Handle timeout
```

**Outbox Monitoring**:
```typescript
interface OutboxState {
  role: AgentRole;
  lastReadTimestamp: string;
  lastMessageCount: number;
}

function checkOutbox(role: AgentRole, lastState: OutboxState): AgentMessage[] {
  const messages = messageBus.readMessages(role, 'outbox');
  const newMessages = messages.filter(m =>
    m.timestamp > lastState.lastReadTimestamp
  );
  return newMessages;
}
```

---

### `synthesizeResults()`

**Purpose**: Aggregate results from all agents into final output.

**Behavior**:

```
1. COLLECT OUTPUTS
   ├── Get all processed messages from state
   ├── Group by agent role
   └── Group by message type

2. EXTRACT ARTIFACTS
   ├── For each 'artifact' message:
   │   ├── Get file paths
   │   └── Collect to list
   │
   └── For each 'finding' message:
       └── Collect findings

3. GENERATE SUMMARY
   ├── Count by agent (messages, tasks)
   ├── List key outcomes
   └── Note any errors/issues

4. CALL WORKFLOW SYNTHESIS
   └── workflow.synthesizeResult(state)

5. CREATE SESSION RESULT
   ├── success: boolean
   ├── summary: string
   ├── duration: ms
   ├── agentSummaries: Map
   ├── artifacts: string[]
   └── errors: SessionError[]

6. SAVE TO DATABASE
   └── Store result in sessions table

7. EXPORT (optional)
   ├── Write outputs/{sessionId}/summary.md
   └── Copy artifacts to outputs/

8. RETURN
   └── SessionResult
```

**Summary Generation**:
```typescript
function generateSummary(state: WorkflowState): string {
  const { workflowName, stageHistory, processedMessageIds } = state;

  const stagesCompleted = stageHistory.filter(s => s.status === 'complete').length;
  const totalStages = stageHistory.length;

  let summary = `Workflow: ${workflowName}\n`;
  summary += `Stages completed: ${stagesCompleted}/${totalStages}\n`;
  summary += `Messages processed: ${processedMessageIds.size}\n`;

  // Add role-specific summaries
  // ...

  return summary;
}
```

---

### `cleanup()`

**Purpose**: Clean up all resources used by the session.

**Behavior**:

```
1. STOP MONITORING
   └── Clear monitor interval

2. TERMINATE AGENTS
   ├── For each agent:
   │   ├── Send Ctrl+C to pane (if Claude running)
   │   ├── Wait for graceful exit
   │   └── Force kill if needed

3. KILL TMUX SESSION
   └── tmux.killSession(sessionId)

4. REMOVE WORKTREES
   ├── For each role:
   │   └── worktree.removeWorktree(role, { force: true })
   └── worktree.pruneWorktrees()

5. CLEANUP MESSAGE FILES
   ├── If autoCleanup:
   │   ├── Remove inbox files
   │   └── Remove outbox files
   └── Else: leave for debugging

6. CLOSE DATABASE
   └── Close SQLite connection

7. EMIT EVENT
   └── 'session_ended'
```

**Graceful Agent Termination**:
```typescript
async function terminateAgentGracefully(paneId: string): Promise<void> {
  // Send Ctrl+C to interrupt
  tmux.sendKeys(sessionId, paneId, 'C-c');
  await sleep(1000);

  // Check if terminated
  const output = tmux.capturePane(sessionId, paneId, 5);
  if (!output.includes('$')) {
    // Still running, send another Ctrl+C
    tmux.sendKeys(sessionId, paneId, 'C-c');
    await sleep(500);
  }

  // If still running, force kill pane
  try {
    tmux.killPane(sessionId, paneId);
  } catch {
    // Pane may already be gone
  }
}
```

---

## 5. Data Flow

### Complete Workflow Execution Flow

```
USER
  │
  └──▶ CLI: ./swarm start research "quantum computing"
          │
          ▼
      ORCHESTRATOR.startWorkflow('research', 'quantum computing')
          │
          ├──▶ Load workflow definition (research.ts)
          │
          ├──▶ worktreeManager.createWorktrees(['researcher', 'reviewer'])
          │         │
          │         └──▶ .worktrees/researcher/, .worktrees/reviewer/
          │
          ├──▶ tmuxManager.createSession('swarm_123456')
          │
          ├──▶ spawnAgent('researcher')
          │         │
          │         ├──▶ tmux split-window
          │         ├──▶ cd .worktrees/researcher
          │         └──▶ claude --resume
          │
          ├──▶ spawnAgent('reviewer')
          │         │
          │         └──▶ (same as above)
          │
          ├──▶ workflow.createInitialTask('quantum computing')
          │         │
          │         └──▶ { type: 'task', to: 'researcher', ... }
          │
          ├──▶ messageBus.sendMessage('orchestrator', 'researcher', task)
          │         │
          │         └──▶ .swarm/messages/inbox/researcher.json
          │
          └──▶ startMonitoring()
                    │
                    ▼
              MONITOR LOOP (every 5s)
                    │
                    ├──▶ Check researcher outbox
                    │         │
                    │         └──▶ New 'finding' message detected
                    │
                    ├──▶ routeMessage('researcher', findingMsg)
                    │         │
                    │         ├──▶ workflow.routeMessage()
                    │         │         │
                    │         │         └──▶ Route to reviewer
                    │         │
                    │         └──▶ messageBus.sendMessage() to reviewer
                    │
                    ├──▶ Check reviewer outbox
                    │         │
                    │         └──▶ New 'review' message (APPROVED)
                    │
                    ├──▶ routeMessage('reviewer', reviewMsg)
                    │         │
                    │         └──▶ workflow.isComplete() → true
                    │
                    └──▶ synthesizeResults()
                              │
                              ├──▶ Collect findings, reviews
                              ├──▶ Generate summary
                              ├──▶ Write outputs/
                              │
                              └──▶ cleanup()
                                        │
                                        ├──▶ Kill agents
                                        ├──▶ Kill tmux session
                                        └──▶ Remove worktrees
```

### Message Routing Flow

```
AGENT (researcher)
  │
  └──▶ Writes to .swarm/messages/outbox/researcher.json
          │
          ▼
      MONITOR LOOP detects new message
          │
          ▼
      ORCHESTRATOR.routeMessage('researcher', msg)
          │
          ├──▶ Store message in database
          │
          ├──▶ WORKFLOW.routeMessage()
          │         │
          │         ├──▶ Match routing rules
          │         ├──▶ Determine target agent
          │         └──▶ Return RoutingDecision
          │
          └──▶ Apply routing
                    │
                    ├──▶ MESSAGE BUS.sendMessage('researcher', 'reviewer', msg)
                    │         │
                    │         └──▶ Write to .swarm/messages/inbox/reviewer.json
                    │
                    └──▶ Update workflow state
                              │
                              └──▶ stageTransition, agent states
```

---

## 6. State Management

### Session State

The Orchestrator maintains session state in memory and persists to database:

```typescript
// In-memory state
class Orchestrator {
  private session: Session | null = null;
  private monitorInterval: Timer | null = null;
  private eventHandlers: Set<EventHandler> = new Set();
  private outboxStates: Map<AgentRole, OutboxState> = new Map();
}
```

### Database Persistence

The Orchestrator uses database tables defined in **Step 02 (Database Layer)**:

- **sessions**: Core session tracking (id, workflow_type, goal, status, timestamps)
- **messages**: Agent-to-agent communication history
- **agent_activity**: Agent lifecycle events and monitoring (spawned, ready, message, complete, error)
- **checkpoints**: Session state snapshots for recovery (used by Step 10)
- **error_log**: Error tracking and recovery attempts (used by Step 10)

See Step 02 for complete table schemas and indexes.

### State Recovery

For potential session resume (future feature):

```typescript
// Persist state periodically
function persistState(session: Session): void {
  const stateJson = JSON.stringify({
    workflowState: session.workflowState,
    agents: Array.from(session.agents.entries()),
    outboxStates: Array.from(outboxStates.entries())
  });

  db.run(
    'UPDATE sessions SET state_json = ? WHERE id = ?',
    [stateJson, session.id]
  );
}

// Recover state (future)
function recoverSession(sessionId: string): Session {
  const row = db.get('SELECT * FROM sessions WHERE id = ?', [sessionId]);
  // Reconstruct session from persisted state
}
```

---

## 7. Error Handling

### Error Categories

| Category | Examples | Handling |
|----------|----------|----------|
| Agent Spawn Error | tmux fails, worktree missing | Retry up to maxRetries, then fail session |
| Agent Timeout | No response within agentTimeout | Send nudge, retry task, then terminate |
| Routing Error | Invalid message format, unknown target | Log error, attempt recovery, notify user |
| Workflow Error | Max iterations, stage condition fail | Follow workflow failureStrategy |
| System Error | Disk full, permission denied | Fail session, cleanup what's possible |

### Error Recovery Strategies

**IMPORTANT**: The Orchestrator detects errors and delegates to the error-handling module (Step 10) for recovery decisions. It does NOT implement recovery strategies directly.

**Agent Timeout Detection & Delegation**:
```typescript
async function handleAgentTimeout(role: AgentRole): Promise<void> {
  const agent = this.getAgent(role);

  // Create error for the error-handling module
  const error = createSwarmError('AGENT_TIMEOUT', {
    component: 'orchestrator',
    agentRole: role,
    context: { timeout: this.config.agentTimeout }
  });

  // Delegate to error-handling module (Plan 10) for recovery decision
  const outcome = await executeRecovery(error, this.getRecoveryContext());

  // Apply the recovery outcome
  if (outcome.success) {
    agent.lastActivityAt = timestamp();
    agent.errorCount = 0;
  } else {
    agent.status = 'error';
    await this.handleAgentFailure(role);
  }
}
```

**Message Routing Error Detection & Delegation**:
```typescript
async function handleRoutingError(
  from: AgentRole,
  message: AgentMessage,
  error: Error
): Promise<void> {
  // Create error for the error-handling module
  const swarmError = createSwarmError('ROUTING_FAILED', {
    component: 'orchestrator',
    agentRole: from,
    message: error.message,
    context: { messageType: message.type }
  });

  // Delegate to error-handling module (Plan 10) for recovery decision
  const outcome = await executeRecovery(swarmError, this.getRecoveryContext());

  // Apply the recovery outcome
  if (!outcome.success) {
    // Recovery failed, park message for manual review
    this.parkMessage(from, message, swarmError);
  }
}
```

### Graceful Degradation

The Orchestrator detects agent failures and delegates degradation decisions to the error-handling module (Step 10):

```typescript
async function handleAgentFailure(role: AgentRole): Promise<void> {
  // Create error for the error-handling module
  const error = createSwarmError('AGENT_CRASHED', {
    component: 'orchestrator',
    agentRole: role
  });

  // Delegate to error-handling module (Plan 10) for degradation decision
  const context = this.getRecoveryContext();
  const canContinue = await canContinueWorkflow(error, context);

  if (!canContinue) {
    this.failSession(`Required agent ${role} failed`);
    return;
  }

  // Apply degradation from error-handling module
  const degradation = await applyDegradation(error, context);
  this.session.degradationState = degradation;

  console.log(`Continuing in degraded mode: ${degradation.level}`);
  console.log(`Warnings: ${degradation.warnings.join(', ')}`);
}
```

---

## 8. Integration Points

### Integration with Error Handling (Step 10)

**IMPORTANT - Delegation Pattern**: The Orchestrator DETECTS errors but DELEGATES to the error-handling module (Step 10) for recovery decisions.

```typescript
// Import error-handling functions from Step 10
import {
  createSwarmError,
  executeRecovery,
  canContinueWorkflow,
  applyDegradation,
  withRetry,
  checkpointOnStage
} from './error-handling';

// Orchestrator uses these functions, does NOT implement recovery logic
class Orchestrator {
  // Error detection -> delegation example
  async handleAgentTimeout(role: AgentRole): Promise<void> {
    const error = createSwarmError('AGENT_TIMEOUT', { /* context */ });
    const outcome = await executeRecovery(error, this.getRecoveryContext());
    // Apply outcome...
  }

  // Wrap operations with retry logic from error-handling module
  async spawnAgent(role: AgentRole): Promise<ManagedAgent> {
    return withRetry(
      async () => this.doSpawnAgent(role),
      RETRY_CONFIGS.agentSpawn,
      `spawn_${role}`
    );
  }

  // Checkpoint integration
  private async onStageComplete(stage: string): Promise<void> {
    await checkpointOnStage(this.session, stage);
  }
}
```

See Step 10 for the complete error-handling implementation that this module delegates to.

### Integration with Tmux Manager (Step 4)

```typescript
// Session management
tmux.createSession(sessionId);
tmux.killSession(sessionId);
tmux.listSessions();

// Pane management
const paneId = tmux.createPane(sessionId, role);
tmux.sendKeys(sessionId, paneId, 'claude --resume');
const output = tmux.capturePane(sessionId, paneId, 100);
tmux.killPane(sessionId, paneId);
```

### Integration with Worktree Manager (Step 5)

```typescript
// Create all worktrees for workflow
const paths = await worktree.createWorktrees(roles, { sessionId });

// Get path for spawning
const worktreePath = worktree.getWorktreePath(role);

// Cleanup
await worktree.removeAllWorktrees({ force: true });
```

### Integration with Message Bus (Step 3)

```typescript
// Send message to agent
messageBus.sendMessage(from, to, message);

// Read agent's outbox
const messages = messageBus.readMessages(role, 'outbox');

// Check for new messages
const newMsgs = messageBus.getNewMessages(role, lastTimestamp);

// Clear processed messages
messageBus.clearInbox(role);
```

### Integration with Database (Step 2)

```typescript
// Store session
db.storeSession(session);

// Store message
db.storeMessage(sessionId, message);

// Store finding
db.storeFinding(sessionId, role, finding);

// Query results
const findings = db.getFindings(sessionId);
const artifacts = db.getArtifacts(sessionId);
```

### Integration with Workflows (Step 7)

```typescript
// Load workflow
const workflow = loadWorkflow(type);

// Get required roles
const roles = workflow.getRoles();

// Create initial task
const task = workflow.createInitialTask(goal);

// Route message
const decision = workflow.routeMessage(from, message, state);

// Check completion
const done = workflow.isComplete(state);

// Synthesize result
const result = workflow.synthesizeResult(state);
```

---

## 9. Testing Strategy

### Unit Tests

**Session Lifecycle**:
- Test session creation with valid workflow
- Test session creation with invalid workflow
- Test session stop and cleanup
- Test duplicate session prevention

**Agent Management**:
- Test agent spawn success
- Test agent spawn with missing worktree
- Test agent ready detection
- Test agent termination

**Message Routing**:
- Test routing with valid message
- Test routing with invalid message format
- Test routing to non-existent agent
- Test routing decision application

### Integration Tests

**End-to-End Workflow**:
1. Start research workflow
2. Verify agents spawn
3. Mock message production
4. Verify routing occurs
5. Trigger completion
6. Verify cleanup

**Error Recovery**:
1. Start workflow
2. Simulate agent timeout
3. Verify recovery attempt
4. Verify graceful degradation

**Multi-Agent Coordination**:
1. Start development workflow (3 agents)
2. Verify all agents spawn
3. Simulate message exchange
4. Verify stage transitions
5. Verify completion synthesis

### Test Fixtures

```typescript
// Mock workflow for testing
const mockWorkflow: Workflow = {
  definition: {
    name: 'test',
    agents: ['researcher'],
    stages: [{ name: 'test', agent: 'researcher', outputType: 'finding' }],
    entryStage: 'test',
    completionStage: 'test',
    config: { failureStrategy: 'continue' }
  },
  getRoles: () => ['researcher'],
  createInitialTask: (goal) => ({ type: 'task', content: { body: goal } }),
  routeMessage: () => ({ messages: [] }),
  isComplete: (state) => state.stageHistory.length > 0,
  synthesizeResult: () => ({ success: true, summary: 'Test complete' })
};
```

### Manual Testing

```bash
# Start a workflow
bun swarm.ts start research "test query"

# In another terminal, watch progress
bun swarm.ts status

# Attach to see agents
bun swarm.ts attach

# View agent output
bun swarm.ts logs researcher

# Stop
bun swarm.ts stop
```

---

## 10. Configuration

### Default Configuration

```typescript
const DEFAULT_CONFIG: Required<OrchestratorConfig> = {
  sessionId: '',
  monitorInterval: 5000,           // Check every 5 seconds
  agentTimeout: 300000,            // 5 minutes per agent response
  workflowTimeout: 1800000,        // 30 minutes total
  autoCleanup: true,
  captureOutput: true,
  verboseLogging: false,
  maxAgents: 4,
  maxRetries: 3
};
```

### Configuration from File

```typescript
// config.json
{
  "orchestrator": {
    "monitorInterval": 10000,
    "agentTimeout": 600000,
    "workflowTimeout": 3600000,
    "verboseLogging": true
  }
}
```

### Environment Variables

```bash
# Override timeout settings
SWARM_AGENT_TIMEOUT=600000
SWARM_WORKFLOW_TIMEOUT=3600000
SWARM_MONITOR_INTERVAL=10000
```

---

## 11. File System & External Effects

### Files/Directories Created

| Path | Purpose |
|------|---------|
| `.swarm/` | Runtime directory (created if missing) |
| `.swarm/memory.db` | SQLite database |
| `.swarm/messages/inbox/*.json` | Agent inboxes |
| `.swarm/messages/outbox/*.json` | Agent outboxes |
| `.swarm/sessions/{id}.json` | Session state backup |
| `outputs/{sessionId}/` | Final outputs |
| `outputs/{sessionId}/summary.md` | Result summary |
| `logs/{sessionId}.log` | Session log |

### External Commands Executed

Via tmux-manager:
- `tmux new-session`, `tmux split-window`, `tmux send-keys`
- `tmux capture-pane`, `tmux kill-session`

Via worktree-manager:
- `git worktree add`, `git worktree remove`
- `git worktree list`, `git worktree prune`

Direct:
- `claude --resume` (spawning agents)

### Resource Usage

- **Memory**: O(messages) for in-memory state
- **Disk**: SQLite DB grows with messages, typically < 10MB
- **Processes**: 1 tmux session, N Claude processes (one per agent)
- **CPU**: Minimal (polling-based monitoring)

---

## 12. Open Questions & Decisions

### Resolved Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Monitoring approach | Polling (5s interval) | Simple, reliable, low overhead |
| State storage | SQLite + in-memory | Persistence with fast access |
| Agent communication | File-based outbox | Debuggable, no IPC complexity |
| Cleanup strategy | Auto by default | Clean slate for each session |
| Failure strategy | Per-workflow configurable | Different workflows need different handling |

### Open Questions

1. **Should Orchestrator support session resume?**
   - Current: No, fresh start each time
   - Alternative: Save state, allow resume
   - Consideration: Adds complexity but useful for long workflows

2. **How to handle large message payloads?**
   - Current: Store inline in JSON
   - Alternative: Store content in files, reference by path
   - Consideration: Large code artifacts may exceed practical limits

3. **Should there be an Orchestrator web UI?**
   - Current: CLI only
   - Alternative: Add HTTP server for status/control
   - Consideration: Useful but out of scope for MVP

4. **How to handle concurrent workflows?**
   - Current: One session at a time
   - Alternative: Multiple sessions with resource partitioning
   - Consideration: Adds complexity, may hit rate limits

### Alternatives Considered

**Alternative: Event-driven instead of polling**
- Pro: More responsive, lower latency
- Con: Requires file watchers, more complex
- Decision: Polling is simpler, 5s latency acceptable

**Alternative: Direct IPC between agents**
- Pro: Lower latency, no file I/O
- Con: Complex, harder to debug
- Decision: File-based is simpler, debuggable

**Alternative: Stateless orchestrator (workflow in agents)**
- Pro: More autonomous agents
- Con: Harder to coordinate, no central view
- Decision: Central orchestrator provides control and visibility

---

## 13. Module Organization

```
src/orchestrator.ts
├── Imports
│   ├── From types.ts
│   ├── From tmux-manager.ts
│   ├── From worktree-manager.ts
│   ├── From message-bus.ts
│   ├── From db.ts
│   └── From workflows/
│
├── Type Definitions
│   ├── OrchestratorConfig
│   ├── ManagedAgent
│   ├── Session
│   ├── SessionResult
│   └── OrchestratorEvent
│
├── Constants
│   ├── DEFAULT_CONFIG
│   └── READY_INDICATORS
│
├── Orchestrator Class
│   ├── Constructor
│   │   └── Initialize with config
│   │
│   ├── Session Lifecycle Methods
│   │   ├── startWorkflow()
│   │   ├── stop()
│   │   ├── kill()
│   │   ├── getSession()
│   │   └── isRunning()
│   │
│   ├── Agent Management Methods
│   │   ├── spawnAgent()
│   │   ├── getAgent()
│   │   ├── listAgents()
│   │   ├── sendToAgent()
│   │   ├── captureAgentOutput()
│   │   └── terminateAgent()
│   │
│   ├── Message Handling Methods
│   │   ├── routeMessage()
│   │   ├── getPendingMessages()
│   │   └── getMessageHistory()
│   │
│   ├── Monitoring Methods
│   │   ├── startMonitoring()
│   │   ├── stopMonitoring()
│   │   ├── checkAgentHealth()
│   │   ├── checkOutboxes() (private)
│   │   └── getProgress()
│   │
│   ├── Results Methods
│   │   ├── synthesizeResults()
│   │   ├── getAgentResults()
│   │   └── exportResults()
│   │
│   ├── Cleanup Methods
│   │   ├── cleanup()
│   │   └── cleanupAgent()
│   │
│   ├── Event Methods
│   │   ├── on()
│   │   ├── off()
│   │   └── emit() (private)
│   │
│   └── Helper Methods (private)
│       ├── generateSessionId()
│       ├── detectAgentReady()
│       ├── handleAgentTimeout()
│       ├── handleRoutingError()
│       └── handleAgentFailure()
│
└── Exports
    └── Orchestrator class
```

---

## Next Step

After implementing the Orchestrator, proceed to **Step 9: CLI Interface** which provides the user-facing commands that interact with the Orchestrator.
