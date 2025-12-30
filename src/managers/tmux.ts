/**
 * Tmux Manager - Terminal Multiplexer Operations
 *
 * Provides a TypeScript wrapper around tmux for managing sessions, panes,
 * and Claude Code instances. Uses Bun's shell execution for all tmux commands.
 */

import { Result, ok, err } from '../types.js';
import { type Logger, createNoopLogger, formatDuration, truncateOutput } from '../logger.js';

// =============================================================================
// Type Definitions
// =============================================================================

/**
 * Represents a tmux session with its metadata.
 */
export interface TmuxSession {
  name: string;
  windows: number;
  created: string;
  attached: boolean;
}

/**
 * Represents a pane within a tmux session.
 * IDs are stable (e.g., "%0"), indices change with layout.
 */
export interface TmuxPane {
  id: string;
  index: number;
  active: boolean;
  width: number;
  height: number;
  currentPath: string;
  title?: string;
}

/**
 * Typed error for tmux operations.
 */
export interface TmuxError extends Error {
  code: TmuxErrorCode;
  details?: string;
}

/**
 * Error codes for categorizing tmux failures.
 */
export type TmuxErrorCode =
  | 'SESSION_EXISTS'
  | 'SESSION_NOT_FOUND'
  | 'PANE_NOT_FOUND'
  | 'TMUX_NOT_RUNNING'
  | 'COMMAND_FAILED';

/**
 * Built-in tmux layout presets.
 */
export type TmuxLayout =
  | 'tiled'
  | 'even-horizontal'
  | 'even-vertical'
  | 'main-horizontal'
  | 'main-vertical';

// =============================================================================
// Option Types
// =============================================================================

export interface CreatePaneOptions {
  vertical?: boolean;
  size?: number;
  name?: string;
}

export interface SendKeysOptions {
  enter?: boolean;
  literal?: boolean;
}

export interface CaptureOptions {
  lines?: number;
  startLine?: number;
  endLine?: number;
  escape?: boolean;
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  lines?: number;
}

export interface WaitPromptOptions {
  timeoutMs?: number;
  promptPattern?: RegExp;
}

export interface ClaudeCodeOptions {
  resume?: boolean;
  workdir?: string;
  initialPrompt?: string;
  skipPermissions?: boolean;  // Use --dangerously-skip-permissions for autonomous operation
  disallowedTools?: string[]; // Tools to block (e.g., "Bash(rm -rf:*)")
}

// Default dangerous patterns to block even in autonomous mode
export const DANGEROUS_TOOL_PATTERNS = [
  'Bash(rm -rf:*)',
  'Bash(rm -r /:*)',
  'Bash(rm -rf /:*)',
  'Bash(rm -rf ~:*)',
  'Bash(rm -rf /*:*)',
  'Bash(sudo rm:*)',
  'Bash(chmod -R 777 /:*)',
  'Bash(mkfs:*)',
  'Bash(dd if=:*)',
  'Bash(:(){ :|:& };:)',  // Fork bomb
  'Bash(> /dev/sda:*)',
  'Bash(mv /* :*)',
  'Bash(wget * | sh:*)',
  'Bash(curl * | sh:*)',
  'Bash(shutdown:*)',
  'Bash(reboot:*)',
  'Bash(init 0:*)',
  'Bash(halt:*)',
];

export interface ResizeOptions {
  width?: number;
  height?: number;
  direction?: 'L' | 'R' | 'U' | 'D';
  amount?: number;
}

// =============================================================================
// Constants
// =============================================================================

const SWARM_SESSION_PREFIX = 'swarm_';
const DEFAULT_CAPTURE_LINES = 100;

// Valid session name pattern: alphanumeric, underscore, hyphen only
const SESSION_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const DEFAULT_WAIT_TIMEOUT_MS = 60000;
const DEFAULT_WAIT_INTERVAL_MS = 1000;
const DEFAULT_WAIT_LINES = 50;
const DEFAULT_PROMPT_TIMEOUT_MS = 30000;
const DEFAULT_PROMPT_PATTERN = /[$#>%]\s*$/m;
const DEFAULT_ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_COMMAND_TIMEOUT_MS = 30000; // 30 seconds default timeout for tmux commands

// Valid pane ID pattern: %N where N is a number
const PANE_ID_PATTERN = /^%\d+$/;

// =============================================================================
// Module-Level Logger
// =============================================================================

/**
 * Module-level logger instance. Set via setLogger() to enable logging.
 */
let moduleLogger: Logger = createNoopLogger();

/**
 * Poll batching state - reduces log noise from capture-pane polling.
 * Logs a summary every POLL_LOG_INTERVAL_MS instead of every poll.
 */
const POLL_LOG_INTERVAL_MS = 5000;
let pollCount = 0;
let pollLastLogTime = 0;

/**
 * Set the logger for this module.
 * Called from swarm.ts during initialization.
 */
export function setLogger(logger: Logger): void {
  moduleLogger = logger;
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Creates a typed TmuxError object.
 */
function createTmuxError(code: TmuxErrorCode, message: string, details?: string): TmuxError {
  const error = new Error(message) as TmuxError;
  error.code = code;
  error.details = details;
  error.name = 'TmuxError';
  return error;
}

/**
 * Parses a tmux list-sessions format line into a TmuxSession.
 * Format: name|windows|created|attached
 */
function parseSessionLine(line: string): TmuxSession | null {
  const parts = line.split('|');
  if (parts.length < 4) return null;

  return {
    name: parts[0],
    windows: parseInt(parts[1], 10),
    created: parts[2],
    attached: parts[3] === '1',
  };
}

/**
 * Parses a tmux list-panes format line into a TmuxPane.
 * Format: id|index|active|width|height|path|title
 */
function parsePaneLine(line: string): TmuxPane | null {
  const parts = line.split('|');
  if (parts.length < 6) return null;

  return {
    id: parts[0],
    index: parseInt(parts[1], 10),
    active: parts[2] === '1',
    width: parseInt(parts[3], 10),
    height: parseInt(parts[4], 10),
    currentPath: parts[5],
    title: parts[6] || undefined,
  };
}

/**
 * Executes a tmux command and returns the result.
 * Uses Bun's subprocess API with optional timeout.
 * @param args - Command arguments to pass to tmux
 * @param timeoutMs - Optional timeout in milliseconds (default: 30 seconds)
 */
async function runTmux(
  args: string[],
  timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const startTime = Date.now();
  const commandStr = `tmux ${args.join(' ')}`;

  // Batch capture-pane polling logs to reduce noise
  const isCapturePaneCmd = args[0] === 'capture-pane';
  if (isCapturePaneCmd) {
    pollCount++;
    const now = Date.now();
    if (now - pollLastLogTime >= POLL_LOG_INTERVAL_MS) {
      moduleLogger.subprocess.debug('poll_batch', { command: 'capture-pane', count: pollCount, interval: '5s' }, `Polled ${pollCount} times in last 5s`);
      pollCount = 0;
      pollLastLogTime = now;
    }
  } else {
    moduleLogger.subprocess.debug('cmd_start', { command: 'tmux', args: args.join(' ') }, `Executing: ${commandStr}`);
  }

  const proc = Bun.spawn(['tmux', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Create a timeout promise
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      proc.kill();
      reject(new Error(`tmux command timed out after ${timeoutMs}ms`));
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

    // Skip completion logs for capture-pane (already batched), unless it failed
    if (exitCode === 0) {
      if (!isCapturePaneCmd) {
        moduleLogger.subprocess.debug('cmd_complete', { command: 'tmux', exitCode, duration: formatDuration(duration), outputLen: stdout.length }, `Completed: ${commandStr} (${formatDuration(duration)})`);
      }
    } else {
      moduleLogger.subprocess.warn('cmd_failed', { command: 'tmux', exitCode, duration: formatDuration(duration), stderr: truncateOutput(result.stderr, 500) }, `Failed: ${commandStr} - ${truncateOutput(result.stderr, 200)}`);
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    // If timeout occurred, return an error result
    if (error instanceof Error && error.message.includes('timed out')) {
      moduleLogger.subprocess.error('cmd_timeout', { command: 'tmux', timeout: timeoutMs, duration: formatDuration(duration) }, `Timeout: ${commandStr} after ${formatDuration(duration)}`);
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
 * Sleep utility for polling.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Validate session name to prevent tmux target injection.
 * Only allows alphanumeric, underscore, and hyphen.
 */
function validateSessionName(name: string): boolean {
  return SESSION_NAME_PATTERN.test(name);
}

/**
 * Validate path to prevent shell injection.
 * Rejects paths with shell metacharacters.
 */
function validatePath(path: string): boolean {
  // Reject shell metacharacters
  const dangerous = /[;&|`$(){}[\]<>\\'"!#*?~\n\r]/;
  return !dangerous.test(path);
}

/**
 * Validate pane ID to prevent injection attacks.
 * Pane IDs must match the pattern %N where N is a number.
 */
function validatePaneId(paneId: string): boolean {
  return PANE_ID_PATTERN.test(paneId);
}

// =============================================================================
// Availability Functions
// =============================================================================

/**
 * Check if tmux is installed and executable.
 */
export async function isTmuxAvailable(): Promise<boolean> {
  try {
    const result = await runTmux(['-V']);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Get tmux version string (e.g., "tmux 3.3a").
 */
export async function getTmuxVersion(): Promise<string | null> {
  try {
    const result = await runTmux(['-V']);
    return result.exitCode === 0 ? result.stdout : null;
  } catch {
    return null;
  }
}

/**
 * Check if tmux server daemon is running.
 */
export async function isTmuxServerRunning(): Promise<boolean> {
  try {
    const result = await runTmux(['list-sessions']);
    // Server is running if command succeeds, even with no sessions
    return result.exitCode === 0 || !result.stderr.includes('no server running');
  } catch {
    return false;
  }
}

// =============================================================================
// Session Management Functions
// =============================================================================

/**
 * Create a new detached tmux session.
 */
export async function createSession(name: string): Promise<Result<void, TmuxError>> {
  // Validate session name
  if (!validateSessionName(name)) {
    return err(createTmuxError('COMMAND_FAILED', `Invalid session name '${name}': must contain only alphanumeric, underscore, or hyphen`));
  }

  // Check if session already exists
  if (await sessionExists(name)) {
    return err(createTmuxError('SESSION_EXISTS', `Session '${name}' already exists`));
  }

  const result = await runTmux(['new-session', '-d', '-s', name]);

  if (result.exitCode !== 0) {
    return err(createTmuxError('COMMAND_FAILED', `Failed to create session '${name}'`, result.stderr));
  }

  moduleLogger.subprocess.info('session_created', { session: name }, `Created tmux session: ${name}`);
  return ok(undefined);
}

/**
 * Destroy a tmux session and all its panes.
 * Idempotent: returns ok even if session doesn't exist.
 */
export async function killSession(name: string): Promise<Result<void, TmuxError>> {
  const result = await runTmux(['kill-session', '-t', name]);

  // Treat "session not found" and "no server running" as success (idempotent)
  if (result.exitCode !== 0) {
    if (result.stderr.includes("can't find session") || result.stderr.includes('no server running')) {
      moduleLogger.subprocess.debug('session_not_found', { session: name }, `Session ${name} not found (already killed)`);
      return ok(undefined);
    }
    return err(createTmuxError('COMMAND_FAILED', `Failed to kill session '${name}'`, result.stderr));
  }

  moduleLogger.subprocess.info('session_killed', { session: name }, `Killed tmux session: ${name}`);
  return ok(undefined);
}

/**
 * Get all tmux sessions.
 */
export async function listSessions(): Promise<TmuxSession[]> {
  const format = '#{session_name}|#{session_windows}|#{session_created}|#{session_attached}';
  const result = await runTmux(['list-sessions', '-F', format]);

  if (result.exitCode !== 0 || !result.stdout) {
    return [];
  }

  const sessions: TmuxSession[] = [];
  for (const line of result.stdout.split('\n')) {
    const session = parseSessionLine(line);
    if (session) {
      sessions.push(session);
    }
  }

  return sessions;
}

/**
 * Check if a specific session exists.
 */
export async function sessionExists(name: string): Promise<boolean> {
  const sessions = await listSessions();
  return sessions.some((s) => s.name === name);
}

/**
 * Get only swarm sessions (those with swarm_ prefix).
 */
export async function listSwarmSessions(): Promise<TmuxSession[]> {
  const sessions = await listSessions();
  return sessions.filter((s) => s.name.startsWith(SWARM_SESSION_PREFIX));
}

/**
 * Get specific session info.
 */
export async function getSession(name: string): Promise<TmuxSession | null> {
  const sessions = await listSessions();
  return sessions.find((s) => s.name === name) ?? null;
}

// =============================================================================
// Pane Management Functions
// =============================================================================

/**
 * Create a new pane by splitting an existing one.
 * Returns the new pane ID.
 */
export async function createPane(
  sessionName: string,
  options?: CreatePaneOptions
): Promise<Result<string, TmuxError>> {
  const args: string[] = ['split-window'];

  // Add split direction
  if (options?.vertical) {
    args.push('-v');
  } else {
    args.push('-h');
  }

  // Add size percentage
  if (options?.size !== undefined) {
    args.push('-p', options.size.toString());
  }

  // Target session
  args.push('-t', sessionName);

  // Print pane info after creation
  args.push('-P', '-F', '#{pane_id}');

  const result = await runTmux(args);

  if (result.exitCode !== 0) {
    if (result.stderr.includes("can't find session")) {
      return err(createTmuxError('SESSION_NOT_FOUND', `Session '${sessionName}' not found`, result.stderr));
    }
    return err(createTmuxError('COMMAND_FAILED', 'Failed to create pane', result.stderr));
  }

  const paneId = result.stdout.trim();

  // Set pane title if provided
  if (options?.name) {
    await runTmux(['select-pane', '-t', paneId, '-T', options.name]);
  }

  moduleLogger.subprocess.info('pane_created', { session: sessionName, pane: paneId, name: options?.name }, `Created pane ${paneId}${options?.name ? ` (${options.name})` : ''} in session ${sessionName}`);
  return ok(paneId);
}

/**
 * Create multiple panes in a balanced grid layout.
 * Returns array of all pane IDs.
 */
export async function createPaneGrid(
  sessionName: string,
  count: number
): Promise<Result<string[], TmuxError>> {
  if (count < 1) {
    return err(createTmuxError('COMMAND_FAILED', 'Pane count must be at least 1'));
  }

  // Get initial pane
  const panes = await listPanes(sessionName);
  if (panes.length === 0) {
    return err(createTmuxError('SESSION_NOT_FOUND', `Session '${sessionName}' not found or has no panes`));
  }

  const paneIds: string[] = [panes[0].id];

  // Create additional panes
  for (let i = 1; i < count; i++) {
    // Alternate split direction for better grid formation
    const vertical = i % 2 === 1;
    const result = await createPane(sessionName, { vertical });

    if (!result.ok) {
      return result;
    }

    paneIds.push(result.value);
  }

  // Apply tiled layout for balanced grid
  if (count > 1) {
    const layoutResult = await applyLayout(sessionName, 'tiled');
    if (!layoutResult.ok) {
      return layoutResult as Result<string[], TmuxError>;
    }
  }

  return ok(paneIds);
}

/**
 * Get all panes in a session.
 */
export async function listPanes(sessionName: string): Promise<TmuxPane[]> {
  const format = '#{pane_id}|#{pane_index}|#{pane_active}|#{pane_width}|#{pane_height}|#{pane_current_path}|#{pane_title}';
  const result = await runTmux(['list-panes', '-t', sessionName, '-F', format]);

  if (result.exitCode !== 0 || !result.stdout) {
    return [];
  }

  const panes: TmuxPane[] = [];
  for (const line of result.stdout.split('\n')) {
    const pane = parsePaneLine(line);
    if (pane) {
      panes.push(pane);
    }
  }

  return panes;
}

/**
 * Get specific pane info by ID or index.
 */
export async function getPane(
  sessionName: string,
  paneIdOrIndex: string | number
): Promise<TmuxPane | null> {
  const panes = await listPanes(sessionName);

  if (typeof paneIdOrIndex === 'number') {
    return panes.find((p) => p.index === paneIdOrIndex) ?? null;
  }

  return panes.find((p) => p.id === paneIdOrIndex) ?? null;
}

/**
 * Focus a specific pane.
 */
export async function selectPane(
  _sessionName: string,
  paneId: string
): Promise<Result<void, TmuxError>> {
  // Validate pane ID to prevent injection
  if (!validatePaneId(paneId)) {
    return err(createTmuxError('COMMAND_FAILED', `Invalid pane ID '${paneId}': must match pattern %N`));
  }

  // Use global pane ID directly - tmux determines session from it
  const result = await runTmux(['select-pane', '-t', paneId]);

  if (result.exitCode !== 0) {
    if (result.stderr.includes("can't find pane")) {
      return err(createTmuxError('PANE_NOT_FOUND', `Pane '${paneId}' not found`, result.stderr));
    }
    return err(createTmuxError('COMMAND_FAILED', 'Failed to select pane', result.stderr));
  }

  return ok(undefined);
}

/**
 * Close a specific pane.
 */
export async function killPane(
  _sessionName: string,
  paneId: string
): Promise<Result<void, TmuxError>> {
  // Validate pane ID to prevent injection
  if (!validatePaneId(paneId)) {
    return err(createTmuxError('COMMAND_FAILED', `Invalid pane ID '${paneId}': must match pattern %N`));
  }

  // Use global pane ID directly - tmux determines session from it
  const result = await runTmux(['kill-pane', '-t', paneId]);

  if (result.exitCode !== 0) {
    if (result.stderr.includes("can't find pane")) {
      return err(createTmuxError('PANE_NOT_FOUND', `Pane '${paneId}' not found`, result.stderr));
    }
    return err(createTmuxError('COMMAND_FAILED', 'Failed to kill pane', result.stderr));
  }

  moduleLogger.subprocess.debug('pane_killed', { pane: paneId }, `Killed pane ${paneId}`);
  return ok(undefined);
}

// =============================================================================
// Command Execution Functions
// =============================================================================

/**
 * Send keystrokes to a pane.
 */
export async function sendKeys(
  _sessionName: string,
  paneId: string,
  text: string,
  options?: SendKeysOptions
): Promise<Result<void, TmuxError>> {
  // Validate pane ID to prevent injection
  if (!validatePaneId(paneId)) {
    return err(createTmuxError('COMMAND_FAILED', `Invalid pane ID '${paneId}': must match pattern %N`));
  }

  // Use global pane ID directly - tmux determines session from it
  const target = paneId;
  const enter = options?.enter ?? true;
  const literal = options?.literal ?? false;

  const args: string[] = ['send-keys', '-t', target];

  if (literal) {
    args.push('-l');
  }

  args.push(text);

  const result = await runTmux(args);

  if (result.exitCode !== 0) {
    if (result.stderr.includes("can't find pane")) {
      return err(createTmuxError('PANE_NOT_FOUND', `Pane '${paneId}' not found`, result.stderr));
    }
    return err(createTmuxError('COMMAND_FAILED', 'Failed to send keys', result.stderr));
  }

  // Send Enter key if requested
  if (enter) {
    const enterResult = await runTmux(['send-keys', '-t', target, 'Enter']);
    if (enterResult.exitCode !== 0) {
      return err(createTmuxError('COMMAND_FAILED', 'Failed to send Enter key', enterResult.stderr));
    }
  }

  return ok(undefined);
}

/**
 * Send a command as literal text with Enter.
 */
export async function runCommand(
  sessionName: string,
  paneId: string,
  command: string
): Promise<Result<void, TmuxError>> {
  return sendKeys(sessionName, paneId, command, { enter: true, literal: true });
}

/**
 * Send Ctrl+C to interrupt running process.
 */
export async function sendInterrupt(
  _sessionName: string,
  paneId: string
): Promise<Result<void, TmuxError>> {
  // Validate pane ID to prevent injection
  if (!validatePaneId(paneId)) {
    return err(createTmuxError('COMMAND_FAILED', `Invalid pane ID '${paneId}': must match pattern %N`));
  }

  // Use global pane ID directly - tmux determines session from it
  const target = paneId;
  const result = await runTmux(['send-keys', '-t', target, 'C-c']);

  if (result.exitCode !== 0) {
    if (result.stderr.includes("can't find pane")) {
      return err(createTmuxError('PANE_NOT_FOUND', `Pane '${paneId}' not found`, result.stderr));
    }
    return err(createTmuxError('COMMAND_FAILED', 'Failed to send interrupt', result.stderr));
  }

  return ok(undefined);
}

/**
 * Clear the pane screen.
 */
export async function clearPane(
  sessionName: string,
  paneId: string
): Promise<Result<void, TmuxError>> {
  return runCommand(sessionName, paneId, 'clear');
}

// =============================================================================
// Output Capture Functions
// =============================================================================

/**
 * Read content from a pane's screen buffer.
 */
export async function capturePane(
  _sessionName: string,
  paneId: string,
  options?: CaptureOptions
): Promise<Result<string, TmuxError>> {
  // Validate pane ID to prevent injection
  if (!validatePaneId(paneId)) {
    return err(createTmuxError('COMMAND_FAILED', `Invalid pane ID '${paneId}': must match pattern %N`));
  }

  // Use global pane ID directly - tmux determines session from it
  const target = paneId;
  const args: string[] = ['capture-pane', '-t', target, '-p'];

  if (options?.startLine !== undefined && options?.endLine !== undefined) {
    args.push('-S', options.startLine.toString());
    args.push('-E', options.endLine.toString());
  } else {
    const lines = options?.lines ?? DEFAULT_CAPTURE_LINES;
    args.push('-S', `-${lines}`);
  }

  if (options?.escape) {
    args.push('-e');
  }

  const result = await runTmux(args);

  if (result.exitCode !== 0) {
    if (result.stderr.includes("can't find pane")) {
      return err(createTmuxError('PANE_NOT_FOUND', `Pane '${paneId}' not found`, result.stderr));
    }
    return err(createTmuxError('COMMAND_FAILED', 'Failed to capture pane', result.stderr));
  }

  return ok(result.stdout);
}

/**
 * Capture entire scroll buffer.
 */
export async function capturePaneHistory(
  sessionName: string,
  paneId: string
): Promise<Result<string, TmuxError>> {
  return capturePane(sessionName, paneId, { startLine: 0, endLine: -1 });
}

/**
 * Poll pane until pattern appears in output.
 */
export async function waitForPattern(
  sessionName: string,
  paneId: string,
  pattern: RegExp,
  options?: WaitOptions
): Promise<Result<string, TmuxError>> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const intervalMs = options?.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
  const lines = options?.lines ?? DEFAULT_WAIT_LINES;

  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const result = await capturePane(sessionName, paneId, { lines });

    if (!result.ok) {
      return result;
    }

    if (pattern.test(result.value)) {
      return ok(result.value);
    }

    await sleep(intervalMs);
  }

  return err(
    createTmuxError(
      'COMMAND_FAILED',
      `Timeout waiting for pattern '${pattern}' after ${timeoutMs}ms`
    )
  );
}

/**
 * Wait for shell prompt to appear (command completed).
 */
export async function waitForPrompt(
  sessionName: string,
  paneId: string,
  options?: WaitPromptOptions
): Promise<Result<void, TmuxError>> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
  const promptPattern = options?.promptPattern ?? DEFAULT_PROMPT_PATTERN;

  const result = await waitForPattern(sessionName, paneId, promptPattern, {
    timeoutMs,
    intervalMs: 500,
    lines: 20,
  });

  if (!result.ok) {
    return result;
  }

  return ok(undefined);
}

// =============================================================================
// Claude Code Helper Functions
// =============================================================================

/**
 * Start Claude Code CLI in a pane.
 */
export async function startClaudeCode(
  sessionName: string,
  paneId: string,
  options?: ClaudeCodeOptions
): Promise<Result<void, TmuxError>> {
  moduleLogger.subprocess.info('claude_code_start', { session: sessionName, pane: paneId, workdir: options?.workdir, resume: options?.resume }, `Starting Claude Code in pane ${paneId}`);

  // Change directory if specified
  if (options?.workdir) {
    // Validate path to prevent shell injection
    if (!validatePath(options.workdir)) {
      return err(createTmuxError('COMMAND_FAILED', 'Invalid workdir path: contains shell metacharacters'));
    }
    const cdResult = await runCommand(sessionName, paneId, `cd "${options.workdir}"`);
    if (!cdResult.ok) {
      return cdResult;
    }
    await sleep(500);
  }

  // Build claude command
  let command = 'claude';

  // Skip permissions for autonomous agent operation
  if (options?.skipPermissions) {
    command += ' --dangerously-skip-permissions';

    // Always block dangerous patterns when running autonomously
    const disallowed = [...DANGEROUS_TOOL_PATTERNS, ...(options.disallowedTools || [])];
    if (disallowed.length > 0) {
      // Quote each pattern to handle special characters
      const quotedPatterns = disallowed.map(p => `"${p.replace(/"/g, '\\"')}"`).join(' ');
      command += ` --disallowedTools ${quotedPatterns}`;
    }
  }

  if (options?.resume) {
    command += ' --resume';
  }

  if (options?.initialPrompt) {
    const escapedPrompt = options.initialPrompt.replace(/"/g, '\\"');
    command += ` -p "${escapedPrompt}"`;
  }

  const result = await runCommand(sessionName, paneId, command);
  if (result.ok) {
    moduleLogger.subprocess.debug('claude_code_started', { session: sessionName, pane: paneId, command }, `Claude Code started with command: ${command}`);
  }
  return result;
}

/**
 * Send a message to running Claude Code.
 */
export async function sendToClaudeCode(
  sessionName: string,
  paneId: string,
  message: string
): Promise<Result<void, TmuxError>> {
  return sendKeys(sessionName, paneId, message, { enter: true, literal: true });
}

/**
 * Heuristic check if Claude Code appears to be running.
 */
export async function isClaudeCodeRunning(
  sessionName: string,
  paneId: string
): Promise<boolean> {
  const result = await capturePane(sessionName, paneId, { lines: 20 });

  if (!result.ok) {
    return false;
  }

  const output = result.value;

  // Check for Claude Code indicators
  const indicators = [
    /claude/i,
    /anthropic/i,
    /[\u256D\u2500]/, // Box-drawing characters
    /\[.*\]/, // Status indicators
    /Human:/,
    /Assistant:/,
  ];

  return indicators.some((pattern) => pattern.test(output));
}

// =============================================================================
// Layout Management Functions
// =============================================================================

/**
 * Apply a predefined layout to all panes.
 */
export async function applyLayout(
  sessionName: string,
  layout: TmuxLayout
): Promise<Result<void, TmuxError>> {
  const result = await runTmux(['select-layout', '-t', sessionName, layout]);

  if (result.exitCode !== 0) {
    if (result.stderr.includes("can't find session")) {
      return err(createTmuxError('SESSION_NOT_FOUND', `Session '${sessionName}' not found`, result.stderr));
    }
    return err(createTmuxError('COMMAND_FAILED', 'Failed to apply layout', result.stderr));
  }

  return ok(undefined);
}

/**
 * Change pane dimensions.
 */
export async function resizePane(
  _sessionName: string,
  paneId: string,
  options: ResizeOptions
): Promise<Result<void, TmuxError>> {
  // Validate pane ID to prevent injection
  if (!validatePaneId(paneId)) {
    return err(createTmuxError('COMMAND_FAILED', `Invalid pane ID '${paneId}': must match pattern %N`));
  }

  // Use global pane ID directly - tmux determines session from it
  const target = paneId;

  if (options.width !== undefined) {
    const result = await runTmux(['resize-pane', '-t', target, '-x', options.width.toString()]);
    if (result.exitCode !== 0) {
      return err(createTmuxError('COMMAND_FAILED', 'Failed to resize pane width', result.stderr));
    }
  }

  if (options.height !== undefined) {
    const result = await runTmux(['resize-pane', '-t', target, '-y', options.height.toString()]);
    if (result.exitCode !== 0) {
      return err(createTmuxError('COMMAND_FAILED', 'Failed to resize pane height', result.stderr));
    }
  }

  if (options.direction && options.amount !== undefined) {
    const result = await runTmux([
      'resize-pane',
      '-t',
      target,
      `-${options.direction}`,
      options.amount.toString(),
    ]);
    if (result.exitCode !== 0) {
      return err(createTmuxError('COMMAND_FAILED', 'Failed to resize pane', result.stderr));
    }
  }

  return ok(undefined);
}

// =============================================================================
// Session Attachment Functions
// =============================================================================

/**
 * Attach terminal to session (for user interaction).
 * WARNING: This replaces the current terminal with tmux.
 */
export async function attachSession(sessionName: string): Promise<void> {
  const proc = Bun.spawn(['tmux', 'attach', '-t', sessionName], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  await proc.exited;
}

/**
 * Get the shell command to attach (for display to user).
 */
export function getAttachCommand(sessionName: string): string {
  return `tmux attach -t "${sessionName}"`;
}

// =============================================================================
// Cleanup Functions
// =============================================================================

/**
 * Result of killing all swarm sessions with detailed failure information.
 */
export interface KillAllResult {
  successCount: number;
  failedSessions: Array<{ name: string; error: string }>;
}

/**
 * Destroy all swarm sessions.
 * Returns detailed information about both successful and failed kills.
 */
export async function killAllSwarmSessions(): Promise<KillAllResult> {
  const sessions = await listSwarmSessions();
  let successCount = 0;
  const failedSessions: Array<{ name: string; error: string }> = [];

  for (const session of sessions) {
    const result = await killSession(session.name);
    if (result.ok) {
      successCount++;
    } else {
      failedSessions.push({
        name: session.name,
        error: result.error.message,
      });
    }
  }

  return { successCount, failedSessions };
}

/**
 * Result of cleanup orphaned sessions with detailed information.
 */
export interface CleanupOrphanedResult {
  successCount: number;
  failedSessions: Array<{ name: string; error: string }>;
}

/**
 * Remove old swarm sessions.
 * Returns detailed information about the cleanup process.
 */
export async function cleanupOrphanedSessions(maxAgeMs?: number): Promise<CleanupOrphanedResult> {
  const threshold = maxAgeMs ?? DEFAULT_ORPHAN_MAX_AGE_MS;
  const sessions = await listSwarmSessions();
  const now = Date.now();
  let successCount = 0;
  const failedSessions: Array<{ name: string; error: string }> = [];

  for (const session of sessions) {
    // Parse timestamp from session name "swarm_{timestamp}"
    const match = session.name.match(/swarm_(\d+)/);
    if (match) {
      const created = parseInt(match[1], 10);
      if (now - created > threshold) {
        const result = await killSession(session.name);
        if (result.ok) {
          successCount++;
        } else {
          failedSessions.push({
            name: session.name,
            error: result.error.message,
          });
        }
      }
    }
  }

  return { successCount, failedSessions };
}
