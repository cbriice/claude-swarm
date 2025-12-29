# Orchestrator and Workflow Modules Test Case Analysis

This document provides a comprehensive analysis of test cases for the orchestrator and workflow modules of claude-swarm. Each section documents base cases, edge cases, and potentially suboptimal behaviors that should be tested.

---

## Table of Contents

1. [Module Overview](#module-overview)
2. [src/orchestrator.ts - Central Coordinator](#srcorchestratortscentral-coordinator)
3. [src/workflows/templates.ts - Workflow Definitions](#srcworkflowstemplatests---workflow-definitions)
4. [src/workflows/engine.ts - State Machine Execution](#srcworkflowsenginets---state-machine-execution)
5. [src/agents/role-loader.ts - CLAUDE.md Loading](#srcagentsrole-loaderts---claudemd-loading)
6. [Cross-Cutting Concerns](#cross-cutting-concerns)
7. [Severity Classification](#severity-classification)

---

## Module Overview

The claude-swarm orchestrator system consists of four primary modules that work together to manage multi-agent workflows:

| Module | Primary Responsibility | Key Dependencies |
|--------|----------------------|------------------|
| `orchestrator.ts` | Session lifecycle, agent spawning, message routing, monitoring | tmux, worktree, message-bus, db, workflows |
| `templates.ts` | Workflow template definitions, instance creation, step transitions | types |
| `engine.ts` | Step execution, state transitions, message routing decisions | templates |
| `role-loader.ts` | Loading and parsing agent CLAUDE.md configurations | filesystem |

---

## src/orchestrator.ts - Central Coordinator

**Location:** `/home/carso/code/claude-swarm/src/orchestrator.ts`

### Base Cases (Happy Path)

#### TC-ORCH-001: Normal Workflow Start to Finish
**Description:** Complete workflow execution from `startWorkflow()` to successful completion.

**Preconditions:**
- tmux is installed and available
- Git repository with commits exists
- Role CLAUDE.md files exist for required roles

**Steps:**
1. Create orchestrator with default config
2. Call `startWorkflow('research', 'Analyze codebase')`
3. Wait for workflow completion via events
4. Verify `synthesizeResults()` returns success

**Expected Results:**
- Session transitions: `initializing` -> `running` -> `synthesizing` -> `complete`
- All agents spawn successfully
- Events emitted in correct order
- Final result contains all agent summaries

**Verification Points:**
```typescript
// Session status progression
expect(session.status).toBe('initializing'); // After startWorkflow begins
expect(session.status).toBe('running');       // After agents ready
expect(session.status).toBe('complete');      // After synthesis
```

---

#### TC-ORCH-002: Agent Spawn, Communication, Completion
**Description:** Single agent lifecycle from spawn to completion signal.

**Steps:**
1. Start workflow with single-agent template ('review')
2. Observe agent spawning events
3. Send task message to agent
4. Receive completion status

**Expected Results:**
- `agent_spawned` event with paneId
- `agent_ready` event after Claude Code starts
- `agent_working` event when task sent
- `agent_complete` event on completion

**Verification Points:**
- Agent status transitions: `spawning` -> `starting` -> `ready` -> `working` -> `complete`
- `messageCount` increments correctly
- `lastActivityAt` updates on each message

---

#### TC-ORCH-003: Stage Transitions Through Workflow
**Description:** Verify correct stage transitions in multi-stage workflow.

**Steps:**
1. Start 'implement' workflow (architecture -> design_review -> implementation -> code_review -> documentation)
2. Complete each stage with appropriate outputs
3. Verify `stage_transition` events

**Expected Results:**
- Events emitted for each transition
- Checkpoint created after each stage
- Iteration counts updated appropriately

---

### Edge Cases

#### TC-ORCH-E001: Agent Fails to Spawn
**Severity:** HIGH

**Description:** Handle failure when tmux pane creation fails.

**Trigger Conditions:**
- tmux session creation fails
- Maximum pane limit reached
- Worktree does not exist

**Current Behavior (from code analysis):**
```typescript
// Lines 631-723 in orchestrator.ts
if (!existsSync(worktreePath)) {
  return err(createOrchestratorError('AGENT_SPAWN_FAILED',
    `Worktree does not exist for role: ${role}`));
}
```

**Test Cases:**
1. Worktree missing for role
2. tmux pane creation returns error
3. Claude Code fails to start in pane

**Expected Recovery:**
- Retry up to 2 times (per `RETRY_CONFIGS.agentSpawn`)
- Cleanup partial state on final failure
- Return meaningful error to caller

**Potential Issues:**
- **Partial cleanup**: If pane is created but Claude Code fails, pane may be orphaned
- **Map state corruption**: Agent might be added to `session.agents` before full initialization

---

#### TC-ORCH-E002: Agent Crashes Mid-Workflow
**Severity:** HIGH

**Description:** Handle agent termination during active processing.

**Trigger Conditions:**
- Claude Code process exits unexpectedly
- tmux pane dies
- Network disconnection

**Detection Mechanism (from code):**
```typescript
// Lines 975-1048 - checkAgentHealth()
const lastActivity = new Date(agent.lastActivityAt).getTime();
if (Date.now() - lastActivity > this._config.agentTimeout) {
  agent.status = 'error';
  // ... recovery logic
}
```

**Test Cases:**
1. Kill agent pane during active task
2. Agent stops responding (simulated by no output)
3. Agent produces error output

**Expected Recovery:**
- Create SwarmError with `AGENT_TIMEOUT` code
- Execute recovery strategy from error-handling module
- Update session errors array
- Emit `agent_error` event

**Potential Issues:**
- **Lost messages**: Messages sent to crashed agent inbox may never be processed
- **State inconsistency**: Workflow may be in transitional state when crash occurs

---

#### TC-ORCH-E003: Workflow Timeout
**Severity:** MEDIUM

**Description:** Workflow exceeds `workflowTimeout` configuration.

**Configuration:**
```typescript
workflowTimeout: 1800000 // 30 minutes default
```

**Detection (Lines 1373-1384):**
```typescript
const elapsed = Date.now() - new Date(this.session.startedAt).getTime();
if (elapsed > this._config.workflowTimeout) {
  this.recordError({...});
  await this.handleWorkflowTimeout();
}
```

**Test Cases:**
1. Workflow exceeds timeout during agent work
2. Workflow exceeds timeout during stage transition
3. Workflow exceeds timeout during synthesis

**Expected Behavior:**
- Stop monitoring loop
- Set session status to 'failed'
- Synthesize partial results
- Cleanup if autoCleanup enabled

**Potential Issues:**
- **Race condition**: Timeout check and completion check may race
- **Partial synthesis**: Results may be incomplete or inconsistent

---

#### TC-ORCH-E004: Multiple Agents Finishing Simultaneously
**Severity:** MEDIUM

**Description:** Handle concurrent completion signals from multiple agents.

**Scenario:**
- Parallel workflow stages complete at the same time
- Multiple messages arrive in same monitoring interval

**Relevant Code (Lines 1409-1433):**
```typescript
private async checkOutboxes(): Promise<void> {
  for (const [role, agent] of this.session.agents) {
    const newMessages = messageBus.getNewOutboxMessages(role, state.lastReadTimestamp);
    for (const message of newMessages) {
      await this.routeMessage(role, message);
      // ...
    }
  }
}
```

**Test Cases:**
1. Two agents complete in same monitor interval
2. Messages from multiple agents queued simultaneously
3. Stage transition triggered by multiple completion signals

**Potential Issues:**
- **Sequential processing**: Messages processed sequentially, not atomically
- **State drift**: First message may change workflow state, affecting routing of second

---

#### TC-ORCH-E005: Invalid Workflow Type Requested
**Severity:** LOW

**Description:** User requests non-existent workflow type.

**Test Input:**
```typescript
orchestrator.startWorkflow('nonexistent', 'Some goal');
```

**Expected Behavior:**
```typescript
// Lines 336-340
if (!templateResult.ok) {
  return err(createOrchestratorError('WORKFLOW_NOT_FOUND',
    `Workflow type not found: ${type}`));
}
```

**Verification:**
- Returns `WORKFLOW_NOT_FOUND` error
- No resources allocated
- No session created

---

#### TC-ORCH-E006: Empty or Invalid Goal
**Severity:** LOW

**Description:** Workflow started with empty goal string.

**Test Cases:**
1. Empty string: `''`
2. Whitespace only: `'   '`
3. null/undefined (TypeScript should prevent)

**Current Validation (Lines 343-346):**
```typescript
if (!goal || goal.trim().length === 0) {
  return err(createOrchestratorError('SYSTEM_ERROR', 'Goal cannot be empty'));
}
```

---

### Potentially Suboptimal/Harmful Behaviors

#### TC-ORCH-H001: Memory Leak from Uncleared Intervals
**Severity:** HIGH

**Description:** Monitor interval not cleared on error paths.

**Risk Areas:**
```typescript
// Lines 940-956 - startMonitoring()
this.monitorIntervalId = setInterval(
  () => this.monitorLoop(),
  this._config.monitorInterval
);

// Lines 961-970 - stopMonitoring()
if (this.monitorIntervalId) {
  clearInterval(this.monitorIntervalId);
  this.monitorIntervalId = null;
}
```

**Failure Scenarios:**
1. Exception thrown in `startWorkflow()` after monitoring starts
2. `kill()` called without `stop()` first
3. Multiple `startMonitoring()` calls without stop

**Test Cases:**
1. Start workflow, throw error, verify interval cleared
2. Call `startMonitoring()` twice, verify single interval
3. Destroy orchestrator, verify no dangling intervals

**Mitigation in Code:**
```typescript
// Line 943 - Guards against double-start
if (this.monitorIntervalId) {
  return; // Already monitoring
}
```

---

#### TC-ORCH-H002: Event Handler Accumulation
**Severity:** MEDIUM

**Description:** Event handlers not removed, leading to memory growth.

**Risk Pattern:**
```typescript
// Lines 1251-1263
on(handler: EventHandler): void {
  this.eventHandlers.add(handler);
}
off(handler: EventHandler): void {
  this.eventHandlers.delete(handler);
}
```

**Test Cases:**
1. Add many handlers, verify `off()` removes them
2. Verify handlers cleared on orchestrator destruction
3. Ensure same handler not added multiple times

**Current Issue:**
- No automatic cleanup on session end
- `eventHandlers` is a `Set`, so duplicates are prevented
- But handlers must be explicitly removed

---

#### TC-ORCH-H003: Partial Cleanup on Error
**Severity:** HIGH

**Description:** Resources not fully cleaned up when errors occur mid-initialization.

**Cleanup Chain (Lines 1190-1225):**
```typescript
async cleanup(): Promise<void> {
  this.stopMonitoring();
  // Terminate all agents
  for (const agent of this.session.agents.values()) {
    await this.terminateAgentGracefully(agent);
  }
  await tmux.killSession(sessionName);
  await worktree.removeAllWorktrees({ force: true, deleteBranches: true });
  // ...
}
```

**Failure Scenarios:**
1. Some agents terminate, then error on remaining
2. tmux session kill fails
3. Worktree removal partially succeeds

**Test Cases:**
1. Simulate tmux kill failure, verify other cleanup continues
2. Simulate worktree removal failure, verify session state correct
3. Force kill during cleanup, verify no orphaned resources

---

#### TC-ORCH-H004: Lost Messages During Transitions
**Severity:** HIGH

**Description:** Messages may be lost during workflow stage transitions.

**Risk Area (Lines 829-916):**
```typescript
async routeMessage(from: AgentRole, message: AgentMessage): Promise<Result<void, OrchestratorError>> {
  // Log to DB
  db.createMessage({...});

  // Complete step
  const completeResult = completeStep(this.session.workflowInstance, ...);

  // Route message - may fail
  const routingResult = engineRouteMessage(this.session.workflowInstance, message);

  // Apply decisions
  for (const decision of decisions) {
    await this.applyRoutingDecision(from, decision);
  }

  // Transition workflow - state changes
  const transitionResult = transitionWorkflow(...);
}
```

**Race Conditions:**
1. Message arrives during step completion
2. Routing decision targets agent that just crashed
3. Transition happens while routing in progress

**Test Cases:**
1. Send messages rapidly during transitions
2. Route to agent that fails mid-delivery
3. Concurrent messages from multiple sources

---

#### TC-ORCH-H005: Checkpoint Corruption
**Severity:** MEDIUM

**Description:** Checkpoint state may be inconsistent with actual state.

**Checkpoint Creation (Lines 1551-1629):**
```typescript
private async createStageCheckpoint(stageName: string): Promise<void> {
  // Build serialized agent states
  const agentStates = new Map<string, SerializedAgentState>();
  for (const [role, agent] of this.session.agents) {
    agentStates.set(role, {...});
  }
  // ... build other state
  await checkpointOnStage(this.session.id, stageName, {...});
}
```

**Corruption Scenarios:**
1. Agent state changes during checkpoint serialization
2. Message queue changes during snapshot
3. Concurrent writes to database

**Test Cases:**
1. Modify state during checkpoint, verify consistency
2. Crash during checkpoint write, verify recovery
3. Load checkpoint with missing/extra fields

---

#### TC-ORCH-H006: Recovery Loops
**Severity:** HIGH

**Description:** Repeated recovery attempts may create infinite loops.

**Recovery Logic (Lines 1017-1044):**
```typescript
const recoveryOutcome = await executeRecovery(swarmError, recoveryPlan, recoveryContext);
this.recoveryAttempts.push({
  errorId: swarmError.id,
  strategy: recoveryOutcome.strategyUsed,
  outcome: recoveryOutcome.success ? 'success' : 'failed',
  timestamp: now(),
});
```

**Protection Mechanisms (from error-handling.ts):**
```typescript
// shouldContinueRecovery checks:
if (attemptsSoFar >= maxAttempts) return false;
if (error.severity === 'fatal') return false;
if (!error.recoverable) return false;
```

**Test Cases:**
1. Trigger recoverable error repeatedly, verify max attempts honored
2. Recovery succeeds but same error recurs immediately
3. Recovery causes different error that triggers its own recovery

---

## src/workflows/templates.ts - Workflow Definitions

**Location:** `/home/carso/code/claude-swarm/src/workflows/templates.ts`

### Base Cases (Happy Path)

#### TC-TMPL-001: Create Workflow Instance from Template
**Description:** Successfully instantiate a workflow from template.

```typescript
const result = createWorkflowInstance('research', 'session-123', 'Analyze code');
expect(result.ok).toBe(true);
expect(result.value.templateName).toBe('research');
expect(result.value.currentStep).toBe('initial_research');
```

---

#### TC-TMPL-002: Step Transitions with Verdicts
**Description:** Verify verdict-based transitions work correctly.

**For Research Workflow:**
1. `initial_research` -> `verification` (on complete)
2. `verification` -> `synthesis` (on APPROVED)
3. `verification` -> `deep_dive` (on NEEDS_REVISION)
4. `verification` -> `synthesis` (on REJECTED - fallback)

---

#### TC-TMPL-003: List Available Templates
**Description:** Enumerate all registered templates.

```typescript
const templates = listWorkflowTemplates();
expect(templates.length).toBeGreaterThanOrEqual(4); // research, implement, review, full
```

---

### Edge Cases

#### TC-TMPL-E001: Invalid Template Name
**Severity:** LOW

```typescript
const result = getWorkflowTemplate('nonexistent');
expect(result.ok).toBe(false);
expect(result.error.code).toBe('TEMPLATE_NOT_FOUND');
```

---

#### TC-TMPL-E002: Step Not Found in Template
**Severity:** MEDIUM

```typescript
const result = getStepById('research', 'nonexistent_step');
expect(result.ok).toBe(false);
expect(result.error.code).toBe('STEP_NOT_FOUND');
```

---

#### TC-TMPL-E003: No Transitions Defined from Step
**Severity:** HIGH

**Current Implementation (Lines 877-890):**
```typescript
const transitions = template.transitions.filter(t => t.from === currentStep);
if (transitions.length === 0) {
  return err(createWorkflowError('INVALID_TRANSITION',
    `No transitions defined from step '${currentStep}'`));
}
```

**Test Case:** Malformed template with step missing transitions.

---

#### TC-TMPL-E004: Max Iterations Exceeded on Revision Step
**Severity:** MEDIUM

**Implementation (Lines 899-914):**
```typescript
const iterCount = instance.iterationCounts.get(verdictTransition.to) || 0;
if (iterCount >= targetStep.maxIterations) {
  // Find alternative transition
  const completeTransition = transitions.find(t =>
    t.condition.type === 'complete' ||
    (t.condition.type === 'verdict' && t.condition.verdict === 'REJECTED')
  );
}
```

**Test Cases:**
1. Hit max iterations on `deep_dive` step
2. Hit max iterations on `code_revision` step
3. Verify fallback transition is taken

---

### Workflow-Specific Failure Modes

#### Research Workflow (`research`)

| Step | Failure Mode | Expected Behavior |
|------|--------------|-------------------|
| `initial_research` | Agent timeout | Retry, then fail workflow |
| `verification` | Invalid verdict | Default to `complete` transition |
| `deep_dive` | Max iterations (2) | Skip to `synthesis` |
| `synthesis` | Timeout | Partial result synthesis |

---

#### Implementation Workflow (`implement`)

| Step | Failure Mode | Expected Behavior |
|------|--------------|-------------------|
| `architecture` | Design invalid | Review should catch, return NEEDS_REVISION |
| `design_review` | Missing verdict | Default transition |
| `design_revision` | Max iterations (2) | Force proceed to implementation |
| `implementation` | Long-running (30min timeout) | May hit workflow timeout |
| `code_review` | Crash | Retry or fail |
| `code_revision` | Max iterations (3) | Proceed to documentation |
| `documentation` | Missing artifacts | Empty artifact list |

---

#### Review Workflow (`review`)

| Step | Failure Mode | Expected Behavior |
|------|--------------|-------------------|
| `code_analysis` | Invalid input | Agent should handle gracefully |
| `summary` | Synthesis failure | Return partial summary |

---

#### Full Workflow (`full`)

**Complexity:** 9 steps, 4 agents, multiple review cycles

**High-Risk Transitions:**
1. `design_review` -> `design_revision` -> `design_review` loop
2. `code_review` -> `code_revision` -> `code_review` loop
3. Long dependency chain from `research` to `final_synthesis`

---

## src/workflows/engine.ts - State Machine Execution

**Location:** `/home/carso/code/claude-swarm/src/workflows/engine.ts`

### Base Cases (Happy Path)

#### TC-ENG-001: Start Step Execution
**Description:** Successfully start a workflow step.

```typescript
const result = startStep(instance, 'initial_research');
expect(result.ok).toBe(true);
expect(result.value.currentStep).toBe('initial_research');
expect(result.value.stepHistory.length).toBe(1);
```

---

#### TC-ENG-002: Complete Step with Output
**Description:** Mark step as complete with output data.

```typescript
const result = completeStep(instance, 'initial_research', {
  type: 'finding',
  summary: 'Found 3 key issues',
  verdict: undefined
});
expect(result.ok).toBe(true);
expect(result.value.stepHistory[0].status).toBe('complete');
```

---

#### TC-ENG-003: Route Message to Next Agent
**Description:** Determine correct routing for message.

```typescript
const decisions = routeMessage(instance, message);
expect(decisions.ok).toBe(true);
expect(decisions.value[0].to).toBe('reviewer');
```

---

#### TC-ENG-004: Synthesize Final Result
**Description:** Generate result summary from completed workflow.

```typescript
const result = synthesizeResult(completedInstance);
expect(result.ok).toBe(true);
expect(result.value.success).toBe(true);
expect(result.value.stepsExecuted).toBeGreaterThan(0);
```

---

### Edge Cases

#### TC-ENG-E001: Start Step When Already Running
**Severity:** LOW

**Current Behavior:** Creates new execution record, previous remains 'running'.

**Test Case:**
1. Start step A
2. Start step A again without completing
3. Verify two records exist (potential state corruption)

---

#### TC-ENG-E002: Complete Non-Running Step
**Severity:** MEDIUM

**Implementation (Lines 189-202):**
```typescript
const runningIndex = instance.stepHistory.findIndex(
  r => r.stepId === stepId && r.status === 'running'
);
if (runningIndex === -1) {
  return err(createEngineError('STEP_NOT_FOUND',
    `No running step '${stepId}' found in history`));
}
```

**Test Cases:**
1. Complete step that was never started
2. Complete step that already completed
3. Complete step that was skipped

---

#### TC-ENG-E003: Skip Non-Optional Step
**Severity:** MEDIUM

**Implementation (Lines 284-317):**
```typescript
if (!step.optional) {
  return err(createEngineError('INVALID_TRANSITION',
    `Cannot skip non-optional step '${stepId}'`));
}
```

**Test Case:** Attempt to skip required step.

---

#### TC-ENG-E004: Synthesize Incomplete Workflow
**Severity:** LOW

```typescript
if (!isWorkflowComplete(instance)) {
  return err(createEngineError('INVALID_TRANSITION',
    'Cannot synthesize result for incomplete workflow'));
}
```

---

### Potentially Suboptimal Behaviors

#### TC-ENG-H001: Infinite State Machine Loop
**Severity:** CRITICAL

**Risk Pattern:**
```typescript
// Transition creates cycle: A -> B -> A
transitions: [
  { from: 'A', to: 'B', condition: { type: 'complete' } },
  { from: 'B', to: 'A', condition: { type: 'complete' } },
]
```

**Protection Mechanism:** `maxIterations` on each step.

**Test Cases:**
1. Create workflow with cycle
2. Verify iteration limit prevents infinite loop
3. Test with very high iteration count

---

#### TC-ENG-H002: Step History Memory Growth
**Severity:** MEDIUM

**Issue:** `stepHistory` array grows unbounded with revision cycles.

```typescript
stepHistory: [...instance.stepHistory, record] // Always appends
```

**Test Case:** Run workflow with many revisions, check memory usage.

---

#### TC-ENG-H003: Iteration Count Map Synchronization
**Severity:** LOW

**Issue:** `iterationCounts` Map may not reflect actual step executions.

```typescript
iterationCounts: new Map(instance.iterationCounts).set(stepId, currentIterations + 1)
```

**Test Case:** Verify counts match `stepHistory` filtered by stepId.

---

## src/agents/role-loader.ts - CLAUDE.md Loading

**Location:** `/home/carso/code/claude-swarm/src/agents/role-loader.ts`

### Base Cases (Happy Path)

#### TC-ROLE-001: Load Valid Role Config
**Description:** Successfully load a role's CLAUDE.md file.

```typescript
const result = loadRoleConfig('researcher');
expect(result.ok).toBe(true);
expect(result.value).toContain('# Researcher');
```

---

#### TC-ROLE-002: Parse Frontmatter Metadata
**Description:** Extract YAML frontmatter from CLAUDE.md.

```typescript
const result = getRoleMetadata('developer');
expect(result.ok).toBe(true);
expect(result.value.name).toBeDefined();
```

---

#### TC-ROLE-003: List Available Roles
**Description:** Enumerate roles with valid configurations.

```typescript
const roles = listRoles();
expect(roles).toContain('researcher');
expect(roles).toContain('developer');
```

---

### Edge Cases

#### TC-ROLE-E001: Empty CLAUDE.md File
**Severity:** LOW

**Test Case:** Role directory exists but CLAUDE.md is empty (0 bytes).

**Expected Behavior:**
- `loadRoleConfig()` returns empty string
- `parseFrontmatter()` returns `{ metadata: {}, body: '' }`

---

#### TC-ROLE-E002: Malformed Frontmatter
**Severity:** LOW

**Test Cases:**
1. Unclosed frontmatter delimiters (`---` missing)
2. Invalid YAML syntax
3. Only opening delimiter

**Current Handling (Lines 136-170):**
```typescript
const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
const match = content.match(frontmatterRegex);
if (!match) {
  return { metadata: {}, body: content };
}
```

---

#### TC-ROLE-E003: Invalid Role Name
**Severity:** LOW

```typescript
const result = loadRoleConfig('invalid_role');
expect(result.ok).toBe(false);
expect(result.error.code).toBe('INVALID_ROLE');
```

---

#### TC-ROLE-E004: Role Directory Exists, File Missing
**Severity:** MEDIUM

```typescript
const result = loadRoleConfig('researcher'); // Directory exists
// But CLAUDE.md file is missing
expect(result.ok).toBe(false);
expect(result.error.code).toBe('CONFIG_NOT_FOUND');
```

---

#### TC-ROLE-E005: File Read Permission Denied
**Severity:** MEDIUM

**Test Case:** CLAUDE.md exists but not readable.

**Expected:**
```typescript
expect(result.error.code).toBe('READ_ERROR');
```

---

### Potentially Suboptimal Behaviors

#### TC-ROLE-H001: Path Traversal Vulnerability
**Severity:** HIGH

**Risk:** Role name containing `../` could read files outside roles directory.

**Current Protection:** Role validated against `VALID_ROLES` array:
```typescript
export const VALID_ROLES: readonly string[] = [
  'orchestrator', 'researcher', 'developer', 'reviewer', 'architect',
] as const;
```

**Test Cases:**
1. `loadRoleConfig('../../../etc/passwd')` - Should fail validation
2. `loadRoleConfig('researcher/../developer')` - Should fail validation

---

#### TC-ROLE-H002: Slow File System Operations
**Severity:** LOW

**Issue:** `listRoles()` does synchronous file system operations.

```typescript
const entries = readdirSync(rolesDir);
// ...
if (statSync(entryPath).isDirectory() && existsSync(configPath)) {
```

**Test Case:** Measure latency with many subdirectories.

---

#### TC-ROLE-H003: Project Root Detection Failure
**Severity:** MEDIUM

**Issue:** `getProjectRoot()` walks up directory tree looking for `roles/`.

```typescript
while (current !== '/') {
  if (existsSync(join(current, ROLES_DIR))) {
    return current;
  }
  current = resolve(current, '..');
}
return process.cwd(); // Fallback
```

**Test Cases:**
1. Run from deeply nested subdirectory
2. Run from outside any git repository
3. Run from root directory

---

## Cross-Cutting Concerns

### Error Handling Integration

#### TC-ERR-001: SwarmError Propagation
**Description:** Verify errors propagate correctly through call stack.

**Test:** Error in role-loader should reach orchestrator with context.

---

#### TC-ERR-002: Recovery Strategy Selection
**Description:** Verify correct strategy selected for error type.

**Error -> Strategy Mappings:**
| Error Code | Expected Strategy |
|------------|------------------|
| AGENT_TIMEOUT | retry (2 attempts), then restart |
| AGENT_CRASHED | restart (2 attempts), then skip |
| RATE_LIMITED | retry (5 attempts with backoff) |
| MAX_ITERATIONS | skip |
| WORKFLOW_TIMEOUT | abort |

---

### Database Consistency

#### TC-DB-001: Session State Persistence
**Description:** Session state survives process restart via checkpoints.

**Test:**
1. Create checkpoint during workflow
2. Simulate crash
3. Load checkpoint
4. Verify workflow can resume

---

#### TC-DB-002: Message Ordering
**Description:** Messages retrieved in correct order.

```typescript
const messages = getSessionMessages(sessionId);
// Should be ordered by created_at ASC
```

---

### Message Bus Integration

#### TC-MSG-001: Atomic File Operations
**Description:** Message writes are atomic (temp file + rename).

**Test:** Kill process during write, verify no corruption.

---

#### TC-MSG-002: Broadcast Message Delivery
**Description:** Broadcast reaches all agents except sender.

```typescript
broadcastMessage('orchestrator', 'status', {...});
// Should be in inbox of: researcher, developer, reviewer, architect
// Should NOT be in inbox of: orchestrator
```

---

## Severity Classification

### Critical (Workflow Failure, Data Loss)
- TC-ORCH-H006: Recovery loops
- TC-ENG-H001: Infinite state machine loop

### High (Functionality Impaired)
- TC-ORCH-E001: Agent fails to spawn
- TC-ORCH-E002: Agent crashes mid-workflow
- TC-ORCH-H001: Memory leak from uncleared intervals
- TC-ORCH-H003: Partial cleanup on error
- TC-ORCH-H004: Lost messages during transitions
- TC-ROLE-H001: Path traversal vulnerability

### Medium (Degraded Experience)
- TC-ORCH-E003: Workflow timeout
- TC-ORCH-E004: Multiple agents finishing simultaneously
- TC-ORCH-H002: Event handler accumulation
- TC-ORCH-H005: Checkpoint corruption
- TC-TMPL-E003: No transitions from step
- TC-TMPL-E004: Max iterations exceeded
- TC-ENG-E002: Complete non-running step
- TC-ENG-H002: Step history memory growth
- TC-ROLE-E004: Role directory exists, file missing
- TC-ROLE-E005: File read permission denied
- TC-ROLE-H003: Project root detection failure

### Low (Minor Issues)
- TC-ORCH-E005: Invalid workflow type
- TC-ORCH-E006: Empty/invalid goal
- TC-TMPL-E001: Invalid template name
- TC-TMPL-E002: Step not found
- TC-ENG-E001: Start step when running
- TC-ENG-E003: Skip non-optional step
- TC-ENG-E004: Synthesize incomplete workflow
- TC-ENG-H003: Iteration count synchronization
- TC-ROLE-E001: Empty CLAUDE.md file
- TC-ROLE-E002: Malformed frontmatter
- TC-ROLE-E003: Invalid role name
- TC-ROLE-H002: Slow file system operations

---

## Appendix: Test Infrastructure Requirements

### Mocking Requirements

1. **tmux Manager**: Mock pane creation, capture, kill operations
2. **Worktree Manager**: Mock git operations, file system
3. **Message Bus**: Mock file-based queues or use in-memory
4. **Database**: Use in-memory SQLite or mock

### Fixture Requirements

1. Sample CLAUDE.md files with various frontmatter configurations
2. Pre-defined workflow instances at various completion states
3. Sample message sequences for each workflow type

### Performance Test Parameters

| Operation | Target Latency | Measurement Point |
|-----------|---------------|-------------------|
| Agent spawn | < 5s | `spawnAgent()` completion |
| Message routing | < 100ms | `routeMessage()` completion |
| Checkpoint save | < 500ms | `createStageCheckpoint()` completion |
| Full cleanup | < 10s | `cleanup()` completion |
