# Step 3: Message Bus (File-Based IPC)

## 1. Overview & Purpose

### What This Component Does

The Message Bus provides file-based inter-process communication between Claude Code agents running in separate tmux panes. It enables agents to send structured messages to each other through a simple inbox/outbox file system that is both human-readable and debuggable.

### Why It Exists

Claude Code instances run as independent processes without shared memory. They need a communication mechanism that:
- Works without sockets, ports, or complex IPC
- Is debuggable (humans can inspect messages with `cat`)
- Survives process crashes (file system is persistent)
- Is simple enough for Claude Code to read/write via standard file operations
- Supports async message passing (agents don't need to be synchronized)

### How It Fits Into the System

```
┌─────────────────────────────────────────────────────────────────┐
│                          ORCHESTRATOR                            │
│  (Coordinates agents, routes messages, monitors progress)        │
└─────────────────────────────────────────────────────────────────┘
           │                    │                     │
           ▼                    ▼                     ▼
    ┌─────────────┐      ┌─────────────┐      ┌─────────────┐
    │  RESEARCHER │      │  DEVELOPER  │      │   REVIEWER  │
    │  (tmux pane)│      │  (tmux pane)│      │  (tmux pane)│
    └─────────────┘      └─────────────┘      └─────────────┘
           │                    │                     │
           └────────────────────┼─────────────────────┘
                                │
                                ▼
    ┌─────────────────────────────────────────────────────────────┐
    │                       MESSAGE BUS                            │
    │  .swarm/messages/inbox/{agent}.json   (incoming messages)    │
    │  .swarm/messages/outbox/{agent}.json  (outgoing messages)    │
    └─────────────────────────────────────────────────────────────┘
                                │
                                ▼
    ┌─────────────────────────────────────────────────────────────┐
    │                    DATABASE LAYER                            │
    │        (Optional persistence for message history)            │
    └─────────────────────────────────────────────────────────────┘
```

The Message Bus is used by:
- **Orchestrator**: To send tasks to agents and receive results
- **Agents**: To communicate findings, ask questions, and report status
- **Workflows**: To route messages according to workflow stage rules

---

## 2. Prerequisites & Dependencies

### External Dependencies

| Dependency | Purpose | Version |
|------------|---------|---------|
| Bun | Runtime with native file system APIs | 1.0+ |
| Node.js `fs` module | File operations (via Bun compatibility) | N/A |

### Internal Dependencies

| Module | Required Functions | Purpose |
|--------|-------------------|---------|
| `src/types.ts` | `AgentMessage`, `MessageType`, `Priority`, `generateId`, `now` | Type definitions and utilities |
| `src/db.ts` | `createMessage`, `getSessionMessages` | Optional database persistence |

### Preconditions

- Step 1 (Project Scaffolding) completed with `src/types.ts` available
- Step 2 (Database Layer) completed if using message persistence
- Write access to `.swarm/` directory in project root

---

## 3. Public API Design

### Module Exports

```typescript
// src/message-bus.ts

// Directory Management
export function ensureMessageDirs(): void;
export function initializeAgentQueues(): void;
export function clearAllQueues(): void;

// Message Validation
export function validateMessage(msg: unknown): msg is AgentMessage;
export function isValidAgent(agent: string): agent is ValidAgent;

// Message Creation
export function createMessage(input: SendMessageInput): AgentMessage;

// Inbox Operations
export function getInboxPath(agent: string): string;
export function readInbox(agent: string): AgentMessage[];
export function addToInbox(agent: string, message: AgentMessage): void;
export function clearInbox(agent: string): void;
export function removeFromInbox(agent: string, messageId: string): boolean;
export function getUnreadInbox(agent: string): AgentMessage[];
export function getInboxByType(agent: string, type: MessageType): AgentMessage[];
export function getInboxByPriority(agent: string, minPriority: Priority): AgentMessage[];

// Outbox Operations
export function getOutboxPath(agent: string): string;
export function readOutbox(agent: string): AgentMessage[];
export function addToOutbox(agent: string, message: AgentMessage): void;
export function clearOutbox(agent: string): void;
export function getNewOutboxMessages(agent: string, since: string): AgentMessage[];

// Main Messaging API
export function sendMessage(input: SendMessageInput, options?: SendOptions): AgentMessage;
export function broadcastMessage(from: string, type: MessageType, content: MessageContent, options?: SendOptions): AgentMessage;

// Convenience Functions
export function sendTask(from: string, to: string, subject: string, body: string, options?: SendOptions & { priority?: Priority; threadId?: string }): AgentMessage;
export function sendResult(from: string, to: string, subject: string, body: string, threadId: string, options?: SendOptions): AgentMessage;
export function sendStatus(from: string, status: StatusType, summary: string, options?: SendOptions): AgentMessage;
export function sendQuestion(from: string, to: string, question: string, context: string, threadId?: string, options?: SendOptions): AgentMessage;
export function sendFeedback(from: string, to: string, subject: string, feedback: string, verdict: Verdict, threadId?: string, options?: SendOptions): AgentMessage;

// Polling Utilities
export function pollInbox(agent: string, options?: PollOptions): Promise<AgentMessage | null>;
export function pollForType(agent: string, type: MessageType, options?: PollOptions): Promise<AgentMessage | null>;
export function pollForThreadResponse(agent: string, threadId: string, options?: PollOptions): Promise<AgentMessage | null>;
export function pollForCompletion(agent: string, options?: PollOptions): Promise<AgentMessage | null>;

// Thread Management
export function getThreadHistory(sessionId: string, threadId: string): AgentMessage[];
export function createThreadId(): string;

// Debug Utilities
export function getQueueSummary(): Record<string, { inbox: number; outbox: number }>;
export function dumpAllMessages(): { inbox: Record<string, AgentMessage[]>; outbox: Record<string, AgentMessage[]> };
```

### Rationale for API Shape

- **Separate inbox/outbox**: Clear ownership model; each agent writes to their outbox, reads from their inbox
- **Atomic operations**: Individual functions for each operation to prevent partial failures
- **Convenience wrappers**: `sendTask`, `sendStatus`, etc. reduce boilerplate for common patterns
- **Polling over events**: Simpler than file watching; Claude Code agents naturally work in polling loops
- **Optional persistence**: Database storage is opt-in to keep core messaging lightweight

---

## 4. Data Structures

### Core Types (defined in `src/types.ts`)

```typescript
// Message Types - categorizes the purpose of a message
type MessageType =
  | 'task'      // Work assignment from orchestrator or another agent
  | 'result'    // Completed work output
  | 'question'  // Request for clarification
  | 'feedback'  // Review comments or suggestions
  | 'status'    // Progress update or completion signal
  | 'finding'   // Research result from researcher agent
  | 'artifact'  // Code or document from developer agent
  | 'review'    // Review verdict from reviewer agent
  | 'design';   // Architecture proposal from architect agent

// Priority Levels - controls processing order
type Priority = 'critical' | 'high' | 'normal' | 'low';

// Status Types for status messages
type StatusType = 'starting' | 'in_progress' | 'complete' | 'error' | 'blocked';

// Review Verdicts
type Verdict = 'approved' | 'needs_revision' | 'rejected';

// Message Content Structure
interface MessageContent {
  subject: string;                    // Brief description (< 100 chars recommended)
  body: string;                       // Detailed content (markdown allowed)
  artifacts?: string[];               // File paths or inline content references
  metadata?: Record<string, unknown>; // Extensible key-value data
}

// Complete Message Structure
interface AgentMessage {
  id: string;               // UUID, unique across all messages
  timestamp: string;        // ISO8601 timestamp of creation
  from: string;            // Sender agent name
  to: string;              // Recipient agent name or "broadcast"
  type: MessageType;       // Message category
  priority: Priority;      // Processing priority
  content: MessageContent; // Message payload
  threadId?: string;       // Groups related messages in a conversation
  requiresResponse: boolean; // Whether sender expects a reply
  deadline?: string;       // ISO8601 deadline for time-sensitive tasks
}
```

### Input/Option Types

```typescript
// Input for creating and sending messages
interface SendMessageInput {
  from: string;
  to: string;
  type: MessageType;
  priority?: Priority;      // Default: 'normal'
  content: {
    subject: string;
    body: string;
    artifacts?: string[];
    metadata?: Record<string, unknown>;
  };
  threadId?: string;
  requiresResponse?: boolean; // Default: false
  deadline?: string;
  sessionId?: string;        // For database persistence (REQUIRED if persistToDb is true)
}

// Options for send operations
interface SendOptions {
  persistToDb?: boolean;    // Store in SQLite for history
  sessionId?: string;       // REQUIRED if persistToDb is true; provided by orchestrator
}

// Options for polling operations
interface PollOptions {
  intervalMs?: number;      // Polling frequency, default 5000ms
  timeoutMs?: number;       // Max wait time, default 300000ms (5 min)
  filter?: (msg: AgentMessage) => boolean; // Custom filter predicate
}
```

### Valid Agents Constant

```typescript
const VALID_AGENTS = ['researcher', 'developer', 'reviewer', 'architect', 'orchestrator'] as const;
type ValidAgent = typeof VALID_AGENTS[number];
```

### Example Message Data

Task assignment:
```json
{
  "id": "msg_abc123",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "from": "orchestrator",
  "to": "researcher",
  "type": "task",
  "priority": "high",
  "content": {
    "subject": "Research quantum error correction",
    "body": "Find the latest developments in quantum error correction for ML inference. Focus on papers from 2023-2024.",
    "metadata": {
      "maxSources": 5,
      "preferredDomains": ["arxiv.org", "nature.com"]
    }
  },
  "threadId": "thread_xyz789",
  "requiresResponse": true,
  "deadline": "2024-01-15T11:00:00.000Z"
}
```

Status update:
```json
{
  "id": "msg_def456",
  "timestamp": "2024-01-15T10:45:00.000Z",
  "from": "researcher",
  "to": "orchestrator",
  "type": "status",
  "priority": "normal",
  "content": {
    "subject": "Status: complete",
    "body": "Found 5 relevant papers with high confidence findings",
    "metadata": {
      "status": "complete",
      "findingsCount": 5
    }
  },
  "threadId": "thread_xyz789",
  "requiresResponse": false
}
```

---

## 5. Detailed Behavior Specifications

### Directory Management Functions

#### `ensureMessageDirs()`

**Purpose**: Creates the directory structure for message storage if it doesn't exist.

**Behavior**:
1. Creates `.swarm/messages/inbox/` directory recursively
2. Creates `.swarm/messages/outbox/` directory recursively
3. No-op if directories already exist
4. Throws if parent directory is not writable

**Side Effects**: Creates directories on filesystem

**Example**:
```
Before: .swarm/ (empty or doesn't exist)
After:  .swarm/messages/inbox/
        .swarm/messages/outbox/
```

#### `initializeAgentQueues()`

**Purpose**: Creates empty JSON array files for each agent's inbox and outbox.

**Behavior**:
1. Calls `ensureMessageDirs()` first
2. For each agent in `VALID_AGENTS`:
   - If `.swarm/messages/inbox/{agent}.json` doesn't exist, creates it with `[]`
   - If `.swarm/messages/outbox/{agent}.json` doesn't exist, creates it with `[]`
3. Does NOT overwrite existing files (preserves messages)

**Side Effects**: Creates up to 10 JSON files (5 agents x 2 queues)

#### `clearAllQueues()`

**Purpose**: Resets all message queues to empty arrays.

**Behavior**:
1. For each agent in `VALID_AGENTS`:
   - Writes `[]` to inbox file
   - Writes `[]` to outbox file
2. Does NOT delete files, just empties them

**Side Effects**: Truncates all queue files, messages are lost

---

### Message Validation Functions

#### `validateMessage(msg: unknown): msg is AgentMessage`

**Purpose**: Type guard that validates message structure.

**Validation Rules**:
| Field | Rule | Error if |
|-------|------|----------|
| `id` | Non-empty string | Missing, empty, or non-string |
| `timestamp` | Non-empty string | Missing, empty, or non-string |
| `from` | Non-empty string | Missing, empty, or non-string |
| `to` | Non-empty string | Missing, empty, or non-string |
| `type` | One of `MessageType` values | Not in allowed list |
| `priority` | One of `Priority` values | Not in allowed list |
| `content` | Object with `subject` and `body` strings | Missing or wrong shape |
| `requiresResponse` | Boolean | Not a boolean |

**Returns**: `true` if all validations pass, `false` otherwise

**Note**: Does NOT validate optional fields (`threadId`, `deadline`, `artifacts`, `metadata`)

#### `isValidAgent(agent: string): agent is ValidAgent`

**Purpose**: Checks if agent name is in the allowed list.

**Returns**: `true` if agent is one of: `researcher`, `developer`, `reviewer`, `architect`, `orchestrator`

---

### Message Creation

#### `createMessage(input: SendMessageInput): AgentMessage`

**Purpose**: Constructs a complete message object from input.

**Behavior**:
1. Generates new UUID for `id` using `generateId()` from types module
2. Sets `timestamp` to current ISO8601 time using `now()` from types module
3. Copies all required fields from input
4. Sets `priority` to input value or defaults to `'normal'`
5. Sets `requiresResponse` to input value or defaults to `false`
6. Copies optional fields if present

**Returns**: Complete `AgentMessage` ready for sending

**Does NOT**: Write to filesystem or validate recipient

---

### Inbox Operations

#### `readInbox(agent: string): AgentMessage[]`

**Purpose**: Reads all messages from an agent's inbox.

**Behavior**:
1. Constructs path: `.swarm/messages/inbox/{agent}.json`
2. If file doesn't exist, returns `[]`
3. Reads file content as UTF-8
4. Parses JSON, expects array
5. Filters array through `validateMessage()` - invalid entries are silently dropped
6. Returns array of valid messages

**Error Handling**:
- File not found: Returns `[]`
- JSON parse error: Logs warning, returns `[]`
- Invalid array: Logs warning, returns `[]`

**Side Effects**: None (read-only)

#### `addToInbox(agent: string, message: AgentMessage): void`

**Purpose**: Appends a message to an agent's inbox.

**Behavior**:
1. Reads current inbox contents
2. Appends new message to array
3. Writes updated array atomically (temp file + rename)

**Atomicity**: Uses write-to-temp-then-rename pattern to prevent corruption

#### `clearInbox(agent: string): void`

**Purpose**: Removes all messages from inbox.

**Behavior**: Writes `[]` to inbox file atomically

#### `removeFromInbox(agent: string, messageId: string): boolean`

**Purpose**: Removes a specific message by ID.

**Behavior**:
1. Reads current inbox
2. Finds message with matching `id`
3. If found: removes from array, writes back, returns `true`
4. If not found: returns `false` without modifying file

#### `getInboxByType(agent: string, type: MessageType): AgentMessage[]`

**Purpose**: Filters inbox to messages of a specific type.

**Returns**: Array of messages where `message.type === type`

#### `getInboxByPriority(agent: string, minPriority: Priority): AgentMessage[]`

**Purpose**: Filters inbox to messages at or above a priority level.

**Priority Ordering** (highest to lowest): `critical` > `high` > `normal` > `low`

**Example**: `getInboxByPriority('researcher', 'high')` returns messages with `critical` or `high` priority

---

### Message Sending

#### `sendMessage(input: SendMessageInput, options?: SendOptions): AgentMessage`

**Purpose**: Main API for sending messages between agents.

**Behavior**:
1. Creates message using `createMessage(input)`
2. Adds message to sender's outbox via `addToOutbox()`
3. Routes message to recipient(s):
   - If `to === 'broadcast'`: Adds to all agents' inboxes except sender
   - Otherwise: Adds to specific agent's inbox
4. If `options.persistToDb && options.sessionId`:
   - Calls `db.createMessage()` to store in SQLite
5. If `options.persistToDb` is true but `options.sessionId` is missing:
   - Throws error: "sessionId is required when persistToDb is true"
6. Returns the created message

**Validation**: When `persistToDb` is true, `sessionId` must be provided (generated by orchestrator)

**Threading**: Message `id` is unique; use `threadId` to group related messages

#### `broadcastMessage(from, type, content, options?): AgentMessage`

**Purpose**: Convenience wrapper for broadcasting to all agents.

**Behavior**: Calls `sendMessage()` with `to: 'broadcast'`

---

### Polling Utilities

#### `pollInbox(agent: string, options?: PollOptions): Promise<AgentMessage | null>`

**Purpose**: Waits for a message to appear in inbox.

**Algorithm**:
```
1. Record start time
2. Loop:
   a. Read inbox
   b. Apply filter function to each message
   c. If any message matches filter, return it
   d. If elapsed time > timeout, return null
   e. Sleep for interval milliseconds
   f. Repeat
```

**Default Options**:
- `intervalMs`: 5000 (check every 5 seconds)
- `timeoutMs`: 300000 (give up after 5 minutes)
- `filter`: `() => true` (any message matches)

**Returns**: First matching message, or `null` on timeout

#### `pollForCompletion(agent: string, options?): Promise<AgentMessage | null>`

**Purpose**: Waits for a completion status message.

**Filter**: Matches messages where:
- `type === 'status'`
- `content.metadata.status === 'complete'`

---

### Thread Management

#### `createThreadId(): string`

**Purpose**: Generates a unique thread identifier.

**Format**: `thread_{uuid}`

**Use Case**: Start a conversation thread, then pass `threadId` to related messages

#### `getThreadHistory(sessionId, threadId): AgentMessage[]`

**Purpose**: Retrieves all messages in a thread from database.

**Requires**: Database layer (Step 2) and `persistToDb` option used when sending

---

## 6. Internal Architecture

### Module Organization

```
src/message-bus.ts
├── Constants
│   ├── SWARM_DIR = '.swarm'
│   ├── MESSAGES_DIR = '.swarm/messages'
│   ├── INBOX_DIR = '.swarm/messages/inbox'
│   ├── OUTBOX_DIR = '.swarm/messages/outbox'
│   └── VALID_AGENTS = ['researcher', 'developer', ...]
│
├── Internal Functions
│   ├── readMessagesFile(path): AgentMessage[]
│   └── writeMessagesFile(path, messages): void
│
├── Directory Management (exported)
│   ├── ensureMessageDirs()
│   ├── initializeAgentQueues()
│   └── clearAllQueues()
│
├── Validation (exported)
│   ├── validateMessage()
│   └── isValidAgent()
│
├── Message Creation (exported)
│   └── createMessage()
│
├── Inbox Operations (exported)
│   └── [8 functions]
│
├── Outbox Operations (exported)
│   └── [4 functions]
│
├── Send API (exported)
│   ├── sendMessage()
│   ├── broadcastMessage()
│   └── [5 convenience functions]
│
├── Polling (exported)
│   └── [4 functions]
│
└── Debug (exported)
    ├── getQueueSummary()
    └── dumpAllMessages()
```

### Internal Functions

#### `readMessagesFile(filePath: string): AgentMessage[]`

**Purpose**: Low-level file read with validation.

**Steps**:
1. Check if file exists (return `[]` if not)
2. Read file content as UTF-8 string
3. Parse JSON (return `[]` on parse error)
4. Verify result is array (return `[]` if not)
5. Filter through `validateMessage()`
6. Return valid messages only

#### `writeMessagesFile(filePath: string, messages: AgentMessage[]): void`

**Purpose**: Atomic file write.

**Steps**:
1. Ensure parent directory exists
2. Generate temp path: `{filePath}.tmp.{timestamp}`
3. Write JSON to temp file with 2-space indentation
4. Rename temp file to target path (atomic on POSIX)
5. On failure: delete temp file, re-throw error

### Data Flow

```
sendMessage() called
        │
        ▼
createMessage() ──────────────► AgentMessage created with ID, timestamp
        │
        ▼
addToOutbox(from, msg) ───────► Updates sender's outbox file
        │
        ▼
Routing decision
        │
        ├── to === 'broadcast'
        │         │
        │         ▼
        │   For each agent (except sender):
        │         addToInbox(agent, msg)
        │
        └── to === specific agent
                  │
                  ▼
            addToInbox(to, msg)
        │
        ▼
Optional: db.createMessage() ─► SQLite persistence
        │
        ▼
Return message
```

---

## 7. Algorithm Descriptions

### Atomic File Write Algorithm

**Problem**: Concurrent reads during write can see partial content.

**Solution**: Write-to-temp-then-rename

```
1. Generate unique temp filename: "{target}.tmp.{timestamp}"
2. Write complete content to temp file
3. Call rename(temp, target)
   - On POSIX: atomic operation, readers see old or new, never partial
   - On Windows: mostly atomic, may fail if target is open
4. On any error: attempt to delete temp file (cleanup)
```

**Why This Works**: File system rename is atomic at the inode level. Readers either get the old file content or the new file content, never a mix.

### Priority Filtering Algorithm

**Problem**: Find messages at or above a given priority level.

**Priority Order** (index 0 = highest):
```
['critical', 'high', 'normal', 'low']
```

**Algorithm**:
```
1. Find index of minimum priority in order array
2. For each message:
   a. Find index of message's priority
   b. If message index <= minimum index, include message
3. Return matching messages
```

**Example**:
- Minimum priority: `'high'` (index 1)
- Message priority: `'critical'` (index 0)
- 0 <= 1, so include message

### Polling Algorithm

**Problem**: Wait for a message matching criteria without busy-waiting.

**Algorithm**:
```
startTime = now()
while (now() - startTime < timeout):
    messages = readInbox(agent)
    for msg in messages:
        if filter(msg):
            return msg
    sleep(interval)
return null
```

**Complexity**: O(n * m) where n = timeout/interval and m = inbox size

**Trade-off**: Longer interval = less CPU, but slower detection

---

## 8. Error Handling

### Error Categories

| Category | Examples | Handling |
|----------|----------|----------|
| File System | Permission denied, disk full | Throw error with details |
| JSON Parse | Corrupted file, invalid JSON | Log warning, return empty array |
| Validation | Invalid message structure | Filter out, don't propagate |
| Timeout | Poll expires | Return `null`, don't throw |

### Error Recovery Strategies

**Corrupted Queue File**:
1. Attempt to parse JSON
2. On failure, log warning with file path
3. Return empty array (treat as no messages)
4. File will be overwritten on next write

**Temp File Cleanup**:
1. If write fails after creating temp file
2. Attempt to delete temp file
3. Ignore cleanup errors (may leave orphan)
4. Re-throw original error

### Validation Failures

Messages failing validation are **silently dropped** when reading:
- Rationale: One bad message shouldn't block all messages
- Trade-off: Potential data loss, but system remains functional
- Mitigation: Log warning when dropping messages

---

## 9. Edge Cases & Boundary Conditions

### Empty States

| Scenario | Behavior |
|----------|----------|
| Inbox file doesn't exist | `readInbox()` returns `[]` |
| Inbox file is empty | `readInbox()` returns `[]` (after JSON parse of `[]`) |
| Inbox file contains `null` | `readInbox()` returns `[]` |
| Agent name has special chars | Becomes part of filename, may cause issues |

### Concurrent Access

| Scenario | Risk | Mitigation |
|----------|------|------------|
| Two processes write same file | Last write wins | Atomic rename |
| Read during write | May see old content | Acceptable (polling retries) |
| Rapid sequential writes | Possible out-of-order | Use timestamps, not write order |

### Large Messages

| Concern | Limit | Handling |
|---------|-------|----------|
| Message body size | No hard limit | May cause memory issues |
| Number of messages | No hard limit | Performance degrades |
| File size | System dependent | May fail to read/write |

**Recommendation**: Keep message bodies under 100KB, periodically archive old messages.

### Invalid Input

| Input | Behavior |
|-------|----------|
| `sendMessage()` with unknown agent | Still sends (no validation) |
| Empty `subject` or `body` | Passes validation, but discouraged |
| `to: ''` (empty string) | Fails validation |
| Circular thread references | Not detected, application responsibility |

---

## 10. Integration Points

### Database Integration (Optional)

When `options.persistToDb === true`:
```typescript
// Called by sendMessage()
db.createMessage({
  sessionId: options.sessionId,
  threadId: message.threadId,
  fromAgent: message.from,
  toAgent: message.to,
  messageType: message.type,
  priority: message.priority,
  content: message.content,
});
```

**Requires**: Session ID to scope messages to a workflow run

### Orchestrator Integration

The orchestrator calls message bus functions to:
1. Initialize queues at workflow start: `initializeAgentQueues()`
2. Send tasks to agents: `sendTask('orchestrator', agent, ...)`
3. Poll for completion: `pollForCompletion(agent)`
4. Route messages between agents based on workflow rules

### Agent Integration

Agents (via CLAUDE.md instructions) should:
1. Periodically read inbox: `readInbox(agentName)`
2. Process messages and clear: `removeFromInbox(agentName, msg.id)`
3. Write results to outbox via file operations (not this module directly)
4. Signal completion: `sendStatus(agentName, 'complete', summary)`

---

## 11. File System & External Effects

### Files Created

| Path | Content | When |
|------|---------|------|
| `.swarm/messages/inbox/{agent}.json` | JSON array of messages | `initializeAgentQueues()` |
| `.swarm/messages/outbox/{agent}.json` | JSON array of messages | `initializeAgentQueues()` |
| `.swarm/messages/inbox/{agent}.json.tmp.*` | Temp during write | Atomic write, deleted after |

### Directory Structure

```
.swarm/
└── messages/
    ├── inbox/
    │   ├── researcher.json
    │   ├── developer.json
    │   ├── reviewer.json
    │   ├── architect.json
    │   └── orchestrator.json
    └── outbox/
        ├── researcher.json
        ├── developer.json
        ├── reviewer.json
        ├── architect.json
        └── orchestrator.json
```

### Permissions Required

- Read/write access to `.swarm/` directory
- Create directory permission for parent of `.swarm/`

---

## 12. Testing Strategy

### Unit Tests

**Directory Management**:
- Verify directories are created
- Verify idempotent (calling twice is safe)
- Verify queue files are initialized empty
- Verify `clearAllQueues()` empties all files

**Validation**:
- Test each validation rule independently
- Test with missing fields
- Test with wrong types
- Test with invalid enum values

**Inbox/Outbox Operations**:
- Read empty inbox
- Add and read single message
- Add multiple messages
- Remove by ID
- Filter by type
- Filter by priority

**Message Sending**:
- Verify message appears in sender's outbox
- Verify message appears in recipient's inbox
- Verify broadcast reaches all except sender
- Verify message structure is correct

**Polling**:
- Test immediate match
- Test delayed match (message arrives during poll)
- Test timeout (no message arrives)

### Integration Tests

- Send message between two "agents" (simulated)
- Complete conversation thread with multiple messages
- Concurrent send and read operations
- Large message handling

### Test Fixtures

```typescript
// Sample valid message for tests
const validMessage: AgentMessage = {
  id: 'test_123',
  timestamp: '2024-01-01T00:00:00Z',
  from: 'orchestrator',
  to: 'researcher',
  type: 'task',
  priority: 'normal',
  content: { subject: 'Test', body: 'Test body' },
  requiresResponse: false,
};

// Sample invalid messages
const missingId = { ...validMessage, id: undefined };
const invalidType = { ...validMessage, type: 'invalid' };
const missingContent = { ...validMessage, content: undefined };
```

### Manual Verification

```bash
# Initialize and inspect
bun -e "import { initializeAgentQueues } from './src/message-bus'; initializeAgentQueues();"
cat .swarm/messages/inbox/researcher.json  # Should show []

# Send a message and verify
bun -e "
import { sendTask, readInbox } from './src/message-bus';
sendTask('orchestrator', 'researcher', 'Test', 'Body');
console.log(readInbox('researcher'));
"

# Verify file content is readable JSON
cat .swarm/messages/inbox/researcher.json | jq .
```

---

## 13. Configuration

### Configurable Values

| Value | Default | Location | Purpose |
|-------|---------|----------|---------|
| Swarm directory | `.swarm` | Constant | Root for all swarm data |
| Poll interval | 5000ms | `PollOptions.intervalMs` | How often to check inbox |
| Poll timeout | 300000ms | `PollOptions.timeoutMs` | When to give up polling |
| Valid agents | 5 agents | `VALID_AGENTS` | Allowed agent names |

### Future Configuration Options

These are not implemented but may be needed:
- Custom swarm directory path
- Maximum message size
- Maximum queue length
- Message retention period

---

## 14. Open Questions & Decisions

### Resolved Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| IPC mechanism | File-based | Debuggable, no dependencies, Claude-friendly |
| Message format | JSON | Human-readable, Claude can parse |
| Polling vs events | Polling | Simpler, works without watchers |
| Validation approach | Filter on read | Resilient to corruption |
| Atomic writes | Temp + rename | Prevents partial reads |

### Open Questions

1. **Message archival**: How long to keep messages? Currently unbounded.
2. **Queue limits**: Should we limit inbox size? What happens when full?
3. **Agent validation**: Should `sendMessage()` reject unknown agents?
4. **Binary content**: How to handle images or binary data in messages?
5. **Encryption**: Should messages be encrypted at rest?

### Trade-offs Considered

**Polling vs File Watching**:
- Polling: Simpler, works everywhere, predictable CPU usage
- Watching: Faster detection, but more complex, platform differences
- **Chose polling** for simplicity

**JSON vs Binary Format**:
- JSON: Human-readable, Claude-friendly, larger files
- Binary: Smaller, faster, but opaque
- **Chose JSON** for debuggability

**Single File vs Multiple Files**:
- Single file per agent pair: Fewer files, but contention
- File per agent: More files, but no contention
- **Chose per-agent** to avoid write conflicts

---

## Next Step

After implementing the message bus, proceed to **Step 4: Tmux Manager** which will handle spawning and managing Claude Code instances in terminal panes.
