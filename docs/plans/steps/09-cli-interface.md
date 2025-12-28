# Step 9: CLI Interface - Architectural Plan

## 1. Overview & Purpose

### What This Component Does

The CLI Interface is the user-facing entry point for Claude Swarm. It parses command-line arguments, validates user input, creates Orchestrator instances, and provides feedback on workflow progress. It translates user intentions into orchestrator actions and presents results in a human-readable format.

### Why It Exists

Without a CLI:
- Users would have no way to start workflows
- There would be no interactive feedback during execution
- Session management would require manual orchestrator instantiation
- Error messages and help documentation would be missing

The CLI provides:
- Intuitive command structure for all operations
- Interactive feedback during workflow execution
- Session discovery and management
- Consistent error handling and user messaging
- Self-documenting help system

### How It Fits Into The Larger System

```
┌─────────────────────────────────────────────────────────────────┐
│                           USER                                   │
│  $ bun swarm.ts start research "query"                          │
│  $ bun swarm.ts status                                           │
│  $ bun swarm.ts attach                                           │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      CLI (swarm.ts)                              │
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │   Command   │  │   Output    │  │   Session   │              │
│  │   Parser    │  │   Formatter │  │   Manager   │              │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘              │
│         │                │                │                      │
└─────────┼────────────────┼────────────────┼──────────────────────┘
          │                │                │
          ▼                │                │
┌──────────────────────────┼────────────────┼──────────────────────┐
│                      ORCHESTRATOR                                 │
│  Creates and manages workflow sessions                           │
│  Returns events and results to CLI                               │
└──────────────────────────┬───────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    LOWER COMPONENTS                              │
│  Tmux Manager, Worktree Manager, Message Bus, Database          │
└─────────────────────────────────────────────────────────────────┘
```

### Problems It Solves

1. **User Interaction**: Provides the primary interface for all operations
2. **Command Parsing**: Handles argument parsing and validation
3. **Feedback Loop**: Shows progress, status, and results
4. **Session Discovery**: Finds and interacts with existing sessions
5. **Error Presentation**: Translates errors into actionable messages
6. **Documentation**: Self-documenting help and usage information

---

## 2. Prerequisites & Dependencies

### External Dependencies

| Dependency | Version | Purpose |
|------------|---------|---------|
| Bun | 1.0+ | Runtime, process.argv access |
| tmux | 2.0+ | For attach command |

### Internal Dependencies

| Module | Purpose |
|--------|---------|
| `src/orchestrator.ts` | Core workflow execution |
| `src/tmux-manager.ts` | Session listing, attachment |
| `src/message-bus.ts` | Message queue inspection |
| `src/db.ts` | Session history queries |
| `src/workflows/index.ts` | Workflow type validation |

### System State Requirements

- tmux must be installed (for attach command)
- Git repository must exist (for workflow execution)
- `.swarm/` directory access (for status queries)

---

## 3. Command Structure

### Command Hierarchy

```
swarm.ts
├── start <workflow> "<goal>"    # Start a new workflow
├── attach                        # Attach to active tmux session
├── status                        # Show current session status
├── logs <agent>                  # Show agent's terminal output
├── messages [agent]              # Show message queue contents
├── stop                          # Graceful shutdown
├── kill                          # Force terminate all
├── clean                         # Remove session artifacts
├── history                       # Show past sessions
└── help [command]                # Show help
```

### Command Specifications

```typescript
// ============================================
// Command Definitions
// ============================================

interface Command {
  name: string;
  aliases?: string[];
  description: string;
  usage: string;
  arguments: CommandArgument[];
  options: CommandOption[];
  examples: string[];
  handler: CommandHandler;
}

interface CommandArgument {
  name: string;
  description: string;
  required: boolean;
  type: 'string' | 'number' | 'choice';
  choices?: string[];          // For type: 'choice'
  default?: string | number;
}

interface CommandOption {
  name: string;
  short?: string;              // Single-letter alias
  description: string;
  type: 'boolean' | 'string' | 'number';
  default?: boolean | string | number;
}

type CommandHandler = (args: ParsedArgs) => Promise<number>;

interface ParsedArgs {
  command: string;
  positional: string[];
  options: Record<string, boolean | string | number>;
}


// ============================================
// Parsed Command Result
// ============================================

interface ParseResult {
  success: boolean;
  command?: string;
  args?: ParsedArgs;
  error?: ParseError;
}

interface ParseError {
  type: 'unknown_command' | 'missing_argument' | 'invalid_option' | 'validation_error';
  message: string;
  suggestion?: string;
}
```

---

## 4. Command Specifications

### `start` Command

**Purpose**: Start a new workflow session.

**Syntax**:
```bash
bun swarm.ts start <workflow> "<goal>"
```

**Arguments**:

| Argument | Required | Description |
|----------|----------|-------------|
| workflow | Yes | Workflow type: `research`, `develop`, `architect` |
| goal | Yes | The goal or query for the workflow |

**Options**:

| Option | Short | Type | Default | Description |
|--------|-------|------|---------|-------------|
| --session-id | -s | string | auto | Custom session identifier |
| --timeout | -t | number | 1800000 | Workflow timeout in ms |
| --verbose | -v | boolean | false | Enable verbose logging |
| --no-cleanup | | boolean | false | Keep artifacts after completion |

**Behavior**:

```
1. VALIDATE INPUT
   ├── Check workflow type is valid
   ├── Check goal is non-empty
   └── Check no session already running (unless --force)

2. DISPLAY STARTUP INFO
   ├── "Starting {workflow} workflow..."
   ├── "Goal: {goal}"
   └── "Session ID: {sessionId}"

3. CREATE ORCHESTRATOR
   ├── Instantiate with config from options
   └── Subscribe to events for progress display

4. START WORKFLOW
   ├── Call orchestrator.startWorkflow(type, goal)
   └── Handle startup errors

5. MONITOR PROGRESS
   ├── Display agent spawn events
   ├── Display stage transitions
   ├── Display completion status
   └── Handle Ctrl+C for graceful stop

6. DISPLAY RESULTS
   ├── Show success/failure status
   ├── Show summary
   ├── Show output file paths
   └── Exit with appropriate code
```

**Output Examples**:

```
$ bun swarm.ts start research "quantum computing basics"

Starting research workflow...
Goal: quantum computing basics
Session ID: swarm_1703702400

[✓] Spawned agent: researcher
[✓] Spawned agent: reviewer
[→] Stage: initial_research
[→] Stage: verification
[✓] Workflow complete

Summary:
  Duration: 3m 42s
  Findings: 8
  Verified: 6

Output: outputs/swarm_1703702400/summary.md
```

**Exit Codes**:

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Workflow failed |
| 2 | Invalid arguments |
| 3 | Session already running |
| 130 | Interrupted (Ctrl+C) |

---

### `attach` Command

**Purpose**: Attach to the active tmux session to see agents working.

**Syntax**:
```bash
bun swarm.ts attach
```

**Options**:

| Option | Short | Type | Default | Description |
|--------|-------|------|---------|-------------|
| --session | -s | string | auto | Specific session ID to attach |
| --readonly | -r | boolean | false | Read-only attachment |

**Behavior**:

```
1. FIND SESSION
   ├── List tmux sessions matching "swarm_*"
   ├── If none found: display error
   ├── If multiple found: prompt for selection (or use --session)
   └── If one found: proceed

2. DISPLAY INFO
   └── "Attaching to session {sessionId}..."
       "Detach with: Ctrl+B, D"

3. ATTACH
   └── Execute: tmux attach -t {sessionId}

4. RETURN
   └── Exit code from tmux
```

**Output Examples**:

```
$ bun swarm.ts attach
Attaching to session swarm_1703702400...
Detach with: Ctrl+B, D
[tmux session displayed]
```

```
$ bun swarm.ts attach
No active swarm session found.
Run 'bun swarm.ts start <workflow> "<goal>"' to begin.
```

---

### `status` Command

**Purpose**: Show current session status and agent states.

**Syntax**:
```bash
bun swarm.ts status
```

**Options**:

| Option | Short | Type | Default | Description |
|--------|-------|------|---------|-------------|
| --json | -j | boolean | false | Output as JSON |
| --watch | -w | boolean | false | Continuous update |

**Behavior**:

```
1. CHECK FOR ACTIVE SESSION
   ├── Look for tmux sessions matching "swarm_*"
   ├── Read session state from .swarm/sessions/
   └── If none found: display "No active session"

2. GATHER STATUS
   ├── Session ID, workflow type, start time
   ├── Current stage
   ├── For each agent:
   │   ├── Role
   │   ├── Status (ready/working/complete)
   │   ├── Messages sent/received
   │   └── Last activity time
   └── Overall progress

3. DISPLAY STATUS
   ├── Format as table or JSON
   └── If --watch: refresh every 2 seconds
```

**Output Examples**:

```
$ bun swarm.ts status

Session: swarm_1703702400
Workflow: research
Started: 2 minutes ago
Stage: verification

Agents:
  ROLE        STATUS     MESSAGES  LAST ACTIVITY
  researcher  complete   3 sent    1m ago
  reviewer    working    1 sent    10s ago

Progress: ████████░░ 75%
```

---

### `logs` Command

**Purpose**: Show agent's terminal output.

**Syntax**:
```bash
bun swarm.ts logs <agent>
```

**Arguments**:

| Argument | Required | Description |
|----------|----------|-------------|
| agent | Yes | Agent role: `researcher`, `developer`, `reviewer`, `architect` |

**Options**:

| Option | Short | Type | Default | Description |
|--------|-------|------|---------|-------------|
| --lines | -n | number | 100 | Number of lines to show |
| --follow | -f | boolean | false | Continuously show new output |

**Behavior**:

```
1. FIND SESSION
   └── Get active tmux session

2. FIND AGENT PANE
   ├── Look up agent's pane ID from session state
   └── If not found: error "Agent not active"

3. CAPTURE OUTPUT
   ├── Call tmux capture-pane
   └── If --follow: poll every 1 second

4. DISPLAY
   └── Print captured output
```

**Output Examples**:

```
$ bun swarm.ts logs researcher

[researcher output...]
> Starting research on: quantum computing basics
> Searching for authoritative sources...
> Found 12 relevant papers
> Analyzing key concepts...
```

---

### `messages` Command

**Purpose**: Show message queue contents for debugging.

**Syntax**:
```bash
bun swarm.ts messages [agent]
```

**Arguments**:

| Argument | Required | Description |
|----------|----------|-------------|
| agent | No | Specific agent to show (all if omitted) |

**Options**:

| Option | Short | Type | Default | Description |
|--------|-------|------|---------|-------------|
| --inbox | -i | boolean | false | Show inbox only |
| --outbox | -o | boolean | false | Show outbox only |
| --count | -c | boolean | false | Show counts only |

**Behavior**:

```
1. READ MESSAGE FILES
   ├── For specified agent or all agents:
   │   ├── Read .swarm/messages/inbox/{agent}.json
   │   └── Read .swarm/messages/outbox/{agent}.json

2. FORMAT OUTPUT
   ├── Group by agent
   ├── Show message type, timestamp, summary
   └── Truncate long content

3. DISPLAY
   └── Print formatted messages
```

**Output Examples**:

```
$ bun swarm.ts messages

researcher:
  INBOX (1):
    [task] 2m ago - Research Assignment: quantum computing basics
  OUTBOX (2):
    [finding] 1m ago - Quantum computing overview
    [status] 30s ago - Complete

reviewer:
  INBOX (1):
    [finding] 1m ago - From researcher
  OUTBOX (0): empty
```

---

### `stop` Command

**Purpose**: Gracefully stop the current session.

**Syntax**:
```bash
bun swarm.ts stop
```

**Options**:

| Option | Short | Type | Default | Description |
|--------|-------|------|---------|-------------|
| --save | -s | boolean | true | Save current state |
| --timeout | -t | number | 10000 | Shutdown timeout in ms |

**Behavior**:

```
1. FIND SESSION
   └── Get active session or error

2. CONFIRM (if interactive)
   └── "Stop session {id}? Agents will be terminated. [y/N]"

3. GRACEFUL SHUTDOWN
   ├── Signal orchestrator.stop()
   ├── Wait for agents to complete current work
   ├── Save state if --save
   └── Cleanup resources

4. DISPLAY
   ├── "Session stopped."
   ├── Show partial results if any
   └── Show cleanup summary
```

---

### `kill` Command

**Purpose**: Force terminate all agents immediately.

**Syntax**:
```bash
bun swarm.ts kill
```

**Options**:

| Option | Short | Type | Default | Description |
|--------|-------|------|---------|-------------|
| --all | -a | boolean | false | Kill all swarm sessions |

**Behavior**:

```
1. FIND SESSIONS
   ├── If --all: find all "swarm_*" sessions
   └── Else: find active session

2. FORCE KILL
   ├── tmux kill-session for each
   ├── Remove worktrees
   └── Clean message files

3. DISPLAY
   └── "Killed N sessions."
```

---

### `clean` Command

**Purpose**: Remove session artifacts without running workflows.

**Syntax**:
```bash
bun swarm.ts clean
```

**Options**:

| Option | Short | Type | Default | Description |
|--------|-------|------|---------|-------------|
| --all | -a | boolean | false | Clean all sessions |
| --worktrees | -w | boolean | false | Clean worktrees only |
| --messages | -m | boolean | false | Clean messages only |
| --sessions | -s | boolean | false | Clean session state only |

**Behavior**:

```
1. IDENTIFY ARTIFACTS
   ├── .swarm/messages/inbox/*.json
   ├── .swarm/messages/outbox/*.json
   ├── .worktrees/
   └── .swarm/sessions/*.json

2. CONFIRM
   └── "This will remove: [list]. Continue? [y/N]"

3. REMOVE
   ├── Remove selected artifacts
   ├── Prune git worktrees
   └── Reset message files to []

4. DISPLAY
   └── "Cleaned: N files, M worktrees"
```

---

### `history` Command

**Purpose**: Show past session history.

**Syntax**:
```bash
bun swarm.ts history
```

**Options**:

| Option | Short | Type | Default | Description |
|--------|-------|------|---------|-------------|
| --limit | -n | number | 10 | Number of sessions to show |
| --json | -j | boolean | false | Output as JSON |

**Behavior**:

```
1. QUERY DATABASE
   └── SELECT * FROM sessions ORDER BY created_at DESC LIMIT n

2. FORMAT OUTPUT
   ├── Session ID
   ├── Workflow type
   ├── Goal (truncated)
   ├── Status
   ├── Duration
   └── Date

3. DISPLAY
   └── Print as table or JSON
```

**Output Examples**:

```
$ bun swarm.ts history

SESSION            WORKFLOW    GOAL                      STATUS    DURATION
swarm_1703702400   research    quantum computing basics  complete  3m 42s
swarm_1703698800   develop     rate limiter middleware   complete  12m 18s
swarm_1703695200   architect   task queue system         failed    8m 05s
```

---

### `help` Command

**Purpose**: Show help documentation.

**Syntax**:
```bash
bun swarm.ts help [command]
```

**Behavior**:

```
1. IF NO COMMAND
   └── Show general help with all commands

2. IF COMMAND SPECIFIED
   ├── Show detailed help for that command
   ├── Include usage, arguments, options
   └── Include examples
```

**Output Examples**:

```
$ bun swarm.ts help

Claude Swarm - Multi-Agent Collaboration

Usage:
  bun swarm.ts <command> [options]

Commands:
  start <workflow> "<goal>"   Start a new workflow
  attach                      Attach to active session
  status                      Show session status
  logs <agent>                Show agent output
  messages [agent]            Show message queues
  stop                        Graceful shutdown
  kill                        Force terminate
  clean                       Remove artifacts
  history                     Show past sessions
  help [command]              Show help

Run 'bun swarm.ts help <command>' for detailed information.
```

```
$ bun swarm.ts help start

Usage:
  bun swarm.ts start <workflow> "<goal>"

Start a new multi-agent workflow session.

Arguments:
  workflow   The workflow type: research, develop, architect
  goal       The goal or query for the workflow

Options:
  -s, --session-id <id>   Custom session ID (default: auto-generated)
  -t, --timeout <ms>      Workflow timeout (default: 1800000)
  -v, --verbose           Enable verbose logging
  --no-cleanup            Keep artifacts after completion

Examples:
  bun swarm.ts start research "quantum computing basics"
  bun swarm.ts start develop "rate limiter middleware" --verbose
  bun swarm.ts start architect "distributed task queue" -t 3600000
```

---

## 5. Argument Parsing

### Parser Design

The CLI uses a lightweight custom parser (no external dependencies):

```typescript
// ============================================
// Parser Types
// ============================================

interface ParserConfig {
  commands: Command[];
  globalOptions: CommandOption[];
}

interface ParseContext {
  args: string[];
  position: number;
  command?: Command;
  result: ParsedArgs;
  errors: ParseError[];
}


// ============================================
// Parser Functions
// ============================================

// Main entry point
function parseArgs(
  argv: string[],
  config: ParserConfig
): ParseResult;

// Extract command name
function parseCommand(
  context: ParseContext,
  config: ParserConfig
): void;

// Parse positional arguments
function parsePositionalArgs(
  context: ParseContext
): void;

// Parse options (--name value, -n, --flag)
function parseOptions(
  context: ParseContext
): void;

// Validate required arguments present
function validateRequired(
  context: ParseContext
): void;

// Validate choice arguments have valid values
function validateChoices(
  context: ParseContext
): void;
```

### Argument Parsing Rules

1. **Command Detection**: First non-option argument is the command
2. **Option Formats**:
   - Long: `--option value` or `--option=value`
   - Short: `-o value` or `-o=value`
   - Boolean: `--flag` (true) or `--no-flag` (false)
   - Combined short: `-abc` = `-a -b -c`
3. **Positional Arguments**: Non-option arguments after command
4. **Quoted Strings**: Preserve spaces in quoted arguments
5. **Stop Parsing**: `--` stops option parsing, rest are positional

### Validation Rules

```typescript
interface ValidationRule {
  name: string;
  check: (args: ParsedArgs, command: Command) => boolean;
  message: string;
}

const validationRules: ValidationRule[] = [
  {
    name: 'required_args',
    check: (args, cmd) => {
      const required = cmd.arguments.filter(a => a.required);
      return required.every((arg, i) => args.positional[i] !== undefined);
    },
    message: 'Missing required argument: {arg}'
  },
  {
    name: 'valid_workflow',
    check: (args, cmd) => {
      if (cmd.name !== 'start') return true;
      const validWorkflows = ['research', 'develop', 'architect'];
      return validWorkflows.includes(args.positional[0]);
    },
    message: 'Invalid workflow type. Choose: research, develop, architect'
  },
  {
    name: 'non_empty_goal',
    check: (args, cmd) => {
      if (cmd.name !== 'start') return true;
      return args.positional[1]?.trim().length > 0;
    },
    message: 'Goal cannot be empty'
  }
];
```

---

## 6. Output Formatting

### Output Styles

```typescript
// ============================================
// Output Types
// ============================================

type OutputLevel = 'info' | 'success' | 'warning' | 'error' | 'debug';

interface OutputConfig {
  color: boolean;            // Enable ANSI colors
  json: boolean;             // JSON output mode
  verbose: boolean;          // Include debug output
  quiet: boolean;            // Minimal output
}


// ============================================
// Formatting Functions
// ============================================

// Print with color and level prefix
function print(
  message: string,
  level?: OutputLevel
): void;

// Print table data
function printTable(
  headers: string[],
  rows: string[][],
  options?: TableOptions
): void;

// Print progress indicator
function printProgress(
  current: number,
  total: number,
  label?: string
): void;

// Print JSON output
function printJson(
  data: unknown
): void;

// Print spinner during async operations
function withSpinner<T>(
  message: string,
  operation: () => Promise<T>
): Promise<T>;
```

### Color Scheme

| Level | Color | Symbol |
|-------|-------|--------|
| info | default | ℹ |
| success | green | ✓ |
| warning | yellow | ⚠ |
| error | red | ✗ |
| debug | gray | • |

### Progress Display

```typescript
interface ProgressState {
  sessionId: string;
  startTime: number;
  currentStage: string;
  agents: Map<string, AgentDisplayState>;
}

interface AgentDisplayState {
  role: string;
  status: string;
  statusSymbol: string;
  messageCount: number;
}

// Update display without clearing screen
function updateProgress(state: ProgressState): void;

// Clear line and rewrite
function rewriteLine(text: string): void;
```

---

## 7. Event Handling

### Orchestrator Event Subscription

The CLI subscribes to Orchestrator events to provide real-time feedback:

```typescript
function subscribeToEvents(
  orchestrator: Orchestrator,
  outputConfig: OutputConfig
): void {
  orchestrator.on((event: OrchestratorEvent) => {
    switch (event.type) {
      case 'session_started':
        print(`Session started: ${event.sessionId}`, 'info');
        break;

      case 'agent_spawned':
        print(`[✓] Spawned agent: ${event.role}`, 'success');
        break;

      case 'agent_ready':
        if (outputConfig.verbose) {
          print(`Agent ${event.role} ready`, 'debug');
        }
        break;

      case 'agent_working':
        print(`[→] ${event.role}: ${event.task}`, 'info');
        break;

      case 'agent_complete':
        print(`[✓] ${event.role} complete`, 'success');
        break;

      case 'agent_error':
        print(`[✗] ${event.role}: ${event.error}`, 'error');
        break;

      case 'stage_transition':
        print(`[→] Stage: ${event.to}`, 'info');
        break;

      case 'workflow_complete':
        if (event.success) {
          print(`[✓] Workflow complete`, 'success');
        } else {
          print(`[✗] Workflow failed`, 'error');
        }
        break;

      case 'session_ended':
        displayResults(event.result);
        break;
    }
  });
}
```

### Signal Handling

```typescript
// Handle Ctrl+C gracefully
function setupSignalHandlers(orchestrator: Orchestrator | null): void {
  let stopping = false;

  process.on('SIGINT', async () => {
    if (stopping) {
      // Second Ctrl+C: force exit
      print('\nForce stopping...', 'warning');
      process.exit(130);
    }

    stopping = true;
    print('\nStopping gracefully... (Ctrl+C again to force)', 'warning');

    if (orchestrator) {
      try {
        await orchestrator.stop();
        process.exit(0);
      } catch {
        process.exit(1);
      }
    } else {
      process.exit(0);
    }
  });

  process.on('SIGTERM', async () => {
    if (orchestrator) {
      await orchestrator.stop();
    }
    process.exit(0);
  });
}
```

---

## 8. Error Handling

### Error Categories

| Category | Examples | User Message |
|----------|----------|--------------|
| Argument Error | Missing workflow, empty goal | "Error: {specific issue}. Run 'swarm help {cmd}' for usage." |
| Session Error | Already running, not found | "Error: {issue}. {suggestion}" |
| Workflow Error | Agent timeout, stage failure | "Workflow error: {details}" |
| System Error | tmux not found, permission denied | "System error: {details}. {remediation}" |

### Error Display

```typescript
interface CLIError {
  type: 'argument' | 'session' | 'workflow' | 'system';
  message: string;
  suggestion?: string;
  details?: string;
  exitCode: number;
}

function displayError(error: CLIError): void {
  print(`Error: ${error.message}`, 'error');

  if (error.details) {
    print(`Details: ${error.details}`, 'error');
  }

  if (error.suggestion) {
    print(`Suggestion: ${error.suggestion}`, 'info');
  }
}

function handleError(error: unknown): never {
  if (error instanceof CLIError) {
    displayError(error);
    process.exit(error.exitCode);
  }

  // Unexpected error
  print(`Unexpected error: ${String(error)}`, 'error');
  if (process.env.DEBUG) {
    console.error(error);
  }
  process.exit(1);
}
```

### Prerequisite Checking

```typescript
interface PrerequisiteCheck {
  name: string;
  check: () => Promise<boolean>;
  errorMessage: string;
  remediation: string;
}

const prerequisites: PrerequisiteCheck[] = [
  {
    name: 'tmux',
    check: async () => {
      try {
        await $`tmux -V`;
        return true;
      } catch {
        return false;
      }
    },
    errorMessage: 'tmux is not installed',
    remediation: 'Install with: sudo apt install tmux (Linux) or brew install tmux (Mac)'
  },
  {
    name: 'git_repo',
    check: async () => {
      try {
        await $`git rev-parse --is-inside-work-tree`;
        return true;
      } catch {
        return false;
      }
    },
    errorMessage: 'Not in a git repository',
    remediation: 'Initialize with: git init && git add -A && git commit -m "Initial commit"'
  },
  {
    name: 'claude_cli',
    check: async () => {
      try {
        await $`claude --version`;
        return true;
      } catch {
        return false;
      }
    },
    errorMessage: 'Claude Code CLI is not installed',
    remediation: 'Install with: npm install -g @anthropic-ai/claude-code'
  }
];

async function checkPrerequisites(
  required: string[]
): Promise<PrerequisiteCheck[]> {
  const failed: PrerequisiteCheck[] = [];

  for (const prereq of prerequisites) {
    if (required.includes(prereq.name)) {
      const ok = await prereq.check();
      if (!ok) {
        failed.push(prereq);
      }
    }
  }

  return failed;
}
```

---

## 9. Integration Points

### Integration with Orchestrator (Step 8)

```typescript
// Create orchestrator with CLI options
const orchestrator = new Orchestrator({
  sessionId: options.sessionId,
  workflowTimeout: options.timeout,
  verboseLogging: options.verbose,
  autoCleanup: !options.noCleanup
});

// Start workflow
const session = await orchestrator.startWorkflow(type, goal);

// Subscribe to events
orchestrator.on(handleEvent);

// Stop when done or interrupted
await orchestrator.stop();
```

### Integration with Tmux Manager (Step 4)

```typescript
// For attach command
const sessions = tmux.listSessions();
const swarmSessions = sessions.filter(s => s.startsWith('swarm_'));
await $`tmux attach -t ${sessionId}`;

// For logs command
const output = tmux.capturePane(sessionId, agentPaneId, lines);
```

### Integration with Message Bus (Step 3)

```typescript
// For messages command
const inbox = messageBus.readMessages(agent, 'inbox');
const outbox = messageBus.readMessages(agent, 'outbox');
```

### Integration with Database (Step 2)

```typescript
// For history command
const db = getDb();
const sessions = db.query(
  'SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?'
).all(limit);

// For status command
const session = db.query(
  'SELECT * FROM sessions WHERE id = ?'
).get(sessionId);
```

---

## 10. Testing Strategy

### Unit Tests

**Argument Parsing**:
- Test valid command parsing
- Test option parsing (long, short, boolean, combined)
- Test quoted strings with spaces
- Test missing required arguments
- Test invalid option values
- Test unknown commands

**Output Formatting**:
- Test table formatting
- Test progress bar rendering
- Test color output
- Test JSON output mode

**Error Handling**:
- Test error message formatting
- Test exit code mapping
- Test suggestion generation

### Integration Tests

**Command Execution**:
1. Test `start` command creates session
2. Test `status` shows correct information
3. Test `stop` gracefully terminates
4. Test `kill` force terminates
5. Test `clean` removes artifacts

**Event Display**:
1. Start workflow
2. Verify progress events displayed
3. Verify completion displayed
4. Verify error display

### Manual Testing

```bash
# Test help
bun swarm.ts help
bun swarm.ts help start

# Test argument validation
bun swarm.ts start                    # Missing args
bun swarm.ts start invalid "goal"     # Invalid workflow
bun swarm.ts start research ""        # Empty goal

# Test full workflow
bun swarm.ts start research "test query"
bun swarm.ts status
bun swarm.ts logs researcher
bun swarm.ts messages
bun swarm.ts attach                   # Then Ctrl+B, D
bun swarm.ts stop

# Test cleanup
bun swarm.ts clean
bun swarm.ts history
```

---

## 11. Configuration

### Environment Variables

```bash
# Override output behavior
SWARM_NO_COLOR=1           # Disable colors
SWARM_VERBOSE=1            # Enable verbose output
SWARM_JSON=1               # Default to JSON output

# Override defaults
SWARM_DEFAULT_TIMEOUT=3600000
SWARM_MONITOR_INTERVAL=10000
```

### Configuration Loading

```typescript
interface CLIConfig {
  color: boolean;
  verbose: boolean;
  json: boolean;
  defaultTimeout: number;
  monitorInterval: number;
}

function loadConfig(): CLIConfig {
  return {
    color: !process.env.SWARM_NO_COLOR && !process.env.NO_COLOR,
    verbose: !!process.env.SWARM_VERBOSE,
    json: !!process.env.SWARM_JSON,
    defaultTimeout: parseInt(process.env.SWARM_DEFAULT_TIMEOUT || '1800000'),
    monitorInterval: parseInt(process.env.SWARM_MONITOR_INTERVAL || '5000')
  };
}
```

---

## 12. Module Organization

```
swarm.ts
├── Shebang (#!/usr/bin/env bun)
├── Imports
│   ├── From src/orchestrator
│   ├── From src/tmux-manager
│   ├── From src/message-bus
│   ├── From src/db
│   └── From src/workflows
│
├── Type Definitions
│   ├── Command, CommandArgument, CommandOption
│   ├── ParsedArgs, ParseResult, ParseError
│   ├── OutputConfig, OutputLevel
│   └── CLIError, PrerequisiteCheck
│
├── Constants
│   ├── COMMANDS (command definitions)
│   ├── GLOBAL_OPTIONS
│   └── PREREQUISITES
│
├── Parser Functions
│   ├── parseArgs()
│   ├── parseCommand()
│   ├── parsePositionalArgs()
│   ├── parseOptions()
│   └── validate*()
│
├── Output Functions
│   ├── print()
│   ├── printTable()
│   ├── printProgress()
│   ├── printJson()
│   └── withSpinner()
│
├── Command Handlers
│   ├── handleStart()
│   ├── handleAttach()
│   ├── handleStatus()
│   ├── handleLogs()
│   ├── handleMessages()
│   ├── handleStop()
│   ├── handleKill()
│   ├── handleClean()
│   ├── handleHistory()
│   └── handleHelp()
│
├── Utility Functions
│   ├── loadConfig()
│   ├── checkPrerequisites()
│   ├── setupSignalHandlers()
│   ├── subscribeToEvents()
│   └── displayResults()
│
├── Error Handling
│   ├── displayError()
│   └── handleError()
│
└── Main Function
    ├── Parse arguments
    ├── Load configuration
    ├── Check prerequisites
    ├── Execute command handler
    └── Exit with code
```

---

## 13. Open Questions & Decisions

### Resolved Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Argument parsing | Custom parser | Zero dependencies, simple needs |
| Output format | Table/JSON toggle | Human-friendly default, machine-readable option |
| Progress display | Inline updates | Works in most terminals, no ncurses |
| Color | ANSI codes | Universal support, respects NO_COLOR |

### Open Questions

1. **Should there be an interactive mode?**
   - Current: Command-per-invocation
   - Alternative: REPL-style interface
   - Consideration: Adds complexity, may be nice for exploration

2. **Should attach open in a new terminal window?**
   - Current: Replaces current terminal
   - Alternative: Spawn new terminal emulator
   - Consideration: Platform-specific, adds complexity

3. **Should there be command aliases file?**
   - Current: Built-in aliases only
   - Alternative: User-configurable aliases
   - Consideration: Low priority, nice-to-have

4. **Should output support internationalization?**
   - Current: English only
   - Alternative: i18n with message files
   - Consideration: Out of scope for personal tooling

---

## Next Step

After implementing the CLI Interface, proceed to **Step 10: Error Handling & Recovery** which adds robust error handling across all components.
