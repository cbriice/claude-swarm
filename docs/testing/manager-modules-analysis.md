# Manager Modules Test Case Analysis

This document provides a comprehensive analysis of test cases for the manager modules in claude-swarm: `tmux.ts` and `worktree.ts`. The analysis identifies base cases, edge cases, potentially suboptimal behaviors, and security concerns.

**Analysis Date:** 2025-12-29
**Modules Analyzed:**
- `/home/carso/code/claude-swarm/src/managers/tmux.ts`
- `/home/carso/code/claude-swarm/src/managers/worktree.ts`

---

## Table of Contents

1. [Tmux Manager Analysis](#tmux-manager-analysis)
   - [Base Cases (Happy Path)](#tmux-base-cases)
   - [Edge Cases](#tmux-edge-cases)
   - [Potentially Suboptimal/Harmful Behaviors](#tmux-suboptimal-behaviors)
   - [Security Concerns](#tmux-security-concerns)
2. [Worktree Manager Analysis](#worktree-manager-analysis)
   - [Base Cases (Happy Path)](#worktree-base-cases)
   - [Edge Cases](#worktree-edge-cases)
   - [Potentially Suboptimal/Harmful Behaviors](#worktree-suboptimal-behaviors)
   - [Security Concerns](#worktree-security-concerns)
3. [Cross-Module Concerns](#cross-module-concerns)
4. [Recommended Test Matrix](#recommended-test-matrix)

---

## Tmux Manager Analysis

**File:** `/home/carso/code/claude-swarm/src/managers/tmux.ts`

The tmux manager provides a TypeScript wrapper around tmux for managing sessions, panes, and Claude Code instances.

### Tmux Base Cases

#### Session Management

| Test Case | Description | Expected Behavior |
|-----------|-------------|-------------------|
| `createSession_validName` | Create session with alphanumeric name | Session created, returns `ok(undefined)` |
| `createSession_withUnderscore` | Create session with underscore in name | Session created successfully |
| `createSession_withHyphen` | Create session with hyphen in name | Session created successfully |
| `killSession_existing` | Kill an existing session | Session killed, returns `ok(undefined)` |
| `killSession_idempotent` | Kill non-existent session | Returns `ok(undefined)` (idempotent) |
| `listSessions_multiple` | List multiple sessions | Returns array of `TmuxSession` objects with correct metadata |
| `sessionExists_true` | Check if existing session exists | Returns `true` |
| `sessionExists_false` | Check if non-existent session exists | Returns `false` |
| `getSession_existing` | Get metadata for existing session | Returns `TmuxSession` with name, windows, created, attached |
| `listSwarmSessions_filtered` | List only swarm-prefixed sessions | Returns only sessions starting with `swarm_` |

#### Pane Management

| Test Case | Description | Expected Behavior |
|-----------|-------------|-------------------|
| `createPane_horizontal` | Create horizontal split | New pane created, returns pane ID |
| `createPane_vertical` | Create vertical split | New pane created with `-v` flag |
| `createPane_withSize` | Create pane with specific size percentage | Pane created with correct size |
| `createPane_withName` | Create pane with title | Pane created and title set |
| `createPaneGrid_multiple` | Create grid of 4 panes | Returns array of 4 pane IDs, tiled layout applied |
| `listPanes_session` | List panes in session | Returns array of `TmuxPane` objects |
| `getPane_byId` | Get pane by ID (e.g., "%0") | Returns correct `TmuxPane` |
| `getPane_byIndex` | Get pane by index | Returns correct `TmuxPane` |
| `selectPane_valid` | Focus a valid pane | Pane selected, returns `ok(undefined)` |
| `killPane_existing` | Kill an existing pane | Pane killed, returns `ok(undefined)` |

#### Command Execution

| Test Case | Description | Expected Behavior |
|-----------|-------------|-------------------|
| `sendKeys_simple` | Send simple text | Text sent to pane |
| `sendKeys_withEnter` | Send text with Enter | Text sent, Enter key pressed |
| `sendKeys_literal` | Send literal text (no interpretation) | Text sent with `-l` flag |
| `runCommand_simple` | Run a command in pane | Command executed with Enter |
| `sendInterrupt_ctrlC` | Send Ctrl+C interrupt | `C-c` sent to pane |
| `clearPane_command` | Clear pane screen | `clear` command sent |

#### Output Capture

| Test Case | Description | Expected Behavior |
|-----------|-------------|-------------------|
| `capturePane_default` | Capture last 100 lines | Returns pane content string |
| `capturePane_customLines` | Capture custom line count | Returns specified number of lines |
| `capturePane_range` | Capture specific line range | Returns content from startLine to endLine |
| `capturePaneHistory_full` | Capture entire scroll buffer | Returns full history |
| `waitForPattern_found` | Wait for pattern that appears | Returns matched content |
| `waitForPrompt_found` | Wait for shell prompt | Returns `ok(undefined)` when prompt detected |

#### Claude Code Integration

| Test Case | Description | Expected Behavior |
|-----------|-------------|-------------------|
| `startClaudeCode_basic` | Start claude CLI | `claude` command sent |
| `startClaudeCode_resume` | Start with resume flag | `claude --resume` sent |
| `startClaudeCode_workdir` | Start in specific directory | `cd` then `claude` commands |
| `startClaudeCode_prompt` | Start with initial prompt | `claude -p "..."` sent |
| `sendToClaudeCode_message` | Send message to running Claude | Text sent with Enter |
| `isClaudeCodeRunning_true` | Detect running Claude Code | Returns `true` when indicators present |

#### Layout and Cleanup

| Test Case | Description | Expected Behavior |
|-----------|-------------|-------------------|
| `applyLayout_tiled` | Apply tiled layout | Layout applied to session |
| `resizePane_width` | Resize pane width | Pane width changed |
| `resizePane_direction` | Resize in direction with amount | Pane resized |
| `killAllSwarmSessions` | Kill all swarm sessions | All `swarm_*` sessions killed |
| `cleanupOrphanedSessions_old` | Clean sessions older than threshold | Old sessions removed |

### Tmux Edge Cases

#### Tmux Availability

| Test Case | Severity | Description | Expected Behavior |
|-----------|----------|-------------|-------------------|
| `isTmuxAvailable_notInstalled` | HIGH | Tmux not in PATH | Returns `false` |
| `getTmuxVersion_wrongVersion` | MEDIUM | Tmux version incompatible | Should return version string, caller validates |
| `isTmuxServerRunning_noServer` | HIGH | Server not started | Returns `false` |
| `createSession_tmuxNotAvailable` | HIGH | Create session without tmux | Should fail gracefully with error |

#### Session Name Edge Cases

| Test Case | Severity | Description | Expected Behavior |
|-----------|----------|-------------|-------------------|
| `createSession_alreadyExists` | MEDIUM | Session name collision | Returns `err` with `SESSION_EXISTS` code |
| `createSession_emptyName` | HIGH | Empty session name | Validation fails |
| `createSession_veryLongName` | LOW | Session name > 256 chars | May fail at tmux level |
| `createSession_unicodeName` | MEDIUM | Unicode characters in name | Validation rejects (pattern requires alphanumeric) |
| `createSession_withSpaces` | MEDIUM | Spaces in name | Validation rejects |
| `createSession_startsWithNumber` | LOW | Name starting with digit | Should work (pattern allows) |

#### Pane Edge Cases

| Test Case | Severity | Description | Expected Behavior |
|-----------|----------|-------------|-------------------|
| `createPane_sessionNotFound` | HIGH | Create pane in non-existent session | Returns `SESSION_NOT_FOUND` error |
| `createPane_tooManyPanes` | MEDIUM | Create pane when at limit | Tmux handles limit |
| `createPaneGrid_zeroPanes` | MEDIUM | Request 0 panes | Returns error "count must be at least 1" |
| `createPaneGrid_negativePanes` | MEDIUM | Request negative count | Validation should reject |
| `killPane_lastPane` | MEDIUM | Kill last pane in window | May kill window/session |
| `selectPane_notFound` | MEDIUM | Select non-existent pane | Returns `PANE_NOT_FOUND` error |

#### Command Execution Edge Cases

| Test Case | Severity | Description | Expected Behavior |
|-----------|----------|-------------|-------------------|
| `sendKeys_emptyString` | LOW | Send empty string | Sends nothing, no error |
| `sendKeys_veryLongText` | MEDIUM | Send text > 64KB | May need chunking |
| `sendKeys_specialChars` | MEDIUM | Send shell metacharacters | Literal flag should protect |
| `sendKeys_controlSequences` | MEDIUM | Send control sequences | Depends on literal flag |
| `waitForPattern_timeout` | MEDIUM | Pattern never appears | Returns timeout error after `timeoutMs` |
| `waitForPrompt_noPrompt` | MEDIUM | No shell prompt pattern | Returns timeout error |

#### Capture Edge Cases

| Test Case | Severity | Description | Expected Behavior |
|-----------|----------|-------------|-------------------|
| `capturePane_emptyPane` | LOW | Capture empty pane | Returns empty string |
| `capturePane_binaryContent` | MEDIUM | Pane has binary/escape codes | May include escape sequences |
| `capturePane_hugeBuffer` | MEDIUM | Capture very large scroll buffer | Memory considerations |
| `capturePane_paneNotFound` | MEDIUM | Pane doesn't exist | Returns `PANE_NOT_FOUND` error |

#### Cleanup Edge Cases

| Test Case | Severity | Description | Expected Behavior |
|-----------|----------|-------------|-------------------|
| `cleanupOrphanedSessions_noTimestamp` | MEDIUM | Session name without timestamp | Skipped (no match for pattern) |
| `cleanupOrphanedSessions_futureTimestamp` | LOW | Timestamp in future | Not cleaned up |
| `killAllSwarmSessions_someAttached` | MEDIUM | Some sessions are attached | Should still kill |

### Tmux Suboptimal Behaviors

#### Orphaned Sessions

| Issue | Severity | Description | Impact |
|-------|----------|-------------|--------|
| `orphanedSession_crash` | HIGH | Session persists after parent process crash | Resource leak, confusion |
| `orphanedSession_noCleanup` | HIGH | `killSession` fails silently | Sessions accumulate |
| `orphanedSession_partialCreate` | MEDIUM | Session created but pane setup fails | Orphaned empty session |

**Code Location:** Lines 268-304 (`createSession`, `killSession`)

**Analysis:** The `killSession` function is idempotent but there's no mechanism to detect sessions that were created but never properly initialized. The cleanup relies on timestamps in session names, but if a crash occurs between session creation and the first cleanup check, sessions may persist.

**Recommendation:** Implement a session registry or heartbeat mechanism. Consider using tmux environment variables to track session ownership.

#### Zombie Processes

| Issue | Severity | Description | Impact |
|-------|----------|-------------|--------|
| `zombieProcess_noWait` | MEDIUM | `runTmux` doesn't always wait for exit | Process table pollution |
| `zombieProcess_interruptedCapture` | LOW | Capture interrupted mid-process | Unlikely but possible |

**Code Location:** Lines 182-193 (`runTmux`)

**Analysis:** The `runTmux` helper always waits for `proc.exited`, which should prevent zombies. However, if the calling code throws before awaiting the returned promise, processes could be orphaned.

#### Race Conditions

| Issue | Severity | Description | Impact |
|-------|----------|-------------|--------|
| `race_createDestroy` | MEDIUM | Create and destroy same session concurrently | Undefined behavior |
| `race_doubleCreate` | MEDIUM | Two creates for same name | One fails with `SESSION_EXISTS` |
| `race_captureKill` | LOW | Capture while killing pane | Capture may fail |

**Code Location:** Lines 268-304, 507-521

**Analysis:** Session operations check for existence before creating, but there's a TOCTOU (time-of-check-time-of-use) window. If two processes try to create `swarm_123` simultaneously:
1. Process A checks: session doesn't exist
2. Process B checks: session doesn't exist
3. Process A creates: succeeds
4. Process B creates: fails (SESSION_EXISTS)

This is handled, but could cause confusion in logs.

#### Command Timeouts

| Issue | Severity | Description | Impact |
|-------|----------|-------------|--------|
| `timeout_runTmux` | HIGH | No timeout on `runTmux` calls | Hangs indefinitely |
| `timeout_waitForPattern` | MEDIUM | Default 60s may be too long | Slow failure detection |

**Code Location:** Lines 182-193, 661-693

**Analysis:** The `runTmux` function has no timeout. If tmux hangs (e.g., waiting for terminal input), the entire process hangs. The `waitForPattern` has configurable timeouts but `runTmux` does not.

**Recommendation:** Add timeout parameter to `runTmux` using `Promise.race` with a timeout promise.

#### Cleanup Failures

| Issue | Severity | Description | Impact |
|-------|----------|-------------|--------|
| `cleanup_partialState` | MEDIUM | Some sessions killed, some not | Inconsistent state |
| `cleanup_noRetry` | MEDIUM | Failed cleanup not retried | Resources left behind |

**Code Location:** Lines 892-922 (`killAllSwarmSessions`, `cleanupOrphanedSessions`)

**Analysis:** `killAllSwarmSessions` iterates sessions sequentially. If one fails to kill, it continues to the next but doesn't report which failed or retry.

### Tmux Security Concerns

#### Command Injection via Session Names

| Issue | Severity | Description | Mitigation Status |
|-------|----------|-------------|-------------------|
| `injection_sessionName` | CRITICAL | Shell metacharacters in session name | MITIGATED |

**Code Location:** Lines 203-208 (`validateSessionName`), Lines 119-120 (pattern)

**Analysis:** Session names are validated against `SESSION_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/`. This effectively prevents command injection through session names.

**Test Cases Needed:**
- `validateSessionName_shellChars`: Test `test; rm -rf /`
- `validateSessionName_backticks`: Test `` `whoami` ``
- `validateSessionName_dollarSign`: Test `$HOME`
- `validateSessionName_pipes`: Test `test|cat`

**Verdict:** PROPERLY MITIGATED

#### Path Injection in Workdir

| Issue | Severity | Description | Mitigation Status |
|-------|----------|-------------|-------------------|
| `injection_workdir` | HIGH | Shell metacharacters in workdir path | MITIGATED |

**Code Location:** Lines 214-218 (`validatePath`), Lines 732-741 (`startClaudeCode`)

**Analysis:** The `validatePath` function rejects paths containing: `; & | \` $ ( ) { } [ ] < > \ ' " ! # * ? ~ \n \r`. This prevents most injection attacks.

**Potential Bypass:** Path traversal is NOT blocked. A path like `../../../etc` would pass validation.

**Test Cases Needed:**
- `validatePath_traversal`: Test `../../../etc/passwd`
- `validatePath_nullByte`: Test `/valid/path\x00; rm -rf /`
- `validatePath_longPath`: Test path > 4096 chars

**Verdict:** PARTIALLY MITIGATED - path traversal not addressed

#### Pane ID Injection

| Issue | Severity | Description | Mitigation Status |
|-------|----------|-------------|-------------------|
| `injection_paneId` | MEDIUM | Malicious pane IDs | NOT VALIDATED |

**Code Location:** Lines 530-566 (`sendKeys`), Lines 507-521 (`killPane`)

**Analysis:** Pane IDs are passed directly to tmux commands without validation. While pane IDs come from tmux itself (format `%N`), if an attacker could control the pane ID parameter, they might inject commands.

**Risk Assessment:** LOW - Pane IDs typically come from internal state, not user input.

**Recommendation:** Add validation that pane IDs match `^%\d+$` pattern.

#### Environment Variable Leakage

| Issue | Severity | Description | Mitigation Status |
|-------|----------|-------------|-------------------|
| `envLeak_spawn` | LOW | Bun.spawn inherits environment | NOT ADDRESSED |

**Code Location:** Lines 183-186

**Analysis:** `Bun.spawn` inherits the parent process environment. Sensitive environment variables (API keys, tokens) could leak to tmux sessions.

**Recommendation:** Explicitly control which environment variables are passed.

---

## Worktree Manager Analysis

**File:** `/home/carso/code/claude-swarm/src/managers/worktree.ts`

The worktree manager provides git worktree lifecycle management for agent isolation.

### Worktree Base Cases

#### Repository Validation

| Test Case | Description | Expected Behavior |
|-----------|-------------|-------------------|
| `isGitRepository_true` | Inside git repository | Returns `true` |
| `isGitRepository_false` | Outside git repository | Returns `false` |
| `getGitRoot_valid` | Get repo root path | Returns absolute path |
| `hasCommits_true` | Repo with commits | Returns `true` |
| `hasCommits_false` | Empty repo | Returns `false` |
| `getCurrentBranch_normal` | On a branch | Returns branch name |
| `getCurrentBranch_detached` | Detached HEAD | Returns "HEAD" |
| `branchExists_true` | Branch exists | Returns `true` |
| `getMainBranch_main` | Main branch is "main" | Returns "main" |
| `getMainBranch_master` | Main branch is "master" | Returns "master" |
| `validateRepository_valid` | Valid repo with commits | Returns `ok(undefined)` |

#### Worktree Creation

| Test Case | Description | Expected Behavior |
|-----------|-------------|-------------------|
| `createWorktree_researcher` | Create researcher worktree | Worktree created, path returned |
| `createWorktree_developer` | Create developer worktree | Worktree created with correct branch |
| `createWorktree_withBaseBranch` | Specify base branch | Worktree branched from specified branch |
| `createWorktree_copyConfig` | Copy CLAUDE.md by default | Config file copied to worktree |
| `createWorktree_skipConfig` | Skip config copy | No CLAUDE.md in worktree |
| `createWorktrees_multiple` | Create worktrees for multiple roles | All worktrees created, map returned |
| `generateBranchName_format` | Generate branch name | Returns `swarm/{role}-{sessionId}` |
| `getWorktreePath_format` | Get expected path | Returns `{root}/.worktrees/{role}` |

#### Role Configuration

| Test Case | Description | Expected Behavior |
|-----------|-------------|-------------------|
| `getRoleConfigPath_valid` | Get config path | Returns `{root}/roles/{role}/CLAUDE.md` |
| `roleConfigExists_true` | Config exists | Returns `true` |
| `roleConfigExists_false` | Config missing | Returns `false` |
| `copyRoleConfig_success` | Copy config to worktree | File copied successfully |
| `updateRoleConfig_success` | Re-copy config | Updated config in worktree |

#### Worktree Removal

| Test Case | Description | Expected Behavior |
|-----------|-------------|-------------------|
| `removeWorktree_normal` | Remove existing worktree | Worktree and branch removed |
| `removeWorktree_force` | Force remove with changes | Worktree removed despite changes |
| `removeWorktree_keepBranch` | Remove but keep branch | Worktree removed, branch preserved |
| `removeAllWorktrees_multiple` | Remove all swarm worktrees | All worktrees removed, count returned |
| `pruneWorktrees` | Prune stale references | Git worktree prune executed |

#### Listing and Discovery

| Test Case | Description | Expected Behavior |
|-----------|-------------|-------------------|
| `listAllWorktrees` | List all git worktrees | Returns all worktrees including main |
| `listWorktrees_swarmOnly` | List swarm worktrees | Returns only `.worktrees/` worktrees |
| `getWorktreeInfo_exists` | Get info for role | Returns `WorktreeInfo` object |
| `worktreeExists_true` | Check worktree exists | Returns `true` |
| `worktreeExists_false` | Check non-existent | Returns `false` |

#### State Management

| Test Case | Description | Expected Behavior |
|-----------|-------------|-------------------|
| `lockWorktree_success` | Lock worktree | Lock applied |
| `lockWorktree_withReason` | Lock with reason | Lock with message |
| `unlockWorktree_success` | Unlock worktree | Lock removed |
| `unlockWorktree_alreadyUnlocked` | Unlock unlocked worktree | Returns `ok` (idempotent) |
| `getWorktreeHead_valid` | Get HEAD SHA | Returns 40-char SHA |
| `hasUncommittedChanges_true` | Worktree has changes | Returns `true` |
| `hasUncommittedChanges_false` | Worktree is clean | Returns `false` |

#### Cleanup

| Test Case | Description | Expected Behavior |
|-----------|-------------|-------------------|
| `cleanupOrphanedWorktrees_old` | Remove old worktrees | Stale worktrees removed |
| `cleanupSwarmBranches_orphaned` | Remove orphaned branches | Branches without worktrees deleted |
| `fullCleanup` | Complete cleanup | Worktrees, branches removed, dir cleaned |

### Worktree Edge Cases

#### Git Availability

| Test Case | Severity | Description | Expected Behavior |
|-----------|----------|-------------|-------------------|
| `isGitRepository_gitNotInstalled` | HIGH | Git not in PATH | Returns `false` or throws |
| `isGitRepository_corruptedRepo` | HIGH | `.git` directory corrupted | Returns `false` |
| `hasCommits_bareRepo` | MEDIUM | Bare repository | May behave differently |

#### Repository State Edge Cases

| Test Case | Severity | Description | Expected Behavior |
|-----------|----------|-------------|-------------------|
| `createWorktree_notARepo` | HIGH | Not in a git repo | Returns `NOT_A_REPO` error |
| `createWorktree_noCommits` | HIGH | Repo with no commits | Returns `NOT_A_REPO` error |
| `createWorktree_detachedHead` | MEDIUM | Base is detached HEAD | Uses "HEAD" as base |
| `createWorktree_dirtyWorkdir` | LOW | Main worktree has changes | Should still work |

#### Name/Path Edge Cases

| Test Case | Severity | Description | Expected Behavior |
|-----------|----------|-------------|-------------------|
| `createWorktree_alreadyExists` | MEDIUM | Worktree path exists | Returns `WORKTREE_EXISTS` error |
| `createWorktree_invalidRole` | HIGH | Invalid role name | Returns `ROLE_NOT_FOUND` error |
| `createWorktree_emptySessionId` | HIGH | Empty session ID | Returns error |
| `createWorktree_specialCharsSessionId` | MEDIUM | Special chars in session ID | Included in branch name |
| `generateBranchName_longSessionId` | LOW | Very long session ID | May hit git limits |
| `validateWorktreePath_root` | HIGH | Path is `/` | Returns error |
| `validateWorktreePath_systemDir` | HIGH | Path is `/home` | Returns error |
| `validateWorktreePath_nested` | MEDIUM | Path like `/home/user/x` | Allowed (depth > 3) |

#### Role Configuration Edge Cases

| Test Case | Severity | Description | Expected Behavior |
|-----------|----------|-------------|-------------------|
| `copyRoleConfig_missing` | MEDIUM | CLAUDE.md doesn't exist | Returns `ROLE_NOT_FOUND` error |
| `copyRoleConfig_noPermission` | MEDIUM | Can't read source file | Returns error |
| `copyRoleConfig_destReadOnly` | MEDIUM | Worktree is read-only | Returns error |
| `copyRoleConfig_destExists` | LOW | CLAUDE.md already in worktree | Overwrites |
| `updateRoleConfig_worktreeGone` | MEDIUM | Worktree was deleted | Returns `WORKTREE_NOT_FOUND` |

#### Removal Edge Cases

| Test Case | Severity | Description | Expected Behavior |
|-----------|----------|-------------|-------------------|
| `removeWorktree_alreadyRemoved` | LOW | Worktree doesn't exist | Returns `ok` (idempotent) |
| `removeWorktree_locked` | MEDIUM | Worktree is locked | Fails unless force |
| `removeWorktree_branchInUse` | MEDIUM | Branch checked out elsewhere | Branch deletion may fail |
| `removeWorktree_processRunning` | HIGH | Process running in worktree | May fail without force |
| `removeWorktree_notInRepo` | LOW | Called outside git repo | Returns `ok` early |

#### Cleanup Edge Cases

| Test Case | Severity | Description | Expected Behavior |
|-----------|----------|-------------|-------------------|
| `cleanupOrphanedWorktrees_noTimestamp` | MEDIUM | Branch without timestamp | Skipped (createdAt = 0) |
| `cleanupSwarmBranches_currentBranch` | MEDIUM | Current branch is swarm/* | Deletion fails |
| `fullCleanup_nonEmptyDir` | LOW | `.worktrees` has other files | Directory not removed |

#### Disk/Filesystem Edge Cases

| Test Case | Severity | Description | Expected Behavior |
|-----------|----------|-------------|-------------------|
| `createWorktree_diskFull` | HIGH | No disk space | Git fails, error returned |
| `createWorktree_quotaExceeded` | HIGH | Disk quota exceeded | Git fails |
| `createWorktree_nfsLatency` | MEDIUM | High latency network FS | May timeout |
| `copyRoleConfig_atomicity` | MEDIUM | Copy interrupted | Partial file possible |
| `removeWorktree_permissionDenied` | MEDIUM | No delete permission | Fails |

### Worktree Suboptimal Behaviors

#### Orphaned Worktrees

| Issue | Severity | Description | Impact |
|-------|----------|-------------|--------|
| `orphanedWorktree_crash` | HIGH | Worktrees persist after crash | Disk space consumed |
| `orphanedWorktree_noRegistry` | MEDIUM | No tracking of owned worktrees | Can't identify orphans |
| `orphanedBranch_afterRemove` | MEDIUM | Branch deletion fails silently | Git branch pollution |

**Code Location:** Lines 576-634 (`removeWorktree`)

**Analysis:** If `removeWorktree` is interrupted between worktree removal and branch deletion, the branch is orphaned. The `cleanupSwarmBranches` function can clean these up, but it's not automatically called.

**Recommendation:** Consider atomic cleanup or transaction-like approach. Register created resources for cleanup on failure.

#### Race Conditions

| Issue | Severity | Description | Impact |
|-------|----------|-------------|--------|
| `race_createSameRole` | HIGH | Two creates for same role | Directory conflict |
| `race_createRemove` | MEDIUM | Create and remove same role | Undefined outcome |
| `race_rollback` | MEDIUM | Rollback during multi-create | Partial rollback possible |

**Code Location:** Lines 369-459 (`createWorktree`), Lines 465-494 (`createWorktrees`)

**Analysis:** The `createWorktrees` function has rollback logic (lines 484-488), but if the process crashes during rollback, some worktrees are left behind.

```typescript
// Rollback all previously created worktrees
for (const [createdRole] of createdWorktrees) {
  await removeWorktree(createdRole, { force: true, deleteBranch: true });
}
```

If this loop fails partway, earlier worktrees remain.

#### Cleanup Failures

| Issue | Severity | Description | Impact |
|-------|----------|-------------|--------|
| `cleanup_silentFailure` | MEDIUM | `removeWorktree` failures not aggregated | Incomplete cleanup |
| `cleanup_noForce` | MEDIUM | Default cleanup isn't forced | Locked worktrees remain |

**Code Location:** Lines 639-657 (`removeAllWorktrees`)

**Analysis:** `removeAllWorktrees` continues on failure but only returns success count:

```typescript
if (result.ok) {
  count++;
}
```

Failed removals are silently dropped.

#### Partial State

| Issue | Severity | Description | Impact |
|-------|----------|-------------|--------|
| `partialState_worktreeNoConfig` | MEDIUM | Worktree created, config copy fails | Rollback attempted |
| `partialState_configNoBranch` | LOW | Unlikely state | N/A |

**Code Location:** Lines 448-456

**Analysis:** Good practice - rollback is attempted if config copy fails:

```typescript
if (!copyResult.ok) {
  // Rollback: remove the worktree we just created
  await runGit(['worktree', 'remove', '--force', worktreePath]);
  await runGit(['branch', '-D', branchName]);
  return copyResult;
}
```

However, if rollback fails, partial state remains.

### Worktree Security Concerns

#### Path Traversal in Worktree Paths

| Issue | Severity | Description | Mitigation Status |
|-------|----------|-------------|-------------------|
| `traversal_worktreePath` | HIGH | Worktree path outside repo | PARTIALLY MITIGATED |

**Code Location:** Lines 316-338 (`validateWorktreePath`)

**Analysis:** The validation rejects:
- Root directory `/`
- System directories: `/home`, `/usr`, `/etc`, `/var`, `/tmp`, `/bin`, `/sbin`, `/lib`
- Shallow paths under system directories (depth <= 3)

**Gaps:**
1. Does NOT reject paths outside the repository
2. Does NOT check for symlink attacks
3. Does NOT validate the path stays within `.worktrees/`

**Test Cases Needed:**
- `validatePath_symlink`: Symlink `.worktrees` -> `/etc`
- `validatePath_outsideRepo`: Path `../sibling-repo/.worktrees/role`
- `validatePath_absoluteEscape`: Path `/completely/different/path`

**Verdict:** PARTIALLY MITIGATED - System directory protection exists, but path escape not fully prevented.

Note: In practice, worktree paths are constructed internally (`join(root, WORKTREE_BASE, role)`), so user-controlled path traversal is unlikely. The concern is defense-in-depth.

#### Session ID Injection

| Issue | Severity | Description | Mitigation Status |
|-------|----------|-------------|-------------------|
| `injection_sessionId` | MEDIUM | Malicious session IDs in branch names | NOT VALIDATED |

**Code Location:** Lines 348-353 (`generateBranchName`)

**Analysis:** Session IDs are included directly in branch names without validation:

```typescript
return `${BRANCH_PREFIX}/${role}-${sessionId}`;
```

A session ID containing special characters could cause issues:
- Spaces: `swarm/researcher-test id` (invalid branch name)
- Slashes: `swarm/researcher-test/evil` (creates subdirectory)
- Control chars: May confuse git

**Impact:** LOW - Branch creation would fail at git level, but error messages might be confusing.

**Recommendation:** Validate session ID format, similar to tmux session names.

#### Branch Name Injection

| Issue | Severity | Description | Mitigation Status |
|-------|----------|-------------|-------------------|
| `injection_branchDelete` | MEDIUM | Malicious branch names in cleanup | PARTIALLY MITIGATED |

**Code Location:** Lines 889-898 (`cleanupSwarmBranches`)

**Analysis:** Branch names from git output are used directly in `git branch -D`:

```typescript
const deleteResult = await runGit(['branch', '-D', branch]);
```

If a malicious branch name somehow contained shell metacharacters, it could be a problem. However:
1. Git itself validates branch names
2. Branch names come from `git branch --list` output
3. The branch name is passed as an argument, not through shell

**Verdict:** LOW RISK - Git's own validation prevents dangerous branch names.

#### File Overwrite via Config Copy

| Issue | Severity | Description | Mitigation Status |
|-------|----------|-------------|-------------------|
| `overwrite_claudemd` | LOW | Overwrites existing CLAUDE.md | BY DESIGN |

**Code Location:** Lines 522-552 (`copyRoleConfig`)

**Analysis:** If a worktree already has a CLAUDE.md (from a previous run or manually created), it will be overwritten without warning.

**Impact:** LOW - This is expected behavior, and worktrees are meant to be ephemeral.

#### Privilege Escalation

| Issue | Severity | Description | Mitigation Status |
|-------|----------|-------------|-------------------|
| `privilege_gitCommands` | LOW | Git commands run as current user | N/A |
| `privilege_fileOperations` | LOW | File operations as current user | N/A |

**Analysis:** All operations run as the current user. No privilege escalation vectors identified. The module doesn't:
- Execute arbitrary user-provided commands
- Change file permissions in dangerous ways
- Access files outside the repository (except source CLAUDE.md)

---

## Cross-Module Concerns

### Integration Points

| Concern | Severity | Description |
|---------|----------|-------------|
| `integration_sessionWorktreeMismatch` | HIGH | Tmux session exists but worktree doesn't | Inconsistent state |
| `integration_worktreeSessionMismatch` | HIGH | Worktree exists but tmux session doesn't | Orphaned resources |
| `integration_cleanupOrder` | MEDIUM | Must clean tmux before worktrees | Processes still running |

### Shared Failure Modes

| Failure Mode | Tmux Impact | Worktree Impact |
|--------------|-------------|-----------------|
| Process crash | Orphaned sessions | Orphaned worktrees and branches |
| Disk full | Session creation fails | Worktree creation fails |
| Permission denied | Can't access tmux socket | Can't write worktrees |
| Network filesystem | Slow operations | Slow operations, potential corruption |

### Missing Coordination

| Gap | Description | Recommendation |
|-----|-------------|----------------|
| No transaction | No atomic create/destroy across both | Implement saga pattern |
| No registry | No central tracking of resources | Add resource registry to SQLite |
| No health check | Can't verify paired resources exist | Add health check function |

---

## Recommended Test Matrix

### Priority 1 (Critical - Must Have)

| Module | Test Category | Count |
|--------|---------------|-------|
| tmux | Session creation/destruction | 8 |
| tmux | Command injection prevention | 6 |
| worktree | Repository validation | 6 |
| worktree | Path traversal prevention | 5 |
| worktree | Worktree creation/removal | 10 |

### Priority 2 (High - Should Have)

| Module | Test Category | Count |
|--------|---------------|-------|
| tmux | Pane management | 8 |
| tmux | Command execution | 6 |
| tmux | Cleanup functions | 4 |
| worktree | Role configuration | 5 |
| worktree | Cleanup functions | 5 |
| worktree | Lock/unlock operations | 4 |

### Priority 3 (Medium - Nice to Have)

| Module | Test Category | Count |
|--------|---------------|-------|
| tmux | Output capture | 5 |
| tmux | Layout management | 4 |
| tmux | Claude Code helpers | 5 |
| worktree | Listing functions | 4 |
| worktree | State queries | 4 |

### Mock/Stub Requirements

| Dependency | Mock Approach |
|------------|---------------|
| tmux binary | Mock `runTmux` function |
| git binary | Mock `runGit` function |
| Filesystem | Use temp directories |
| Bun.spawn | Not easily mockable - use integration tests |

### Integration Test Requirements

| Scenario | Prerequisites |
|----------|---------------|
| Full tmux lifecycle | tmux installed, no conflicting sessions |
| Full worktree lifecycle | git installed, inside git repo with commits |
| Cross-module lifecycle | Both tmux and git, clean state |

---

## Summary

### Tmux Manager

**Strengths:**
- Session name validation prevents command injection
- Path validation for workdir prevents most injection attacks
- Idempotent cleanup operations
- Result type provides clear error handling

**Weaknesses:**
- No timeout on `runTmux` calls
- Limited pane ID validation
- No mechanism to detect crashed session ownership
- Environment variable inheritance could leak secrets

### Worktree Manager

**Strengths:**
- Repository validation before operations
- System directory protection
- Rollback on partial creation failure
- Idempotent removal operations
- Lock mechanism for protection

**Weaknesses:**
- Session ID not validated
- Path traversal partially prevented but not fully
- Cleanup failures are silent
- No coordination with tmux manager

### Overall Risk Assessment

| Risk Level | Count | Examples |
|------------|-------|----------|
| Critical | 0 | - |
| High | 4 | Orphaned resources, race conditions, no timeouts |
| Medium | 12 | Silent failures, partial mitigation, edge cases |
| Low | 8 | Minor validation gaps, unlikely scenarios |

The modules are reasonably well-designed with good error handling. The main gaps are around resource coordination, timeout handling, and comprehensive validation of user-controlled inputs.
