# Step 5: Worktree Manager - Architectural Plan

## 1. Overview & Purpose

### What This Component Does

The Worktree Manager provides git worktree lifecycle management for agent isolation. Each agent in the swarm runs in its own git worktree, which is a separate working directory with its own branch. This prevents file conflicts when multiple Claude Code instances work simultaneously on the same codebase.

### Why It Exists

Without isolation, multiple Claude Code instances would:
- Overwrite each other's file changes
- Create merge conflicts in real-time
- Have no clear ownership of modifications
- Make it impossible to track which agent made which changes

Git worktrees solve this by giving each agent a complete copy of the repository with its own branch, while sharing the underlying git objects (making it disk-efficient).

### How It Fits Into The Larger System

```
┌─────────────────────────────────────────────────────────────────┐
│                      ORCHESTRATOR                                │
│  Uses worktree-manager to create isolated workspaces            │
│  before spawning agents in tmux panes                           │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                   WORKTREE MANAGER                               │
│  - Creates .worktrees/{role}/ directories                       │
│  - Creates swarm/{role}-{timestamp} branches                    │
│  - Copies role CLAUDE.md into worktree root                     │
│  - Handles cleanup when agents finish                           │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    GIT WORKTREES                                 │
│  .worktrees/researcher/  ← branch: swarm/researcher-1234567     │
│  .worktrees/developer/   ← branch: swarm/developer-1234567      │
│  .worktrees/reviewer/    ← branch: swarm/reviewer-1234567       │
│  .worktrees/architect/   ← branch: swarm/architect-1234567      │
└─────────────────────────────────────────────────────────────────┘
```

### Problems It Solves

1. **Agent Isolation**: Each agent has its own working directory
2. **Branch Per Agent**: Changes on one agent's branch don't affect others
3. **Merge-Ready Output**: Agent work can be merged via standard git workflow
4. **Role Configuration**: Each worktree gets the agent's CLAUDE.md persona file
5. **Clean Cleanup**: Worktrees and branches can be removed atomically

---

## 2. Prerequisites & Dependencies

### External Dependencies

| Dependency | Version | Purpose |
|------------|---------|---------|
| Git | 2.20+ | Core worktree operations (2.5+ minimum, 2.20+ recommended for better error handling) |
| Bun | 1.0+ | Runtime, shell command execution via `$` template literal |

### Internal Dependencies

| Module | Purpose |
|--------|---------|
| `src/types.ts` | Shared types including `AgentRole`, `Result<T, E>` |

### System State Requirements

- Current directory must be inside a git repository
- Repository must have at least one commit (worktrees branch from existing commits)
- Role configuration files must exist in `roles/{role}/CLAUDE.md` (created in Step 6)

---

## 3. Public API Design

### Type Definitions

```typescript
// Agent roles supported by the system
type AgentRole = 'researcher' | 'developer' | 'reviewer' | 'architect';

// Information about an existing worktree
interface WorktreeInfo {
  path: string;           // Absolute path to worktree directory
  branch: string;         // Full branch name (e.g., "swarm/researcher-1234567")
  role: AgentRole;        // Which agent role this worktree belongs to
  head: string;           // Current commit SHA (40 characters)
  isLocked: boolean;      // Whether worktree is locked against removal
  createdAt: number;      // Unix timestamp extracted from branch name
}

// Structured error with machine-readable code
interface WorktreeError extends Error {
  code: WorktreeErrorCode;
  details?: string;
}

type WorktreeErrorCode =
  | 'NOT_A_REPO'           // Not in a git repository or no commits
  | 'WORKTREE_EXISTS'      // Worktree already exists at target path
  | 'WORKTREE_NOT_FOUND'   // Referenced worktree doesn't exist
  | 'BRANCH_EXISTS'        // Branch name already taken
  | 'GIT_FAILED'           // Git command failed unexpectedly
  | 'ROLE_NOT_FOUND'       // Role CLAUDE.md doesn't exist
  | 'CLEANUP_FAILED';      // Failed to remove worktree or branch

// Options for worktree creation
interface CreateWorktreeOptions {
  sessionId: string;       // REQUIRED: Session ID from orchestrator (for branch name grouping)
  baseBranch?: string;     // Branch to create worktree from (default: current)
  copyRoleConfig?: boolean; // Whether to copy CLAUDE.md (default: true)
}

// Options for worktree removal
interface RemoveWorktreeOptions {
  force?: boolean;         // Remove even if worktree has changes
  deleteBranch?: boolean;  // Also delete the branch (default: true)
}
```

### Function Signatures

```typescript
// === Repository Validation ===

// Check if current directory is inside a git work tree
function isGitRepository(): Promise<boolean>;

// Get absolute path to repository root
function getGitRoot(): Promise<string | null>;

// Check if repository has at least one commit
function hasCommits(): Promise<boolean>;

// Get name of current branch
function getCurrentBranch(): Promise<string | null>;

// Check if a specific branch exists
function branchExists(branchName: string): Promise<boolean>;

// Validate repository is ready for worktree operations
// Returns error if not a repo or has no commits
function validateRepository(): Promise<Result<void, WorktreeError>>;


// === Worktree Creation ===

// Generate branch name from role and session ID (sessionId is REQUIRED, provided by orchestrator)
function generateBranchName(role: AgentRole, sessionId: string): string;

// Get the filesystem path where a role's worktree would be
function getWorktreePath(role: AgentRole): string;

// Create a single worktree for an agent role
function createWorktree(
  role: AgentRole,
  options?: CreateWorktreeOptions
): Promise<Result<string, WorktreeError>>;

// Create worktrees for multiple roles atomically
// If any creation fails, all previously created are rolled back
function createWorktrees(
  roles: AgentRole[],
  options: { sessionId: string; baseBranch?: string }
): Promise<Result<Map<AgentRole, string>, WorktreeError>>;


// === Role Configuration ===

// Get path to a role's CLAUDE.md source file
function getRoleConfigPath(role: AgentRole): string;

// Check if a role's CLAUDE.md exists
function roleConfigExists(role: AgentRole): boolean;

// Copy role CLAUDE.md into a worktree's root directory
function copyRoleConfig(
  role: AgentRole,
  worktreePath: string
): Promise<Result<void, WorktreeError>>;

// Re-copy role config (for updating after CLAUDE.md changes)
function updateRoleConfig(role: AgentRole): Promise<Result<void, WorktreeError>>;


// === Worktree Removal ===

// Remove a single worktree and optionally its branch
function removeWorktree(
  role: AgentRole,
  options?: RemoveWorktreeOptions
): Promise<Result<void, WorktreeError>>;

// Remove all swarm worktrees
function removeAllWorktrees(
  options?: { force?: boolean; deleteBranches?: boolean }
): Promise<Result<number, WorktreeError>>;

// Prune stale worktree references from git
function pruneWorktrees(): Promise<void>;


// === Worktree Listing and Discovery ===

// List all git worktrees (including main and non-swarm)
function listAllWorktrees(): Promise<Array<{
  path: string;
  branch: string;
  head: string;
}>>;

// List only swarm worktrees (in .worktrees/ directory)
function listWorktrees(): Promise<WorktreeInfo[]>;

// Get detailed info about a specific role's worktree
function getWorktreeInfo(role: AgentRole): Promise<WorktreeInfo | null>;

// Check if a worktree exists for a given role
function worktreeExists(role: AgentRole): Promise<boolean>;


// === Worktree Operations ===

// Lock a worktree to prevent accidental removal
function lockWorktree(
  role: AgentRole,
  reason?: string
): Promise<Result<void, WorktreeError>>;

// Unlock a previously locked worktree
function unlockWorktree(role: AgentRole): Promise<Result<void, WorktreeError>>;

// Get current HEAD commit SHA for a worktree
function getWorktreeHead(role: AgentRole): Promise<string | null>;

// Check if worktree has uncommitted changes
function hasUncommittedChanges(role: AgentRole): Promise<boolean>;


// === Cleanup Utilities ===

// Remove worktrees older than specified age
function cleanupOrphanedWorktrees(maxAgeMs?: number): Promise<number>;

// Delete swarm/* branches that don't have active worktrees
function cleanupSwarmBranches(): Promise<number>;

// Full cleanup: all worktrees, branches, and empty directories
function fullCleanup(): Promise<{ worktrees: number; branches: number }>;


// === Constants (exported for testing/configuration) ===

const WORKTREE_BASE: string;   // ".worktrees"
const ROLES_DIR: string;       // "roles"
const BRANCH_PREFIX: string;   // "swarm"
const VALID_ROLES: AgentRole[]; // All valid role values
```

---

## 4. Detailed Behavior Specifications

### `createWorktree(role, options?)`

**Purpose**: Create an isolated working directory for an agent.

**Parameters**:
- `role`: Must be one of `VALID_ROLES` ('researcher', 'developer', 'reviewer', 'architect')
- `options.sessionId`: REQUIRED - Session ID from orchestrator. Used in branch name for grouping worktrees from same session.
- `options.baseBranch`: Branch to create worktree from. If omitted, uses current branch. If current branch unavailable, uses 'HEAD'.
- `options.copyRoleConfig`: If `false`, skips copying CLAUDE.md. Default `true`.

**Behavior**:
1. Validate role is in `VALID_ROLES`
2. Call `validateRepository()` to ensure git repo exists with commits
3. Check if worktree already exists at target path → return `WORKTREE_EXISTS` error
4. Create `.worktrees/` directory if it doesn't exist
5. Generate branch name: `swarm/{role}-{sessionId}`
   - sessionId is REQUIRED (provided by orchestrator)
   - If sessionId is not provided, throw error: "sessionId is required"
6. Execute: `git worktree add {path} -b {branchName} {baseBranch}`
7. If `copyRoleConfig !== false`, copy role's CLAUDE.md to worktree root
8. If CLAUDE.md copy fails, remove the worktree and return error
9. Return absolute path to created worktree

**Success Output**: `Result.ok("/absolute/path/to/.worktrees/{role}")`

**Error Conditions**:
- Invalid role → `ROLE_NOT_FOUND`
- Not a git repo → `NOT_A_REPO`
- Worktree path exists → `WORKTREE_EXISTS`
- Git command fails → `GIT_FAILED` with stderr in details
- CLAUDE.md missing → `ROLE_NOT_FOUND`

**Side Effects**:
- Creates directory at `.worktrees/{role}/`
- Creates branch `swarm/{role}-{timestamp}`
- Creates file `.worktrees/{role}/CLAUDE.md`

**Example**:
```
Input:  createWorktree('researcher', { sessionId: 'abc123' })
Output: ok("/home/user/project/.worktrees/researcher")

Branch created: swarm/researcher-abc123
Files: .worktrees/researcher/ (full repo) + CLAUDE.md
```

---

### `createWorktrees(roles, options?)`

**Purpose**: Create multiple worktrees atomically. If any fails, all are rolled back.

**Parameters**:
- `roles`: Array of roles to create worktrees for
- `options.sessionId`: REQUIRED - Shared session ID from orchestrator for all worktrees
- `options.baseBranch`: Branch to create all worktrees from

**Behavior**:
1. Validate sessionId is provided (REQUIRED - must come from orchestrator)
   - If not provided, throw error: "sessionId is required"
2. For each role in order:
   - Call `createWorktree(role, { sessionId, baseBranch })`
   - If creation fails, remove all previously created worktrees and return error
   - Track successful paths in a Map
3. Return Map of role → path

**Atomicity Guarantee**: Either all worktrees are created, or none are (rollback on failure).

**Success Output**: `Result.ok(Map { 'researcher' => '/path', 'developer' => '/path', ... })`

---

### `removeWorktree(role, options?)`

**Purpose**: Remove a worktree and optionally its associated branch.

**Parameters**:
- `role`: The agent role whose worktree to remove
- `options.force`: If `true`, removes even if worktree has uncommitted changes
- `options.deleteBranch`: If `true` (default), also deletes the branch after removing worktree

**Behavior**:
1. Get worktree info to extract branch name
2. Execute: `git worktree remove {path}` (add `--force` if option set)
3. If removal fails because worktree doesn't exist, that's OK (idempotent)
4. If removal fails and path exists but isn't valid worktree, `rm -rf` the directory
5. If `deleteBranch` (default true) and branch name known, execute: `git branch -D {branch}`
6. Ignore branch deletion failures (branch may not exist)

**Idempotency**: Calling on already-removed worktree succeeds silently.

---

### `listWorktrees()`

**Purpose**: Get information about all swarm worktrees.

**Behavior**:
1. Execute: `git worktree list --porcelain`
2. Parse output to extract worktree path, branch, and HEAD
3. Filter to only worktrees inside `.worktrees/` directory
4. For each, validate role name from path is in `VALID_ROLES`
5. Extract timestamp from branch name pattern `swarm/{role}-{timestamp}`
6. Check lock status from porcelain output

**Output**: Array of `WorktreeInfo` objects, may be empty if no swarm worktrees exist.

---

### `fullCleanup()`

**Purpose**: Complete cleanup of all swarm artifacts.

**Behavior**:
1. Call `removeAllWorktrees({ force: true, deleteBranches: true })`
2. Call `cleanupSwarmBranches()` to catch any orphaned branches
3. Call `pruneWorktrees()` to clean git references
4. If `.worktrees/` directory is empty, remove it
5. Return counts of removed worktrees and branches

---

## 5. Data Structures

### Worktree Directory Layout

```
.worktrees/
├── researcher/                  # Worktree for researcher agent
│   ├── .git                     # File (not directory) pointing to main repo's .git
│   ├── CLAUDE.md                # Copied from roles/researcher/CLAUDE.md
│   ├── src/                     # Full project source (same as main repo)
│   ├── package.json             # Full project files
│   └── ...                      # Everything from the repo
├── developer/
│   ├── .git
│   ├── CLAUDE.md                # Copied from roles/developer/CLAUDE.md
│   └── ...
├── reviewer/
│   └── ...
└── architect/
    └── ...
```

### Git Worktree Porcelain Format

The output of `git worktree list --porcelain` is parsed to build `WorktreeInfo`:

```
worktree /absolute/path/to/main
HEAD abc123def456...
branch refs/heads/main

worktree /absolute/path/to/.worktrees/researcher
HEAD def789abc012...
branch refs/heads/swarm/researcher-1234567890
locked
```

Fields per worktree entry:
- `worktree {path}` - Absolute path
- `HEAD {sha}` - 40-character commit SHA
- `branch refs/heads/{name}` - Full ref, strip prefix to get branch name
- `locked` - Present if worktree is locked (optional line)
- Empty line separates entries

### Branch Naming Convention

```
Pattern:  swarm/{role}-{timestamp}
Examples: swarm/researcher-1703849234567
          swarm/developer-1703849234567
          swarm/reviewer-test-session-123

Breakdown:
- "swarm/"      - Prefix identifying swarm-managed branches
- "{role}"      - Agent role (researcher, developer, reviewer, architect)
- "-"           - Separator
- "{timestamp}" - Unix timestamp (ms) or custom session ID
```

---

## 6. Internal Architecture

### Module Organization

```
src/worktree-manager.ts
├── Constants
│   ├── WORKTREE_BASE = ".worktrees"
│   ├── ROLES_DIR = "roles"
│   ├── BRANCH_PREFIX = "swarm"
│   └── VALID_ROLES = [...]
│
├── Error Factory
│   └── createWorktreeError(code, message, details)
│
├── Git Validation Functions
│   ├── isGitRepository()
│   ├── getGitRoot()
│   ├── hasCommits()
│   ├── getCurrentBranch()
│   ├── branchExists()
│   └── validateRepository()
│
├── Core Worktree Functions
│   ├── generateBranchName()
│   ├── getWorktreePath()
│   ├── createWorktree()
│   ├── createWorktrees()
│   ├── removeWorktree()
│   └── removeAllWorktrees()
│
├── Role Configuration Functions
│   ├── getRoleConfigPath()
│   ├── roleConfigExists()
│   ├── copyRoleConfig()
│   └── updateRoleConfig()
│
├── Listing Functions
│   ├── listAllWorktrees()
│   ├── listWorktrees()
│   ├── getWorktreeInfo()
│   └── worktreeExists()
│
├── Worktree State Functions
│   ├── lockWorktree()
│   ├── unlockWorktree()
│   ├── getWorktreeHead()
│   └── hasUncommittedChanges()
│
└── Cleanup Functions
    ├── pruneWorktrees()
    ├── cleanupOrphanedWorktrees()
    ├── cleanupSwarmBranches()
    └── fullCleanup()
```

### Data Flow: Creating Worktrees for a Session

```
startWorkflow(type, goal)
        │
        ▼
createWorktrees(['researcher', 'developer', 'reviewer'])
        │
        ├──▶ Generate sessionId: Date.now().toString()
        │
        ├──▶ For each role:
        │       │
        │       ├──▶ createWorktree(role, { sessionId })
        │       │         │
        │       │         ├──▶ validateRepository()
        │       │         │         └──▶ git rev-parse commands
        │       │         │
        │       │         ├──▶ Check path doesn't exist
        │       │         │
        │       │         ├──▶ git worktree add .worktrees/{role} -b swarm/{role}-{sessionId}
        │       │         │
        │       │         └──▶ copyRoleConfig(role, path)
        │       │                   └──▶ fs.copyFileSync(roles/{role}/CLAUDE.md, path/CLAUDE.md)
        │       │
        │       └──▶ If error: rollback all created worktrees
        │
        └──▶ Return Map<AgentRole, string>
```

---

## 7. Algorithm Descriptions

### Parsing Git Worktree Porcelain Output

```
Input: Multi-line string from `git worktree list --porcelain`

Algorithm:
1. Initialize: currentEntry = {}, results = []
2. Split input by newline
3. For each line:
   a. If line starts with "worktree ":
      - Extract path (everything after "worktree ")
      - currentEntry.path = extracted path
   b. If line starts with "HEAD ":
      - currentEntry.head = rest of line (40-char SHA)
   c. If line starts with "branch ":
      - Extract branch, remove "refs/heads/" prefix
      - currentEntry.branch = extracted branch name
   d. If line equals "locked":
      - currentEntry.isLocked = true
   e. If line is empty AND currentEntry.path exists:
      - Push currentEntry to results
      - Reset currentEntry = {}
4. Handle final entry (may not have trailing newline)
5. Return results
```

### Rollback Logic for Atomic Multi-Worktree Creation

```
Input: roles[], options

Algorithm:
1. createdWorktrees = Map<AgentRole, string>
2. sessionId = options.sessionId ?? Date.now().toString()
3. For each role in roles:
   a. result = createWorktree(role, { sessionId, ...options })
   b. If result is Error:
      - For each (role, path) in createdWorktrees:
        - removeWorktree(role, { force: true })
      - Return the error
   c. createdWorktrees.set(role, result.value)
4. Return ok(createdWorktrees)

Guarantee: Either all worktrees created, or none remain.
```

### Extracting Timestamp from Branch Name

```
Input: branch name like "swarm/researcher-1703849234567"

Algorithm:
1. Match against regex: /swarm\/\w+-(\d+)/
2. If match, parse captured group as integer
3. If no match or parse fails, return 0 (unknown creation time)

Edge cases:
- "swarm/researcher-abc" → no match → 0
- "swarm/researcher-" → no match → 0
- "other/researcher-123" → no match → 0
- "swarm/researcher-123abc" → captures "123" → 123
```

---

## 8. Error Handling

### Error Categories

| Code | Cause | Recovery Strategy |
|------|-------|-------------------|
| `NOT_A_REPO` | Not in git repository or no commits | User must initialize git repo and make initial commit |
| `WORKTREE_EXISTS` | Directory already exists at target path | Either remove existing worktree or use different session |
| `WORKTREE_NOT_FOUND` | Referenced worktree doesn't exist | Check if worktree was already removed (may be OK) |
| `BRANCH_EXISTS` | Attempting to create branch that exists | Use different session ID or delete orphaned branch |
| `GIT_FAILED` | Git command returned non-zero | Log stderr, may indicate disk/permission issues |
| `ROLE_NOT_FOUND` | Role CLAUDE.md doesn't exist | Create the role configuration first (Step 6) |
| `CLEANUP_FAILED` | Failed to remove worktree/branch | May need manual intervention, try --force |

### Error Object Structure

```typescript
{
  name: "Error",
  message: "Human-readable description of what went wrong",
  code: "WORKTREE_EXISTS",  // Machine-readable code
  details: "Worktree already exists at /path/to/.worktrees/researcher"  // Additional context
}
```

### Error Handling in Dependent Operations

When `copyRoleConfig` fails during `createWorktree`:
1. The partially-created worktree should be removed
2. The branch should be deleted
3. The original error (ROLE_NOT_FOUND) should be returned

When git commands fail:
1. Capture stderr from the command
2. Include stderr in error details
3. Return GIT_FAILED with context

---

## 9. Edge Cases & Boundary Conditions

### Worktree Creation Edge Cases

| Scenario | Expected Behavior |
|----------|-------------------|
| Role already has worktree | Return `WORKTREE_EXISTS` error |
| `.worktrees/` directory doesn't exist | Create it automatically |
| Role CLAUDE.md missing | Return `ROLE_NOT_FOUND`, don't create worktree |
| Branch name already exists (from previous session) | Git will fail, return `GIT_FAILED` |
| Repository has uncommitted changes | Worktree creation still works (changes stay in main) |
| Repository is in detached HEAD state | Use 'HEAD' as base branch |
| Worktree path contains spaces | Should work (git handles spaces) |

### Worktree Removal Edge Cases

| Scenario | Expected Behavior |
|----------|-------------------|
| Worktree doesn't exist | Return success (idempotent) |
| Worktree has uncommitted changes | Fail unless `force: true` |
| Worktree is locked | Fail unless `force: true` |
| Branch was already deleted | Ignore branch deletion error |
| Directory exists but isn't valid worktree | Force-remove directory |
| Worktree path is symlink | Let git handle it (git worktree remove) |

### Listing Edge Cases

| Scenario | Expected Behavior |
|----------|-------------------|
| No worktrees exist | Return empty array |
| Main worktree only | Return empty array (filter to .worktrees/ only) |
| Worktree with non-standard role name | Skip it (not in VALID_ROLES) |
| Worktree with missing branch (detached) | Still include, branch will be empty string |
| Git worktree list fails | Return empty array |

### Race Conditions

| Scenario | Risk | Mitigation |
|----------|------|------------|
| Two processes create same worktree | Git will fail second creation | Check exists first, handle error gracefully |
| Worktree removed while being read | Read may get partial data | Re-read or treat missing as "gone" |
| Cleanup during active session | Agents lose working directory | Lock worktrees during active use |

---

## 10. Integration Points

### Integration with Orchestrator (src/orchestrator.ts)

The orchestrator calls worktree manager during workflow startup:

```typescript
// Orchestrator.startWorkflow():
1. createWorktrees(workflowRoles, { sessionId: this.sessionId })
2. For each created worktree path:
   - tmuxManager.createPane(sessionId, role)
   - tmuxManager.sendKeys(pane, `cd ${worktreePath}`)
   - tmuxManager.sendKeys(pane, 'claude --resume')

// Orchestrator.cleanup():
1. removeAllWorktrees({ force: true })
```

### Integration with Message Bus (src/message-bus.ts)

Message bus creates inbox/outbox files in main repo, not worktrees:
- `.swarm/messages/inbox/{agent}.json` - Main repo
- Agents read/write via paths relative to worktree, so they navigate up to find `.swarm/`

### Integration with Role Configurations (roles/*/CLAUDE.md)

Worktree manager depends on role configs existing:
- `roles/researcher/CLAUDE.md`
- `roles/developer/CLAUDE.md`
- `roles/reviewer/CLAUDE.md`
- `roles/architect/CLAUDE.md`

If missing, `createWorktree` returns `ROLE_NOT_FOUND` error.

### Expected Call Patterns

**Startup sequence**:
```typescript
validateRepository()  // Ensure we're in valid git repo
createWorktrees(roles, { sessionId })  // Create all at once
```

**Per-agent operation**:
```typescript
getWorktreePath(role)  // Get path to use in tmux commands
getWorktreeInfo(role)  // Check agent's branch/commit
hasUncommittedChanges(role)  // See if agent modified files
```

**Cleanup sequence**:
```typescript
removeAllWorktrees({ force: true })
// or
fullCleanup()  // More thorough
```

---

## 11. File System & External Effects

### Files/Directories Created

| Path | Purpose |
|------|---------|
| `.worktrees/` | Base directory for all agent worktrees |
| `.worktrees/{role}/` | Individual worktree directory with full repo |
| `.worktrees/{role}/CLAUDE.md` | Copied role configuration |
| `.worktrees/{role}/.git` | File pointing to main repo's git directory |

### Files Read

| Path | Purpose |
|------|---------|
| `roles/{role}/CLAUDE.md` | Source for agent persona files |
| `.git/worktrees/` | Git's internal worktree tracking |

### External Commands Executed

All via Bun's `$` shell template literal:

| Command | Purpose |
|---------|---------|
| `git rev-parse --is-inside-work-tree` | Check if in git repo |
| `git rev-parse --show-toplevel` | Get repo root path |
| `git rev-parse HEAD` | Check commits exist |
| `git rev-parse --abbrev-ref HEAD` | Get current branch |
| `git rev-parse --verify {branch}` | Check if branch exists |
| `git worktree add {path} -b {branch} {base}` | Create worktree |
| `git worktree remove {path} [--force]` | Remove worktree |
| `git worktree list --porcelain` | List all worktrees |
| `git worktree lock {path} [--reason]` | Lock worktree |
| `git worktree unlock {path}` | Unlock worktree |
| `git worktree prune` | Clean stale references |
| `git branch -D {branch}` | Delete branch |
| `git branch --list 'swarm/*'` | List swarm branches |
| `git -C {path} rev-parse HEAD` | Get HEAD in worktree |
| `git -C {path} status --porcelain` | Check uncommitted changes |

### Environment Variables Used

None directly. Inherits git's environment (GIT_DIR, GIT_WORK_TREE if set).

### Permissions Required

- Read/write access to project directory
- Execute permission for git commands
- Sufficient disk space for worktrees (shares objects, but working files duplicated)

---

## 12. Testing Strategy

### Unit Tests

**Repository Validation**:
- Test `isGitRepository()` returns true inside repo
- Test `isGitRepository()` returns false outside repo
- Test `hasCommits()` returns false in empty repo
- Test `validateRepository()` returns error with appropriate code

**Branch Name Generation**:
- Test `generateBranchName('researcher')` matches pattern
- Test unique names generated for successive calls
- Test custom sessionId is used when provided

**Worktree Path Calculation**:
- Test `getWorktreePath()` returns correct path for each role
- Test path is absolute

### Integration Tests

**Single Worktree Lifecycle**:
1. Create worktree for 'researcher'
2. Verify directory exists
3. Verify CLAUDE.md was copied
4. Verify branch was created
5. Remove worktree
6. Verify directory gone
7. Verify branch deleted

**Multi-Worktree Atomicity**:
1. Create worktrees for all 4 roles
2. Verify all exist
3. Artificially fail 4th creation (e.g., by pre-creating the path)
4. Verify 1-3 were rolled back

**Cleanup Functions**:
1. Create several worktrees
2. Call `fullCleanup()`
3. Verify no worktrees remain
4. Verify no swarm/* branches remain
5. Verify .worktrees/ directory removed

### Test Fixtures

- Need a test git repository (can use temp directory with `git init`)
- Need mock role configurations in `roles/*/CLAUDE.md`
- Tests should clean up after themselves

### Manual Verification

```bash
# Verify worktree creation
bun test:create-worktree

# Inspect result
ls -la .worktrees/
git worktree list
cat .worktrees/researcher/CLAUDE.md

# Verify cleanup
bun test:cleanup
ls .worktrees/  # Should not exist
git branch --list 'swarm/*'  # Should be empty
```

---

## 13. Configuration

### Constants (Configurable via Code Changes)

| Constant | Default | Purpose |
|----------|---------|---------|
| `WORKTREE_BASE` | `".worktrees"` | Directory name for worktrees |
| `ROLES_DIR` | `"roles"` | Directory containing role configurations |
| `BRANCH_PREFIX` | `"swarm"` | Prefix for all swarm-managed branches |
| `VALID_ROLES` | `['researcher', 'developer', 'reviewer', 'architect']` | Allowed agent roles |

### Future Configuration Options

If configuration file is added later (`config.json`):

```json
{
  "worktrees": {
    "basePath": ".worktrees",
    "branchPrefix": "swarm",
    "autoCleanupAge": 86400000
  }
}
```

### Adding New Roles

To add a new agent role:

1. Create `roles/{new-role}/CLAUDE.md`
2. Add `'{new-role}'` to `VALID_ROLES` array in worktree-manager
3. Add `'{new-role}'` to `VALID_AGENTS` in message-bus
4. Update workflow configurations to use new role

---

## 14. Open Questions & Decisions

### Resolved Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Worktree location | `.worktrees/` in project root | Standard, easy to gitignore, co-located |
| Branch naming | `swarm/{role}-{timestamp}` | Unique, sortable, easily identifiable |
| CLAUDE.md copying | Copy to worktree root | Claude Code reads from cwd |
| Atomic multi-create | Yes, rollback on failure | Prevents partial states |
| Branch deletion default | Delete with worktree | Clean up fully |

### Open Questions

1. **Should worktrees be created from main branch or current branch?**
   - Current: Uses current branch as base
   - Alternative: Always use main/master
   - Consideration: Current branch may have uncommitted work

2. **How to handle worktrees with uncommitted agent work?**
   - Current: Force removal with explicit flag
   - Alternative: Prompt user or auto-commit
   - Consideration: Agent work may be valuable

3. **Should session ID be stored persistently?**
   - Current: Derived from branch names
   - Alternative: Store in `.swarm/session.json`
   - Consideration: Would enable session resume

4. **What happens if role CLAUDE.md is modified during session?**
   - Current: `updateRoleConfig()` must be called explicitly
   - Alternative: Watch for changes and auto-update
   - Consideration: Agents may already have context from old version

### Alternatives Considered

**Alternative: Separate repositories per agent**
- Pro: Complete isolation
- Con: No shared history, complex merge workflow
- Decision: Rejected, worktrees give sufficient isolation

**Alternative: Same directory, different branches (switching)**
- Pro: Less disk space
- Con: Can't run agents simultaneously
- Decision: Rejected, defeats purpose of parallel agents

**Alternative: Docker containers per agent**
- Pro: Full environment isolation
- Con: Heavy, slow startup, complex
- Decision: Rejected, overkill for file isolation

---

## Next Step

After implementing the Worktree Manager, proceed to **Step 6: Agent Role Configurations** to create the CLAUDE.md persona files that will be copied into each worktree.
