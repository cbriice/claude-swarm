/**
 * Claude Swarm - Worktree Manager
 *
 * Provides git worktree lifecycle management for agent isolation.
 * Each agent in the swarm runs in its own git worktree with its own branch,
 * preventing file conflicts when multiple Claude Code instances work simultaneously.
 */

import { existsSync, copyFileSync, rmSync, mkdirSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { Result, ok, err, type AgentRole } from '../types.js';
import { type Logger, createNoopLogger, formatDuration, truncateOutput } from '../logger.js';

// =============================================================================
// Constants
// =============================================================================

export const WORKTREE_BASE = '.worktrees';
export const ROLES_DIR = 'roles';
export const BRANCH_PREFIX = 'swarm';
export const VALID_ROLES: AgentRole[] = ['orchestrator', 'researcher', 'developer', 'reviewer', 'architect'];

// Valid session ID pattern: alphanumeric, underscore, hyphen only (for safe branch names)
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const DEFAULT_COMMAND_TIMEOUT_MS = 30000; // 30 seconds default timeout for git commands

// =============================================================================
// Module-Level Logger
// =============================================================================

/**
 * Module-level logger instance. Set via setLogger() to enable logging.
 */
let moduleLogger: Logger = createNoopLogger();

/**
 * Set the logger for this module.
 * Called from swarm.ts during initialization.
 */
export function setLogger(logger: Logger): void {
  moduleLogger = logger;
}

// =============================================================================
// Type Definitions
// =============================================================================

/**
 * Information about an existing worktree.
 */
export interface WorktreeInfo {
  /** Absolute path to worktree directory */
  path: string;
  /** Full branch name (e.g., "swarm/researcher-1234567") */
  branch: string;
  /** Which agent role this worktree belongs to */
  role: AgentRole;
  /** Current commit SHA (40 characters) */
  head: string;
  /** Whether worktree is locked against removal */
  isLocked: boolean;
  /** Unix timestamp extracted from branch name */
  createdAt: number;
}

/**
 * Structured error with machine-readable code.
 */
export interface WorktreeError extends Error {
  code: WorktreeErrorCode;
  details?: string;
}

export type WorktreeErrorCode =
  | 'NOT_A_REPO'           // Not in a git repository or no commits
  | 'WORKTREE_EXISTS'      // Worktree already exists at target path
  | 'WORKTREE_NOT_FOUND'   // Referenced worktree doesn't exist
  | 'BRANCH_EXISTS'        // Branch name already taken
  | 'GIT_FAILED'           // Git command failed unexpectedly
  | 'ROLE_NOT_FOUND'       // Role CLAUDE.md doesn't exist
  | 'CLEANUP_FAILED';      // Failed to remove worktree or branch

/**
 * Options for worktree creation.
 */
export interface CreateWorktreeOptions {
  /** REQUIRED: Session ID from orchestrator (for branch name grouping) */
  sessionId: string;
  /** Branch to create worktree from (default: current) */
  baseBranch?: string;
  /** Whether to copy CLAUDE.md (default: true) */
  copyRoleConfig?: boolean;
}

/**
 * Options for worktree removal.
 */
export interface RemoveWorktreeOptions {
  /** Remove even if worktree has changes */
  force?: boolean;
  /** Also delete the branch (default: true) */
  deleteBranch?: boolean;
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Creates a typed WorktreeError object.
 */
function createWorktreeError(
  code: WorktreeErrorCode,
  message: string,
  details?: string
): WorktreeError {
  const error = new Error(message) as WorktreeError;
  error.code = code;
  error.details = details;
  error.name = 'WorktreeError';
  return error;
}

/**
 * Executes a git command and returns the result.
 * Uses Bun's subprocess API with optional timeout.
 * @param args - Command arguments to pass to git
 * @param cwd - Optional working directory
 * @param timeoutMs - Optional timeout in milliseconds (default: 30 seconds)
 */
async function runGit(
  args: string[],
  cwd?: string,
  timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const startTime = Date.now();
  const commandStr = `git ${args.join(' ')}`;

  moduleLogger.subprocess.debug('cmd_start', { command: 'git', args: args.join(' '), cwd }, `Executing: ${commandStr}`);

  const proc = Bun.spawn(['git', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd,
  });

  // Create a timeout promise
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      proc.kill();
      reject(new Error(`git command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    // Race between command completion and timeout
    const [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]),
      timeoutPromise,
    ]);

    const duration = Date.now() - startTime;
    const result = { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };

    if (exitCode === 0) {
      moduleLogger.subprocess.debug('cmd_complete', { command: 'git', exitCode, duration: formatDuration(duration), outputLen: stdout.length }, `Completed: ${commandStr} (${formatDuration(duration)})`);
    } else {
      moduleLogger.subprocess.warn('cmd_failed', { command: 'git', exitCode, duration: formatDuration(duration), stderr: truncateOutput(result.stderr, 500) }, `Failed: ${commandStr} - ${truncateOutput(result.stderr, 200)}`);
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    // If timeout occurred, return an error result
    if (error instanceof Error && error.message.includes('timed out')) {
      moduleLogger.subprocess.error('cmd_timeout', { command: 'git', timeout: timeoutMs, duration: formatDuration(duration) }, `Timeout: ${commandStr} after ${formatDuration(duration)}`);
      return {
        exitCode: -1,
        stdout: '',
        stderr: error.message,
      };
    }
    throw error;
  }
}

/**
 * Validate session ID to prevent git branch name injection.
 * Only allows alphanumeric, underscore, and hyphen.
 */
function validateSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

/**
 * Validate that role is a valid AgentRole.
 */
function isValidRole(role: string): role is AgentRole {
  return (VALID_ROLES as readonly string[]).includes(role);
}

/**
 * Extract role from worktree path.
 * Path format: /absolute/path/.worktrees/{role}
 */
function extractRoleFromPath(worktreePath: string): AgentRole | null {
  const parts = worktreePath.split('/');
  const worktreesIndex = parts.indexOf(WORKTREE_BASE);
  if (worktreesIndex === -1 || worktreesIndex >= parts.length - 1) {
    return null;
  }
  const role = parts[worktreesIndex + 1];
  return isValidRole(role) ? role : null;
}

/**
 * Extract timestamp from branch name.
 * Pattern: swarm/{role}-{timestamp}
 */
function extractTimestampFromBranch(branch: string): number {
  const match = branch.match(/swarm\/\w+-(.+)$/);
  if (!match) return 0;

  // Try to parse as number (timestamp)
  const parsed = parseInt(match[1], 10);
  if (!isNaN(parsed)) return parsed;

  // If not a pure number, return 0 (custom session ID)
  return 0;
}

/**
 * Parse git worktree list --porcelain output into structured data.
 */
function parseWorktreeListOutput(output: string): Array<{
  path: string;
  branch: string;
  head: string;
  isLocked: boolean;
}> {
  const results: Array<{
    path: string;
    branch: string;
    head: string;
    isLocked: boolean;
  }> = [];

  let current: {
    path?: string;
    branch?: string;
    head?: string;
    isLocked: boolean;
  } = { isLocked: false };

  const lines = output.split('\n');

  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      // Start of new entry - save previous if complete
      if (current.path) {
        results.push({
          path: current.path,
          branch: current.branch ?? '',
          head: current.head ?? '',
          isLocked: current.isLocked,
        });
      }
      current = { path: line.substring(9), isLocked: false };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.substring(5);
    } else if (line.startsWith('branch ')) {
      // Remove "refs/heads/" prefix
      const fullRef = line.substring(7);
      current.branch = fullRef.replace(/^refs\/heads\//, '');
    } else if (line === 'locked') {
      current.isLocked = true;
    } else if (line === '' && current.path) {
      // Empty line marks end of entry
      results.push({
        path: current.path,
        branch: current.branch ?? '',
        head: current.head ?? '',
        isLocked: current.isLocked,
      });
      current = { isLocked: false };
    }
  }

  // Handle final entry if no trailing newline
  if (current.path) {
    results.push({
      path: current.path,
      branch: current.branch ?? '',
      head: current.head ?? '',
      isLocked: current.isLocked,
    });
  }

  return results;
}

// =============================================================================
// Repository Validation Functions
// =============================================================================

/**
 * Check if current directory is inside a git work tree.
 */
export async function isGitRepository(cwd?: string): Promise<boolean> {
  const result = await runGit(['rev-parse', '--is-inside-work-tree'], cwd);
  return result.exitCode === 0 && result.stdout === 'true';
}

/**
 * Get absolute path to repository root.
 */
export async function getGitRoot(cwd?: string): Promise<string | null> {
  const result = await runGit(['rev-parse', '--show-toplevel'], cwd);
  return result.exitCode === 0 ? result.stdout : null;
}

/**
 * Check if repository has at least one commit.
 */
export async function hasCommits(cwd?: string): Promise<boolean> {
  const result = await runGit(['rev-parse', 'HEAD'], cwd);
  return result.exitCode === 0;
}

/**
 * Get name of current branch.
 */
export async function getCurrentBranch(cwd?: string): Promise<string | null> {
  const result = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (result.exitCode !== 0) return null;
  // Returns "HEAD" if in detached state
  return result.stdout;
}

/**
 * Check if a specific branch exists.
 */
export async function branchExists(branchName: string, cwd?: string): Promise<boolean> {
  const result = await runGit(['rev-parse', '--verify', branchName], cwd);
  return result.exitCode === 0;
}

/**
 * Detect the main branch name (main or master).
 */
export async function getMainBranch(cwd?: string): Promise<string | null> {
  // Check for 'main' first
  if (await branchExists('main', cwd)) {
    return 'main';
  }
  // Fall back to 'master'
  if (await branchExists('master', cwd)) {
    return 'master';
  }
  return null;
}

/**
 * Validate repository is ready for worktree operations.
 * Returns error if not a repo or has no commits.
 */
export async function validateRepository(cwd?: string): Promise<Result<void, WorktreeError>> {
  if (!(await isGitRepository(cwd))) {
    return err(createWorktreeError('NOT_A_REPO', 'Not inside a git repository'));
  }

  if (!(await hasCommits(cwd))) {
    return err(
      createWorktreeError(
        'NOT_A_REPO',
        'Repository has no commits. Make an initial commit before creating worktrees.'
      )
    );
  }

  return ok(undefined);
}

/**
 * Validate that a path is safe for worktree creation.
 * Prevents dangerous paths like /, /home, etc.
 */
export function validateWorktreePath(path: string): Result<void, WorktreeError> {
  const resolved = resolve(path);

  // Reject root directory
  if (resolved === '/') {
    return err(createWorktreeError('GIT_FAILED', 'Cannot create worktree at root directory'));
  }

  // Reject common system directories
  const dangerousPaths = ['/home', '/usr', '/etc', '/var', '/tmp', '/bin', '/sbin', '/lib'];
  for (const dangerous of dangerousPaths) {
    if (resolved === dangerous || resolved.startsWith(dangerous + '/') && resolved.split('/').length <= 3) {
      return err(
        createWorktreeError(
          'GIT_FAILED',
          `Cannot create worktree at system directory: ${resolved}`
        )
      );
    }
  }

  return ok(undefined);
}

// =============================================================================
// Worktree Creation Functions
// =============================================================================

/**
 * Generate branch name from role and session ID.
 * sessionId is REQUIRED and provided by the orchestrator.
 */
export function generateBranchName(role: AgentRole, sessionId: string): string {
  if (!sessionId) {
    throw new Error('sessionId is required');
  }
  if (!validateSessionId(sessionId)) {
    throw new Error(`Invalid sessionId '${sessionId}': must contain only alphanumeric, underscore, or hyphen characters`);
  }
  return `${BRANCH_PREFIX}/${role}-${sessionId}`;
}

/**
 * Get the filesystem path where a role's worktree would be.
 */
export async function getWorktreePath(role: AgentRole, cwd?: string): Promise<string> {
  const root = await getGitRoot(cwd);
  if (!root) {
    throw new Error('Not inside a git repository');
  }
  return join(root, WORKTREE_BASE, role);
}

/**
 * Create a single worktree for an agent role.
 */
export async function createWorktree(
  role: AgentRole,
  options: CreateWorktreeOptions
): Promise<Result<string, WorktreeError>> {
  // Validate role
  if (!isValidRole(role)) {
    return err(createWorktreeError('ROLE_NOT_FOUND', `Invalid role: ${role}`));
  }

  // Validate sessionId is provided and safe
  if (!options.sessionId) {
    return err(createWorktreeError('GIT_FAILED', 'sessionId is required'));
  }

  if (!validateSessionId(options.sessionId)) {
    return err(createWorktreeError('GIT_FAILED', `Invalid sessionId '${options.sessionId}': must contain only alphanumeric, underscore, or hyphen characters`));
  }

  // Validate repository
  const repoValidation = await validateRepository();
  if (!repoValidation.ok) {
    return repoValidation;
  }

  // Get repo root
  const root = await getGitRoot();
  if (!root) {
    return err(createWorktreeError('NOT_A_REPO', 'Could not determine git repository root'));
  }

  // Get worktree path
  const worktreePath = join(root, WORKTREE_BASE, role);

  // Validate path is safe
  const pathValidation = validateWorktreePath(worktreePath);
  if (!pathValidation.ok) {
    return pathValidation;
  }

  // Check if worktree already exists
  if (existsSync(worktreePath)) {
    return err(
      createWorktreeError(
        'WORKTREE_EXISTS',
        `Worktree already exists at ${worktreePath}`,
        worktreePath
      )
    );
  }

  // Create .worktrees directory if it doesn't exist
  const worktreeBase = join(root, WORKTREE_BASE);
  if (!existsSync(worktreeBase)) {
    mkdirSync(worktreeBase, { recursive: true });
  }

  // Determine base branch
  let baseBranch = options.baseBranch;
  if (!baseBranch) {
    const currentBranch = await getCurrentBranch();
    baseBranch = currentBranch === 'HEAD' ? 'HEAD' : currentBranch ?? 'HEAD';
  }

  // Generate branch name
  const branchName = generateBranchName(role, options.sessionId);

  // Create worktree with new branch
  const result = await runGit([
    'worktree',
    'add',
    worktreePath,
    '-b',
    branchName,
    baseBranch,
  ]);

  if (result.exitCode !== 0) {
    return err(
      createWorktreeError('GIT_FAILED', `Failed to create worktree: ${result.stderr}`, result.stderr)
    );
  }

  // Copy role configuration if requested (default: true)
  if (options.copyRoleConfig !== false) {
    const copyResult = await copyRoleConfig(role, worktreePath);
    if (!copyResult.ok) {
      // Rollback: remove the worktree we just created
      await runGit(['worktree', 'remove', '--force', worktreePath]);
      await runGit(['branch', '-D', branchName]);
      return copyResult;
    }
  }

  moduleLogger.subprocess.info('worktree_created', { role, branch: branchName, path: worktreePath }, `Created worktree for ${role} at ${worktreePath}`);
  return ok(worktreePath);
}

/**
 * Create worktrees for multiple roles atomically.
 * If any creation fails, all previously created are rolled back.
 */
export async function createWorktrees(
  roles: AgentRole[],
  options: { sessionId: string; baseBranch?: string }
): Promise<Result<Map<AgentRole, string>, WorktreeError>> {
  // Validate sessionId is provided and safe
  if (!options.sessionId) {
    return err(createWorktreeError('GIT_FAILED', 'sessionId is required'));
  }

  if (!validateSessionId(options.sessionId)) {
    return err(createWorktreeError('GIT_FAILED', `Invalid sessionId '${options.sessionId}': must contain only alphanumeric, underscore, or hyphen characters`));
  }

  const createdWorktrees = new Map<AgentRole, string>();

  for (const role of roles) {
    const result = await createWorktree(role, {
      sessionId: options.sessionId,
      baseBranch: options.baseBranch,
    });

    if (!result.ok) {
      // Rollback all previously created worktrees
      for (const [createdRole] of createdWorktrees) {
        await removeWorktree(createdRole, { force: true, deleteBranch: true });
      }
      return result;
    }

    createdWorktrees.set(role, result.value);
  }

  moduleLogger.subprocess.info('worktrees_created', { count: createdWorktrees.size, roles: roles.join(',') }, `Created ${createdWorktrees.size} worktrees for roles: ${roles.join(', ')}`);
  return ok(createdWorktrees);
}

// =============================================================================
// Role Configuration Functions
// =============================================================================

/**
 * Get path to a role's CLAUDE.md source file.
 */
export async function getRoleConfigPath(role: AgentRole, cwd?: string): Promise<string> {
  const root = await getGitRoot(cwd);
  if (!root) {
    throw new Error('Not inside a git repository');
  }
  return join(root, ROLES_DIR, role, 'CLAUDE.md');
}

/**
 * Check if a role's CLAUDE.md exists.
 */
export async function roleConfigExists(role: AgentRole, cwd?: string): Promise<boolean> {
  const configPath = await getRoleConfigPath(role, cwd);
  return existsSync(configPath);
}

/**
 * Copy role CLAUDE.md into a worktree's root directory.
 */
export async function copyRoleConfig(
  role: AgentRole,
  worktreePath: string
): Promise<Result<void, WorktreeError>> {
  const sourcePath = await getRoleConfigPath(role);

  if (!existsSync(sourcePath)) {
    return err(
      createWorktreeError(
        'ROLE_NOT_FOUND',
        `Role configuration not found: ${sourcePath}`,
        sourcePath
      )
    );
  }

  const destPath = join(worktreePath, 'CLAUDE.md');

  try {
    copyFileSync(sourcePath, destPath);
    return ok(undefined);
  } catch (error) {
    return err(
      createWorktreeError(
        'GIT_FAILED',
        `Failed to copy role config: ${error}`,
        String(error)
      )
    );
  }
}

/**
 * Re-copy role config (for updating after CLAUDE.md changes).
 */
export async function updateRoleConfig(role: AgentRole): Promise<Result<void, WorktreeError>> {
  const worktreePath = await getWorktreePath(role);

  if (!existsSync(worktreePath)) {
    return err(
      createWorktreeError('WORKTREE_NOT_FOUND', `Worktree not found for role: ${role}`)
    );
  }

  return copyRoleConfig(role, worktreePath);
}

// =============================================================================
// Worktree Removal Functions
// =============================================================================

/**
 * Remove a single worktree and optionally its branch.
 */
export async function removeWorktree(
  role: AgentRole,
  options?: RemoveWorktreeOptions
): Promise<Result<void, WorktreeError>> {
  const root = await getGitRoot();
  if (!root) {
    return ok(undefined); // Not in a repo, nothing to remove
  }

  const worktreePath = join(root, WORKTREE_BASE, role);
  const deleteBranch = options?.deleteBranch !== false;

  // Get worktree info to extract branch name before removal
  const info = await getWorktreeInfo(role);
  const branchName = info?.branch;

  // Build git worktree remove command
  const args = ['worktree', 'remove'];
  if (options?.force) {
    args.push('--force');
  }
  args.push(worktreePath);

  const result = await runGit(args);

  if (result.exitCode !== 0) {
    // If worktree doesn't exist, that's OK (idempotent)
    if (
      result.stderr.includes('is not a working tree') ||
      result.stderr.includes('No such file or directory')
    ) {
      // If directory exists but isn't a valid worktree, try to force-remove it
      if (existsSync(worktreePath)) {
        try {
          rmSync(worktreePath, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors
        }
      }
    } else {
      return err(
        createWorktreeError(
          'CLEANUP_FAILED',
          `Failed to remove worktree: ${result.stderr}`,
          result.stderr
        )
      );
    }
  }

  // Delete the branch if requested and we know the branch name
  if (deleteBranch && branchName) {
    // Use -D to force delete even if not fully merged
    await runGit(['branch', '-D', branchName]);
    // Ignore branch deletion errors (branch may not exist)
  }

  moduleLogger.subprocess.debug('worktree_removed', { role, branch: branchName, path: worktreePath }, `Removed worktree for ${role}`);
  return ok(undefined);
}

/**
 * Result of removing all worktrees with detailed failure information.
 */
export interface RemoveAllResult {
  successCount: number;
  failedRoles: Array<{ role: AgentRole; error: string }>;
}

/**
 * Remove all swarm worktrees.
 * Returns detailed information about both successful and failed removals.
 */
export async function removeAllWorktrees(
  options?: { force?: boolean; deleteBranches?: boolean }
): Promise<Result<RemoveAllResult, WorktreeError>> {
  const worktrees = await listWorktrees();
  let successCount = 0;
  const failedRoles: Array<{ role: AgentRole; error: string }> = [];

  for (const worktree of worktrees) {
    const result = await removeWorktree(worktree.role, {
      force: options?.force,
      deleteBranch: options?.deleteBranches !== false,
    });

    if (result.ok) {
      successCount++;
    } else {
      failedRoles.push({
        role: worktree.role,
        error: result.error.message,
      });
    }
  }

  if (failedRoles.length > 0) {
    moduleLogger.subprocess.warn('worktrees_removed', { success: successCount, failed: failedRoles.length }, `Removed ${successCount} worktrees, ${failedRoles.length} failed`);
  } else {
    moduleLogger.subprocess.info('worktrees_removed', { count: successCount }, `Removed all ${successCount} worktrees`);
  }
  return ok({ successCount, failedRoles });
}

/**
 * Prune stale worktree references from git.
 */
export async function pruneWorktrees(): Promise<void> {
  await runGit(['worktree', 'prune']);
}

// =============================================================================
// Worktree Listing and Discovery Functions
// =============================================================================

/**
 * List all git worktrees (including main and non-swarm).
 */
export async function listAllWorktrees(): Promise<
  Array<{
    path: string;
    branch: string;
    head: string;
  }>
> {
  const result = await runGit(['worktree', 'list', '--porcelain']);

  if (result.exitCode !== 0 || !result.stdout) {
    return [];
  }

  return parseWorktreeListOutput(result.stdout).map(({ path, branch, head }) => ({
    path,
    branch,
    head,
  }));
}

/**
 * List only swarm worktrees (in .worktrees/ directory).
 */
export async function listWorktrees(): Promise<WorktreeInfo[]> {
  const root = await getGitRoot();
  if (!root) {
    return [];
  }

  const worktreeBase = join(root, WORKTREE_BASE);

  // Get full worktree info once (includes lock status)
  const result = await runGit(['worktree', 'list', '--porcelain']);
  if (result.exitCode !== 0 || !result.stdout) {
    return [];
  }

  const allParsed = parseWorktreeListOutput(result.stdout);
  const swarmWorktrees: WorktreeInfo[] = [];

  for (const wt of allParsed) {
    // Only include worktrees inside .worktrees/ directory
    if (!wt.path.startsWith(worktreeBase)) {
      continue;
    }

    const role = extractRoleFromPath(wt.path);
    if (!role) {
      continue;
    }

    swarmWorktrees.push({
      path: wt.path,
      branch: wt.branch,
      role,
      head: wt.head,
      isLocked: wt.isLocked,
      createdAt: extractTimestampFromBranch(wt.branch),
    });
  }

  return swarmWorktrees;
}

/**
 * Get detailed info about a specific role's worktree.
 */
export async function getWorktreeInfo(role: AgentRole): Promise<WorktreeInfo | null> {
  const worktrees = await listWorktrees();
  return worktrees.find((wt) => wt.role === role) ?? null;
}

/**
 * Check if a worktree exists for a given role.
 */
export async function worktreeExists(role: AgentRole): Promise<boolean> {
  const info = await getWorktreeInfo(role);
  return info !== null;
}

// =============================================================================
// Worktree State Functions
// =============================================================================

/**
 * Lock a worktree to prevent accidental removal.
 */
export async function lockWorktree(
  role: AgentRole,
  reason?: string
): Promise<Result<void, WorktreeError>> {
  const worktreePath = await getWorktreePath(role);

  if (!existsSync(worktreePath)) {
    return err(createWorktreeError('WORKTREE_NOT_FOUND', `Worktree not found for role: ${role}`));
  }

  const args = ['worktree', 'lock', worktreePath];
  if (reason) {
    args.push('--reason', reason);
  }

  const result = await runGit(args);

  if (result.exitCode !== 0) {
    return err(
      createWorktreeError('GIT_FAILED', `Failed to lock worktree: ${result.stderr}`, result.stderr)
    );
  }

  return ok(undefined);
}

/**
 * Unlock a previously locked worktree.
 */
export async function unlockWorktree(role: AgentRole): Promise<Result<void, WorktreeError>> {
  const worktreePath = await getWorktreePath(role);

  if (!existsSync(worktreePath)) {
    return err(createWorktreeError('WORKTREE_NOT_FOUND', `Worktree not found for role: ${role}`));
  }

  const result = await runGit(['worktree', 'unlock', worktreePath]);

  if (result.exitCode !== 0) {
    // Already unlocked is OK
    if (!result.stderr.includes('is not locked')) {
      return err(
        createWorktreeError(
          'GIT_FAILED',
          `Failed to unlock worktree: ${result.stderr}`,
          result.stderr
        )
      );
    }
  }

  return ok(undefined);
}

/**
 * Get current HEAD commit SHA for a worktree.
 */
export async function getWorktreeHead(role: AgentRole): Promise<string | null> {
  const worktreePath = await getWorktreePath(role);

  if (!existsSync(worktreePath)) {
    return null;
  }

  const result = await runGit(['-C', worktreePath, 'rev-parse', 'HEAD']);
  return result.exitCode === 0 ? result.stdout : null;
}

/**
 * Check if worktree has uncommitted changes.
 */
export async function hasUncommittedChanges(role: AgentRole): Promise<boolean> {
  const worktreePath = await getWorktreePath(role);

  if (!existsSync(worktreePath)) {
    return false;
  }

  const result = await runGit(['-C', worktreePath, 'status', '--porcelain']);
  return result.exitCode === 0 && result.stdout.length > 0;
}

// =============================================================================
// Cleanup Utilities
// =============================================================================

/**
 * Remove worktrees older than specified age.
 * Default: 24 hours.
 */
export async function cleanupOrphanedWorktrees(maxAgeMs?: number): Promise<number> {
  const threshold = maxAgeMs ?? 24 * 60 * 60 * 1000; // 24 hours
  const now = Date.now();
  const worktrees = await listWorktrees();
  let count = 0;

  for (const wt of worktrees) {
    // Only cleanup if we have a valid timestamp
    if (wt.createdAt > 0 && now - wt.createdAt > threshold) {
      const result = await removeWorktree(wt.role, { force: true, deleteBranch: true });
      if (result.ok) {
        count++;
      }
    }
  }

  return count;
}

/**
 * Delete swarm/* branches that don't have active worktrees.
 */
export async function cleanupSwarmBranches(): Promise<number> {
  // Get all swarm/* branches
  const result = await runGit(['branch', '--list', `${BRANCH_PREFIX}/*`]);
  if (result.exitCode !== 0 || !result.stdout) {
    return 0;
  }

  // Get branches that have active worktrees
  const worktrees = await listWorktrees();
  const activeBranches = new Set(worktrees.map((wt) => wt.branch));

  const branches = result.stdout
    .split('\n')
    .map((line) => line.trim().replace(/^\* /, '')); // Remove current branch marker

  let count = 0;

  for (const branch of branches) {
    if (branch && !activeBranches.has(branch)) {
      const deleteResult = await runGit(['branch', '-D', branch]);
      if (deleteResult.exitCode === 0) {
        count++;
      }
    }
  }

  return count;
}

/**
 * Full cleanup result with detailed information.
 */
export interface FullCleanupResult {
  worktreesRemoved: number;
  branchesRemoved: number;
  failedWorktrees: Array<{ role: AgentRole; error: string }>;
}

/**
 * Full cleanup: all worktrees, branches, and empty directories.
 * Returns detailed information about the cleanup process.
 */
export async function fullCleanup(): Promise<FullCleanupResult> {
  // Remove all worktrees
  const worktreeResult = await removeAllWorktrees({ force: true, deleteBranches: true });
  const worktreesRemoved = worktreeResult.ok ? worktreeResult.value.successCount : 0;
  const failedWorktrees = worktreeResult.ok ? worktreeResult.value.failedRoles : [];

  // Cleanup any orphaned branches
  const branchesRemoved = await cleanupSwarmBranches();

  // Prune git references
  await pruneWorktrees();

  // Remove .worktrees directory if empty
  const root = await getGitRoot();
  if (root) {
    const worktreeBase = join(root, WORKTREE_BASE);
    if (existsSync(worktreeBase)) {
      try {
        const contents = readdirSync(worktreeBase);
        if (contents.length === 0) {
          rmSync(worktreeBase, { recursive: true });
        }
      } catch {
        // Ignore errors
      }
    }
  }

  return { worktreesRemoved, branchesRemoved, failedWorktrees };
}

/**
 * Create a new branch at a specific starting point.
 */
export async function createBranch(
  branchName: string,
  startPoint?: string,
  cwd?: string
): Promise<Result<void, WorktreeError>> {
  const args = ['branch', branchName];
  if (startPoint) {
    args.push(startPoint);
  }

  const result = await runGit(args, cwd);

  if (result.exitCode !== 0) {
    if (result.stderr.includes('already exists')) {
      return err(
        createWorktreeError('BRANCH_EXISTS', `Branch '${branchName}' already exists`)
      );
    }
    return err(
      createWorktreeError('GIT_FAILED', `Failed to create branch: ${result.stderr}`, result.stderr)
    );
  }

  return ok(undefined);
}
