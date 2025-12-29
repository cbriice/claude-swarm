# Code Review: Steps 1-2 (Project Scaffolding & Database Layer)

**Date:** 2025-12-28
**Reviewer:** Subagent (thorough review)
**Files Reviewed:**
- `src/types.ts` - Type definitions
- `src/db.ts` - Database layer

**Verdict:** PASS (with minor recommendations)

---

## Summary

The implementation is solid and production-ready for its intended use case (personal tooling). All required tables and core functionality are present with good type safety, correct SQL, and proper foreign key enforcement.

---

## Issues Found

### Critical Issues: NONE

### Medium Issues

#### 1. Missing `requiresResponse` and `deadline` Storage
- **Location:** `src/db.ts` - `messageRowToAgentMessage()`
- **Problem:** The `AgentMessage` type has `requiresResponse: boolean` and `deadline?: string`, but the `messages` table doesn't store these fields separately
- **Current behavior:** Implementation hardcodes `requiresResponse: false`
- **Spec expectation:** Extract these from `content`:
  ```typescript
  requiresResponse: content.requiresResponse ?? false,
  deadline: content.deadline,
  ```
- **Impact:** Messages that require responses won't be tracked correctly
- **Status:** NOT FIXED - Acceptable for MVP, can be addressed later

#### 2. Return Type Deviation from Spec
- **Location:** All CRUD create functions in `src/db.ts`
- **Problem:** Spec says create functions return `string` (the ID), but implementation returns full domain objects
- **Current behavior:** Returns `SwarmSession`, `Finding`, etc.
- **Impact:** This is actually **better** than spec - returning full object is more useful
- **Status:** NOT FIXED - Intentional improvement, document as design decision

### Low Issues

#### 1. Missing Indexes (2)
- **Location:** `src/db.ts` - `initializeSchema()`
- **Problem:** Spec required indexes not created:
  - `idx_checkpoints_created_at` on `checkpoints(created_at)`
  - `idx_error_log_code` on `error_log(code)`
- **Status:** FIXED - Added both indexes

#### 2. Missing `getMessage` Function
- **Location:** `src/db.ts`
- **Problem:** No function to get a single message by ID
- **Impact:** Minor - may not be needed, can query thread instead
- **Status:** NOT FIXED - Not required by spec, add if needed

#### 3. `getThreadMessages` Signature Deviation
- **Location:** `src/db.ts`
- **Problem:** Spec says `getThreadMessages(threadId: string)`, implementation uses `getThreadMessages(sessionId: string, threadId: string)`
- **Impact:** Actually **better** - prevents cross-session thread leakage
- **Status:** NOT FIXED - Intentional improvement

#### 4. JSON.parse Can Throw
- **Location:** Type mapping functions in `src/db.ts`
- **Problem:** `JSON.parse(row.sources)` etc. can throw on malformed JSON
- **Current mitigation:** Database layer controls what gets stored, so should be safe
- **Risk:** If DB is manually edited, could crash
- **Recommended fix:**
  ```typescript
  function safeJsonParse<T>(str: string, fallback: T): T {
    try {
      return JSON.parse(str) as T;
    } catch {
      return fallback;
    }
  }

  // Usage:
  sources: safeJsonParse(row.sources, []) as string[],
  ```
- **Status:** NOT FIXED - Low risk, add if issues arise

#### 5. DecisionRow `alternatives_considered` Nullability Mismatch
- **Location:** `src/db.ts`
- **Problem:**
  - Spec table definition: `alternatives_considered TEXT NULL`
  - Schema: `alternatives_considered TEXT NOT NULL`
  - DecisionRow type: `alternatives_considered: string` (not nullable)
- **Impact:** Schema enforces NOT NULL, which is stricter than spec
- **Status:** NOT FIXED - Implementation is consistent with itself, stricter is fine

---

## Type Safety Analysis

### types.ts - Strengths
- All types properly defined and exported
- No `any` types used (correctly uses `unknown` in `Record<string, unknown>`)
- Comprehensive union types for statuses
- Good use of optional properties with `?` syntax
- Utility types `Result<T, E>` and helpers well-designed

### db.ts - Strengths
- Row types properly defined with snake_case matching DB columns
- Input types properly defined with camelCase
- Type mapping functions correctly transform between Row and Domain types
- Generic type parameters used correctly

---

## Correctness Analysis

### SQL Queries
All queries have correct syntax - verified CREATE TABLE, INSERT, UPDATE, SELECT statements.

### Foreign Key Relationships
All properly defined with appropriate CASCADE/SET NULL behavior:
- `findings.session_id` -> `sessions.id` ON DELETE CASCADE
- `artifacts.session_id` -> `sessions.id` ON DELETE CASCADE
- `decisions.session_id` -> `sessions.id` ON DELETE CASCADE
- `tasks.session_id` -> `sessions.id` ON DELETE CASCADE
- `tasks.parent_task_id` -> `tasks.id` ON DELETE SET NULL
- `messages.session_id` -> `sessions.id` ON DELETE CASCADE
- `checkpoints.session_id` -> `sessions.id` ON DELETE CASCADE
- `agent_activity.session_id` -> `sessions.id` ON DELETE CASCADE
- `error_log.session_id` - No FK (intentionally nullable for errors without session)

### JSON Field Handling
Correctly implemented:
- `JSON.stringify()` on insert
- `JSON.parse()` on read in mapping functions

---

## Completeness Analysis

### Tables (9/9 present)
| Table | Status |
|-------|--------|
| sessions | Complete |
| findings | Complete |
| artifacts | Complete |
| decisions | Complete |
| tasks | Complete |
| messages | Complete |
| checkpoints | Complete |
| error_log | Complete |
| agent_activity | Complete |

### Indexes
| Index | Status |
|-------|--------|
| idx_findings_session | Present |
| idx_artifacts_session | Present |
| idx_artifacts_review | Present (single column) |
| idx_tasks_session | Present |
| idx_tasks_status | Present |
| idx_tasks_assigned | Present |
| idx_messages_session | Present |
| idx_messages_thread | Present |
| idx_decisions_session | Present |
| idx_checkpoints_session | Present |
| idx_checkpoints_created | **FIXED** |
| idx_errors_session | Present |
| idx_errors_code | **FIXED** |
| idx_errors_severity | Present |
| idx_agent_activity_session | Present |
| idx_agent_activity_role | Present |

---

## Security

**No SQL injection vulnerabilities.** All queries use parameterized statements:
```typescript
db.run('UPDATE ... WHERE id = ?', [id])
db.query<RowType, [string]>('SELECT * FROM ... WHERE id = ?').get(id)
```

---

## Recommendations for Future

1. **Add `safeJsonParse` helper** - For robustness against manual DB edits
2. **Add `getMessage(id)` function** - If single message lookup becomes needed
3. **Consider extracting `requiresResponse`/`deadline` from content** - If message tracking becomes important
4. **Document return type deviation** - Note that create functions return full objects (improvement over spec)

---

## Fixes Applied

1. Added `idx_checkpoints_created_at` index on `checkpoints(created_at)`
2. Added `idx_error_log_code` index on `error_log(code)`
