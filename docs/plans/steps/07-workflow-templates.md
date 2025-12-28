# Step 7: Workflow Templates - Architectural Plan

## 1. Overview & Purpose

### What This Component Does

Workflow Templates define the multi-stage coordination patterns for different types of tasks. Each workflow specifies which agents participate, in what order, how messages route between them, and what conditions trigger stage transitions. They are the "playbooks" that the Orchestrator follows to coordinate agent collaboration.

### Why It Exists

Without predefined workflows:
- The Orchestrator wouldn't know which agents to spawn
- Message routing would be ad-hoc and error-prone
- There would be no defined progression from start to completion
- Different task types (research vs development) would need custom orchestration code

Workflows provide:
- Declarative stage definitions
- Automatic message routing rules
- Completion detection logic
- Retry and revision handling

### How It Fits Into The Larger System

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLI (swarm.ts)                            │
│  User runs: ./swarm start research "query"                      │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      ORCHESTRATOR                                │
│  Loads workflow by type, executes stages                        │
│  Uses workflow to determine routing and completion              │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                   WORKFLOW TEMPLATES                             │
│  src/workflows/                                                  │
│  ├── types.ts          # Shared workflow interfaces              │
│  ├── research.ts       # Research with verification              │
│  ├── development.ts    # Code with review cycle                  │
│  └── architecture.ts   # Design evaluation                       │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                       AGENTS                                     │
│  Execute stages, communicate via message bus                    │
│  Workflow determines which agents and in what order             │
└─────────────────────────────────────────────────────────────────┘
```

### Problems It Solves

1. **Coordination Logic**: Defines who does what and when
2. **Reusability**: Same workflow can be used for different goals
3. **Routing Rules**: Automatic message routing between stages
4. **Completion Detection**: Knows when workflow is done
5. **Revision Handling**: Manages review-rejection-revision cycles
6. **Extensibility**: New workflows can be added without changing orchestrator

---

## 2. Prerequisites & Dependencies

### External Dependencies

None - workflows are pure TypeScript definitions.

### Internal Dependencies

| Module | Purpose |
|--------|---------|
| `src/types.ts` | Shared types (`AgentRole`, `AgentMessage`) |
| `src/message-bus.ts` | Message routing (referenced but not imported) |

### System State Requirements

- Agent role configurations must exist in `roles/` directory
- Message bus must be initialized before workflow execution

---

## 3. Public API Design

### Core Type Definitions

```typescript
// ============================================
// Agent and Message Types (from src/types.ts)
// ============================================

type AgentRole = 'researcher' | 'developer' | 'reviewer' | 'architect';

type MessageType =
  | 'task'           // Assignment from orchestrator
  | 'finding'        // Research result
  | 'artifact'       // Code/documentation output
  | 'review'         // Review feedback
  | 'design'         // Architecture output
  | 'status'         // Completion/progress signal
  | 'question';      // Clarification request

type TaskStatus =
  | 'pending'        // Waiting to start
  | 'in_progress'    // Currently executing
  | 'awaiting_review'// Output produced, waiting for review
  | 'revision'       // Rejected, needs rework
  | 'complete';      // Successfully finished


// ============================================
// Workflow Stage Definitions
// ============================================

// A single stage in a workflow
interface WorkflowStage {
  name: string;                    // Unique identifier for this stage
  agent: AgentRole;                // Which agent executes this stage
  description: string;             // Human-readable description

  // Input configuration
  inputFrom?: string[];            // Stage names whose output feeds this stage
  inputTypes?: MessageType[];      // Message types this stage accepts

  // Output configuration
  outputType: MessageType;         // Primary output type from this stage
  outputTo?: string[];             // Stage names to route output to

  // Execution control
  condition?: StageCondition;      // When to execute (if omitted, always runs)
  timeout?: number;                // Max execution time in ms
  optional?: boolean;              // If true, workflow continues if stage fails

  // Iteration control (for revision cycles)
  maxIterations?: number;          // Max times this stage can run
  iterationTrigger?: MessageType;  // Message type that triggers re-execution
}

// Condition for whether a stage should execute
interface StageCondition {
  type: 'message_received' | 'verdict' | 'count' | 'custom';

  // For 'message_received': stage runs when specific message arrives
  messageType?: MessageType;
  from?: AgentRole;

  // For 'verdict': stage runs based on reviewer verdict
  verdict?: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED';

  // For 'count': stage runs if count meets threshold
  countField?: string;             // Field in metadata to check
  threshold?: number;              // Minimum count

  // For 'custom': stage runs based on custom logic
  customCheck?: string;            // Name of registered condition function
}


// ============================================
// Workflow Definition
// ============================================

interface WorkflowDefinition {
  name: string;                    // Unique workflow identifier
  description: string;             // What this workflow does
  version: string;                 // Semantic version

  // Agent configuration
  agents: AgentRole[];             // All agents used in this workflow

  // Stage definitions (ordered by dependency, not execution)
  stages: WorkflowStage[];

  // Entry point
  entryStage: string;              // First stage to execute

  // Completion criteria
  completionStage: string;         // Stage whose completion ends workflow

  // Configuration
  config: WorkflowConfig;
}

interface WorkflowConfig {
  maxDuration?: number;            // Max workflow duration in ms
  maxRevisions?: number;           // Global revision limit
  parallelAgents?: boolean;        // Can stages run in parallel?
  failureStrategy: 'abort' | 'continue' | 'retry';
}


// ============================================
// Workflow Runtime State
// ============================================

// Tracks execution state during workflow run
interface WorkflowState {
  workflowName: string;
  sessionId: string;
  startedAt: string;               // ISO8601

  // Stage tracking
  currentStage: string;
  stageHistory: StageExecution[];

  // Agent states
  agentStates: Map<AgentRole, AgentState>;

  // Message tracking
  pendingMessages: AgentMessage[];
  processedMessageIds: Set<string>;

  // Iteration tracking (for revision cycles)
  iterationCounts: Map<string, number>;  // stage name -> count

  // Completion
  status: 'running' | 'complete' | 'failed' | 'timeout';
  completedAt?: string;
  result?: WorkflowResult;
}

interface StageExecution {
  stageName: string;
  startedAt: string;
  completedAt?: string;
  status: 'running' | 'complete' | 'skipped' | 'failed';
  iteration: number;
  outputMessageIds: string[];
}

interface AgentState {
  role: AgentRole;
  status: 'idle' | 'working' | 'complete' | 'blocked' | 'error';
  currentTask?: string;
  lastMessageAt?: string;
}

interface WorkflowResult {
  success: boolean;
  summary: string;
  artifacts: string[];             // File paths or message IDs
  findings?: any[];                // For research workflows
  reviews?: any[];                 // Review summaries
}


// ============================================
// Workflow Module Interface
// ============================================

// Each workflow file exports this interface
interface Workflow {
  definition: WorkflowDefinition;

  // Get roles needed for this workflow
  getRoles(): AgentRole[];

  // Create initial task message for workflow
  createInitialTask(goal: string): AgentMessage;

  // Route a message to appropriate next stage(s)
  routeMessage(
    from: AgentRole,
    message: AgentMessage,
    state: WorkflowState
  ): RoutingDecision;

  // Check if workflow is complete
  isComplete(state: WorkflowState): boolean;

  // Get next stage to execute (if any)
  getNextStage(state: WorkflowState): string | null;

  // Handle stage completion
  onStageComplete(
    stageName: string,
    messages: AgentMessage[],
    state: WorkflowState
  ): void;

  // Synthesize final result
  synthesizeResult(state: WorkflowState): WorkflowResult;
}

interface RoutingDecision {
  // Messages to send
  messages: Array<{
    to: AgentRole;
    message: AgentMessage;
  }>;

  // Stage transitions
  stageTransition?: {
    from: string;
    to: string;
  };

  // State updates
  updateAgentState?: {
    role: AgentRole;
    state: Partial<AgentState>;
  };
}
```

### Workflow File Structure

```
src/workflows/
├── types.ts           # All type definitions above
├── base.ts            # Base workflow utilities
├── research.ts        # Research workflow
├── development.ts     # Development workflow
└── architecture.ts    # Architecture workflow
```

---

## 4. Workflow Specifications

### 4.1 Research Workflow

**File**: `src/workflows/research.ts`

**Purpose**: Multi-source research with verification loop.

**Agents**: researcher, reviewer

**Stages**:

```
┌──────────────────┐
│ initial_research │  Researcher gathers findings
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│   verification   │  Reviewer verifies findings
└────────┬─────────┘
         │
    ┌────┴────┐
    ▼         ▼
APPROVED   NEEDS_REVISION
    │         │
    │    ┌────┘
    │    ▼
    │  ┌──────────────────┐
    │  │    deep_dive     │  Researcher addresses gaps
    │  └────────┬─────────┘
    │           │
    │           ▼
    │  ┌──────────────────┐
    │  │  re_verification │  Reviewer re-checks
    │  └────────┬─────────┘
    │           │
    │      ┌────┴────┐
    │      ▼         ▼
    │  APPROVED   NEEDS_REVISION (max 2 iterations)
    │      │         │
    └──────┴─────────┘
           │
           ▼
    ┌──────────────────┐
    │    synthesis     │  Final report
    └──────────────────┘
```

**Stage Definitions**:

| Stage | Agent | Input | Output | Condition |
|-------|-------|-------|--------|-----------|
| initial_research | researcher | task | finding | Always (entry) |
| verification | reviewer | finding | review | After initial_research |
| deep_dive | researcher | review | finding | If verdict=NEEDS_REVISION |
| re_verification | reviewer | finding | review | After deep_dive |
| synthesis | orchestrator | findings, reviews | result | When APPROVED or max iterations |

**Initial Task Format**:
```json
{
  "type": "task",
  "from": "orchestrator",
  "to": "researcher",
  "content": {
    "subject": "Research Assignment",
    "body": "{user's research query}",
    "metadata": {
      "workflow": "research",
      "sessionId": "...",
      "expectations": [
        "Find accurate, current information",
        "Cite sources with URLs",
        "Assess confidence levels"
      ]
    }
  }
}
```

**Completion Criteria**:
- Reviewer returns APPROVED verdict, OR
- Maximum revision iterations (2) reached

**Routing Logic**:
1. Researcher `finding` → Reviewer inbox
2. Reviewer `review` with APPROVED → Mark complete
3. Reviewer `review` with NEEDS_REVISION → Researcher inbox (if iterations < max)
4. Any `status:complete` → Check if all required outputs received

---

### 4.2 Development Workflow

**File**: `src/workflows/development.ts`

**Purpose**: Code implementation with design and review cycles.

**Agents**: architect, developer, reviewer

**Stages**:

```
┌──────────────────┐
│   architecture   │  Architect creates design
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  design_review   │  Reviewer evaluates design
└────────┬─────────┘
         │
    ┌────┴────┐
    ▼         ▼
APPROVED   NEEDS_REVISION ──┐
    │                       │
    │    ┌──────────────────┘
    │    ▼
    │  ┌──────────────────┐
    │  │ design_revision  │  Architect revises
    │  └────────┬─────────┘
    │           │
    │           └───▶ design_review (max 2)
    │
    ▼
┌──────────────────┐
│ implementation   │  Developer builds it
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│   code_review    │  Reviewer checks code
└────────┬─────────┘
         │
    ┌────┴────┐
    ▼         ▼
APPROVED   NEEDS_REVISION ──┐
    │                       │
    │    ┌──────────────────┘
    │    ▼
    │  ┌──────────────────┐
    │  │ code_revision    │  Developer fixes
    │  └────────┬─────────┘
    │           │
    │           └───▶ code_review (max 3)
    │
    ▼
┌──────────────────┐
│  documentation   │  Developer documents
└────────┬─────────┘
         │
         ▼
    ┌──────────────────┐
    │     complete     │
    └──────────────────┘
```

**Stage Definitions**:

| Stage | Agent | Input | Output | Max Iterations |
|-------|-------|-------|--------|----------------|
| architecture | architect | task | design | 1 |
| design_review | reviewer | design | review | 1 per design |
| design_revision | architect | review | design | 2 |
| implementation | developer | design (approved) | artifact | 1 |
| code_review | reviewer | artifact | review | 1 per artifact |
| code_revision | developer | review | artifact | 3 |
| documentation | developer | artifact (approved) | artifact | 1 |

**Initial Task Format**:
```json
{
  "type": "task",
  "from": "orchestrator",
  "to": "architect",
  "content": {
    "subject": "Development Task",
    "body": "{feature specification}",
    "metadata": {
      "workflow": "development",
      "sessionId": "...",
      "requirements": [
        "Design the approach",
        "Implementation with tests",
        "Documentation"
      ]
    }
  }
}
```

**Completion Criteria**:
- Documentation stage completes, OR
- Code approved and documentation produced, OR
- Maximum revision iterations exceeded (fails gracefully)

**Routing Logic**:
1. Architect `design` → Reviewer inbox
2. Reviewer `review` of design:
   - APPROVED → Developer inbox with approved design
   - NEEDS_REVISION → Architect inbox
3. Developer `artifact` → Reviewer inbox
4. Reviewer `review` of code:
   - APPROVED → Developer inbox (for documentation)
   - NEEDS_REVISION → Developer inbox (for fixes)
5. Developer `artifact` (documentation) → Mark complete

---

### 4.3 Architecture Workflow

**File**: `src/workflows/architecture.ts`

**Purpose**: System design evaluation with research backing.

**Agents**: researcher, architect, reviewer

**Stages**:

```
┌──────────────────┐
│   requirements   │  Orchestrator clarifies requirements
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│   prior_art      │  Researcher finds existing solutions
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ design_options   │  Architect creates alternatives
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│   evaluation     │  Reviewer evaluates options
└────────┬─────────┘
         │
    ┌────┴────┐
    ▼         ▼
APPROVED   NEEDS_WORK ──────┐
    │                       │
    │    ┌──────────────────┘
    │    ▼
    │  Additional research or design iteration
    │
    ▼
┌──────────────────┐
│    decision      │  Select approach
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ implementation_  │  Architect creates detailed plan
│     plan         │
└──────────────────┘
```

**Stage Definitions**:

| Stage | Agent | Input | Output | Notes |
|-------|-------|-------|--------|-------|
| requirements | orchestrator | task | task (refined) | May include clarifications |
| prior_art | researcher | requirements | finding | Research existing solutions |
| design_options | architect | requirements, findings | design | Multiple alternatives |
| evaluation | reviewer | design | review | Evaluates each option |
| decision | orchestrator | reviews | task | Selects recommended approach |
| implementation_plan | architect | decision | design | Detailed phased plan |

**Initial Task Format**:
```json
{
  "type": "task",
  "from": "orchestrator",
  "to": "researcher",
  "content": {
    "subject": "Architecture Research",
    "body": "{system requirements}",
    "metadata": {
      "workflow": "architecture",
      "sessionId": "...",
      "phase": "prior_art",
      "lookingFor": [
        "Similar systems",
        "Common patterns",
        "Known pitfalls"
      ]
    }
  }
}
```

**Completion Criteria**:
- Implementation plan produced and approved, OR
- Reviewer approves design without plan (for simpler projects)

---

## 5. Routing Logic Specifications

### Message Routing Rules

Each workflow defines routing rules as a state machine:

```typescript
interface RoutingRule {
  // Match criteria
  from: AgentRole;
  messageType: MessageType;
  condition?: (msg: AgentMessage, state: WorkflowState) => boolean;

  // Actions
  routeTo: AgentRole | 'orchestrator';
  transformMessage?: (msg: AgentMessage) => AgentMessage;
  updateStage?: string;
  updateState?: Partial<WorkflowState>;
}
```

### Research Workflow Routing

| From | Type | Condition | Route To | Stage Transition |
|------|------|-----------|----------|------------------|
| researcher | finding | - | reviewer | → verification |
| reviewer | review | verdict=APPROVED | orchestrator | → synthesis |
| reviewer | review | verdict=NEEDS_REVISION, iter<max | researcher | → deep_dive |
| reviewer | review | verdict=NEEDS_REVISION, iter>=max | orchestrator | → synthesis (partial) |
| researcher | finding | stage=deep_dive | reviewer | → re_verification |
| * | status:complete | - | orchestrator | Check completion |

### Development Workflow Routing

| From | Type | Condition | Route To | Stage Transition |
|------|------|-----------|----------|------------------|
| architect | design | stage=architecture | reviewer | → design_review |
| reviewer | review | target=design, APPROVED | developer | → implementation |
| reviewer | review | target=design, NEEDS_REVISION | architect | → design_revision |
| architect | design | stage=design_revision | reviewer | → design_review |
| developer | artifact | type=code | reviewer | → code_review |
| reviewer | review | target=code, APPROVED | developer | → documentation |
| reviewer | review | target=code, NEEDS_REVISION | developer | → code_revision |
| developer | artifact | type=documentation | orchestrator | → complete |

### Transition Guards

```typescript
// Guards prevent invalid transitions
interface TransitionGuard {
  name: string;
  check: (state: WorkflowState, message: AgentMessage) => boolean;
  errorMessage: string;
}

// Example guards
const guards = {
  maxIterationsNotExceeded: {
    check: (state, msg) => {
      const count = state.iterationCounts.get(state.currentStage) || 0;
      return count < getStageMaxIterations(state.currentStage);
    },
    errorMessage: "Maximum revision iterations exceeded"
  },

  previousStageComplete: {
    check: (state, msg) => {
      const stage = getStageDefinition(state.currentStage);
      return stage.inputFrom?.every(s =>
        state.stageHistory.some(h => h.stageName === s && h.status === 'complete')
      ) ?? true;
    },
    errorMessage: "Required input stages not complete"
  }
};
```

---

## 6. Completion Detection

### Completion Criteria by Workflow

**Research Workflow**:
```typescript
function isResearchComplete(state: WorkflowState): boolean {
  // Complete if:
  // 1. Reviewer approved findings, OR
  // 2. Max iterations reached and we have findings

  const hasApproval = state.stageHistory.some(s =>
    s.stageName === 'verification' &&
    s.status === 'complete'
  );

  const maxIterationsReached =
    (state.iterationCounts.get('deep_dive') || 0) >= 2;

  const hasFindings = state.processedMessageIds.size > 0;

  return hasApproval || (maxIterationsReached && hasFindings);
}
```

**Development Workflow**:
```typescript
function isDevelopmentComplete(state: WorkflowState): boolean {
  // Complete if documentation stage completed
  return state.stageHistory.some(s =>
    s.stageName === 'documentation' &&
    s.status === 'complete'
  );
}
```

**Architecture Workflow**:
```typescript
function isArchitectureComplete(state: WorkflowState): boolean {
  // Complete if implementation plan produced
  return state.stageHistory.some(s =>
    s.stageName === 'implementation_plan' &&
    s.status === 'complete'
  );
}
```

### Completion Signal Detection

Detect completion from agent status messages:

```typescript
function detectCompletion(message: AgentMessage): boolean {
  if (message.type !== 'status') return false;

  const status = message.content?.metadata?.status;
  return status === 'complete';
}
```

---

## 7. Base Workflow Utilities

**File**: `src/workflows/base.ts`

### Utility Functions

```typescript
// Generate unique message ID
function generateMessageId(): string;

// Create timestamp in ISO8601
function timestamp(): string;

// Create a task message
function createTaskMessage(
  to: AgentRole,
  subject: string,
  body: string,
  metadata?: Record<string, unknown>
): AgentMessage;

// Create initial workflow state
function createWorkflowState(
  workflowName: string,
  sessionId: string
): WorkflowState;

// Update stage in state
function transitionStage(
  state: WorkflowState,
  to: string
): WorkflowState;

// Record message as processed
function markMessageProcessed(
  state: WorkflowState,
  messageId: string
): WorkflowState;

// Increment iteration counter
function incrementIteration(
  state: WorkflowState,
  stageName: string
): WorkflowState;

// Check if agent is in expected state
function validateAgentState(
  state: WorkflowState,
  role: AgentRole,
  expectedStatus: AgentState['status']
): boolean;

// Get stage definition by name
function getStageDefinition(
  workflow: WorkflowDefinition,
  stageName: string
): WorkflowStage | undefined;

// Check if stage should run based on condition
function evaluateStageCondition(
  stage: WorkflowStage,
  state: WorkflowState,
  message?: AgentMessage
): boolean;

// Get all agents currently needed
function getActiveAgents(
  workflow: WorkflowDefinition,
  state: WorkflowState
): AgentRole[];
```

---

## 8. Integration Points

### Integration with Orchestrator (Step 8)

The Orchestrator uses workflows via:

```typescript
// Orchestrator.startWorkflow()
const workflow = await loadWorkflow(type);  // 'research', 'development', 'architecture'
const roles = workflow.getRoles();
const initialTask = workflow.createInitialTask(goal);

// Orchestrator.monitorLoop()
for (const message of newMessages) {
  const routing = workflow.routeMessage(from, message, state);
  // Apply routing decisions
}

if (workflow.isComplete(state)) {
  const result = workflow.synthesizeResult(state);
}
```

### Integration with Message Bus (Step 3)

Workflows reference message paths but don't directly use message-bus:

- Workflows define message routing (who gets what)
- Orchestrator applies routing via message-bus
- Message format matches `AgentMessage` from types.ts

### Integration with Agent Roles (Step 6)

Agents listed in workflow must have CLAUDE.md configs:
- `roles/researcher/CLAUDE.md`
- `roles/developer/CLAUDE.md`
- `roles/reviewer/CLAUDE.md`
- `roles/architect/CLAUDE.md`

### Loading Workflows

```typescript
// src/workflows/index.ts
import { researchWorkflow } from './research';
import { developmentWorkflow } from './development';
import { architectureWorkflow } from './architecture';

const workflows: Record<string, Workflow> = {
  research: researchWorkflow,
  development: developmentWorkflow,
  development: developmentWorkflow,
  architect: architectureWorkflow,
  architecture: architectureWorkflow,  // alias
};

export function loadWorkflow(type: string): Workflow {
  const workflow = workflows[type];
  if (!workflow) {
    throw new Error(`Unknown workflow type: ${type}`);
  }
  return workflow;
}

export function listWorkflows(): string[] {
  return Object.keys(workflows);
}
```

---

## 9. Error Handling

### Stage Errors

| Error | Handling |
|-------|----------|
| Agent timeout | Retry stage, then mark failed |
| Invalid output format | Request clarification from agent |
| Agent blocked | Route to orchestrator for manual intervention |
| Unexpected message type | Log warning, attempt best-effort routing |

### Workflow-Level Errors

| Error | Handling |
|-------|----------|
| Max iterations exceeded | Complete with partial results |
| Workflow timeout | Synthesize available results |
| Agent crash | Attempt restart, then fail gracefully |
| Missing required output | Block dependent stages |

### Error State in WorkflowState

```typescript
interface WorkflowState {
  // ... other fields ...

  errors: WorkflowError[];
}

interface WorkflowError {
  timestamp: string;
  stage: string;
  agent?: AgentRole;
  code: 'TIMEOUT' | 'INVALID_OUTPUT' | 'AGENT_ERROR' | 'MAX_ITERATIONS';
  message: string;
  recoverable: boolean;
}
```

---

## 10. Testing Strategy

### Unit Tests

**Stage Condition Evaluation**:
- Test each condition type evaluates correctly
- Test edge cases (empty state, missing fields)

**Routing Logic**:
- Test each routing rule matches correctly
- Test routing with various message types
- Test transition guards

**Completion Detection**:
- Test completion detected when criteria met
- Test completion not triggered prematurely
- Test partial completion scenarios

### Integration Tests

**Workflow Execution Simulation**:
1. Create mock messages for each stage
2. Feed through workflow routing
3. Verify state transitions
4. Verify completion detection

**Multi-Iteration Tests**:
1. Simulate NEEDS_REVISION cycles
2. Verify iteration counts
3. Verify max iteration handling

### Test Fixtures

```typescript
// Example test messages
const mockResearcherFinding: AgentMessage = {
  id: 'test-finding-1',
  timestamp: '2024-01-01T00:00:00Z',
  from: 'researcher',
  to: 'reviewer',
  type: 'finding',
  priority: 'normal',
  content: {
    subject: 'Research Finding',
    body: 'Test finding content',
    metadata: {
      claim: 'Test claim',
      confidence: 'high',
      sources: ['https://example.com']
    }
  }
};

const mockReviewerApproval: AgentMessage = {
  id: 'test-review-1',
  type: 'review',
  from: 'reviewer',
  to: 'orchestrator',
  content: {
    metadata: {
      verdict: 'APPROVED'
    }
  }
};
```

---

## 11. Configuration

### Workflow Configuration Options

```typescript
// Default configurations
const defaultWorkflowConfig: WorkflowConfig = {
  maxDuration: 30 * 60 * 1000,  // 30 minutes
  maxRevisions: 3,
  parallelAgents: false,
  failureStrategy: 'continue'
};

// Per-workflow overrides
const researchConfig: WorkflowConfig = {
  ...defaultWorkflowConfig,
  maxDuration: 20 * 60 * 1000,  // 20 minutes for research
  maxRevisions: 2
};

const developmentConfig: WorkflowConfig = {
  ...defaultWorkflowConfig,
  maxDuration: 60 * 60 * 1000,  // 1 hour for development
  maxRevisions: 3
};
```

### Adding New Workflows

To add a custom workflow:

1. Create `src/workflows/{name}.ts`
2. Define `WorkflowDefinition` with stages
3. Implement `Workflow` interface
4. Export from `src/workflows/index.ts`
5. Add to workflows map

---

## 12. Open Questions & Decisions

### Resolved Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Workflow storage | TypeScript files | Type-safe, co-located with code |
| Stage dependencies | Explicit inputFrom | Clear data flow |
| Iteration limits | Per-stage configurable | Different stages need different limits |
| Routing | Centralized in workflow | Keeps logic together |

### Open Questions

1. **Should workflows support parallel stages?**
   - Current: Sequential only
   - Alternative: Allow concurrent stage execution
   - Consideration: Adds complexity, may need it later

2. **How to handle agent substitution?**
   - Current: Fixed agent per stage
   - Alternative: Allow fallback agents
   - Consideration: Complexity vs resilience tradeoff

3. **Should workflows be hot-reloadable?**
   - Current: Loaded at startup
   - Alternative: Watch for changes
   - Consideration: Useful for development

4. **How to version workflow definitions?**
   - Current: Version field but not enforced
   - Alternative: Breaking change detection
   - Consideration: For future compatibility

---

## 13. File Layout Summary

```
src/workflows/
├── types.ts              # All type definitions
│   ├── WorkflowStage
│   ├── WorkflowDefinition
│   ├── WorkflowState
│   ├── Workflow interface
│   └── Supporting types
│
├── base.ts               # Utility functions
│   ├── generateMessageId()
│   ├── createTaskMessage()
│   ├── createWorkflowState()
│   ├── transitionStage()
│   └── Other utilities
│
├── research.ts           # Research workflow
│   ├── definition: WorkflowDefinition
│   ├── getRoles()
│   ├── createInitialTask()
│   ├── routeMessage()
│   ├── isComplete()
│   └── synthesizeResult()
│
├── development.ts        # Development workflow
│   └── (same structure)
│
├── architecture.ts       # Architecture workflow
│   └── (same structure)
│
└── index.ts              # Exports and loader
    ├── loadWorkflow()
    └── listWorkflows()
```

---

## Next Step

After implementing Workflow Templates, proceed to **Step 8: Orchestrator** which uses these workflows to coordinate the actual agent execution.
