/**
 * Tmux Manager - Terminal Multiplexer Operations
 *
 * Provides a TypeScript wrapper around tmux for managing sessions, panes,
 * and Claude Code instances. Uses Bun's shell execution for all tmux commands.
 */

import { Result, ok, err } from './types';

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
}

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
 * Uses Bun's $ for shell execution.
 */
async function runTmux(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['tmux', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
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
      return ok(undefined);
    }
    return err(createTmuxError('COMMAND_FAILED', `Failed to kill session '${name}'`, result.stderr));
  }

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
    await runTmux(['select-pane', '-t', `${sessionName}:${paneId}`, '-T', options.name]);
  }

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
  sessionName: string,
  paneId: string
): Promise<Result<void, TmuxError>> {
  const result = await runTmux(['select-pane', '-t', `${sessionName}:${paneId}`]);

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
  sessionName: string,
  paneId: string
): Promise<Result<void, TmuxError>> {
  const result = await runTmux(['kill-pane', '-t', `${sessionName}:${paneId}`]);

  if (result.exitCode !== 0) {
    if (result.stderr.includes("can't find pane")) {
      return err(createTmuxError('PANE_NOT_FOUND', `Pane '${paneId}' not found`, result.stderr));
    }
    return err(createTmuxError('COMMAND_FAILED', 'Failed to kill pane', result.stderr));
  }

  return ok(undefined);
}

// =============================================================================
// Command Execution Functions
// =============================================================================

/**
 * Send keystrokes to a pane.
 */
export async function sendKeys(
  sessionName: string,
  paneId: string,
  text: string,
  options?: SendKeysOptions
): Promise<Result<void, TmuxError>> {
  const target = `${sessionName}:${paneId}`;
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
  sessionName: string,
  paneId: string
): Promise<Result<void, TmuxError>> {
  const target = `${sessionName}:${paneId}`;
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
  sessionName: string,
  paneId: string,
  options?: CaptureOptions
): Promise<Result<string, TmuxError>> {
  const target = `${sessionName}:${paneId}`;
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

  if (options?.resume) {
    command += ' --resume';
  }

  if (options?.initialPrompt) {
    const escapedPrompt = options.initialPrompt.replace(/"/g, '\\"');
    command += ` -p "${escapedPrompt}"`;
  }

  return runCommand(sessionName, paneId, command);
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
  sessionName: string,
  paneId: string,
  options: ResizeOptions
): Promise<Result<void, TmuxError>> {
  const target = `${sessionName}:${paneId}`;

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
 * Destroy all swarm sessions.
 */
export async function killAllSwarmSessions(): Promise<void> {
  const sessions = await listSwarmSessions();
  for (const session of sessions) {
    await killSession(session.name);
  }
}

/**
 * Remove old swarm sessions.
 * Returns count of killed sessions.
 */
export async function cleanupOrphanedSessions(maxAgeMs?: number): Promise<number> {
  const threshold = maxAgeMs ?? DEFAULT_ORPHAN_MAX_AGE_MS;
  const sessions = await listSwarmSessions();
  const now = Date.now();
  let count = 0;

  for (const session of sessions) {
    // Parse timestamp from session name "swarm_{timestamp}"
    const match = session.name.match(/swarm_(\d+)/);
    if (match) {
      const created = parseInt(match[1], 10);
      if (now - created > threshold) {
        await killSession(session.name);
        count++;
      }
    }
  }

  return count;
}
