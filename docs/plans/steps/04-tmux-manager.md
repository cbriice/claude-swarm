# Step 4: Tmux Manager

## 1. Overview & Purpose

### What This Component Does

The Tmux Manager provides a TypeScript wrapper around tmux operations for session and pane management. It enables the orchestrator to spawn Claude Code instances in isolated terminal panes, send commands to them, capture their output, and manage their lifecycle.

### Why It Exists

Claude Swarm needs to run multiple Claude Code instances simultaneously, each in its own isolated terminal environment. Tmux provides:
- Process isolation (each pane is a separate shell)
- Parallel execution (all panes run concurrently)
- Output capture (can read what agents produce)
- Persistence (sessions survive disconnection)
- Visual debugging (user can attach and watch agents)

### How It Fits Into the System

```
┌─────────────────────────────────────────────────────────────────┐
│                          ORCHESTRATOR                            │
│  Calls: createSession(), spawnAgent(), capturePane()            │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                        TMUX MANAGER                              │
│  src/tmux-manager.ts                                            │
│  Wraps tmux CLI commands, provides typed async interface        │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                        TMUX SERVER                               │
│  System process managing terminal sessions                       │
│  ├── Session: swarm_1704067200000                               │
│  │    └── Window 0                                               │
│  │         ├── Pane %0 (researcher) ──► Claude Code instance    │
│  │         ├── Pane %1 (developer)  ──► Claude Code instance    │
│  │         ├── Pane %2 (reviewer)   ──► Claude Code instance    │
│  │         └── Pane %3 (architect)  ──► Claude Code instance    │
│  └── Session: swarm_1704153600000 (another swarm run)           │
└─────────────────────────────────────────────────────────────────┘
```

The Tmux Manager is used by:
- **Orchestrator**: To create sessions, spawn agent panes, send commands, and monitor output
- **CLI**: To list, attach to, and kill swarm sessions
- **Cleanup utilities**: To remove orphaned sessions

---

## 2. Prerequisites & Dependencies

### External Dependencies

| Dependency | Purpose | Version | Detection |
|------------|---------|---------|-----------|
| tmux | Terminal multiplexer | 2.0+ | `tmux -V` |
| Bun | Runtime with shell execution (`$`) | 1.0+ | `bun --version` |

### Internal Dependencies

| Module | Required Items | Purpose |
|--------|----------------|---------|
| `src/types.ts` | `Result<T, E>`, `ok()`, `err()` | Error handling pattern |

### Preconditions

- tmux installed and in PATH
- User has permission to create tmux sessions
- Step 1 (Project Scaffolding) completed with types module

### Tmux Concepts

```
┌─────────────────────────────────────────────────────────────────┐
│ tmux server (single daemon process)                              │
│  │                                                               │
│  ├── Session: "swarm_123" ◄─── Named container                  │
│  │    │                                                          │
│  │    ├── Window 0 ◄─── Tab (we use one main window)            │
│  │    │    │                                                     │
│  │    │    ├── Pane %0 ◄─── Split terminal (unique ID)          │
│  │    │    ├── Pane %1     Index: 0, 1, 2, 3                    │
│  │    │    ├── Pane %2     ID: %0, %1, %2, %3 (stable)          │
│  │    │    └── Pane %3                                          │
│  │    │                                                          │
│  │    └── Window 1 (optional additional windows)                │
│  │                                                               │
│  └── Session: "other_session"                                   │
└─────────────────────────────────────────────────────────────────┘
```

**Important**: Pane **IDs** (like `%0`, `%1`) are stable and don't change when panes are rearranged. Pane **indices** (0, 1, 2, 3) change based on position. We use IDs for reliability.

---

## 3. Public API Design

### Module Exports

```typescript
// src/tmux-manager.ts

// Type Exports
export interface TmuxSession {
  name: string;
  windows: number;
  created: string;
  attached: boolean;
}

export interface TmuxPane {
  id: string;           // Stable ID like "%0", "%1"
  index: number;        // Position-based index (changes with layout)
  active: boolean;      // Whether this pane is focused
  width: number;        // Pane width in characters
  height: number;       // Pane height in characters
  currentPath: string;  // Working directory
  title?: string;       // Optional pane title
}

export interface TmuxError extends Error {
  code: TmuxErrorCode;
  details?: string;
}

export type TmuxErrorCode =
  | 'SESSION_EXISTS'
  | 'SESSION_NOT_FOUND'
  | 'PANE_NOT_FOUND'
  | 'TMUX_NOT_RUNNING'
  | 'COMMAND_FAILED';

export type TmuxLayout =
  | 'tiled'
  | 'even-horizontal'
  | 'even-vertical'
  | 'main-horizontal'
  | 'main-vertical';

// Availability Checks
export function isTmuxAvailable(): Promise<boolean>;
export function getTmuxVersion(): Promise<string | null>;
export function isTmuxServerRunning(): Promise<boolean>;

// Session Management
export function createSession(name: string): Promise<Result<void, TmuxError>>;
export function killSession(name: string): Promise<Result<void, TmuxError>>;
export function listSessions(): Promise<TmuxSession[]>;
export function sessionExists(name: string): Promise<boolean>;
export function listSwarmSessions(): Promise<TmuxSession[]>;
export function getSession(name: string): Promise<TmuxSession | null>;

// Pane Management
export function createPane(sessionName: string, options?: CreatePaneOptions): Promise<Result<string, TmuxError>>;
export function createPaneGrid(sessionName: string, count: number): Promise<Result<string[], TmuxError>>;
export function listPanes(sessionName: string): Promise<TmuxPane[]>;
export function getPane(sessionName: string, paneIdOrIndex: string | number): Promise<TmuxPane | null>;
export function selectPane(sessionName: string, paneId: string): Promise<Result<void, TmuxError>>;
export function killPane(sessionName: string, paneId: string): Promise<Result<void, TmuxError>>;

// Command Execution
export function sendKeys(sessionName: string, paneId: string, text: string, options?: SendKeysOptions): Promise<Result<void, TmuxError>>;
export function runCommand(sessionName: string, paneId: string, command: string): Promise<Result<void, TmuxError>>;
export function sendInterrupt(sessionName: string, paneId: string): Promise<Result<void, TmuxError>>;
export function clearPane(sessionName: string, paneId: string): Promise<Result<void, TmuxError>>;

// Output Capture
export function capturePane(sessionName: string, paneId: string, options?: CaptureOptions): Promise<Result<string, TmuxError>>;
export function capturePaneHistory(sessionName: string, paneId: string): Promise<Result<string, TmuxError>>;
export function waitForPattern(sessionName: string, paneId: string, pattern: RegExp, options?: WaitOptions): Promise<Result<string, TmuxError>>;
export function waitForPrompt(sessionName: string, paneId: string, options?: WaitPromptOptions): Promise<Result<void, TmuxError>>;

// Claude Code Helpers
export function startClaudeCode(sessionName: string, paneId: string, options?: ClaudeCodeOptions): Promise<Result<void, TmuxError>>;
export function sendToClaudeCode(sessionName: string, paneId: string, message: string): Promise<Result<void, TmuxError>>;
export function isClaudeCodeRunning(sessionName: string, paneId: string): Promise<boolean>;

// Layout Management
export function applyLayout(sessionName: string, layout: TmuxLayout): Promise<Result<void, TmuxError>>;
export function resizePane(sessionName: string, paneId: string, options: ResizeOptions): Promise<Result<void, TmuxError>>;

// Session Attachment
export function attachSession(sessionName: string): Promise<void>;
export function getAttachCommand(sessionName: string): string;

// Cleanup
export function killAllSwarmSessions(): Promise<void>;
export function cleanupOrphanedSessions(maxAgeMs?: number): Promise<number>;
```

### Option Types

```typescript
interface CreatePaneOptions {
  vertical?: boolean;   // Split vertically (default: horizontal)
  size?: number;        // Percentage size (1-99)
  name?: string;        // Pane title
}

interface SendKeysOptions {
  enter?: boolean;      // Send Enter after text (default: true)
  literal?: boolean;    // Send literal text, no key interpretation (default: false)
}

interface CaptureOptions {
  lines?: number;       // Number of lines from bottom (default: 100)
  startLine?: number;   // Start from this line (negative = from bottom)
  endLine?: number;     // End at this line
  escape?: boolean;     // Include ANSI escape sequences (default: false)
}

interface WaitOptions {
  timeoutMs?: number;   // Maximum wait time (default: 60000)
  intervalMs?: number;  // Check interval (default: 1000)
  lines?: number;       // Lines to capture for pattern check (default: 50)
}

interface WaitPromptOptions {
  timeoutMs?: number;     // Maximum wait time (default: 30000)
  promptPattern?: RegExp; // Custom prompt pattern (default: /[$#>%]\s*$/m)
}

interface ClaudeCodeOptions {
  resume?: boolean;       // Use --resume flag
  workdir?: string;       // Change to this directory first
  initialPrompt?: string; // Initial prompt to send with -p flag
}

interface ResizeOptions {
  width?: number;         // Absolute width in characters
  height?: number;        // Absolute height in lines
  direction?: 'L' | 'R' | 'U' | 'D'; // Resize direction
  amount?: number;        // Resize amount when using direction
}
```

### Rationale for API Shape

- **Result type**: Explicit error handling without exceptions for predictable control flow
- **Async everywhere**: All tmux operations involve spawning processes
- **Pane IDs over indices**: IDs are stable across layout changes
- **Options objects**: Extensible and self-documenting parameters
- **Swarm-specific helpers**: `listSwarmSessions()`, `cleanupOrphanedSessions()` for managing multiple swarm runs
- **Claude Code helpers**: Specialized functions for the primary use case

---

## 4. Data Structures

### TmuxSession

Represents a tmux session.

```typescript
interface TmuxSession {
  name: string;       // Session name, e.g., "swarm_1704067200000"
  windows: number;    // Number of windows in session
  created: string;    // Creation timestamp from tmux
  attached: boolean;  // Whether a client is currently attached
}
```

**Example**:
```json
{
  "name": "swarm_1704067200000",
  "windows": 1,
  "created": "1704067200",
  "attached": false
}
```

### TmuxPane

Represents a pane within a tmux window.

```typescript
interface TmuxPane {
  id: string;           // Stable identifier, format: "%{number}"
  index: number;        // Position index (0-based), changes with layout
  active: boolean;      // True if this pane has focus
  width: number;        // Width in terminal columns
  height: number;       // Height in terminal lines
  currentPath: string;  // Current working directory
  title?: string;       // User-set pane title
}
```

**Example**:
```json
{
  "id": "%0",
  "index": 0,
  "active": true,
  "width": 120,
  "height": 40,
  "currentPath": "/home/user/project",
  "title": "researcher"
}
```

### TmuxError

Typed error for tmux operations.

```typescript
interface TmuxError extends Error {
  code: TmuxErrorCode;  // Categorized error type
  details?: string;     // Additional context (stderr, etc.)
}

type TmuxErrorCode =
  | 'SESSION_EXISTS'      // Attempted to create existing session
  | 'SESSION_NOT_FOUND'   // Session doesn't exist
  | 'PANE_NOT_FOUND'      // Pane ID/index doesn't exist
  | 'TMUX_NOT_RUNNING'    // tmux server not running
  | 'COMMAND_FAILED';     // General command failure
```

### Result Type (from types.ts)

```typescript
type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

function ok<T>(value: T): Result<T, never>;
function err<E>(error: E): Result<never, E>;
```

---

## 5. Detailed Behavior Specifications

### Availability Functions

#### `isTmuxAvailable(): Promise<boolean>`

**Purpose**: Check if tmux is installed and executable.

**Behavior**:
1. Execute `tmux -V` with output suppressed
2. Return `true` if exit code is 0
3. Return `false` if command fails or isn't found

**Use Case**: Pre-flight check before starting a swarm

#### `getTmuxVersion(): Promise<string | null>`

**Purpose**: Get tmux version string.

**Behavior**:
1. Execute `tmux -V`
2. Return trimmed output (e.g., "tmux 3.3a")
3. Return `null` if command fails

#### `isTmuxServerRunning(): Promise<boolean>`

**Purpose**: Check if tmux server daemon is running.

**Behavior**:
1. Execute `tmux list-sessions`
2. Return `true` if command succeeds (even with empty output)
3. Return `false` if "no server running" error

**Note**: First session creation starts the server automatically

---

### Session Management Functions

#### `createSession(name: string): Promise<Result<void, TmuxError>>`

**Purpose**: Create a new detached tmux session.

**Behavior**:
1. Check if session already exists via `listSessions()`
2. If exists, return error with code `SESSION_EXISTS`
3. Execute: `tmux new-session -d -s {name}`
4. Return `ok(undefined)` on success

**Session Name Conventions**:
- Swarm sessions use format: `swarm_{sessionId}`
- sessionId is provided by the orchestrator (not generated here)
- Name must not contain spaces or special characters

**Side Effects**: Creates tmux session with one window and one pane

#### `killSession(name: string): Promise<Result<void, TmuxError>>`

**Purpose**: Destroy a tmux session and all its panes.

**Behavior**:
1. Execute: `tmux kill-session -t {name}`
2. If "can't find session" error, return `ok(undefined)` (idempotent)
3. If "no server running" error, return `ok(undefined)` (already gone)
4. Return `ok(undefined)` on success
5. Return error for other failures

**Side Effects**: Kills all processes in all panes of the session

#### `listSessions(): Promise<TmuxSession[]>`

**Purpose**: Get all tmux sessions.

**Behavior**:
1. Execute: `tmux list-sessions -F '#{session_name}|#{session_windows}|#{session_created}|#{session_attached}'`
2. Parse pipe-delimited output into `TmuxSession` objects
3. Return empty array if no sessions or no server

**Output Format**: One session per line, fields separated by `|`

#### `sessionExists(name: string): Promise<boolean>`

**Purpose**: Check if a specific session exists.

**Behavior**: Calls `listSessions()` and checks if name is in list

#### `listSwarmSessions(): Promise<TmuxSession[]>`

**Purpose**: Get only swarm sessions (prefix filter).

**Behavior**: Returns sessions where `name.startsWith('swarm_')`

#### `getSession(name: string): Promise<TmuxSession | null>`

**Purpose**: Get specific session info.

**Behavior**: Returns matching session or `null` if not found

---

### Pane Management Functions

#### `createPane(sessionName: string, options?: CreatePaneOptions): Promise<Result<string, TmuxError>>`

**Purpose**: Create a new pane by splitting an existing one.

**Behavior**:
1. Determine split direction: `-v` for vertical, `-h` for horizontal (default)
2. If `options.size` provided, include `-p {size}` for percentage
3. Execute: `tmux split-window {flags} -t {sessionName}`
4. Get new pane ID: `tmux display-message -p '#{pane_id}'`
5. If `options.name` provided, set title: `tmux select-pane -t {sessionName} -T {name}`
6. Return pane ID string (e.g., "%1")

**Layout Impact**: New pane takes space from currently focused pane

#### `createPaneGrid(sessionName: string, count: number): Promise<Result<string[], TmuxError>>`

**Purpose**: Create multiple panes in a balanced layout.

**Behavior**:
1. Get initial pane ID (pane that exists after session creation)
2. Add to result array
3. For i from 1 to count-1:
   - Alternate split direction (vertical for odd, horizontal for even)
   - Call `createPane()` with alternating direction
   - Add new pane ID to result
4. Apply tiled layout: `tmux select-layout -t {sessionName} tiled`
5. Return array of all pane IDs

**Layout Strategy**: Alternating splits + tiled layout produces balanced grid

#### `listPanes(sessionName: string): Promise<TmuxPane[]>`

**Purpose**: Get all panes in a session.

**Behavior**:
1. Execute: `tmux list-panes -t {sessionName} -F '{format}'`
2. Format includes: `#{pane_id}|#{pane_index}|#{pane_active}|#{pane_width}|#{pane_height}|#{pane_current_path}|#{pane_title}`
3. Parse each line into `TmuxPane` object
4. Return empty array if session doesn't exist

#### `getPane(sessionName: string, paneIdOrIndex: string | number): Promise<TmuxPane | null>`

**Purpose**: Get specific pane info.

**Behavior**:
- If `paneIdOrIndex` is number: Match by `index`
- If string: Match by `id`
- Return `null` if not found

#### `selectPane(sessionName: string, paneId: string): Promise<Result<void, TmuxError>>`

**Purpose**: Focus a specific pane.

**Behavior**: Execute `tmux select-pane -t {sessionName}:{paneId}`

#### `killPane(sessionName: string, paneId: string): Promise<Result<void, TmuxError>>`

**Purpose**: Close a specific pane.

**Behavior**: Execute `tmux kill-pane -t {sessionName}:{paneId}`

**Side Effects**: Process in pane receives SIGHUP

---

### Command Execution Functions

#### `sendKeys(sessionName: string, paneId: string, text: string, options?: SendKeysOptions): Promise<Result<void, TmuxError>>`

**Purpose**: Send keystrokes to a pane.

**Behavior**:
1. Build target: `{sessionName}:{paneId}`
2. If `options.literal` (default: false):
   - Execute: `tmux send-keys -t {target} -l {text}`
   - Literal mode: text is sent character-by-character
3. Else:
   - Execute: `tmux send-keys -t {target} {text}`
   - Allows special keys like `C-c`, `Enter`, `Escape`
4. If `options.enter` (default: true):
   - Execute: `tmux send-keys -t {target} Enter`

**Special Keys** (when not literal):
- `Enter`, `Tab`, `Escape`
- `C-c` (Ctrl+C), `C-d` (Ctrl+D), `C-z` (Ctrl+Z)
- `Up`, `Down`, `Left`, `Right`

#### `runCommand(sessionName: string, paneId: string, command: string): Promise<Result<void, TmuxError>>`

**Purpose**: Send a command as literal text with Enter.

**Behavior**: Calls `sendKeys()` with `{ enter: true, literal: true }`

**Use Case**: Safely send shell commands without special key interpretation

#### `sendInterrupt(sessionName: string, paneId: string): Promise<Result<void, TmuxError>>`

**Purpose**: Send Ctrl+C to interrupt running process.

**Behavior**: Execute `tmux send-keys -t {target} C-c`

#### `clearPane(sessionName: string, paneId: string): Promise<Result<void, TmuxError>>`

**Purpose**: Clear the pane screen.

**Behavior**: Calls `runCommand()` with "clear"

---

### Output Capture Functions

#### `capturePane(sessionName: string, paneId: string, options?: CaptureOptions): Promise<Result<string, TmuxError>>`

**Purpose**: Read content from a pane's screen buffer.

**Behavior**:
1. Build target: `{sessionName}:{paneId}`
2. Build command based on options:
   - If `startLine` and `endLine`: `-S {startLine} -E {endLine}`
   - Else: `-S -{lines}` (last N lines from history)
3. If `options.escape`: Add `-e` flag for ANSI codes
4. Execute: `tmux capture-pane -t {target} -p {flags}`
5. Return captured text

**Line Numbering**:
- Positive numbers: absolute line in buffer
- Negative numbers: relative to current screen
- `-S 0 -E -1`: Entire history up to current line

**Output**: Plain text, optionally with ANSI escape sequences

#### `capturePaneHistory(sessionName: string, paneId: string): Promise<Result<string, TmuxError>>`

**Purpose**: Capture entire scroll buffer.

**Behavior**: Calls `capturePane()` with `{ startLine: 0, endLine: -1 }`

**Note**: History size depends on tmux `history-limit` setting (default: 2000 lines)

#### `waitForPattern(sessionName: string, paneId: string, pattern: RegExp, options?: WaitOptions): Promise<Result<string, TmuxError>>`

**Purpose**: Poll pane until pattern appears in output.

**Algorithm**:
```
startTime = now()
while (now() - startTime < timeoutMs):
    result = capturePane(sessionName, paneId, { lines: options.lines })
    if result.ok AND pattern.test(result.value):
        return ok(result.value)
    sleep(intervalMs)
return err(TmuxError with code 'COMMAND_FAILED')
```

**Default Values**:
- `timeoutMs`: 60000 (1 minute)
- `intervalMs`: 1000 (1 second)
- `lines`: 50

**Returns**: Captured output when pattern matches, or error on timeout

#### `waitForPrompt(sessionName: string, paneId: string, options?: WaitPromptOptions): Promise<Result<void, TmuxError>>`

**Purpose**: Wait for shell prompt to appear (command completed).

**Default Pattern**: `/[$#>%]\s*$/m` - matches common shell prompts

**Behavior**: Calls `waitForPattern()` with prompt pattern, returns `ok(undefined)` on match

---

### Claude Code Helper Functions

#### `startClaudeCode(sessionName: string, paneId: string, options?: ClaudeCodeOptions): Promise<Result<void, TmuxError>>`

**Purpose**: Start Claude Code CLI in a pane.

**Behavior**:
1. If `options.workdir`:
   - Send: `cd {workdir}`
   - Wait 500ms for directory change
2. Build command: `claude`
3. If `options.resume`: Append ` --resume`
4. If `options.initialPrompt`:
   - Escape quotes in prompt
   - Append ` -p "{escapedPrompt}"`
5. Execute command via `runCommand()`

**Quote Escaping**: Replace `"` with `\"`

#### `sendToClaudeCode(sessionName: string, paneId: string, message: string): Promise<Result<void, TmuxError>>`

**Purpose**: Send a message to running Claude Code.

**Behavior**: Calls `sendKeys()` with `{ enter: true, literal: true }`

**Assumption**: Claude Code is running and waiting for input

#### `isClaudeCodeRunning(sessionName: string, paneId: string): Promise<boolean>`

**Purpose**: Heuristic check if Claude Code appears to be running.

**Behavior**:
1. Capture last 20 lines from pane
2. Check for Claude Code indicators:
   - `/claude/i` or `/anthropic/i` text
   - Box-drawing characters `╭─`
   - Status indicators `[...]`
   - `Human:` or `Assistant:` prompts
3. Return `true` if any indicator matches

**Note**: This is heuristic, not definitive

---

### Layout Management Functions

#### `applyLayout(sessionName: string, layout: TmuxLayout): Promise<Result<void, TmuxError>>`

**Purpose**: Apply a predefined layout to all panes.

**Layouts**:
| Layout | Description |
|--------|-------------|
| `tiled` | Equal-sized grid, balanced |
| `even-horizontal` | Side-by-side, equal width |
| `even-vertical` | Stacked, equal height |
| `main-horizontal` | One large at top, rest below |
| `main-vertical` | One large at left, rest at right |

**Behavior**: Execute `tmux select-layout -t {sessionName} {layout}`

#### `resizePane(sessionName: string, paneId: string, options: ResizeOptions): Promise<Result<void, TmuxError>>`

**Purpose**: Change pane dimensions.

**Behavior**:
- If `options.width`: `tmux resize-pane -t {target} -x {width}`
- If `options.height`: `tmux resize-pane -t {target} -y {height}`
- If `options.direction` and `options.amount`: `tmux resize-pane -t {target} -{direction} {amount}`

---

### Session Attachment Functions

#### `attachSession(sessionName: string): Promise<void>`

**Purpose**: Attach terminal to session (for user interaction).

**Behavior**: Execute `tmux attach -t {sessionName}`

**Warning**: This replaces the current terminal with tmux. Typically used as final action.

#### `getAttachCommand(sessionName: string): string`

**Purpose**: Get the shell command to attach (for display to user).

**Returns**: `tmux attach -t {sessionName}`

---

### Cleanup Functions

#### `killAllSwarmSessions(): Promise<void>`

**Purpose**: Destroy all swarm sessions.

**Behavior**:
1. Get all swarm sessions via `listSwarmSessions()`
2. For each session, call `killSession()`

**Use Case**: Clean shutdown, testing cleanup

#### `cleanupOrphanedSessions(maxAgeMs?: number): Promise<number>`

**Purpose**: Remove old swarm sessions.

**Default `maxAgeMs`**: 86400000 (24 hours)

**Behavior**:
1. Get all swarm sessions
2. Parse timestamp from session name (`swarm_{timestamp}`)
3. If `Date.now() - timestamp > maxAgeMs`, kill session
4. Return count of killed sessions

**Use Case**: Cleanup after crashes, daily maintenance

---

## 6. Internal Architecture

### Module Organization

```
src/tmux-manager.ts
├── Types & Constants
│   ├── TmuxSession, TmuxPane, TmuxError interfaces
│   └── TmuxErrorCode, TmuxLayout types
│
├── Internal Helpers
│   ├── createTmuxError(code, message, details): TmuxError
│   └── parseSessionLine(line): TmuxSession
│   └── parsePaneLine(line): TmuxPane
│
├── Availability Functions (exported)
│   ├── isTmuxAvailable()
│   ├── getTmuxVersion()
│   └── isTmuxServerRunning()
│
├── Session Management (exported)
│   ├── createSession()
│   ├── killSession()
│   ├── listSessions()
│   ├── sessionExists()
│   ├── listSwarmSessions()
│   └── getSession()
│
├── Pane Management (exported)
│   ├── createPane()
│   ├── createPaneGrid()
│   ├── listPanes()
│   ├── getPane()
│   ├── selectPane()
│   └── killPane()
│
├── Command Execution (exported)
│   ├── sendKeys()
│   ├── runCommand()
│   ├── sendInterrupt()
│   └── clearPane()
│
├── Output Capture (exported)
│   ├── capturePane()
│   ├── capturePaneHistory()
│   ├── waitForPattern()
│   └── waitForPrompt()
│
├── Claude Code Helpers (exported)
│   ├── startClaudeCode()
│   ├── sendToClaudeCode()
│   └── isClaudeCodeRunning()
│
├── Layout Management (exported)
│   ├── applyLayout()
│   └── resizePane()
│
├── Attachment (exported)
│   ├── attachSession()
│   └── getAttachCommand()
│
└── Cleanup (exported)
    ├── killAllSwarmSessions()
    └── cleanupOrphanedSessions()
```

### Internal Helper Functions

#### `createTmuxError(code: TmuxErrorCode, message: string, details?: string): TmuxError`

Creates a typed error object with `code`, `message`, and optional `details`.

#### `parseSessionLine(line: string): TmuxSession`

Parses tmux format string `name|windows|created|attached` into `TmuxSession`.

#### `parsePaneLine(line: string): TmuxPane`

Parses tmux format string `id|index|active|width|height|path|title` into `TmuxPane`.

### Shell Command Execution

Uses Bun's `$` template literal for shell execution:

```typescript
// Example pattern
const result = await $`tmux list-sessions -F '#{session_name}'`.text();
```

**Benefits**:
- Automatic escaping of interpolated values
- Promise-based with `.text()`, `.quiet()`, etc.
- Access to exit codes and stderr

---

## 7. Algorithm Descriptions

### Pane Grid Creation Algorithm

**Problem**: Create N balanced panes from a session with one initial pane.

**Approach**: Alternating splits followed by tiled layout.

```
Input: count (number of panes needed)
Output: array of pane IDs

1. Get initial pane ID (exists after session creation)
2. Add to result array
3. For i = 1 to count - 1:
   a. direction = (i % 2 == 1) ? vertical : horizontal
   b. Create pane with split in 'direction'
   c. Add new pane ID to result
4. Apply 'tiled' layout to balance all panes
5. Return result array
```

**Why Alternating**: Creates a mix of vertical and horizontal splits before tiling, which produces a more balanced grid than all-horizontal or all-vertical.

**Example for 4 panes**:
```
Initial:   After 1st split:   After 2nd:       After 3rd:       After tiled:
┌───────┐  ┌───────┬───────┐  ┌───────┬───────┐  ┌───────┬───────┐  ┌───┬───┐
│   0   │  │   0   │   1   │  │   0   │   1   │  │   0   │   1   │  │ 0 │ 1 │
│       │  │       │       │  ├───────┤       │  ├───────┼───────┤  ├───┼───┤
│       │  │       │       │  │   2   │       │  │   2   │   3   │  │ 2 │ 3 │
└───────┘  └───────┴───────┘  └───────┴───────┘  └───────┴───────┘  └───┴───┘
```

### Pattern Waiting Algorithm

**Problem**: Detect when expected output appears in pane.

```
Input: sessionName, paneId, pattern (RegExp), options
Output: Result with captured output or timeout error

startTime = now()
timeout = options.timeoutMs ?? 60000
interval = options.intervalMs ?? 1000
lines = options.lines ?? 50

loop:
    if (now() - startTime >= timeout):
        return err(TmuxError: timeout)

    capture = capturePane(sessionName, paneId, { lines })
    if not capture.ok:
        return capture  // Propagate error

    if pattern.test(capture.value):
        return ok(capture.value)

    sleep(interval)
    goto loop
```

**Complexity**: O(timeout / interval) capture operations

### Session Age Cleanup Algorithm

**Problem**: Remove swarm sessions older than threshold.

```
Input: maxAgeMs (default: 24 hours)
Output: count of removed sessions

count = 0
sessions = listSwarmSessions()
now = Date.now()

for session in sessions:
    // Parse timestamp from "swarm_{timestamp}"
    match = session.name.match(/swarm_(\d+)/)
    if match:
        created = parseInt(match[1])
        if (now - created) > maxAgeMs:
            killSession(session.name)
            count++

return count
```

---

## 8. Error Handling

### Error Categories

| Code | Meaning | Recovery |
|------|---------|----------|
| `SESSION_EXISTS` | Session name already taken | Use different name or kill existing |
| `SESSION_NOT_FOUND` | Session doesn't exist | Check session name, verify server |
| `PANE_NOT_FOUND` | Invalid pane ID/index | Re-list panes, use valid ID |
| `TMUX_NOT_RUNNING` | No tmux server | Create a session to start server |
| `COMMAND_FAILED` | General failure | Check stderr in `details` |

### Error Recovery Strategies

**Session Already Exists**:
1. Caller can kill existing session first
2. Or append unique suffix to name
3. For swarm, timestamp ensures uniqueness

**Session Not Found (during kill)**:
- Return `ok(undefined)` - session is already gone
- Idempotent cleanup is safe

**Tmux Not Available**:
- Check `isTmuxAvailable()` at startup
- Fail fast with clear error message
- Don't attempt operations without tmux

### Graceful Degradation

| Scenario | Behavior |
|----------|----------|
| tmux not installed | All functions fail fast with clear message |
| Server crashes mid-session | Sessions are gone, new session starts fresh |
| Pane process exits | Pane closes, can be detected via `listPanes()` |
| Capture during rapid output | May miss content between captures |

---

## 9. Edge Cases & Boundary Conditions

### Session Names

| Input | Behavior |
|-------|----------|
| Empty string | tmux rejects, command fails |
| Contains spaces | Unexpected behavior, avoid |
| Contains `:` | Conflicts with target format |
| Very long name | OS-dependent limit |
| Unicode characters | tmux 2.1+ supports, earlier versions may not |

**Recommendation**: Use `swarm_{sessionId}` format only, where sessionId is provided by orchestrator

### Pane Operations

| Scenario | Behavior |
|----------|----------|
| Kill last pane in session | Session is destroyed |
| Split pane in closed session | Error |
| Send keys to nonexistent pane | Error |
| Capture empty pane | Returns empty string |

### Output Capture

| Scenario | Behavior |
|----------|----------|
| Pane has no history | Returns current screen only |
| Request more lines than exist | Returns what's available |
| ANSI sequences in output | Stripped unless `escape: true` |
| Very long lines | May be wrapped based on pane width |

### Concurrent Operations

| Scenario | Risk | Mitigation |
|----------|------|------------|
| Two processes create same session | Race condition | Use timestamps for uniqueness |
| Capture during heavy output | Missing content | Multiple captures, look for markers |
| Send keys while pane is busy | Keys queued | Acceptable, tmux handles queuing |

---

## 10. Integration Points

### Orchestrator Integration

The orchestrator uses the tmux manager to:

1. **Session Lifecycle**:
   ```
   createSession("swarm_{timestamp}")
   // ... work ...
   killSession(sessionName)
   ```

2. **Agent Spawning**:
   ```
   createPaneGrid(sessionName, agentCount)
   for each (pane, agent):
       startClaudeCode(sessionName, paneId, { workdir, resume: true })
   ```

3. **Monitoring**:
   ```
   while not complete:
       for each agent:
           output = capturePane(sessionName, paneId)
           // analyze output for completion signals
   ```

### Worktree Manager Integration

Combined with worktree manager:
```
worktreePath = worktree.createWorktree(role)
tmux.startClaudeCode(session, pane, { workdir: worktreePath })
```

### CLI Integration

User-facing commands:
```
bun swarm.ts attach     → attachSession(getSwarmSession())
bun swarm.ts status     → listSwarmSessions()
bun swarm.ts logs agent → capturePane(session, agentPane)
bun swarm.ts stop       → killAllSwarmSessions()
```

---

## 11. File System & External Effects

### External Commands Executed

| Command | Purpose | Side Effects |
|---------|---------|--------------|
| `tmux new-session -d -s {name}` | Create session | Starts tmux server if needed |
| `tmux kill-session -t {name}` | Destroy session | Kills processes in panes |
| `tmux split-window` | Create pane | Spawns new shell |
| `tmux send-keys` | Type into pane | Affects running process |
| `tmux capture-pane` | Read output | None (read-only) |

### tmux Server

- Single tmux server process manages all sessions
- Started automatically on first session creation
- Persists until all sessions are killed
- No explicit cleanup needed

### Process Signals

| Action | Signal Sent |
|--------|-------------|
| `killSession()` | SIGHUP to all processes |
| `killPane()` | SIGHUP to pane process |
| `sendInterrupt()` | SIGINT (like Ctrl+C) |

---

## 12. Testing Strategy

### Unit Tests

**Availability Tests**:
- `isTmuxAvailable()` returns true when tmux is installed
- `getTmuxVersion()` returns version string matching `/tmux \d+\.\d+/`

**Session Tests**:
- Create session, verify it exists, kill it, verify gone
- Create duplicate session fails with `SESSION_EXISTS`
- Kill nonexistent session is idempotent (no error)
- List sessions returns empty when none exist

**Pane Tests**:
- Create pane increases pane count
- Create vertical vs horizontal split (visual verification)
- Create pane grid with 4 produces 4 panes
- List panes returns correct structure

**Command Tests**:
- Send keys appears in pane (echo test)
- Run command executes (create file, verify exists)
- Capture pane returns expected output

**Pattern Waiting Tests**:
- Immediate match returns quickly
- Delayed match (output arrives mid-poll) succeeds
- Timeout when pattern never appears

### Integration Tests

- Full lifecycle: create session → create panes → send commands → capture → cleanup
- Start Claude Code (mock or real) and detect running state
- Multiple concurrent sessions don't interfere

### Test Fixtures

```typescript
// Standard test session name
const testSession = 'test_swarm_jest';

// Cleanup helper for afterEach
async function cleanupTestSession() {
  await killSession(testSession);
}

// Unique marker for output tests
const marker = `MARKER_${Date.now()}`;
```

### Manual Verification

```bash
# Create session manually
bun -e "
import { createSession, createPaneGrid, listPanes } from './src/tmux-manager';
await createSession('manual_test');
await createPaneGrid('manual_test', 4);
console.log(await listPanes('manual_test'));
console.log('Attach with: tmux attach -t manual_test');
"

# Verify in tmux
tmux attach -t manual_test
# Use Ctrl+B, arrow keys to navigate panes
# Ctrl+B, D to detach

# Cleanup
tmux kill-session -t manual_test
```

---

## 13. Configuration

### Configurable Values

| Value | Default | Location | Purpose |
|-------|---------|----------|---------|
| Session prefix | `swarm_` | Constant | Identifies swarm sessions |
| Capture lines | 100 | `CaptureOptions.lines` | Default history to read |
| Wait timeout | 60000ms | `WaitOptions.timeoutMs` | Pattern wait timeout |
| Wait interval | 1000ms | `WaitOptions.intervalMs` | Pattern check frequency |
| Prompt pattern | `/[$#>%]\s*$/m` | `WaitPromptOptions.promptPattern` | Shell prompt detection |
| Orphan age | 24 hours | `cleanupOrphanedSessions()` | When to clean old sessions |

### tmux Configuration

These tmux settings affect behavior:

| Setting | Default | Impact |
|---------|---------|--------|
| `history-limit` | 2000 | Lines available for capture |
| `mouse` | off | Whether mouse works in attached session |
| `status` | on | Status bar visibility |

**Note**: These are user tmux settings, not controlled by our code

---

## 14. Open Questions & Decisions

### Resolved Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Shell execution | Bun's `$` | Built-in, clean syntax, async |
| Error handling | Result type | Explicit, type-safe, composable |
| Pane identification | IDs over indices | Stable across layout changes |
| Session naming | Timestamp suffix | Unique, sortable, cleanup-friendly |
| Wait strategy | Polling | Simple, portable, predictable |

### Open Questions

1. **Session recovery**: Should we support reconnecting to orphaned sessions?
2. **Pane titles**: Should we enforce/require pane titles for all agents?
3. **Output streaming**: Would file-based output capture be more reliable?
4. **Multi-window**: Should we support multiple windows per session?
5. **tmux config**: Should we set specific tmux options for swarm sessions?

### Trade-offs Considered

**Polling vs Webhooks/Events**:
- Polling: Simple, works with any tmux version
- Events: tmux control mode is complex, version-dependent
- **Chose polling** for reliability and simplicity

**Pane IDs vs Named Targets**:
- IDs: Auto-assigned, unique, stable
- Names: User-friendly but require management
- **Chose IDs** with optional titles for clarity

**Shell vs Native tmux Integration**:
- Shell commands: Portable, well-documented
- Native (libtmux, etc.): Faster but more dependencies
- **Chose shell** for zero dependencies

---

## 15. Tmux Quick Reference

### Session Commands

```bash
tmux new-session -d -s NAME      # Create detached session
tmux kill-session -t NAME        # Kill session
tmux ls                          # List sessions
tmux attach -t NAME              # Attach to session
```

### Pane Commands

```bash
tmux split-window -h             # Split horizontally
tmux split-window -v             # Split vertically
tmux split-window -p 30          # Split with 30% size
tmux select-pane -t PANE         # Select pane
tmux kill-pane -t PANE           # Kill pane
tmux list-panes -F FORMAT        # List with format
```

### Sending Commands

```bash
tmux send-keys -t TARGET "cmd" Enter    # Send command
tmux send-keys -t TARGET -l "text"      # Send literal text
tmux send-keys -t TARGET C-c            # Send Ctrl+C
```

### Capturing Output

```bash
tmux capture-pane -t TARGET -p          # Print pane content
tmux capture-pane -t TARGET -p -S -100  # Last 100 lines
tmux capture-pane -t TARGET -p -S 0 -E -1  # All history
```

### Layout Commands

```bash
tmux select-layout tiled                # Balanced grid
tmux select-layout even-horizontal      # Side by side
tmux select-layout main-vertical        # One large + small ones
```

### Target Format

```
session:window.pane
session:pane_id          # e.g., swarm_123:%0
session:pane_index       # e.g., swarm_123:0
```

### Inside tmux (Prefix: Ctrl+B)

```
Ctrl+B, D     # Detach from session
Ctrl+B, [     # Enter scroll mode (q to exit)
Ctrl+B, %     # Split horizontal
Ctrl+B, "     # Split vertical
Ctrl+B, o     # Cycle to next pane
Ctrl+B, x     # Kill current pane
```

---

## Next Step

After implementing the tmux manager, proceed to **Step 5: Worktree Manager** which will handle git worktree creation for agent isolation.
