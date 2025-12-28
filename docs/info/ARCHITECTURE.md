# Claude Swarm: Local Multi-Agent Collaboration Environment

## Specification Document v1.1

**Purpose:** Enable 3+ Claude Code instances to communicate, delegate tasks, and work as a coordinated team with distinct roles/personalities.

**Target Use Cases:**
1. Deep research with verification loops
2. Code development, testing, and documentation
3. System architecture and plan evaluation

**Philosophy:** Good enough to work predictably. Personal tooling. Minimal dependencies.

---

## 1. Technology Stack

### Architecture Decision: Build a Lightweight Orchestrator

After evaluating existing tools, we're building a **custom orchestrator** using proven primitives:

**Why not use existing frameworks:**
- `claude-flow@alpha`: Exists on npm (v2.7.47) but has **native compilation dependencies** (hnswlib-node) that fail in many environments
- `langroid`: Python-based, adds environment complexity for a Claude Code-focused workflow
- `MetaGPT`/`CrewAI`: Overkill for personal use, heavy dependencies

**What we're building instead:**
A thin orchestration layer using battle-tested Unix tools that Claude Code instances can reliably use:

```
Custom Orchestrator (Bun/TypeScript)
├── tmux: Session management, parallel terminals
├── git worktrees: Isolated codebases per agent
├── SQLite (bun:sqlite): Shared memory/state (native to Bun)
├── File-based message passing: JSON in .swarm/messages/
└── Claude Code CLI: The actual agents
```

### Core Components

| Component | Technology | Purpose |
|-----------|------------|---------|
| Runtime | Bun | Fast TypeScript execution, native SQLite |
| Session Manager | tmux | Spawn/manage parallel Claude Code instances |
| Code Isolation | git worktrees | Each agent works on isolated branch |
| Shared Memory | bun:sqlite | Persistent state, findings, decisions |
| Message Bus | File-based JSON | Inter-agent communication |
| Orchestrator | TypeScript | Task routing, lifecycle management |

### Prerequisites
```bash
# Required (install once)
npm install -g @anthropic-ai/claude-code  # Claude Code CLI
curl -fsSL https://bun.sh/install | bash  # Bun runtime
sudo apt install tmux                      # Terminal multiplexer (or brew install tmux on Mac)
git --version                              # Git 2.20+ (for worktrees)
```

### Why This Stack
- **Bun**: Native TypeScript, built-in SQLite (no native compilation), fast startup
- **tmux**: Proven, zero-dependency session management; can run 10+ Claude instances
- **git worktrees**: Native git feature, no external tools; perfect isolation
- **bun:sqlite**: Zero-config, no native compilation issues, survives restarts
- **File-based messaging**: Debuggable, works everywhere, no IPC complexity

### Inspiration Sources
This approach is validated by several community projects:
- [claude-squad](https://github.com/smtg-ai/claude-squad): tmux + git worktrees for parallel agents
- [claude_code_agent_farm](https://github.com/Dicklesworthstone/claude_code_agent_farm): 20+ parallel agents with tmux
- [tmux-claude-mcp-server](https://github.com/michael-abdo/tmux-claude-mcp-server): Hierarchical Claude instances

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         USER INTERFACE                               │
│                    (CLI: ./swarm start <workflow>)                   │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      ORCHESTRATOR (Bun/TypeScript)                   │
│  src/orchestrator.ts                                                 │
│  Responsibilities:                                                   │
│    - Parse user goals into subtasks                                  │
│    - Spawn tmux sessions with Claude Code instances                  │
│    - Route messages between agents via file queue                    │
│    - Monitor agent health via tmux pane capture                      │
│    - Collect results and synthesize final output                     │
└─────────────────────────────────────────────────────────────────────┘
           │              │              │              │
           ▼              ▼              ▼              ▼
┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌───────────────┐
│  RESEARCHER   │ │   DEVELOPER   │ │   REVIEWER    │ │  ARCHITECT    │
│  (tmux pane)  │ │  (tmux pane)  │ │  (tmux pane)  │ │  (tmux pane)  │
│               │ │               │ │               │ │               │
│ git worktree: │ │ git worktree: │ │ git worktree: │ │ git worktree: │
│ .worktrees/   │ │ .worktrees/   │ │ .worktrees/   │ │ .worktrees/   │
│   researcher  │ │   developer   │ │   reviewer    │ │   architect   │
│               │ │               │ │               │ │               │
│ Claude Code   │ │ Claude Code   │ │ Claude Code   │ │ Claude Code   │
│ --resume flag │ │ --resume flag │ │ --resume flag │ │ --resume flag │
│ CLAUDE.md has │ │ CLAUDE.md has │ │ CLAUDE.md has │ │ CLAUDE.md has │
│ role persona  │ │ role persona  │ │ role persona  │ │ role persona  │
└───────────────┘ └───────────────┘ └───────────────┘ └───────────────┘
           │              │              │              │
           └──────────────┴──────────────┴──────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     SHARED RESOURCES                                 │
├─────────────────────────────────────────────────────────────────────┤
│  .swarm/memory.db (SQLite)     │  .swarm/messages/ (JSON files)     │
│  - Research findings           │  - inbox/{agent}.json              │
│  - Code artifacts              │  - outbox/{agent}.json             │
│  - Decision log                │  - Polling-based message passing   │
│  - Task status                 │                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### How It Works

1. **User starts a workflow**: `./swarm start research "topic"`
2. **Orchestrator creates tmux session**: `swarm_{timestamp}`
3. **For each agent role needed**:
   - Creates git worktree: `git worktree add .worktrees/{role} -b swarm/{role}`
   - Copies role-specific CLAUDE.md to worktree
   - Spawns tmux pane: `tmux split-window -t swarm`
   - Starts Claude Code: `claude --resume` with initial prompt
4. **Agents communicate via file-based message queue**:
   - Agent writes to `.swarm/messages/outbox/{self}.json`
   - Orchestrator routes to `.swarm/messages/inbox/{target}.json`
   - Agents poll their inbox (via CLAUDE.md instructions)
5. **Orchestrator monitors progress**:
   - Captures tmux pane content periodically
   - Detects completion signals or errors
   - Synthesizes final output when all agents done

---

## 3. Agent Definitions

Each agent is a Claude Code instance with a role-specific `CLAUDE.md` file that defines its persona. The CLAUDE.md is copied into the agent's worktree before spawning.

### 3.1 Researcher Agent
**File: `roles/researcher/CLAUDE.md`**
```markdown
# Agent Role: Researcher

You are a thorough researcher working as part of a multi-agent team.

## Your Responsibilities
1. Find accurate, current information on assigned topics
2. Always cite sources with URLs
3. Cross-reference claims across multiple sources
4. Flag uncertainty levels (high/medium/low confidence)
5. Distinguish facts from opinions/speculation

## Communication Style
Academic, citation-heavy, hedges appropriately.
Always provide source URLs. Never make claims without backing.

## Output Format
For each finding, write to `.swarm/messages/outbox/researcher.json`:
```json
{
  "type": "finding",
  "claim": "the specific claim",
  "confidence": "high|medium|low",
  "sources": ["url1", "url2"],
  "contradicting_evidence": "if any",
  "timestamp": "ISO8601"
}
```

## Checking for Tasks
Periodically read `.swarm/messages/inbox/researcher.json` for new assignments.
When you see a task, acknowledge it, complete it, then write results to outbox.

## Completion Signal
When done with all assigned tasks, write:
```json
{"type": "status", "status": "complete", "summary": "brief summary"}
```
```

### 3.2 Developer Agent
**File: `roles/developer/CLAUDE.md`**
```markdown
# Agent Role: Developer

You are a pragmatic developer working as part of a multi-agent team.

## Your Responsibilities
1. Write clean, working code that solves the specified problem
2. Include inline comments for non-obvious logic
3. Write basic tests alongside implementation
4. Document public APIs and usage examples
5. Prefer simplicity over cleverness

## Communication Style
Practical, code-first, explains tradeoffs.
Always provide runnable code. Flag assumptions made.

## Output Format
For completed work, write to `.swarm/messages/outbox/developer.json`:
```json
{
  "type": "artifact",
  "artifact_type": "code|test|documentation",
  "filepath": "relative/path/to/file",
  "summary": "what this does",
  "assumptions": ["list of assumptions"],
  "known_limitations": ["list"],
  "timestamp": "ISO8601"
}
```

## Checking for Tasks
Periodically read `.swarm/messages/inbox/developer.json` for new assignments.
Tasks may include specs from the architect or feedback from the reviewer.

## Completion Signal
When done: `{"type": "status", "status": "complete", "files_created": [...]}`
```

### 3.3 Reviewer Agent
**File: `roles/reviewer/CLAUDE.md`**
```markdown
# Agent Role: Reviewer

You are a skeptical reviewer and quality gate for the team.

## Your Responsibilities
1. Verify claims made by the researcher (spot-check sources)
2. Review code for bugs, security issues, edge cases
3. Check that outputs actually answer the original question
4. Push back on low-quality or incomplete work
5. Approve or reject deliverables with clear reasoning

## Communication Style
Critical but constructive, specific feedback.
Never rubber-stamp. Always find at least one thing to improve.

## Output Format
For reviews, write to `.swarm/messages/outbox/reviewer.json`:
```json
{
  "type": "review",
  "target": "what you reviewed",
  "verdict": "APPROVED|NEEDS_REVISION|REJECTED",
  "issues_found": ["numbered list"],
  "verification_checks": ["what you verified"],
  "suggestions": ["improvements"],
  "timestamp": "ISO8601"
}
```

## Checking for Tasks
Read `.swarm/messages/inbox/reviewer.json` for items to review.
You receive outputs from researcher and developer for verification.

## Completion Signal
When all reviews done: `{"type": "status", "status": "complete", "approved": N, "rejected": M}`
```

### 3.4 Architect Agent
**File: `roles/architect/CLAUDE.md`**
```markdown
# Agent Role: Architect

You are a systems thinker and planner for the team.

## Your Responsibilities
1. Design system architectures and technical approaches
2. Evaluate tradeoffs between different solutions
3. Create implementation plans with clear phases
4. Identify risks and dependencies
5. Think about scalability, maintainability, and edge cases

## Communication Style
Strategic, thinks in systems, considers future implications.
Always present multiple options with pros/cons.

## Output Format
For designs, write to `.swarm/messages/outbox/architect.json`:
```json
{
  "type": "design",
  "recommended_approach": "summary",
  "alternatives": [{"name": "...", "pros": [...], "cons": [...]}],
  "implementation_phases": ["phase 1", "phase 2"],
  "risks": [{"risk": "...", "mitigation": "..."}],
  "open_questions": ["questions needing clarification"],
  "timestamp": "ISO8601"
}
```

## Checking for Tasks
Read `.swarm/messages/inbox/architect.json` for design requests.

## Completion Signal
When done: `{"type": "status", "status": "complete", "designs_produced": N}`
```

---

## 4. Communication Protocol

### 4.1 Message Format
All inter-agent communication uses structured JSON:

```json
{
  "id": "msg_uuid",
  "timestamp": "ISO8601",
  "from": "agent_name",
  "to": "agent_name | broadcast",
  "type": "task | result | question | feedback | status",
  "priority": "critical | high | normal | low",
  "content": {
    "subject": "brief description",
    "body": "detailed content",
    "artifacts": ["file paths or inline content"],
    "metadata": {}
  },
  "thread_id": "for tracking related messages",
  "requires_response": true | false,
  "deadline": "ISO8601 or null"
}
```

### 4.2 Task Lifecycle

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│ CREATED  │────▶│ ASSIGNED │────▶│ IN_PROG  │────▶│ REVIEW   │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
                                                        │
                      ┌─────────────────────────────────┤
                      ▼                                 ▼
                ┌──────────┐                     ┌──────────┐
                │ REVISION │                     │ COMPLETE │
                └──────────┘                     └──────────┘
                      │                                 │
                      └─────────▶ IN_PROG ◀────────────┘
                                (if rejected)    (final output)
```

### 4.3 Delegation Rules

1. **Coordinator is the only agent that can create tasks** for other agents
2. **Agents can request help** from coordinator, who decides routing
3. **Reviewer must approve** all deliverables before marking complete
4. **Any agent can flag blockers** that pause the pipeline
5. **Memory writes are append-only** - no agent can delete another's findings

---

## 5. Workflow Templates

### 5.1 Research Workflow
```yaml
name: deep_research
description: Multi-source research with verification
stages:
  - name: initial_research
    agent: researcher
    output: raw_findings
    
  - name: verification
    agent: reviewer
    input: raw_findings
    output: verified_findings
    
  - name: gap_analysis
    agent: coordinator
    input: verified_findings
    output: followup_questions
    
  - name: deep_dive
    agent: researcher
    input: followup_questions
    output: additional_findings
    condition: "if followup_questions.length > 0"
    
  - name: synthesis
    agent: coordinator
    input: [verified_findings, additional_findings]
    output: final_report
```

### 5.2 Development Workflow
```yaml
name: code_development
description: Implementation with review cycle
stages:
  - name: architecture
    agent: architect
    output: technical_design
    
  - name: design_review
    agent: reviewer
    input: technical_design
    output: approved_design
    
  - name: implementation
    agent: developer
    input: approved_design
    output: code_artifacts
    
  - name: code_review
    agent: reviewer
    input: code_artifacts
    output: review_feedback
    
  - name: revision
    agent: developer
    input: review_feedback
    output: revised_code
    condition: "if review_feedback.verdict != APPROVED"
    max_iterations: 3
    
  - name: documentation
    agent: developer
    input: revised_code
    output: final_deliverable
```

### 5.3 Autonomous Development Workflow
```yaml
name: autonomous_development
description: Architect-led implementation with iterative review cycles
stages:
  - name: task_decomposition
    agent: architect
    input: implementation_spec
    output: task_queue
    description: Break spec into discrete implementation tasks

  - name: implementation
    agent: developer
    input: current_task
    output: code_artifacts

  - name: code_review
    agent: reviewer
    input: code_artifacts
    output: review_feedback

  - name: revision_decision
    agent: architect
    input: review_feedback
    output: next_action
    description: Decide to revise, continue, or mark task complete

  - name: revision
    agent: developer
    input: [review_feedback, revision_instructions]
    output: revised_code
    condition: "if next_action == 'revise'"

  - name: task_completion
    agent: architect
    input: [approved_code, task_queue]
    output: updated_queue
    condition: "if next_action == 'complete'"
    description: Mark task done, assign next task or signal workflow complete

  - name: integration_check
    agent: reviewer
    input: all_completed_artifacts
    output: integration_review
    condition: "if task_queue.remaining == 0"
    description: Final verification that all pieces work together

delegation_rules:
  - architect_is_coordinator: true
  - architect_can_reassign: true
  - architect_can_reprioritize: true
  - max_revision_cycles: 3
  - auto_escalate_on_stuck: true
```

### 5.4 Architecture Planning Workflow
```yaml
name: system_planning
description: Evaluate approaches and create plan
stages:
  - name: requirements
    agent: coordinator
    output: requirements_doc
    
  - name: research_prior_art
    agent: researcher
    input: requirements_doc
    output: existing_solutions
    
  - name: design_options
    agent: architect
    input: [requirements_doc, existing_solutions]
    output: design_alternatives
    
  - name: evaluation
    agent: reviewer
    input: design_alternatives
    output: evaluated_designs
    
  - name: decision
    agent: coordinator
    input: evaluated_designs
    output: selected_approach
    
  - name: implementation_plan
    agent: architect
    input: selected_approach
    output: phased_plan
```

---

## 6. Memory Schema

### 6.1 SQLite Tables

```sql
-- Research findings
CREATE TABLE findings (
  id TEXT PRIMARY KEY,
  thread_id TEXT,
  agent TEXT,
  claim TEXT,
  confidence TEXT CHECK(confidence IN ('high', 'medium', 'low')),
  sources TEXT, -- JSON array of URLs
  verified_by TEXT,
  verified_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Code artifacts
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  thread_id TEXT,
  agent TEXT,
  artifact_type TEXT, -- 'code', 'document', 'diagram', etc.
  filepath TEXT,
  content TEXT,
  version INTEGER DEFAULT 1,
  review_status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Decision log
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  thread_id TEXT,
  agent TEXT,
  decision TEXT,
  rationale TEXT,
  alternatives_considered TEXT, -- JSON
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Task tracking
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  thread_id TEXT,
  parent_task_id TEXT,
  assigned_to TEXT,
  status TEXT DEFAULT 'created',
  priority TEXT DEFAULT 'normal',
  description TEXT,
  input_data TEXT, -- JSON
  output_data TEXT, -- JSON
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Agent messages (full history)
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT,
  from_agent TEXT,
  to_agent TEXT,
  message_type TEXT,
  content TEXT, -- JSON
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

### 6.2 Memory Access Patterns

```javascript
// Agents read/write via claude-flow memory commands
// Namespaced by thread_id for isolation between sessions

// Store a finding
npx claude-flow@alpha memory store \
  "finding:${id}" \
  '{"claim":"...", "sources":[...]}' \
  --namespace "thread_${threadId}" \
  --reasoningbank

// Query findings
npx claude-flow@alpha memory query "finding" \
  --namespace "thread_${threadId}" \
  --reasoningbank

// Semantic search across all findings
npx claude-flow@alpha memory vector-search \
  "authentication security best practices" \
  --k 10 \
  --threshold 0.7
```

---

## 7. Implementation Plan

### Phase 1: Project Scaffolding (Day 1)
```bash
# 1. Create project directory
mkdir claude-swarm && cd claude-swarm
bun init -y

# 2. No external dependencies needed!
# Bun has native SQLite, native TypeScript, native file I/O

# 3. Create directory structure
mkdir -p src roles/{researcher,developer,reviewer,architect} .swarm/{messages/inbox,messages/outbox}

# 4. Verify prerequisites
claude --version          # Should show Claude Code version
tmux -V                   # Should show tmux version
git --version             # Should show git 2.20+
bun --version             # Should show bun version
```

**Deliverables:**
- [ ] Project initialized with package.json
- [ ] Directory structure created
- [ ] Prerequisites verified (no deps to install!)

### Phase 2: Core Orchestrator (Day 1-2)
Create the main orchestrator that manages tmux sessions and agents.

**Files to create:**
- [ ] `src/orchestrator.ts` - Main coordination logic
- [ ] `src/tmux-manager.ts` - tmux session/pane management
- [ ] `src/worktree-manager.ts` - git worktree lifecycle
- [ ] `src/message-bus.ts` - File-based message routing
- [ ] `src/db.ts` - SQLite memory layer (using bun:sqlite)

**Key functions:**
```typescript
// src/tmux-manager.ts
createSession(sessionName: string): void
createPane(sessionName: string, name: string): string
sendKeys(session: string, pane: string, text: string): void
capturePane(session: string, pane: string): string
killSession(sessionName: string): void

// src/worktree-manager.ts
createWorktree(role: string): string
removeWorktree(role: string): void
copyRoleConfig(role: string, worktreePath: string): void

// src/orchestrator.ts
startWorkflow(type: string, goal: string): Promise<void>
spawnAgent(role: string, task: string): Promise<void>
monitorAgents(): void
synthesizeResults(): Promise<void>
```

### Phase 3: Agent Role Configs (Day 2)
Create CLAUDE.md files for each role.

**Files to create:**
- [ ] `roles/researcher/CLAUDE.md`
- [ ] `roles/developer/CLAUDE.md`
- [ ] `roles/reviewer/CLAUDE.md`
- [ ] `roles/architect/CLAUDE.md`

### Phase 4: Workflow Templates (Day 2-3)
Define multi-agent workflows.

**Files to create:**
- [ ] `src/workflows/research.ts` - Research with verification
- [ ] `src/workflows/development.ts` - Code with review cycle
- [ ] `src/workflows/architecture.ts` - Design evaluation

### Phase 5: CLI Interface (Day 3)
```bash
./swarm start research "query"
./swarm start develop "feature spec"
./swarm start architect "system requirements"
./swarm status
./swarm logs [agent]
./swarm stop
```

**Files to create:**
- [ ] `swarm.ts` - CLI entry point (Bun native, no commander.js needed)

### Phase 6: Testing & Iteration (Day 4-5)
- [ ] Test single agent spawn/kill cycle
- [ ] Test two agents communicating
- [ ] Test full research workflow
- [ ] Test full development workflow
- [ ] Tune agent prompts based on behavior
- [ ] Document quirks and workarounds

---

## 8. File Structure

```
claude-swarm/
├── package.json
├── tsconfig.json                   # TypeScript config (minimal, Bun handles most)
├── swarm.ts                        # CLI entry point (run with: bun swarm.ts)
├── .env                            # ANTHROPIC_API_KEY (optional, claude uses system env)
├── .gitignore
│
├── src/
│   ├── orchestrator.ts             # Main coordination logic
│   ├── tmux-manager.ts             # tmux session/pane management
│   ├── worktree-manager.ts         # git worktree lifecycle
│   ├── message-bus.ts              # File-based message routing
│   ├── db.ts                       # SQLite wrapper (bun:sqlite)
│   ├── types.ts                    # Shared TypeScript types
│   └── workflows/
│       ├── research.ts             # Research workflow
│       ├── development.ts          # Development workflow
│       └── architecture.ts         # Architecture workflow
│
├── roles/                          # Agent persona definitions
│   ├── researcher/
│   │   └── CLAUDE.md               # Researcher persona + instructions
│   ├── developer/
│   │   └── CLAUDE.md
│   ├── reviewer/
│   │   └── CLAUDE.md
│   └── architect/
│       └── CLAUDE.md
│
├── .swarm/                         # Runtime state (gitignored)
│   ├── memory.db                   # SQLite database
│   ├── messages/
│   │   ├── inbox/                  # Per-agent incoming messages
│   │   │   ├── researcher.json
│   │   │   ├── developer.json
│   │   │   ├── reviewer.json
│   │   │   └── architect.json
│   │   └── outbox/                 # Per-agent outgoing messages
│   │       ├── researcher.json
│   │       ├── developer.json
│   │       ├── reviewer.json
│   │       └── architect.json
│   └── sessions/                   # Session metadata
│       └── {session_id}.json
│
├── .worktrees/                     # git worktrees for each agent (gitignored)
│   ├── researcher/                 # Isolated working directory
│   ├── developer/
│   ├── reviewer/
│   └── architect/
│
├── outputs/                        # Final deliverables
│   └── {session_id}/
│       ├── summary.md
│       └── artifacts/
│
└── logs/                           # Session logs
    └── {session_id}.log
```

### .gitignore
```
.swarm/
.worktrees/
node_modules/
logs/
outputs/
.env
```

### package.json
```json
{
  "name": "claude-swarm",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "bun swarm.ts",
    "dev": "bun --watch swarm.ts"
  }
}
```

### tsconfig.json
```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

---

## 9. CLI Usage

### Start a Session
```bash
# Research task
bun swarm.ts start research "What are the latest developments in homomorphic encryption for ML inference?"

# Development task (single feature, architect designs then hands off)
bun swarm.ts start develop "Create a rate limiter middleware for Express with sliding window algorithm"

# Autonomous development (architect-led, iterates through full spec)
bun swarm.ts start autonomous "path/to/implementation-spec.md"
# Or with inline spec:
bun swarm.ts start autonomous --spec "Implement the user authentication module per the design doc"

# Architecture task
bun swarm.ts start architect "Design a distributed task queue system for 10k jobs/second"
```

### Monitor Progress
```bash
# View tmux session (interactive)
bun swarm.ts attach

# View current status
bun swarm.ts status

# View specific agent's pane content
bun swarm.ts logs researcher
bun swarm.ts logs developer

# View message queues
bun swarm.ts messages
```

### Control
```bash
# Stop all agents gracefully
bun swarm.ts stop

# Kill everything immediately
bun swarm.ts kill

# Clean up worktrees and session
bun swarm.ts clean
```

---

## 10. Configuration

### config.json (optional, in project root)
```json
{
  "maxAgents": 4,
  "defaultTimeout": 300000,
  "messagePollingInterval": 5000,
  "tmux": {
    "sessionPrefix": "swarm"
  },
  "worktrees": {
    "basePath": ".worktrees"
  },
  "workflows": {
    "research": {
      "agents": ["researcher", "reviewer"],
      "maxIterations": 3
    },
    "development": {
      "agents": ["architect", "developer", "reviewer"],
      "maxRevisions": 3
    },
    "autonomous_development": {
      "agents": ["architect", "developer", "reviewer"],
      "coordinator": "architect",
      "maxRevisionCycles": 3,
      "maxTasksPerRun": 50,
      "requiresSpec": true,
      "autoIterate": true
    },
    "architecture": {
      "agents": ["researcher", "architect", "reviewer"],
      "maxIterations": 2
    }
  }
}
```

---

## 11. Core Implementation Snippets

### src/types.ts
```typescript
export interface AgentMessage {
  type: 'task' | 'finding' | 'artifact' | 'review' | 'design' | 'status';
  from?: string;
  timestamp: string;
  [key: string]: unknown;
}

export interface AgentInfo {
  pane: string;
  worktreePath: string;
  status: 'running' | 'complete' | 'error';
}

export interface WorkflowConfig {
  agents: string[];
  maxIterations?: number;
  maxRevisions?: number;
}
```

### src/tmux-manager.ts
```typescript
import { $ } from 'bun';

export function createSession(name: string): void {
  $.sync`tmux new-session -d -s ${name}`;
}

export function createPane(session: string, paneName: string): string {
  $.sync`tmux split-window -t ${session} -h`;
  const result = $.sync`tmux display-message -p '#{pane_id}'`;
  return result.stdout.toString().trim();
}

export function sendKeys(session: string, pane: string, text: string): void {
  // Bun shell handles escaping automatically
  $.sync`tmux send-keys -t ${session}:${pane} ${text} Enter`;
}

export function capturePane(session: string, pane: string, lines = 100): string {
  const result = $.sync`tmux capture-pane -t ${session}:${pane} -p -S -${lines}`;
  return result.stdout.toString();
}

export function killSession(session: string): void {
  try {
    $.sync`tmux kill-session -t ${session}`;
  } catch {
    // Session might not exist
  }
}

export function listSessions(): string[] {
  try {
    const result = $.sync`tmux ls -F '#{session_name}'`;
    return result.stdout.toString().trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}
```

### src/worktree-manager.ts
```typescript
import { $ } from 'bun';
import { existsSync, copyFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const WORKTREE_BASE = '.worktrees';

export function createWorktree(role: string): string {
  const worktreePath = join(WORKTREE_BASE, role);
  const branchName = `swarm/${role}-${Date.now()}`;
  
  // Create base directory if needed
  if (!existsSync(WORKTREE_BASE)) {
    mkdirSync(WORKTREE_BASE, { recursive: true });
  }
  
  // Create worktree with new branch
  $.sync`git worktree add ${worktreePath} -b ${branchName}`;
  
  return worktreePath;
}

export function copyRoleConfig(role: string, worktreePath: string): void {
  const src = join('roles', role, 'CLAUDE.md');
  const dest = join(worktreePath, 'CLAUDE.md');
  copyFileSync(src, dest);
}

export function removeWorktree(role: string): void {
  const worktreePath = join(WORKTREE_BASE, role);
  $.sync`git worktree remove ${worktreePath} --force`;
}

export function listWorktrees(): string[] {
  const result = $.sync`git worktree list --porcelain`;
  const lines = result.stdout.toString().split('\n');
  return lines
    .filter(line => line.startsWith('worktree '))
    .map(line => line.replace('worktree ', ''));
}
```

### src/message-bus.ts
```typescript
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { AgentMessage } from './types';

const INBOX_DIR = '.swarm/messages/inbox';
const OUTBOX_DIR = '.swarm/messages/outbox';

export function ensureDirs(): void {
  mkdirSync(INBOX_DIR, { recursive: true });
  mkdirSync(OUTBOX_DIR, { recursive: true });
}

export function sendMessage(from: string, to: string, message: Omit<AgentMessage, 'from' | 'timestamp'>): void {
  const inboxPath = join(INBOX_DIR, `${to}.json`);
  const messages = readMessages(to, 'inbox');
  messages.push({ 
    from, 
    ...message, 
    timestamp: new Date().toISOString() 
  });
  writeFileSync(inboxPath, JSON.stringify(messages, null, 2));
}

export function readMessages(agent: string, box: 'inbox' | 'outbox' = 'inbox'): AgentMessage[] {
  const dir = box === 'inbox' ? INBOX_DIR : OUTBOX_DIR;
  const filePath = join(dir, `${agent}.json`);
  if (!existsSync(filePath)) return [];
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return [];
  }
}

export function clearInbox(agent: string): void {
  const inboxPath = join(INBOX_DIR, `${agent}.json`);
  writeFileSync(inboxPath, '[]');
}

export function getNewMessages(agent: string, since?: string): AgentMessage[] {
  const messages = readMessages(agent, 'outbox');
  if (!since) return messages;
  return messages.filter(m => m.timestamp > since);
}
```

### src/db.ts
```typescript
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'fs';

const DB_PATH = '.swarm/memory.db';

let db: Database | null = null;

export function getDb(): Database {
  if (!db) {
    // Ensure directory exists
    if (!existsSync('.swarm')) {
      mkdirSync('.swarm', { recursive: true });
    }
    
    db = new Database(DB_PATH);
    initSchema();
  }
  return db;
}

function initSchema(): void {
  const database = db!;
  
  database.run(`
    CREATE TABLE IF NOT EXISTS findings (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      agent TEXT,
      claim TEXT,
      confidence TEXT CHECK(confidence IN ('high', 'medium', 'low')),
      sources TEXT,
      verified_by TEXT,
      verified_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  database.run(`
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      agent TEXT,
      artifact_type TEXT,
      filepath TEXT,
      content TEXT,
      version INTEGER DEFAULT 1,
      review_status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  database.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      assigned_to TEXT,
      status TEXT DEFAULT 'created',
      priority TEXT DEFAULT 'normal',
      description TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

export function storeFinding(sessionId: string, agent: string, finding: {
  claim: string;
  confidence: 'high' | 'medium' | 'low';
  sources: string[];
}): string {
  const id = crypto.randomUUID();
  const database = getDb();
  database.run(
    `INSERT INTO findings (id, session_id, agent, claim, confidence, sources) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, sessionId, agent, finding.claim, finding.confidence, JSON.stringify(finding.sources)]
  );
  return id;
}

export function getFindings(sessionId: string): Array<Record<string, unknown>> {
  const database = getDb();
  return database.query(`SELECT * FROM findings WHERE session_id = ?`).all(sessionId) as Array<Record<string, unknown>>;
}
```

### src/orchestrator.ts
```typescript
import * as tmux from './tmux-manager';
import * as worktree from './worktree-manager';
import * as messages from './message-bus';
import { getDb } from './db';
import type { AgentInfo, AgentMessage } from './types';

export class Orchestrator {
  sessionId: string;
  agents: Map<string, AgentInfo> = new Map();
  
  constructor(sessionId?: string) {
    this.sessionId = sessionId || `swarm_${Date.now()}`;
  }

  async startWorkflow(type: string, goal: string): Promise<void> {
    // 1. Initialize
    messages.ensureDirs();
    getDb(); // Initialize database
    
    // 2. Create tmux session
    tmux.createSession(this.sessionId);
    
    // 3. Load workflow config
    const workflow = await import(`./workflows/${type}.ts`);
    const roles = workflow.getRoles();
    
    // 4. Spawn each agent
    for (const role of roles) {
      await this.spawnAgent(role);
    }
    
    // 5. Send initial task to first agent
    const initialTask = workflow.createInitialTask(goal);
    messages.sendMessage('orchestrator', roles[0], initialTask);
    
    // 6. Start monitoring loop
    this.monitorLoop(workflow);
  }

  async spawnAgent(role: string): Promise<void> {
    // Create isolated worktree
    const wtPath = worktree.createWorktree(role);
    worktree.copyRoleConfig(role, wtPath);
    
    // Create tmux pane
    const pane = tmux.createPane(this.sessionId, role);
    
    // Start Claude Code in worktree
    tmux.sendKeys(this.sessionId, pane, `cd ${wtPath}`);
    await Bun.sleep(500); // Brief pause for cd
    tmux.sendKeys(this.sessionId, pane, 'claude --resume');
    
    this.agents.set(role, { pane, worktreePath: wtPath, status: 'running' });
    console.log(`Spawned agent: ${role} in pane ${pane}`);
  }

  monitorLoop(workflow: { routeMessage: Function; isComplete: Function }): void {
    const checkInterval = setInterval(async () => {
      // Check each agent's outbox for new messages
      for (const [role, agent] of this.agents) {
        const outMessages = messages.readMessages(role, 'outbox');
        
        for (const msg of outMessages) {
          if (msg.type === 'status' && (msg as any).status === 'complete') {
            agent.status = 'complete';
          }
          // Route messages to appropriate next agent
          workflow.routeMessage(role, msg, this);
        }
      }
      
      // Check if workflow is complete
      if (workflow.isComplete(this.agents)) {
        clearInterval(checkInterval);
        await this.synthesizeResults();
      }
    }, 5000);
  }

  async synthesizeResults(): Promise<void> {
    console.log('Workflow complete. Synthesizing results...');
    // Collect all findings, artifacts from db
    // Generate final summary
  }
  
  cleanup(): void {
    // Kill tmux session
    tmux.killSession(this.sessionId);
    
    // Remove worktrees
    for (const [role] of this.agents) {
      try {
        worktree.removeWorktree(role);
      } catch {
        // May already be removed
      }
    }
  }
}
```

### swarm.ts (CLI entry point)
```typescript
#!/usr/bin/env bun

import { Orchestrator } from './src/orchestrator';
import * as tmux from './src/tmux-manager';
import { $ } from 'bun';

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  switch (command) {
    case 'start': {
      const [, workflowType, ...goalParts] = args;
      const goal = goalParts.join(' ');
      
      if (!workflowType || !goal) {
        console.log('Usage: bun swarm.ts start <workflow> "<goal>"');
        console.log('Workflows: research, develop, architect');
        process.exit(1);
      }
      
      const orchestrator = new Orchestrator();
      console.log(`Starting ${workflowType} workflow: ${goal}`);
      console.log(`Session: ${orchestrator.sessionId}`);
      await orchestrator.startWorkflow(workflowType, goal);
      break;
    }
    
    case 'attach': {
      const sessions = tmux.listSessions();
      const swarmSession = sessions.find(s => s.startsWith('swarm_'));
      if (swarmSession) {
        await $`tmux attach -t ${swarmSession}`;
      } else {
        console.log('No active swarm session found');
      }
      break;
    }
    
    case 'status': {
      const sessions = tmux.listSessions();
      console.log('Active sessions:', sessions.filter(s => s.startsWith('swarm_')));
      break;
    }
    
    case 'logs': {
      const [, agent] = args;
      const sessions = tmux.listSessions();
      const swarmSession = sessions.find(s => s.startsWith('swarm_'));
      if (swarmSession && agent) {
        const output = tmux.capturePane(swarmSession, agent, 200);
        console.log(output);
      }
      break;
    }
    
    case 'stop':
    case 'kill': {
      const sessions = tmux.listSessions();
      for (const session of sessions.filter(s => s.startsWith('swarm_'))) {
        tmux.killSession(session);
        console.log(`Killed session: ${session}`);
      }
      break;
    }
    
    default:
      console.log(`
Claude Swarm - Multi-Agent Collaboration

Usage:
  bun swarm.ts start <workflow> "<goal>"   Start a new workflow
  bun swarm.ts attach                      Attach to active session
  bun swarm.ts status                      Show active sessions
  bun swarm.ts logs <agent>                Show agent output
  bun swarm.ts stop                        Stop all agents

Workflows:
  research    - Deep research with verification
  develop     - Code development with review
  architect   - System design evaluation
      `);
  }
}

main().catch(console.error);
```

---

## 11. Error Handling

### Retry Logic
```javascript
const RETRY_CONFIG = {
  maxRetries: 3,
  backoffMs: 1000,
  backoffMultiplier: 2,
  retryableErrors: [
    'RATE_LIMIT',
    'TIMEOUT', 
    'CONNECTION_ERROR'
  ]
};
```

### Failure Modes
| Failure | Handling |
|---------|----------|
| Agent timeout | Retry with extended timeout, then escalate to coordinator |
| Rate limit | Exponential backoff, queue remaining tasks |
| Invalid output | Send back to agent with specific correction request |
| Circular delegation | Detect via message thread, break cycle, alert coordinator |
| Memory write failure | Retry, fall back to in-memory, log for recovery |

### Graceful Degradation
- If reviewer unavailable: Coordinator marks output as "unverified"
- If researcher unavailable: Coordinator prompts for manual input or skips
- If all agents fail: Save state, allow resume later

---

## 12. Testing Checklist

### Smoke Tests
- [ ] Can spawn single agent
- [ ] Can spawn 3 agents concurrently
- [ ] Agents can write to shared memory
- [ ] Agents can read from shared memory
- [ ] Messages route correctly between agents

### Integration Tests
- [ ] Research workflow completes end-to-end
- [ ] Development workflow completes end-to-end
- [ ] Reviewer can reject and trigger revision
- [ ] Session survives restart (memory persistence)

### Load Tests
- [ ] 4 agents running simultaneously
- [ ] 10+ message exchanges without corruption
- [ ] Memory queries return correct results

---

## 13. Known Limitations & Workarounds

| Limitation | Workaround |
|------------|------------|
| Claude Code rate limits | Stagger agent spawns, use queuing |
| Context window limits | Summarize long threads, use memory for retrieval |
| No true parallelism | Sequential with async simulation |
| Agent personality drift | Re-inject system prompt periodically |
| Memory search accuracy | Use explicit namespacing, structured keys |

---

## 14. Quick Start Commands

```bash
# One-time system setup
npm install -g @anthropic-ai/claude-code
curl -fsSL https://bun.sh/install | bash  # Install Bun
# Mac: brew install tmux
# Linux: sudo apt install tmux

# Clone and setup this project (after it's built)
git clone <your-repo>
cd claude-swarm
# No npm install needed! Bun has everything built-in

# Initialize git repo if needed (for worktrees)
git init
git add -A && git commit -m "Initial commit"

# Test basic tmux
tmux new-session -d -s test
tmux send-keys -t test "echo hello" Enter
tmux capture-pane -t test -p
tmux kill-session -t test

# Run first task
bun swarm.ts start research "Explain quantum error correction basics"

# Watch the agents work
bun swarm.ts attach
# (Ctrl+B, D to detach)

# Check status
bun swarm.ts status
```

---

## 15. Next Steps After Initial Build

1. **Prompt tuning**: Run tasks, observe failures, refine CLAUDE.md personas
2. **Add specialized agents**: Domain-specific roles (e.g., security-reviewer, ml-engineer)
3. **Improve monitoring**: Web dashboard showing agent activity in real-time
4. **Session templates**: Pre-configured workflows for common tasks
5. **Export formats**: Generate markdown reports, slide decks, etc.
6. **MCP integration**: Add custom MCP tools for inter-agent communication (instead of file polling)

---

## Appendix A: tmux Quick Reference

```bash
# Session management
tmux new-session -d -s NAME      # Create detached session
tmux attach -t NAME              # Attach to session
tmux kill-session -t NAME        # Kill session
tmux ls                          # List sessions

# Pane management
tmux split-window -h             # Split horizontally
tmux split-window -v             # Split vertically
tmux select-pane -t N            # Select pane N

# Sending commands
tmux send-keys -t SESSION:PANE "command" Enter

# Capturing output
tmux capture-pane -t SESSION:PANE -p -S -100   # Last 100 lines

# Inside tmux (prefix is Ctrl+B by default)
Ctrl+B, D                        # Detach
Ctrl+B, [                        # Scroll mode (q to exit)
Ctrl+B, %                        # Split horizontal
Ctrl+B, "                        # Split vertical
Ctrl+B, arrow                    # Navigate panes
```

---

## Appendix B: git Worktrees Quick Reference

```bash
# Create worktree with new branch
git worktree add <path> -b <branch-name>

# Create worktree from existing branch
git worktree add <path> <branch-name>

# List worktrees
git worktree list

# Remove worktree
git worktree remove <path>

# Force remove (if dirty)
git worktree remove <path> --force

# Prune stale worktree info
git worktree prune
```

---

## Appendix C: Troubleshooting

**"Claude Code not starting in tmux"**
- Check Claude Code CLI is authenticated: `claude --version`
- Verify API key is set: `echo $ANTHROPIC_API_KEY`
- Check rate limits in Anthropic console
- Try running `claude` manually in a terminal first

**"Agents not seeing messages"**
- Check message files exist: `ls .swarm/messages/inbox/`
- Verify JSON is valid: `cat .swarm/messages/inbox/researcher.json | bunx json`
- Check agent's CLAUDE.md has polling instructions

**"git worktree errors"**
- Ensure you're in a git repo: `git status`
- Check for locked worktrees: `git worktree list`
- Prune stale references: `git worktree prune`
- Force remove if needed: `git worktree remove .worktrees/agent --force`

**"tmux session issues"**
- List sessions: `tmux ls`
- Kill stuck session: `tmux kill-session -t swarm`
- Check for zombie processes: `ps aux | grep claude`

**"Workflow stuck"**
- Check agent pane output: `bun swarm.ts logs <agent>`
- Look for errors in captured output
- Manually send completion message to unblock

**"Bun not found"**
- Reinstall: `curl -fsSL https://bun.sh/install | bash`
- Check PATH: `which bun`
- Restart terminal after install

---

*End of Specification v1.2*
