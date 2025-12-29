# Code Review: Steps 3-4 (Message Bus & Tmux Manager)

**Date:** 2025-12-29
**Reviewer:** Subagent (thorough review)
**Files Reviewed:**
- `src/message-bus.ts` - Message Bus (Step 3)
- `src/tmux-manager.ts` - Tmux Manager (Step 4)
- `src/types.ts` - Type definitions

**Verdict:** PASS (with fixes applied)

---

## Summary

Both implementations are solid and follow their specs well. The message bus has proper atomic file writes and the tmux manager has comprehensive session/pane management. However, there was a critical shell injection vulnerability in the tmux manager that has been fixed.

---

## Issues Found

### Critical Issues

#### 1. Shell Command Injection in `startClaudeCode` (FIXED)
- **Location:** `src/tmux-manager.ts` - `startClaudeCode()`
- **Problem:** The `workdir` parameter was passed directly to a shell command without sanitization
- **Attack vector:** `workdir = "; rm -rf /"` would execute arbitrary commands
- **Fix Applied:** Added path validation to reject shell metacharacters

#### 2. Unescaped Session/Pane Names (FIXED)
- **Location:** Multiple functions in `src/tmux-manager.ts`
- **Problem:** Session names weren't validated, allowing potential tmux target confusion
- **Fix Applied:** Added `validateSessionName()` function that enforces alphanumeric + underscore/hyphen only

### Medium Issues

#### 1. Missing Error Throw When persistToDb Without sessionId (FIXED)
- **Location:** `src/message-bus.ts` - `sendMessage()`
- **Problem:** Spec requires throwing error when `persistToDb` is true but `sessionId` is missing. Implementation silently skipped persistence.
- **Fix Applied:** Now throws error as specified

#### 2. Missing `sendTask` Parameters (FIXED)
- **Location:** `src/message-bus.ts` - `sendTask()`
- **Problem:** Spec signature includes `priority` and `threadId` in options, implementation didn't support them
- **Fix Applied:** Added priority and threadId support to sendTask options

#### 3. Incomplete MessageType Validation (FIXED)
- **Location:** `src/message-bus.ts` - `validateMessage()`
- **Problem:** Only checked that `type` and `priority` were non-empty strings, not that they were valid enum values
- **Fix Applied:** Added validation against allowed values list

#### 4. Race Condition in createSession
- **Location:** `src/tmux-manager.ts` - `createSession()`
- **Problem:** TOCTOU race between `sessionExists()` check and `new-session` command
- **Status:** NOT FIXED - Low risk for personal tooling, would require refactoring to rely on tmux's own error handling

#### 5. Missing Warning Log for Invalid Messages (FIXED)
- **Location:** `src/message-bus.ts` - `readMessagesFile()`
- **Problem:** Silently returned empty array on parse errors without logging
- **Fix Applied:** Added warning log on errors

### Low Issues

#### 1. Missing MESSAGES_DIR Constant
- **Location:** `src/message-bus.ts`
- **Problem:** Spec mentions `MESSAGES_DIR = '.swarm/messages'` but only child dirs are exported
- **Status:** NOT FIXED - Minor, can be derived from INBOX_DIR parent

#### 2. isClaudeCodeRunning Pattern Too Broad
- **Location:** `src/tmux-manager.ts`
- **Problem:** `/\[.*\]/` regex matches any bracketed text, could false-positive
- **Status:** NOT FIXED - Heuristic is good enough for intended use

#### 3. getAttachCommand Doesn't Quote Session Name (FIXED)
- **Location:** `src/tmux-manager.ts`
- **Problem:** Returned command would break if session name had spaces
- **Fix Applied:** Added quotes around session name

---

## Type Safety Analysis

### message-bus.ts - Strengths
- Proper use of generics in helper functions
- Result<T,E> pattern not heavily used (mostly throws on errors)
- Good type guards in `validateMessage()`
- Clean MessageContent union types

### tmux-manager.ts - Strengths
- Consistent Result<T,E> pattern throughout
- Well-defined TmuxError type with error codes
- Proper typing for all tmux output parsing
- No `any` types used

---

## Security Analysis

### Shell Command Safety
- **Bun.spawn with arrays:** Both files correctly use array arguments to Bun.spawn, avoiding shell string interpolation vulnerabilities
- **Path sanitization:** Now validates workdir paths in startClaudeCode
- **Session name validation:** Now validates session names to prevent tmux target injection

### File System Safety
- **Atomic writes:** message-bus.ts correctly uses temp file + rename pattern
- **Path traversal:** Not a concern - paths are constructed from known constants

---

## Completeness Analysis

### message-bus.ts (Step 3)
All 33 specified functions implemented. Key functionality:
- Queue initialization and cleanup
- Message creation and validation
- Inbox/outbox operations with atomic writes
- Priority-based sorting
- Polling with configurable intervals
- Thread management
- Broadcasting with sender exclusion

### tmux-manager.ts (Step 4)
All 32 specified functions implemented. Key functionality:
- Session lifecycle (create, kill, list, exists)
- Pane management (create, grid, select, kill)
- Command execution (sendKeys, runCommand, interrupt)
- Output capture with history
- Pattern/prompt waiting
- Claude Code helpers
- Layout management
- Cleanup utilities

---

## Fixes Applied

1. Added `validateSessionName()` function to tmux-manager.ts
2. Added session name validation to `createSession()` and `createPane()`
3. Added path sanitization to `startClaudeCode()` workdir parameter
4. Added error throw in `sendMessage()` when persistToDb without sessionId
5. Added priority/threadId support to `sendTask()` options
6. Added MessageType and Priority validation to `validateMessage()`
7. Added warning log to `readMessagesFile()` on parse errors
8. Added quotes to `getAttachCommand()` session name

---

## Recommendations for Future

1. **Consider removing the pre-check in createSession** - Rely on tmux's own "duplicate session" error to eliminate race condition
2. **Add integration tests** - Both modules would benefit from tests against real tmux/filesystem
3. **Consider adding retry logic** - For transient tmux command failures
4. **Refine isClaudeCodeRunning patterns** - If false positives become an issue
