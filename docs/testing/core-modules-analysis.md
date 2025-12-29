# Core Modules Test Case Analysis

**Document Version:** 1.0
**Analysis Date:** 2025-12-29
**Modules Analyzed:**
- `src/types.ts` - Result pattern, type definitions
- `src/db.ts` - SQLite database operations
- `src/message-bus.ts` - File-based IPC

---

## Table of Contents

1. [Module: types.ts](#module-typests)
2. [Module: db.ts](#module-dbts)
3. [Module: message-bus.ts](#module-message-busts)
4. [Cross-Module Concerns](#cross-module-concerns)
5. [Severity Summary](#severity-summary)

---

## Module: types.ts

**Location:** `/home/carso/code/claude-swarm/src/types.ts`
**Purpose:** Shared type definitions and utility functions for the swarm system

### Overview

This module defines TypeScript interfaces for messages, agents, tasks, findings, artifacts, decisions, workflows, and sessions. It also provides utility functions:
- `ok<T>(value: T)` - Create success Result
- `err<E>(error: E)` - Create error Result
- `generateId()` - Generate UUID v4
- `now()` - Get current ISO 8601 timestamp

---

### Base Cases (Happy Path)

#### TC-TYPES-001: Result Pattern Success
```typescript
const result = ok({ data: "test" });
// Expected: { ok: true, value: { data: "test" } }
```

#### TC-TYPES-002: Result Pattern Error
```typescript
const result = err(new Error("failed"));
// Expected: { ok: false, error: Error("failed") }
```

#### TC-TYPES-003: UUID Generation
```typescript
const id = generateId();
// Expected: Valid UUID v4 string (e.g., "550e8400-e29b-41d4-a716-446655440000")
```

#### TC-TYPES-004: Timestamp Generation
```typescript
const timestamp = now();
// Expected: ISO 8601 string (e.g., "2025-12-29T19:30:00.000Z")
```

---

### Edge Cases

#### TC-TYPES-005: ok() with undefined value
```typescript
const result = ok(undefined);
// Expected: { ok: true, value: undefined }
// Note: TypeScript allows this - may need runtime validation if undefined is invalid
```

#### TC-TYPES-006: ok() with null value
```typescript
const result = ok(null);
// Expected: { ok: true, value: null }
// Note: May be semantically incorrect for some use cases
```

#### TC-TYPES-007: err() with non-Error type
```typescript
const result = err("string error");
const result2 = err({ code: 500, msg: "server error" });
// Expected: Both work due to generic E parameter
// Consideration: Inconsistent error handling across codebase
```

#### TC-TYPES-008: generateId() consecutive calls
```typescript
const id1 = generateId();
const id2 = generateId();
// Expected: id1 !== id2 (uniqueness guarantee)
```

#### TC-TYPES-009: now() across DST boundary
```typescript
// Call during DST transition
const timestamp = now();
// Expected: Correct UTC timestamp (toISOString always uses UTC)
```

---

### Potentially Suboptimal/Harmful Behaviors

#### ISSUE-TYPES-001: No Validation in Result Helpers
**Severity:** Low
**Description:** The `ok()` and `err()` functions accept any value without validation. `ok(undefined)` or `ok(null)` may create semantically invalid success results.

**Test Case:**
```typescript
const result = ok(undefined);
if (result.ok) {
  // result.value is undefined - may cause downstream errors
  console.log(result.value.toString()); // TypeError
}
```

**Recommendation:** Consider adding runtime type guards or providing typed wrapper functions for common patterns.

---

#### ISSUE-TYPES-002: crypto.randomUUID() Browser Compatibility
**Severity:** Low (Bun-specific project)
**Description:** `crypto.randomUUID()` requires a secure context in browsers. In Bun/Node.js, this works fine, but code reuse in browser contexts would fail.

**Test Case:**
```typescript
// In non-secure browser context (HTTP, not HTTPS)
generateId(); // TypeError: crypto.randomUUID is not a function
```

---

### Security Concerns

#### SEC-TYPES-001: UUID Predictability (Theoretical)
**Severity:** Very Low
**Description:** UUID v4 relies on `crypto.randomUUID()` which uses cryptographically secure random numbers. No practical concern, but worth noting for audit completeness.

---

## Module: db.ts

**Location:** `/home/carso/code/claude-swarm/src/db.ts`
**Purpose:** SQLite database operations using Bun's native SQLite driver

### Overview

This module provides:
- Singleton database connection management (`getDb()`, `closeDb()`)
- Schema initialization with 8 tables (sessions, findings, artifacts, decisions, tasks, messages, checkpoints, error_log, agent_activity)
- CRUD operations for all entity types
- Row-to-domain object mapping functions

---

### Base Cases (Happy Path)

#### TC-DB-001: Database Initialization
```typescript
const db = getDb();
// Expected: Creates .swarm/memory.db, enables WAL mode, creates all tables
```

#### TC-DB-002: Create Session
```typescript
const session = createSession({ workflowType: 'development', goal: 'Build feature X' });
// Expected: Returns SwarmSession with generated id, timestamps, status='initializing'
```

#### TC-DB-003: Create and Retrieve Finding
```typescript
const finding = createFinding({
  sessionId: 'valid-session-id',
  agent: 'researcher',
  claim: 'API supports pagination',
  confidence: 'high',
  sources: ['https://docs.example.com']
});
const retrieved = getFinding(finding.id);
// Expected: retrieved matches finding
```

#### TC-DB-004: Create and Retrieve Task
```typescript
const task = createTask({
  sessionId: 'valid-session-id',
  assignedTo: 'developer',
  priority: 'high',
  description: 'Implement login'
});
// Expected: Task created with status='created', proper timestamps
```

#### TC-DB-005: Session Stats Aggregation
```typescript
const stats = getSessionStats(sessionId);
// Expected: { findings: { total: N, verified: M }, artifacts: {...}, tasks: {...}, ... }
```

---

### Edge Cases

#### TC-DB-006: Get Non-Existent Session
```typescript
const session = getSession('non-existent-id');
// Expected: Returns null
```

#### TC-DB-007: Create Session with Empty Goal
```typescript
const session = createSession({ workflowType: 'development', goal: '' });
// Expected: Session created (no validation on goal content)
// Note: May want to validate non-empty goal
```

#### TC-DB-008: Create Finding with Empty Sources Array
```typescript
const finding = createFinding({
  sessionId: 'valid-id',
  agent: 'researcher',
  claim: 'Test claim',
  confidence: 'high',
  sources: []
});
// Expected: Works, sources stored as "[]" in DB
```

#### TC-DB-009: Update Non-Existent Task
```typescript
updateTaskStatus('non-existent-id', 'complete');
// Expected: No error thrown, no rows affected
// Concern: Silent failure - caller doesn't know update failed
```

#### TC-DB-010: Delete Session with Cascade
```typescript
deleteSession(sessionId);
// Expected: Session and all related findings, artifacts, tasks, messages deleted via CASCADE
```

#### TC-DB-011: JSON Parsing of Malformed Data
```typescript
// If sources column contains invalid JSON
const finding = getFinding(id); // Where sources = "not valid json"
// Expected: JSON.parse throws SyntaxError
// Current behavior: Unhandled exception
```

#### TC-DB-012: Very Long Content in Artifacts
```typescript
const artifact = createArtifact({
  sessionId: 'valid-id',
  agent: 'developer',
  artifactType: 'code',
  filepath: '/src/large-file.ts',
  content: 'x'.repeat(100_000_000) // 100MB string
});
// Expected: Works but may exhaust memory or hit SQLite limits
```

---

### Potentially Suboptimal/Harmful Behaviors

#### ISSUE-DB-001: Singleton Database Connection
**Severity:** Medium
**Description:** The module uses a global singleton (`dbInstance`) for the database connection. This can cause issues in:
- Testing (tests share state)
- Concurrent operations in multi-threaded contexts
- Connection lifecycle management

**Test Case:**
```typescript
// Test 1 modifies data
createSession({ workflowType: 'research', goal: 'Test 1' });
// Test 2 sees Test 1's data if not properly isolated
const sessions = listSessions();
// sessions may contain unexpected data
```

**Recommendation:** Consider dependency injection or connection factory pattern for testability.

---

#### ISSUE-DB-002: No Input Validation
**Severity:** Medium
**Description:** CRUD functions accept inputs without validation. Invalid data (empty strings, wrong types at runtime) can be inserted into the database.

**Test Cases:**
```typescript
// Empty required fields
createSession({ workflowType: '' as any, goal: '' });

// Invalid JSON in inputData
createTask({
  sessionId: 'id',
  assignedTo: 'developer',
  priority: 'high',
  description: 'test',
  inputData: { circular: null } // What if circular reference?
});
```

---

#### ISSUE-DB-003: Silent Update Failures
**Severity:** Medium
**Description:** Update functions don't verify that a row was actually updated. Updates to non-existent IDs silently succeed.

**Test Case:**
```typescript
updateSessionStatus('non-existent-id', 'complete');
// No error, no indication of failure
// Caller assumes session was updated
```

**Recommendation:** Check `db.run()` return value for affected rows, return Result type or throw on failure.

---

#### ISSUE-DB-004: JSON.parse Without Error Handling
**Severity:** High
**Description:** Row-to-domain mapping functions call `JSON.parse()` on JSON columns (sources, alternatives_considered, input_data, output_data, content) without try/catch. Corrupted data causes unhandled exceptions.

**Test Case:**
```typescript
// Manually corrupt database
db.run("UPDATE findings SET sources = 'invalid json' WHERE id = ?", [id]);

// Application crashes
const finding = getFinding(id);
// Throws: SyntaxError: Unexpected token 'i', "invalid json" is not valid JSON
```

**Recommendation:** Wrap JSON.parse in try/catch, return Result type or use a safe parser.

---

#### ISSUE-DB-005: No Connection Pooling or Retry Logic
**Severity:** Low
**Description:** Single connection with no retry logic for transient failures (disk full, locked database).

**Test Case:**
```typescript
// Simulate database lock
// Process A: Long transaction
// Process B: getDb() and query
// Process B may get SQLITE_BUSY error
```

---

#### ISSUE-DB-006: WAL Mode Without Checkpointing
**Severity:** Medium
**Description:** WAL mode is enabled but no explicit checkpointing is performed. WAL file can grow unboundedly under sustained write load.

**Test Case:**
```typescript
// Continuous writes
for (let i = 0; i < 1_000_000; i++) {
  createMessage({...});
}
// .swarm/memory.db-wal grows to gigabytes
```

**Recommendation:** Implement periodic `PRAGMA wal_checkpoint(TRUNCATE)` or rely on auto-checkpoint (default 1000 pages).

---

#### ISSUE-DB-007: Type Casting Without Validation
**Severity:** Medium
**Description:** Domain types use `as` casts on database row values without validating they're valid enum values.

**Test Case:**
```typescript
// Corrupt data: UPDATE sessions SET status = 'invalid_status'
const session = getSession(id);
// session.status is 'invalid_status' but typed as SessionStatus
// Downstream code may fail unexpectedly
```

---

#### ISSUE-DB-008: Missing requiresResponse Persistence
**Severity:** Low
**Description:** `AgentMessage.requiresResponse` is always set to `false` when reading from DB because the field isn't stored.

**Test Case:**
```typescript
// Create message with requiresResponse: true via message-bus
// Read back from DB
const msg = messageRowToAgentMessage(row);
// msg.requiresResponse is always false - information lost
```

---

### Resource Leaks

#### ISSUE-DB-009: Database Connection Not Closed on Error
**Severity:** Low
**Description:** If schema initialization fails, `dbInstance` is set but connection may be in bad state.

**Test Case:**
```typescript
// Corrupt .swarm/memory.db file
const db = getDb(); // Throws during initializeSchema
// dbInstance is now partially initialized
// Subsequent getDb() returns broken connection
```

---

### Security Concerns

#### SEC-DB-001: SQL Injection - SAFE
**Severity:** N/A (Passed)
**Description:** All queries use parameterized statements (`?` placeholders). No string concatenation in SQL.

**Evidence:**
```typescript
db.run('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?', [status, timestamp, id]);
```

---

#### SEC-DB-002: Path Traversal in DB Path
**Severity:** Low
**Description:** `DB_DIR` and `DB_FILE` are hardcoded constants (`.swarm` and `memory.db`). No user input affects database path.

---

#### SEC-DB-003: Sensitive Data in Database
**Severity:** Medium
**Description:** Database stores task descriptions, message content, error logs with stack traces. If `.swarm/memory.db` is exposed, sensitive project information leaks.

**Recommendation:**
- Document that `.swarm/` should be in `.gitignore`
- Consider encrypting sensitive fields
- Scrub sensitive data from error logs

---

## Module: message-bus.ts

**Location:** `/home/carso/code/claude-swarm/src/message-bus.ts`
**Purpose:** File-based inter-process communication for agent messaging

### Overview

This module provides:
- File-based message queues (JSON files for inbox/outbox)
- Atomic file writes using temp file + rename
- Message validation
- Polling utilities for async message receipt
- Broadcast and convenience messaging functions

---

### Base Cases (Happy Path)

#### TC-MB-001: Initialize Agent Queues
```typescript
initializeAgentQueues();
// Expected: Creates .swarm/messages/inbox/ and .swarm/messages/outbox/
// Creates {agent}.json files for all 5 agents
```

#### TC-MB-002: Send Message Between Agents
```typescript
const msg = sendMessage({
  from: 'orchestrator',
  to: 'developer',
  type: 'task',
  content: { subject: 'Build feature', body: 'Details...' }
});
// Expected: Message in orchestrator's outbox and developer's inbox
```

#### TC-MB-003: Broadcast Message
```typescript
const msg = broadcastMessage('orchestrator', 'status', {
  subject: 'System update',
  body: 'All agents...'
});
// Expected: Message in researcher, developer, reviewer, architect inboxes (not orchestrator)
```

#### TC-MB-004: Read Inbox
```typescript
const messages = readInbox('developer');
// Expected: Array of AgentMessage objects
```

#### TC-MB-005: Remove Message From Inbox
```typescript
const removed = removeFromInbox('developer', 'message-id');
// Expected: true if found, false otherwise
```

---

### Edge Cases

#### TC-MB-006: Read Non-Existent Inbox
```typescript
const messages = readInbox('developer');
// When .swarm/messages/inbox/developer.json doesn't exist
// Expected: Returns empty array []
```

#### TC-MB-007: Read Corrupted Inbox File
```typescript
// inbox/developer.json contains: "not valid json"
const messages = readInbox('developer');
// Expected: Returns empty array [], logs warning
```

#### TC-MB-008: Read Non-Array JSON
```typescript
// inbox/developer.json contains: {"key": "value"}
const messages = readInbox('developer');
// Expected: Returns empty array [] (not an array)
```

#### TC-MB-009: Inbox with Invalid Messages
```typescript
// inbox/developer.json contains: [{"id": "1"}, {"invalid": "message"}]
const messages = readInbox('developer');
// Expected: Filters out invalid messages, returns only valid ones
```

#### TC-MB-010: Send to Invalid Agent
```typescript
const msg = sendMessage({
  from: 'orchestrator',
  to: 'nonexistent-agent',
  type: 'task',
  content: { subject: 'Test', body: 'Body' }
});
// Expected: Message written to .swarm/messages/inbox/nonexistent-agent.json
// Note: No validation that target is a valid agent
```

#### TC-MB-011: Send from Invalid Agent
```typescript
const msg = sendMessage({
  from: 'fake-agent',
  to: 'developer',
  type: 'task',
  content: { subject: 'Test', body: 'Body' }
});
// Expected: Works - no validation on sender
```

#### TC-MB-012: Empty String Agent Name
```typescript
const path = getInboxPath('');
// Expected: '.swarm/messages/inbox/.json' - problematic path
```

#### TC-MB-013: Agent Name with Path Characters
```typescript
const path = getInboxPath('../../../etc/passwd');
// Expected: Path traversal vulnerability
// Returns: '.swarm/messages/inbox/../../../etc/passwd.json'
```

#### TC-MB-014: Poll Timeout
```typescript
const msg = await pollInbox('developer', { timeoutMs: 100 });
// When inbox is empty
// Expected: Returns null after 100ms
```

#### TC-MB-015: Concurrent Writes to Same Inbox
```typescript
// Process A and B both call addToInbox('developer', msg) simultaneously
// Expected: Potential race condition - one message may be lost
```

---

### Potentially Suboptimal/Harmful Behaviors

#### ISSUE-MB-001: Race Condition in Read-Modify-Write
**Severity:** High
**Description:** `addToInbox()` and `addToOutbox()` perform non-atomic read-modify-write:
1. Read current messages
2. Append new message
3. Write all messages

Two concurrent writes can cause message loss.

**Test Case:**
```typescript
// Concurrent execution:
// T1: Read inbox (empty)
// T2: Read inbox (empty)
// T1: Write [msg1]
// T2: Write [msg2] -- overwrites msg1!
```

**Recommendation:** Use file locking (flock) or append-only format with separate consumption tracking.

---

#### ISSUE-MB-002: No Agent Name Validation in Path Functions
**Severity:** High
**Description:** `getInboxPath()` and `getOutboxPath()` concatenate agent name into path without sanitization.

**Test Case:**
```typescript
getInboxPath('../../../etc/passwd');
// Returns: '.swarm/messages/inbox/../../../etc/passwd.json'
// If system allows writing, could overwrite system files
```

**Recommendation:** Validate agent name against `VALID_AGENTS` before constructing path, or sanitize input.

---

#### ISSUE-MB-003: Unbounded Inbox Growth
**Severity:** Medium
**Description:** Messages are never automatically removed from inbox/outbox files. Under sustained load, files grow indefinitely.

**Test Case:**
```typescript
// Agent receives 1000 messages but doesn't call removeFromInbox
// Inbox file grows to thousands of entries
// Each readInbox() call parses entire file
```

**Recommendation:** Implement inbox size limits, message TTL, or pagination.

---

#### ISSUE-MB-004: Poll Loop Without Jitter
**Severity:** Low
**Description:** `pollInbox()` uses fixed interval polling. Multiple agents polling simultaneously create synchronized disk access spikes.

**Test Case:**
```typescript
// 5 agents all poll every 5000ms
// At t=0, t=5000, t=10000: all 5 read their inboxes simultaneously
```

**Recommendation:** Add random jitter: `intervalMs + Math.random() * 1000`

---

#### ISSUE-MB-005: Temp File Cleanup on Rename Failure
**Severity:** Low
**Description:** `writeMessagesFile()` creates temp file then renames. If rename fails (cross-device, permissions), temp file may be cleaned up successfully, but original file is unchanged. Error is propagated, which is correct. However, if `unlinkSync` fails during cleanup, error is silently ignored.

**Test Case:**
```typescript
// Simulate: rename fails, temp file has restricted permissions
// unlinkSync(tempPath) fails
// Orphan temp file remains on disk
```

---

#### ISSUE-MB-006: Message Validation Gaps
**Severity:** Low
**Description:** `validateMessage()` doesn't validate:
- `artifacts` array contents (should be strings)
- `metadata` structure (accepts any object)
- ISO 8601 format of timestamp/deadline

**Test Case:**
```typescript
const msg = {
  // ... valid required fields
  content: {
    subject: 'Test',
    body: 'Body',
    artifacts: [123, null, {}] // Invalid types
  }
};
validateMessage(msg); // Returns true
```

---

#### ISSUE-MB-007: persistToDb Requires sessionId
**Severity:** Low
**Description:** When `persistToDb: true`, `sessionId` is required but error is only thrown at runtime, not caught by types.

**Test Case:**
```typescript
sendMessage(input, { persistToDb: true }); // No sessionId
// Throws: "sessionId is required when persistToDb is true"
// But types don't enforce this
```

---

#### ISSUE-MB-008: readMessagesFile Logs to Console
**Severity:** Low
**Description:** `console.warn()` is called on file read errors. In production, this may be inappropriate or leak path information.

**Test Case:**
```typescript
// Corrupt file
readMessagesFile('/path/to/inbox.json');
// Console output: "[message-bus] Failed to read messages from /path/to/inbox.json: SyntaxError..."
```

**Recommendation:** Use structured logging with configurable levels, avoid exposing full paths.

---

### Resource Leaks

#### ISSUE-MB-009: Poll Loop Memory
**Severity:** Very Low
**Description:** `pollInbox()` reads entire inbox file each iteration. Large inboxes cause repeated memory allocation.

---

### Security Concerns

#### SEC-MB-001: Path Traversal Vulnerability
**Severity:** High
**Description:** Agent names are not validated before constructing file paths. Malicious agent names can escape the message directory.

**Attack Vector:**
```typescript
// If attacker can control 'from' or 'to' field:
sendMessage({
  from: 'orchestrator',
  to: '../../../tmp/exploit',
  type: 'task',
  content: { subject: 'Attack', body: 'Payload' }
});
// Writes to: .swarm/messages/inbox/../../../tmp/exploit.json
// Actual path: /tmp/exploit.json
```

**Mitigation:** Always validate agent against `VALID_AGENTS` before any path operation.

---

#### SEC-MB-002: Arbitrary File Read via Agent Name
**Severity:** Medium
**Description:** Similar to write, if attacker controls agent parameter to `readInbox()`:
```typescript
readInbox('../../../etc/passwd');
// Attempts to read: .swarm/messages/inbox/../../../etc/passwd.json
// Would fail to parse as JSON, but confirms file exists
```

---

#### SEC-MB-003: Denial of Service via Large Messages
**Severity:** Medium
**Description:** No size limits on message content. Attacker can send huge messages to fill disk or exhaust memory.

**Attack Vector:**
```typescript
sendMessage({
  from: 'orchestrator',
  to: 'developer',
  type: 'task',
  content: {
    subject: 'Test',
    body: 'x'.repeat(1_000_000_000) // 1GB
  }
});
```

---

#### SEC-MB-004: Information Disclosure in Error Logs
**Severity:** Low
**Description:** `console.warn()` includes full file paths and error details that could aid attackers.

---

## Cross-Module Concerns

### CROSS-001: Inconsistent Error Handling
**Severity:** Medium
**Modules:** All

| Module | Pattern |
|--------|---------|
| types.ts | Result type defined but not used internally |
| db.ts | Throws exceptions, no Result wrapping |
| message-bus.ts | Mix of exceptions and silent failures |

**Recommendation:** Establish consistent error handling policy. Use Result for expected failures, exceptions for bugs.

---

### CROSS-002: No Logging Framework
**Severity:** Low
**Modules:** db.ts, message-bus.ts

Both modules use `console.warn()` for errors. No structured logging, log levels, or log destination configuration.

---

### CROSS-003: Hardcoded Paths
**Severity:** Low
**Modules:** db.ts, message-bus.ts

| Constant | Value | Location |
|----------|-------|----------|
| DB_DIR | `.swarm` | db.ts |
| DB_FILE | `memory.db` | db.ts |
| SWARM_DIR | `.swarm` | message-bus.ts |
| INBOX_DIR | `.swarm/messages/inbox` | message-bus.ts |
| OUTBOX_DIR | `.swarm/messages/outbox` | message-bus.ts |

**Recommendation:** Move to configuration or environment variables for flexibility.

---

### CROSS-004: No Schema Versioning
**Severity:** Medium
**Modules:** db.ts

Schema is created with `CREATE TABLE IF NOT EXISTS`. No mechanism to migrate existing databases when schema changes.

---

### CROSS-005: Testing Infrastructure Missing
**Severity:** Medium
**Modules:** All

No existing test files (`*.test.ts` or `*.spec.ts`). Singleton patterns and hardcoded paths make unit testing difficult.

---

## Severity Summary

### Critical (0)
None identified.

### High (3)
| ID | Module | Issue |
|----|--------|-------|
| ISSUE-DB-004 | db.ts | JSON.parse without error handling |
| ISSUE-MB-001 | message-bus.ts | Race condition in read-modify-write |
| SEC-MB-001 | message-bus.ts | Path traversal vulnerability |

### Medium (9)
| ID | Module | Issue |
|----|--------|-------|
| ISSUE-DB-001 | db.ts | Singleton database connection |
| ISSUE-DB-002 | db.ts | No input validation |
| ISSUE-DB-003 | db.ts | Silent update failures |
| ISSUE-DB-006 | db.ts | WAL mode without checkpointing |
| ISSUE-DB-007 | db.ts | Type casting without validation |
| SEC-DB-003 | db.ts | Sensitive data in database |
| ISSUE-MB-003 | message-bus.ts | Unbounded inbox growth |
| SEC-MB-002 | message-bus.ts | Arbitrary file read via agent name |
| SEC-MB-003 | message-bus.ts | DoS via large messages |

### Low (12)
| ID | Module | Issue |
|----|--------|-------|
| ISSUE-TYPES-001 | types.ts | No validation in Result helpers |
| ISSUE-TYPES-002 | types.ts | crypto.randomUUID browser compatibility |
| ISSUE-DB-005 | db.ts | No connection pooling |
| ISSUE-DB-008 | db.ts | Missing requiresResponse persistence |
| ISSUE-DB-009 | db.ts | Database connection not closed on error |
| ISSUE-MB-004 | message-bus.ts | Poll loop without jitter |
| ISSUE-MB-005 | message-bus.ts | Temp file cleanup edge case |
| ISSUE-MB-006 | message-bus.ts | Message validation gaps |
| ISSUE-MB-007 | message-bus.ts | persistToDb requires sessionId (type safety) |
| ISSUE-MB-008 | message-bus.ts | readMessagesFile logs to console |
| SEC-MB-004 | message-bus.ts | Information disclosure in error logs |
| SEC-TYPES-001 | types.ts | UUID predictability (theoretical) |

---

## Test Priority Matrix

Based on severity and likelihood, recommended test implementation order:

1. **Path traversal prevention** (SEC-MB-001, SEC-MB-002)
2. **JSON parsing safety** (ISSUE-DB-004)
3. **Concurrent write handling** (ISSUE-MB-001)
4. **Input validation** (ISSUE-DB-002, ISSUE-MB-006)
5. **Update/delete verification** (ISSUE-DB-003)
6. **Message size limits** (SEC-MB-003)
7. **Inbox size limits** (ISSUE-MB-003)
8. **Database isolation for tests** (ISSUE-DB-001)

---

## Appendix: Recommended Test File Structure

```
tests/
  types.test.ts
    - Result pattern tests
    - UUID generation tests
    - Timestamp format tests

  db.test.ts
    - Connection management tests
    - CRUD operation tests
    - Schema migration tests
    - Error handling tests
    - Concurrent access tests

  message-bus.test.ts
    - Queue initialization tests
    - Message send/receive tests
    - Validation tests
    - Path security tests
    - Poll operation tests
    - Concurrent write tests

  integration/
    - db-message-bus.test.ts (persistToDb flow)
```
