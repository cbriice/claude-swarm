# Step 10: Error Handling & Recovery - Architectural Plan

## 1. Overview & Purpose

### What This Component Does

Error Handling & Recovery is a cross-cutting concern that provides robust error detection, recovery strategies, graceful degradation, and state persistence across all Claude Swarm components. It ensures the system can handle failures at any level without losing work and provides clear feedback to users about what went wrong and how to recover.

**IMPORTANT - Relationship with Orchestrator (Step 8)**: The Orchestrator (Plan 08) detects errors and delegates to THIS module for recovery decisions. The Orchestrator does NOT implement recovery logic directly - it calls functions from this module (`executeRecovery`, `applyDegradation`, `canContinueWorkflow`) which determine and execute the appropriate recovery strategy.

### Why It Exists

Without comprehensive error handling:
- Agent failures would crash the entire workflow
- Rate limits would cause immediate failures
- Network issues would lose work in progress
- Users would get cryptic error messages
- No way to resume failed workflows

Error Handling provides:
- Categorized error types with specific handling strategies
- Retry logic with exponential backoff
- Graceful degradation when components fail
- State persistence for recovery
- Clear, actionable error messages
- Audit trail for debugging

### How It Fits Into The Larger System

```
┌─────────────────────────────────────────────────────────────────┐
│                    ERROR HANDLING LAYER                          │
│  Wraps all components, intercepts failures, applies strategies  │
└─────────────────────────────────────────────────────────────────┘
         │              │              │              │
         ▼              ▼              ▼              ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│     CLI      │ │ Orchestrator │ │    Agents    │ │  Message Bus │
│              │ │              │ │              │ │              │
│ • Input      │ │ • Lifecycle  │ │ • Spawn      │ │ • File I/O   │
│   validation │ │   errors     │ │   errors     │ │   errors     │
│ • Output     │ │ • Timeout    │ │ • Timeout    │ │ • Parse      │
│   errors     │ │   handling   │ │ • Response   │ │   errors     │
│ • Signal     │ │ • Workflow   │ │   errors     │ │ • Routing    │
│   handling   │ │   failures   │ │ • Crash      │ │   errors     │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
         │              │              │              │
         ▼              ▼              ▼              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    PERSISTENCE LAYER                             │
│  SQLite: error logs, session state, recovery checkpoints        │
└─────────────────────────────────────────────────────────────────┘
```

### Problems It Solves

1. **Resilience**: System continues despite component failures
2. **Recovery**: Failed workflows can be resumed
3. **Visibility**: Clear error reporting and debugging information
4. **Rate Limiting**: Handles API limits gracefully
5. **Resource Cleanup**: Ensures cleanup even on failures
6. **User Experience**: Actionable error messages and suggestions

---

## 2. Error Taxonomy

### Error Categories

```typescript
// ============================================
// Error Category Definitions
// ============================================

type ErrorCategory =
  | 'AGENT_ERROR'        // Agent-related failures
  | 'WORKFLOW_ERROR'     // Workflow execution failures
  | 'SYSTEM_ERROR'       // System/infrastructure failures
  | 'USER_ERROR'         // User input/action errors
  | 'EXTERNAL_ERROR';    // External service failures

type ErrorSeverity =
  | 'fatal'              // Cannot continue, must stop
  | 'error'              // Serious, may require intervention
  | 'warning'            // Issue detected, continuing
  | 'info';              // Informational only

interface SwarmError {
  // Identification
  id: string;                        // Unique error ID
  code: string;                      // Error code (e.g., "AGENT_TIMEOUT")
  category: ErrorCategory;
  severity: ErrorSeverity;

  // Context
  message: string;                   // Human-readable message
  details?: string;                  // Technical details
  component: string;                 // Which component failed
  sessionId?: string;                // Associated session
  agentRole?: string;                // Associated agent

  // Timing
  timestamp: string;                 // ISO8601
  duration?: number;                 // How long operation ran before failing

  // Recovery
  recoverable: boolean;
  retryable: boolean;
  retryCount?: number;               // How many retries attempted
  recoveryStrategy?: string;         // What recovery was attempted

  // Debugging
  stack?: string;                    // Stack trace
  context?: Record<string, unknown>; // Additional context
  cause?: SwarmError;                // Underlying error
}
```

### Error Codes

```typescript
// ============================================
// Agent Errors
// ============================================

const AGENT_ERRORS = {
  AGENT_SPAWN_FAILED: {
    code: 'AGENT_SPAWN_FAILED',
    category: 'AGENT_ERROR',
    severity: 'error',
    message: 'Failed to spawn agent',
    recoverable: true,
    retryable: true
  },
  AGENT_TIMEOUT: {
    code: 'AGENT_TIMEOUT',
    category: 'AGENT_ERROR',
    severity: 'error',
    message: 'Agent did not respond within timeout',
    recoverable: true,
    retryable: true
  },
  AGENT_CRASHED: {
    code: 'AGENT_CRASHED',
    category: 'AGENT_ERROR',
    severity: 'error',
    message: 'Agent process terminated unexpectedly',
    recoverable: true,
    retryable: true
  },
  AGENT_INVALID_OUTPUT: {
    code: 'AGENT_INVALID_OUTPUT',
    category: 'AGENT_ERROR',
    severity: 'warning',
    message: 'Agent produced invalid or malformed output',
    recoverable: true,
    retryable: true
  },
  AGENT_BLOCKED: {
    code: 'AGENT_BLOCKED',
    category: 'AGENT_ERROR',
    severity: 'warning',
    message: 'Agent is blocked waiting for input',
    recoverable: true,
    retryable: false
  }
};


// ============================================
// Workflow Errors
// ============================================

const WORKFLOW_ERRORS = {
  WORKFLOW_NOT_FOUND: {
    code: 'WORKFLOW_NOT_FOUND',
    category: 'WORKFLOW_ERROR',
    severity: 'fatal',
    message: 'Specified workflow type does not exist',
    recoverable: false,
    retryable: false
  },
  WORKFLOW_TIMEOUT: {
    code: 'WORKFLOW_TIMEOUT',
    category: 'WORKFLOW_ERROR',
    severity: 'error',
    message: 'Workflow exceeded maximum duration',
    recoverable: true,
    retryable: false
  },
  MAX_ITERATIONS: {
    code: 'MAX_ITERATIONS',
    category: 'WORKFLOW_ERROR',
    severity: 'warning',
    message: 'Maximum revision iterations reached',
    recoverable: true,
    retryable: false
  },
  STAGE_FAILED: {
    code: 'STAGE_FAILED',
    category: 'WORKFLOW_ERROR',
    severity: 'error',
    message: 'Workflow stage failed to complete',
    recoverable: true,
    retryable: true
  },
  ROUTING_FAILED: {
    code: 'ROUTING_FAILED',
    category: 'WORKFLOW_ERROR',
    severity: 'error',
    message: 'Failed to route message to target agent',
    recoverable: true,
    retryable: true
  }
};


// ============================================
// System Errors
// ============================================

const SYSTEM_ERRORS = {
  TMUX_NOT_FOUND: {
    code: 'TMUX_NOT_FOUND',
    category: 'SYSTEM_ERROR',
    severity: 'fatal',
    message: 'tmux is not installed',
    recoverable: false,
    retryable: false
  },
  TMUX_SESSION_FAILED: {
    code: 'TMUX_SESSION_FAILED',
    category: 'SYSTEM_ERROR',
    severity: 'error',
    message: 'Failed to create tmux session',
    recoverable: true,
    retryable: true
  },
  GIT_WORKTREE_FAILED: {
    code: 'GIT_WORKTREE_FAILED',
    category: 'SYSTEM_ERROR',
    severity: 'error',
    message: 'Failed to create git worktree',
    recoverable: true,
    retryable: true
  },
  DATABASE_ERROR: {
    code: 'DATABASE_ERROR',
    category: 'SYSTEM_ERROR',
    severity: 'error',
    message: 'Database operation failed',
    recoverable: true,
    retryable: true
  },
  FILESYSTEM_ERROR: {
    code: 'FILESYSTEM_ERROR',
    category: 'SYSTEM_ERROR',
    severity: 'error',
    message: 'File system operation failed',
    recoverable: true,
    retryable: true
  },
  PERMISSION_DENIED: {
    code: 'PERMISSION_DENIED',
    category: 'SYSTEM_ERROR',
    severity: 'fatal',
    message: 'Permission denied for operation',
    recoverable: false,
    retryable: false
  }
};


// ============================================
// External Errors
// ============================================

const EXTERNAL_ERRORS = {
  RATE_LIMITED: {
    code: 'RATE_LIMITED',
    category: 'EXTERNAL_ERROR',
    severity: 'warning',
    message: 'API rate limit exceeded',
    recoverable: true,
    retryable: true
  },
  CLAUDE_API_ERROR: {
    code: 'CLAUDE_API_ERROR',
    category: 'EXTERNAL_ERROR',
    severity: 'error',
    message: 'Claude API returned an error',
    recoverable: true,
    retryable: true
  },
  NETWORK_ERROR: {
    code: 'NETWORK_ERROR',
    category: 'EXTERNAL_ERROR',
    severity: 'error',
    message: 'Network connection failed',
    recoverable: true,
    retryable: true
  }
};


// ============================================
// User Errors
// ============================================

const USER_ERRORS = {
  INVALID_ARGUMENT: {
    code: 'INVALID_ARGUMENT',
    category: 'USER_ERROR',
    severity: 'error',
    message: 'Invalid command argument',
    recoverable: false,
    retryable: false
  },
  SESSION_EXISTS: {
    code: 'SESSION_EXISTS',
    category: 'USER_ERROR',
    severity: 'error',
    message: 'A session is already running',
    recoverable: false,
    retryable: false
  },
  SESSION_NOT_FOUND: {
    code: 'SESSION_NOT_FOUND',
    category: 'USER_ERROR',
    severity: 'error',
    message: 'No active session found',
    recoverable: false,
    retryable: false
  }
};
```

---

## 3. Retry Logic

### Retry Configuration

```typescript
// ============================================
// Retry Configuration
// ============================================

interface RetryConfig {
  maxRetries: number;                // Maximum retry attempts
  initialDelayMs: number;            // First retry delay
  maxDelayMs: number;                // Maximum delay between retries
  backoffMultiplier: number;         // Exponential backoff factor
  jitterPercent: number;             // Random jitter (0-100)
  retryableErrors: string[];         // Error codes to retry
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitterPercent: 20,
  retryableErrors: [
    'AGENT_SPAWN_FAILED',
    'AGENT_TIMEOUT',
    'AGENT_CRASHED',
    'TMUX_SESSION_FAILED',
    'GIT_WORKTREE_FAILED',
    'DATABASE_ERROR',
    'RATE_LIMITED',
    'NETWORK_ERROR'
  ]
};

// Per-operation overrides
const RETRY_CONFIGS: Record<string, Partial<RetryConfig>> = {
  agentSpawn: {
    maxRetries: 2,
    initialDelayMs: 2000
  },
  messageSend: {
    maxRetries: 5,
    initialDelayMs: 500
  },
  databaseWrite: {
    maxRetries: 3,
    initialDelayMs: 100
  },
  rateLimited: {
    maxRetries: 5,
    initialDelayMs: 5000,
    maxDelayMs: 60000
  }
};
```

### Retry Implementation Pattern

```typescript
// ============================================
// Retry Types
// ============================================

interface RetryContext {
  operation: string;                 // Operation name
  attempt: number;                   // Current attempt (1-based)
  maxAttempts: number;               // Total attempts allowed
  errors: SwarmError[];              // Errors from previous attempts
  startTime: number;                 // When first attempt started
}

interface RetryResult<T> {
  success: boolean;
  result?: T;
  attempts: number;
  totalDuration: number;
  errors: SwarmError[];
}

type RetryableOperation<T> = (context: RetryContext) => Promise<T>;


// ============================================
// Retry Functions
// ============================================

// Main retry wrapper
async function withRetry<T>(
  operation: RetryableOperation<T>,
  config: RetryConfig,
  operationName: string
): Promise<RetryResult<T>>;

// Calculate delay with exponential backoff and jitter
function calculateDelay(
  attempt: number,
  config: RetryConfig
): number;

// Check if error is retryable
function isRetryable(
  error: SwarmError,
  config: RetryConfig
): boolean;

// Wait with cancellation support
function delay(
  ms: number,
  signal?: AbortSignal
): Promise<void>;
```

### Backoff Calculation

```
Delay Calculation:
  baseDelay = initialDelayMs * (backoffMultiplier ^ (attempt - 1))
  cappedDelay = min(baseDelay, maxDelayMs)
  jitter = cappedDelay * (random() * jitterPercent / 100)
  finalDelay = cappedDelay + jitter

Example (default config):
  Attempt 1: 1000ms + jitter
  Attempt 2: 2000ms + jitter
  Attempt 3: 4000ms + jitter
  Attempt 4: 8000ms + jitter (capped at 30000ms)
```

---

## 4. Recovery Strategies

### Strategy Definitions

```typescript
// ============================================
// Recovery Strategy Types
// ============================================

type RecoveryStrategy =
  | 'retry'              // Retry the failed operation
  | 'restart'            // Restart the component
  | 'skip'               // Skip and continue without
  | 'substitute'         // Use alternative component
  | 'rollback'           // Undo and try different approach
  | 'escalate'           // Escalate to user/orchestrator
  | 'abort';             // Give up, fail gracefully

interface RecoveryPlan {
  strategy: RecoveryStrategy;
  maxAttempts?: number;
  timeout?: number;
  fallbackStrategy?: RecoveryStrategy;
  actions: RecoveryAction[];
}

interface RecoveryAction {
  type: 'wait' | 'execute' | 'notify' | 'log' | 'cleanup';
  description: string;
  parameters?: Record<string, unknown>;
}


// ============================================
// Recovery Strategy Selection
// ============================================

interface StrategySelector {
  errorCode: string;
  condition?: (error: SwarmError, context: RecoveryContext) => boolean;
  strategy: RecoveryPlan;
}

interface RecoveryContext {
  sessionId: string;
  workflowState: WorkflowState;
  agentStates: Map<string, AgentState>;
  errorHistory: SwarmError[];
  attemptHistory: Map<string, number>;
}
```

### Strategy Mappings

```typescript
// ============================================
// Error to Strategy Mapping
// ============================================

const RECOVERY_STRATEGIES: StrategySelector[] = [
  // Agent Errors
  {
    errorCode: 'AGENT_TIMEOUT',
    strategy: {
      strategy: 'retry',
      maxAttempts: 2,
      fallbackStrategy: 'restart',
      actions: [
        { type: 'log', description: 'Log timeout occurrence' },
        { type: 'notify', description: 'Send nudge to agent' },
        { type: 'wait', description: 'Wait for response', parameters: { ms: 30000 } },
        { type: 'execute', description: 'Check for new messages' }
      ]
    }
  },
  {
    errorCode: 'AGENT_CRASHED',
    strategy: {
      strategy: 'restart',
      maxAttempts: 2,
      fallbackStrategy: 'skip',
      actions: [
        { type: 'cleanup', description: 'Terminate crashed pane' },
        { type: 'wait', description: 'Cool-down period', parameters: { ms: 2000 } },
        { type: 'execute', description: 'Respawn agent' },
        { type: 'execute', description: 'Resend last task' }
      ]
    }
  },
  {
    errorCode: 'AGENT_INVALID_OUTPUT',
    strategy: {
      strategy: 'retry',
      maxAttempts: 2,
      fallbackStrategy: 'escalate',
      actions: [
        { type: 'log', description: 'Log invalid output for debugging' },
        { type: 'execute', description: 'Request clarification from agent' }
      ]
    }
  },

  // Rate Limiting
  {
    errorCode: 'RATE_LIMITED',
    strategy: {
      strategy: 'retry',
      maxAttempts: 5,
      fallbackStrategy: 'abort',
      actions: [
        { type: 'log', description: 'Log rate limit hit' },
        { type: 'wait', description: 'Exponential backoff', parameters: { base: 5000 } },
        { type: 'execute', description: 'Retry operation' }
      ]
    }
  },

  // Workflow Errors
  {
    errorCode: 'MAX_ITERATIONS',
    strategy: {
      strategy: 'skip',
      actions: [
        { type: 'log', description: 'Log iteration limit reached' },
        { type: 'notify', description: 'Mark output as partial' },
        { type: 'execute', description: 'Continue to next stage' }
      ]
    }
  },
  {
    errorCode: 'WORKFLOW_TIMEOUT',
    strategy: {
      strategy: 'abort',
      actions: [
        { type: 'log', description: 'Log timeout' },
        { type: 'execute', description: 'Synthesize partial results' },
        { type: 'cleanup', description: 'Cleanup resources' }
      ]
    }
  },

  // System Errors
  {
    errorCode: 'TMUX_SESSION_FAILED',
    strategy: {
      strategy: 'retry',
      maxAttempts: 2,
      fallbackStrategy: 'abort',
      actions: [
        { type: 'cleanup', description: 'Kill any stale sessions' },
        { type: 'wait', description: 'Brief pause', parameters: { ms: 1000 } },
        { type: 'execute', description: 'Retry session creation' }
      ]
    }
  },
  {
    errorCode: 'GIT_WORKTREE_FAILED',
    strategy: {
      strategy: 'retry',
      maxAttempts: 2,
      fallbackStrategy: 'abort',
      actions: [
        { type: 'execute', description: 'Prune stale worktrees' },
        { type: 'cleanup', description: 'Remove partial worktree' },
        { type: 'execute', description: 'Retry worktree creation' }
      ]
    }
  }
];
```

### Recovery Execution

```typescript
// ============================================
// Recovery Execution Types
// ============================================

interface RecoveryOutcome {
  success: boolean;
  strategyUsed: RecoveryStrategy;
  actionsExecuted: number;
  duration: number;
  result?: unknown;
  fallbackUsed: boolean;
  finalError?: SwarmError;
}


// ============================================
// Recovery Functions
// ============================================

// Select appropriate recovery strategy
function selectStrategy(
  error: SwarmError,
  context: RecoveryContext
): RecoveryPlan;

// Execute recovery plan
async function executeRecovery(
  error: SwarmError,
  plan: RecoveryPlan,
  context: RecoveryContext
): Promise<RecoveryOutcome>;

// Execute single recovery action
async function executeAction(
  action: RecoveryAction,
  error: SwarmError,
  context: RecoveryContext
): Promise<void>;

// Check if recovery should continue
function shouldContinueRecovery(
  error: SwarmError,
  context: RecoveryContext,
  attemptsSoFar: number
): boolean;
```

---

## 5. Graceful Degradation

### Degradation Levels

```typescript
// ============================================
// Degradation Types
// ============================================

type DegradationLevel =
  | 'full'               // All features available
  | 'reduced'            // Some features unavailable
  | 'minimal'            // Basic functionality only
  | 'failed';            // Cannot continue

interface DegradationState {
  level: DegradationLevel;
  unavailableAgents: string[];
  skippedStages: string[];
  partialOutputs: string[];
  warnings: string[];
}


// ============================================
// Degradation Rules
// ============================================

interface DegradationRule {
  trigger: string;                   // Error code or condition
  impact: string;                    // What becomes unavailable
  mitigation: string;                // How to proceed
  userMessage: string;               // What to tell user
}

const DEGRADATION_RULES: DegradationRule[] = [
  {
    trigger: 'AGENT_CRASHED:researcher',
    impact: 'Research capability unavailable',
    mitigation: 'Continue with cached findings or user input',
    userMessage: 'Researcher agent failed. Research stage will be skipped.'
  },
  {
    trigger: 'AGENT_CRASHED:reviewer',
    impact: 'Review capability unavailable',
    mitigation: 'Mark outputs as unverified',
    userMessage: 'Reviewer agent failed. Outputs will not be verified.'
  },
  {
    trigger: 'AGENT_CRASHED:developer',
    impact: 'Development capability unavailable',
    mitigation: 'Cannot continue development workflow',
    userMessage: 'Developer agent failed. Cannot complete development.'
  },
  {
    trigger: 'MAX_ITERATIONS',
    impact: 'Revision cycle incomplete',
    mitigation: 'Use best available output',
    userMessage: 'Maximum revisions reached. Using current version.'
  },
  {
    trigger: 'WORKFLOW_TIMEOUT',
    impact: 'Workflow incomplete',
    mitigation: 'Synthesize partial results',
    userMessage: 'Workflow timed out. Showing partial results.'
  }
];
```

### Degradation Handling

```typescript
// ============================================
// Degradation Functions
// ============================================

// Check if workflow can continue
function canContinue(
  error: SwarmError,
  state: WorkflowState,
  degradation: DegradationState
): boolean;

// Apply degradation to workflow
function applyDegradation(
  rule: DegradationRule,
  state: WorkflowState,
  degradation: DegradationState
): DegradationState;

// Get available functionality
function getAvailableCapabilities(
  degradation: DegradationState
): string[];

// Check if specific feature is available
function isFeatureAvailable(
  feature: string,
  degradation: DegradationState
): boolean;

// Generate user-facing degradation summary
function generateDegradationSummary(
  degradation: DegradationState
): string;
```

### Workflow Continuation Logic

```
Degradation Decision Tree:

Agent Failed?
    │
    ├── Is agent critical for remaining stages?
    │   │
    │   ├── YES: Can we substitute?
    │   │   │
    │   │   ├── YES: Use substitute, continue
    │   │   │
    │   │   └── NO: Apply degradation rule
    │   │       │
    │   │       ├── Can continue without?
    │   │       │   │
    │   │       │   ├── YES: Skip dependent stages
    │   │       │   │
    │   │       │   └── NO: Abort workflow
    │   │
    │   └── NO: Mark agent unavailable, continue
    │
    └── Update degradation state
```

---

## 6. State Persistence

### Checkpoint Types

```typescript
// ============================================
// Checkpoint Types
// ============================================

interface Checkpoint {
  id: string;
  sessionId: string;
  timestamp: string;
  type: CheckpointType;

  // State snapshots
  workflowState: WorkflowState;
  agentStates: Map<string, SerializedAgentState>;
  messageQueueState: MessageQueueSnapshot;

  // Progress
  completedStages: string[];
  pendingStages: string[];
  processedMessageIds: string[];

  // Errors
  errors: SwarmError[];
  recoveryAttempts: RecoveryAttempt[];

  // Metadata
  createdBy: 'auto' | 'manual' | 'error';
  notes?: string;
}

type CheckpointType =
  | 'session_start'       // Initial checkpoint
  | 'stage_complete'      // After stage completion
  | 'periodic'            // Regular interval
  | 'before_retry'        // Before recovery attempt
  | 'error_recovery'      // After error recovery
  | 'manual';             // User-requested

interface SerializedAgentState {
  role: string;
  status: string;
  lastTask?: string;
  messageCount: number;
  lastActivityAt: string;
}

interface MessageQueueSnapshot {
  inboxes: Record<string, number>;   // Agent -> message count
  outboxes: Record<string, number>;
  lastProcessedTimestamps: Record<string, string>;
}

interface RecoveryAttempt {
  errorId: string;
  strategy: RecoveryStrategy;
  outcome: 'success' | 'failed' | 'partial';
  timestamp: string;
}
```

### Checkpoint Management

```typescript
// ============================================
// Checkpoint Functions
// ============================================

// Create a checkpoint
function createCheckpoint(
  session: Session,
  type: CheckpointType,
  notes?: string
): Checkpoint;

// Save checkpoint to database
function saveCheckpoint(
  checkpoint: Checkpoint
): Promise<void>;

// Load most recent checkpoint
function loadLatestCheckpoint(
  sessionId: string
): Promise<Checkpoint | null>;

// Load checkpoint by ID
function loadCheckpoint(
  checkpointId: string
): Promise<Checkpoint | null>;

// List checkpoints for session
function listCheckpoints(
  sessionId: string
): Promise<Checkpoint[]>;

// Delete old checkpoints (keep last N)
function pruneCheckpoints(
  sessionId: string,
  keepCount: number
): Promise<number>;
```

### Database Schema

Error handling uses database tables defined in **Step 02 (Database Layer)**:

- **checkpoints**: Session state snapshots for recovery (id, session_id, type, created_by, workflow_state_json, agent_states_json, message_queue_json, completed_stages_json, pending_stages_json, errors_json, notes, created_at)
- **error_log**: Error tracking and debugging (id, session_id, code, category, severity, message, details, component, agent_role, recoverable, recovered, recovery_strategy, stack, context_json, created_at)
- **sessions**: Core session tracking (referenced by checkpoints and errors)

See Step 02 for complete table schemas and indexes.

### Automatic Checkpointing

```typescript
// ============================================
// Auto-Checkpoint Configuration
// ============================================

interface CheckpointConfig {
  enabled: boolean;
  intervalMs: number;                // Periodic checkpoint interval
  onStageComplete: boolean;          // Checkpoint after each stage
  onError: boolean;                  // Checkpoint before recovery
  maxCheckpoints: number;            // Maximum checkpoints to keep
}

const DEFAULT_CHECKPOINT_CONFIG: CheckpointConfig = {
  enabled: true,
  intervalMs: 60000,                 // Every minute
  onStageComplete: true,
  onError: true,
  maxCheckpoints: 10
};


// ============================================
// Checkpoint Triggers
// ============================================

// Start periodic checkpointing
function startAutoCheckpoint(
  session: Session,
  config: CheckpointConfig
): Timer;

// Stop periodic checkpointing
function stopAutoCheckpoint(
  timer: Timer
): void;

// Checkpoint on stage completion
function checkpointOnStage(
  session: Session,
  stageName: string
): Promise<void>;

// Checkpoint before error recovery
function checkpointBeforeRecovery(
  session: Session,
  error: SwarmError
): Promise<void>;
```

---

## 7. Session Recovery

### Recovery Process

```typescript
// ============================================
// Recovery Types
// ============================================

interface RecoveryOptions {
  checkpointId?: string;             // Specific checkpoint (latest if omitted)
  skipFailedStage: boolean;          // Skip the stage that failed
  resetAgents: boolean;              // Respawn all agents
  preserveMessages: boolean;         // Keep message queues
}

interface RecoveryResult {
  success: boolean;
  resumedFrom: string;               // Checkpoint ID
  restoredState: WorkflowState;
  skippedStages: string[];
  warnings: string[];
  error?: SwarmError;
}


// ============================================
// Recovery Functions
// ============================================

// Check if session can be recovered
function canRecover(
  sessionId: string
): Promise<boolean>;

// Recover session from checkpoint
async function recoverSession(
  sessionId: string,
  options: RecoveryOptions
): Promise<RecoveryResult>;

// Restore workflow state
function restoreWorkflowState(
  checkpoint: Checkpoint
): WorkflowState;

// Restore agent states
async function restoreAgents(
  checkpoint: Checkpoint,
  options: RecoveryOptions
): Promise<Map<string, ManagedAgent>>;

// Restore message queues
function restoreMessageQueues(
  checkpoint: Checkpoint
): void;

// Resume workflow execution
async function resumeWorkflow(
  session: Session,
  fromStage: string
): Promise<void>;
```

### Recovery Flow

```
Session Recovery Flow:

1. FIND RECOVERY POINT
   ├── Load latest checkpoint (or specified)
   ├── Validate checkpoint integrity
   └── Determine resume point

2. CLEANUP STALE STATE
   ├── Kill any orphaned tmux sessions
   ├── Remove stale worktrees
   └── Clear outdated message files

3. RESTORE STATE
   ├── Restore workflow state from checkpoint
   ├── Restore message queue states
   └── Reset error counters

4. RESPAWN AGENTS
   ├── Create new worktrees (or reuse)
   ├── Spawn agent processes
   └── Inject current task context

5. RESUME WORKFLOW
   ├── Determine next stage
   ├── Send pending messages
   └── Start monitoring loop

6. VERIFY RECOVERY
   ├── Check all agents responsive
   ├── Verify message routing
   └── Emit recovery complete event
```

---

## 8. Error Reporting

### Error Output Formatting

```typescript
// ============================================
// Error Reporting Types
// ============================================

interface ErrorReport {
  timestamp: string;
  sessionId: string;
  summary: string;
  errors: FormattedError[];
  recoveryAttempts: FormattedRecovery[];
  suggestions: string[];
  debugInfo?: DebugInfo;
}

interface FormattedError {
  code: string;
  message: string;
  when: string;                      // Relative time
  where: string;                     // Component/agent
  recovered: boolean;
}

interface FormattedRecovery {
  error: string;
  strategy: string;
  outcome: string;
  when: string;
}

interface DebugInfo {
  checkpointId?: string;
  logFile: string;
  stateFile: string;
  messageFiles: string[];
}


// ============================================
// Error Reporting Functions
// ============================================

// Generate error report for session
function generateErrorReport(
  session: Session
): ErrorReport;

// Format error for display
function formatError(
  error: SwarmError,
  verbose: boolean
): string;

// Format error for logging
function formatErrorLog(
  error: SwarmError
): string;

// Get actionable suggestions
function getSuggestions(
  error: SwarmError
): string[];
```

### User-Facing Messages

```typescript
// ============================================
// User Message Templates
// ============================================

const ERROR_MESSAGES: Record<string, (error: SwarmError) => string> = {
  AGENT_TIMEOUT: (e) =>
    `Agent '${e.agentRole}' did not respond within ${e.context?.timeout}ms. ` +
    `The agent may be processing a complex task.`,

  AGENT_CRASHED: (e) =>
    `Agent '${e.agentRole}' terminated unexpectedly. ` +
    `Check the agent logs for details: bun swarm.ts logs ${e.agentRole}`,

  RATE_LIMITED: (e) =>
    `API rate limit reached. Waiting ${e.context?.retryIn}ms before retry. ` +
    `Consider spacing out requests or upgrading your API plan.`,

  WORKFLOW_TIMEOUT: (e) =>
    `Workflow exceeded maximum duration of ${e.context?.timeout}ms. ` +
    `Partial results have been saved.`,

  TMUX_NOT_FOUND: () =>
    `tmux is required but not installed. ` +
    `Install with: sudo apt install tmux (Linux) or brew install tmux (Mac)`,

  GIT_WORKTREE_FAILED: (e) =>
    `Failed to create git worktree for agent '${e.agentRole}'. ` +
    `Try: git worktree prune && bun swarm.ts clean --worktrees`
};

// Get user-friendly error message
function getUserMessage(error: SwarmError): string;

// Get remediation steps
function getRemediationSteps(error: SwarmError): string[];
```

---

## 9. Integration Points

### Integration with Orchestrator (Step 8)

**Delegation Pattern**: The Orchestrator detects errors and calls THIS module's functions for recovery decisions. This module provides the implementation; the Orchestrator provides the integration points.

**What Orchestrator Does**:
- Detects agent timeouts, crashes, routing failures
- Creates `SwarmError` objects with context
- Calls error-handling module functions
- Applies recovery outcomes to session state

**What This Module Provides to Orchestrator**:
- `createSwarmError()` - Create structured errors
- `executeRecovery()` - Execute recovery strategy
- `canContinueWorkflow()` - Check if workflow can continue
- `applyDegradation()` - Apply graceful degradation
- `checkpointOnStage()` - Create state checkpoints
- `withRetry()` - Wrap operations with retry logic

**Example Integration**:
```typescript
// In Orchestrator (Plan 08) - Detection and delegation
class Orchestrator {
  async handleAgentTimeout(role: AgentRole): Promise<void> {
    // 1. Detect the error
    const error = createSwarmError('AGENT_TIMEOUT', {
      component: 'orchestrator',
      agentRole: role,
      context: { timeout: this.config.agentTimeout }
    });

    // 2. Delegate to THIS module for recovery decision
    const outcome = await executeRecovery(error, this.getRecoveryContext());

    // 3. Apply the outcome
    if (outcome.success) {
      this.resetAgentTimeout(role);
    } else {
      await this.handleAgentFailure(role);
    }
  }

  async handleAgentFailure(role: AgentRole): Promise<void> {
    // 1. Detect the error
    const error = createSwarmError('AGENT_CRASHED', {
      component: 'orchestrator',
      agentRole: role
    });

    // 2. Delegate to THIS module for degradation decision
    const context = this.getRecoveryContext();
    const canContinue = await canContinueWorkflow(error, context);

    if (!canContinue) {
      this.failSession(`Required agent ${role} failed`);
      return;
    }

    // 3. Apply degradation from THIS module
    const degradation = await applyDegradation(error, context);
    this.session.degradationState = degradation;
  }

  // Wrap critical operations with retry from THIS module
  async spawnAgent(role: AgentRole): Promise<ManagedAgent> {
    return withRetry(
      async () => this.doSpawnAgent(role),
      RETRY_CONFIGS.agentSpawn,
      `spawn_${role}`
    );
  }
}
```

### Integration with CLI (Step 9)

```typescript
// CLI error handling
async function handleCommand(command: string, args: ParsedArgs): Promise<number> {
  try {
    return await executeCommand(command, args);
  } catch (error) {
    const swarmError = wrapError(error);
    displayError(swarmError);

    // Log for debugging
    await logError(swarmError);

    // Suggest recovery options
    const suggestions = getSuggestions(swarmError);
    if (suggestions.length > 0) {
      print('Suggestions:', 'info');
      suggestions.forEach(s => print(`  - ${s}`));
    }

    return swarmError.severity === 'fatal' ? 1 : 2;
  }
}

// Recovery command
async function handleRecover(sessionId: string): Promise<number> {
  if (!await canRecover(sessionId)) {
    print('No recovery point available for this session', 'error');
    return 1;
  }

  const result = await recoverSession(sessionId, {
    skipFailedStage: true,
    resetAgents: true,
    preserveMessages: true
  });

  if (result.success) {
    print(`Recovered from checkpoint: ${result.resumedFrom}`, 'success');
    return 0;
  } else {
    displayError(result.error!);
    return 1;
  }
}
```

### Integration with Message Bus (Step 3)

```typescript
// Wrap message operations
async function sendMessageSafe(
  from: string,
  to: string,
  message: AgentMessage
): Promise<void> {
  return withRetry(
    async () => sendMessage(from, to, message),
    RETRY_CONFIGS.messageSend,
    `send_${from}_${to}`
  );
}

// Handle parse errors
function readMessagesSafe(agent: string, box: 'inbox' | 'outbox'): AgentMessage[] {
  try {
    return readMessages(agent, box);
  } catch (error) {
    logError(createSwarmError('FILESYSTEM_ERROR', {
      message: `Failed to read ${box} for ${agent}`,
      details: String(error),
      component: 'message-bus'
    }));
    return [];
  }
}
```

### Integration with Database (Step 2)

```typescript
// Wrap database operations
async function queryWithRetry<T>(
  sql: string,
  params: unknown[]
): Promise<T> {
  return withRetry(
    async () => db.query(sql).all(...params) as T,
    RETRY_CONFIGS.databaseWrite,
    'database_query'
  );
}

// Handle database errors
function handleDatabaseError(error: unknown): never {
  const swarmError = createSwarmError('DATABASE_ERROR', {
    message: 'Database operation failed',
    details: String(error),
    component: 'database'
  });

  logError(swarmError);
  throw swarmError;
}
```

---

## 10. Testing Strategy

### Unit Tests

**Error Creation**:
- Test error code to SwarmError mapping
- Test error context preservation
- Test error serialization/deserialization

**Retry Logic**:
- Test successful retry after failures
- Test max retries exceeded
- Test backoff calculation
- Test jitter randomization
- Test non-retryable errors

**Recovery Strategy Selection**:
- Test error code to strategy mapping
- Test condition-based strategy selection
- Test fallback strategy selection

**Graceful Degradation**:
- Test degradation state updates
- Test canContinue logic
- Test capability availability checks

### Integration Tests

**Error Recovery Flow**:
1. Start workflow
2. Inject agent failure
3. Verify recovery attempt
4. Verify workflow continues or degrades appropriately

**Checkpoint and Recovery**:
1. Start workflow
2. Progress through stages
3. Verify checkpoints created
4. Simulate crash
5. Recover from checkpoint
6. Verify state restored correctly

**Rate Limit Handling**:
1. Mock rate limit response
2. Verify backoff applied
3. Verify retry succeeds
4. Verify workflow completes

### Test Fixtures

```typescript
// Mock errors for testing
const mockAgentTimeout: SwarmError = {
  id: 'test-error-1',
  code: 'AGENT_TIMEOUT',
  category: 'AGENT_ERROR',
  severity: 'error',
  message: 'Agent did not respond within timeout',
  component: 'orchestrator',
  agentRole: 'researcher',
  timestamp: new Date().toISOString(),
  recoverable: true,
  retryable: true,
  context: { timeout: 300000 }
};

// Mock checkpoint for testing
const mockCheckpoint: Checkpoint = {
  id: 'checkpoint-1',
  sessionId: 'session-1',
  timestamp: new Date().toISOString(),
  type: 'stage_complete',
  workflowState: { /* ... */ },
  agentStates: new Map(),
  messageQueueState: { inboxes: {}, outboxes: {}, lastProcessedTimestamps: {} },
  completedStages: ['initial_research'],
  pendingStages: ['verification'],
  processedMessageIds: ['msg-1'],
  errors: [],
  recoveryAttempts: [],
  createdBy: 'auto'
};
```

---

## 11. Configuration

### Error Handling Configuration

```typescript
interface ErrorHandlingConfig {
  // Retry settings
  retry: RetryConfig;

  // Recovery settings
  recovery: {
    maxAttemptsPerError: number;
    maxTotalAttempts: number;
    cooldownMs: number;
  };

  // Checkpointing
  checkpoint: CheckpointConfig;

  // Logging
  logging: {
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    logToFile: boolean;
    logFilePath: string;
    maxLogSize: number;
  };

  // Degradation
  degradation: {
    allowPartialResults: boolean;
    continueWithoutReviewer: boolean;
    continueWithoutResearcher: boolean;
  };
}

const DEFAULT_ERROR_CONFIG: ErrorHandlingConfig = {
  retry: DEFAULT_RETRY_CONFIG,
  recovery: {
    maxAttemptsPerError: 3,
    maxTotalAttempts: 10,
    cooldownMs: 5000
  },
  checkpoint: DEFAULT_CHECKPOINT_CONFIG,
  logging: {
    logLevel: 'info',
    logToFile: true,
    logFilePath: 'logs/error.log',
    maxLogSize: 10 * 1024 * 1024  // 10MB
  },
  degradation: {
    allowPartialResults: true,
    continueWithoutReviewer: true,
    continueWithoutResearcher: false
  }
};
```

### Environment Variables

```bash
# Retry configuration
SWARM_MAX_RETRIES=3
SWARM_RETRY_DELAY=1000
SWARM_RETRY_BACKOFF=2

# Checkpoint configuration
SWARM_CHECKPOINT_ENABLED=true
SWARM_CHECKPOINT_INTERVAL=60000

# Logging
SWARM_LOG_LEVEL=info
SWARM_LOG_TO_FILE=true

# Degradation
SWARM_ALLOW_PARTIAL=true
```

---

## 12. Module Organization

```
src/error-handling/
├── types.ts              # Error types and interfaces
│   ├── SwarmError
│   ├── ErrorCategory, ErrorSeverity
│   ├── RetryConfig, RetryResult
│   ├── RecoveryPlan, RecoveryOutcome
│   ├── DegradationState
│   └── Checkpoint
│
├── errors.ts             # Error definitions and factory
│   ├── AGENT_ERRORS
│   ├── WORKFLOW_ERRORS
│   ├── SYSTEM_ERRORS
│   ├── EXTERNAL_ERRORS
│   ├── USER_ERRORS
│   ├── createSwarmError()
│   └── wrapError()
│
├── retry.ts              # Retry logic
│   ├── withRetry()
│   ├── calculateDelay()
│   ├── isRetryable()
│   └── RETRY_CONFIGS
│
├── recovery.ts           # Recovery strategies
│   ├── RECOVERY_STRATEGIES
│   ├── selectStrategy()
│   ├── executeRecovery()
│   └── executeAction()
│
├── degradation.ts        # Graceful degradation
│   ├── DEGRADATION_RULES
│   ├── canContinue()
│   ├── applyDegradation()
│   └── getAvailableCapabilities()
│
├── checkpoint.ts         # State persistence
│   ├── createCheckpoint()
│   ├── saveCheckpoint()
│   ├── loadCheckpoint()
│   ├── loadLatestCheckpoint()
│   └── pruneCheckpoints()
│
├── session-recovery.ts   # Session recovery
│   ├── canRecover()
│   ├── recoverSession()
│   ├── restoreWorkflowState()
│   └── resumeWorkflow()
│
├── reporting.ts          # Error reporting
│   ├── generateErrorReport()
│   ├── formatError()
│   ├── getUserMessage()
│   └── getSuggestions()
│
└── index.ts              # Public exports
    ├── All error types
    ├── withRetry
    ├── executeRecovery
    ├── checkpoint functions
    └── recovery functions
```

---

## 13. Open Questions & Decisions

### Resolved Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Retry approach | Exponential backoff with jitter | Industry standard, prevents thundering herd |
| Checkpoint storage | SQLite | Already using for other state, reliable |
| Error codes | String constants | More readable than numeric, easier debugging |
| Recovery granularity | Per-error strategies | Different errors need different handling |

### Open Questions

1. **Should recovery be automatic or manual?**
   - Current: Manual via CLI command
   - Alternative: Automatic on next start
   - Consideration: User may want to inspect state first

2. **How long to keep checkpoints?**
   - Current: Keep last 10
   - Alternative: Time-based retention
   - Consideration: Storage vs history tradeoff

3. **Should there be a "dry run" recovery mode?**
   - Current: No
   - Alternative: Preview what would be restored
   - Consideration: Useful for debugging

4. **How to handle partial file writes?**
   - Current: Retry full operation
   - Alternative: Atomic writes with temp files
   - Consideration: Complexity vs reliability

### Alternatives Considered

**Alternative: Circuit breaker pattern**
- Pro: Prevents cascading failures
- Con: Adds complexity, may be overkill
- Decision: Use simple retry with max attempts

**Alternative: Distributed checkpoints**
- Pro: Survives disk failure
- Con: Requires external storage
- Decision: Local SQLite sufficient for personal tool

**Alternative: Structured error logging (JSON)**
- Pro: Easier to parse/analyze
- Con: Harder to read in terminal
- Decision: Human-readable default, JSON option available

---

## 14. Implementation Notes

### Error Handling Best Practices

1. **Fail Fast, Recover Gracefully**: Detect errors early, but don't crash immediately
2. **Preserve Context**: Always capture enough context to debug later
3. **User-First Messages**: Error messages should be actionable, not technical
4. **Log Everything**: Better to over-log than under-log for debugging
5. **Idempotent Recovery**: Recovery operations should be safe to retry
6. **Clean Up Always**: Use try/finally to ensure cleanup happens

### Performance Considerations

1. **Checkpoint Size**: Don't checkpoint large message bodies, reference by ID
2. **Log Rotation**: Implement log rotation to prevent disk fill
3. **Retry Limits**: Set reasonable limits to prevent infinite loops
4. **Async Checkpointing**: Don't block workflow for checkpoint writes

---

## Next Steps

After implementing Error Handling & Recovery, the core Claude Swarm system is complete. Consider:

1. **End-to-End Testing**: Full workflow tests with error injection
2. **Performance Tuning**: Optimize checkpoint frequency and retry delays
3. **Documentation**: User-facing troubleshooting guide
4. **Monitoring**: Optional metrics/dashboard for system health
