#!/usr/bin/env bun
/**
 * Claude Swarm - CLI Interface
 *
 * The main entry point for the claude-swarm CLI. Provides command-line access
 * to orchestrate multi-agent workflows, manage sessions, and view results.
 */

import { existsSync, rmSync } from 'fs';
import { join } from 'path';

import {
  type AgentRole,
} from './types.js';

import {
  Orchestrator,
  createOrchestrator,
  type OrchestratorConfig,
  type OrchestratorEvent,
  type SessionResult,
} from './orchestrator.js';

import * as tmux from './managers/tmux.js';
import * as messageBus from './message-bus.js';
import * as db from './db.js';
import { listWorkflowTemplates } from './workflows/templates.js';

// =============================================================================
// Type Definitions
// =============================================================================

/**
 * Command definition for the CLI.
 */
interface Command {
  name: string;
  aliases?: string[];
  description: string;
  usage: string;
  arguments: CommandArgument[];
  options: CommandOption[];
  examples: string[];
  handler: CommandHandler;
  prerequisites?: string[];
}

interface CommandArgument {
  name: string;
  description: string;
  required: boolean;
  type: 'string' | 'number' | 'choice';
  choices?: string[];
  default?: string | number;
}

interface CommandOption {
  name: string;
  short?: string;
  description: string;
  type: 'boolean' | 'string' | 'number';
  default?: boolean | string | number;
}

type CommandHandler = (args: ParsedArgs) => Promise<number>;

interface ParsedArgs {
  command: string;
  positional: string[];
  options: Record<string, boolean | string | number>;
}

interface ParseResult {
  success: boolean;
  command?: string;
  args?: ParsedArgs;
  error?: ParseError;
}

interface ParseError {
  type: 'unknown_command' | 'missing_argument' | 'invalid_option' | 'validation_error';
  message: string;
  suggestion?: string;
}

type OutputLevel = 'info' | 'success' | 'warning' | 'error' | 'debug';

interface CLIConfig {
  color: boolean;
  verbose: boolean;
  json: boolean;
  defaultTimeout: number;
  monitorInterval: number;
}

interface CLIError {
  type: 'argument' | 'session' | 'workflow' | 'system';
  message: string;
  suggestion?: string;
  details?: string;
  exitCode: number;
}

interface PrerequisiteCheck {
  name: string;
  check: () => Promise<boolean>;
  errorMessage: string;
  remediation: string;
}

// =============================================================================
// Constants
// =============================================================================

const SWARM_DIR = '.swarm';
const VERSION = '1.0.0';

const VALID_WORKFLOWS = ['research', 'implement', 'development', 'review', 'full', 'architecture'];

const EXIT_CODES = {
  SUCCESS: 0,
  WORKFLOW_FAILED: 1,
  INVALID_ARGS: 2,
  SESSION_EXISTS: 3,
  INTERRUPTED: 130,
} as const;

// ANSI color codes
const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const;

const SYMBOLS = {
  info: 'i',
  success: '[ok]',
  warning: '[!]',
  error: '[x]',
  debug: '*',
  arrow: '->',
  bullet: '-',
} as const;

// =============================================================================
// Configuration
// =============================================================================

/**
 * Load CLI configuration from environment variables.
 */
function loadConfig(): CLIConfig {
  return {
    color: !process.env.SWARM_NO_COLOR && !process.env.NO_COLOR,
    verbose: !!process.env.SWARM_VERBOSE,
    json: !!process.env.SWARM_JSON,
    defaultTimeout: parseInt(process.env.SWARM_DEFAULT_TIMEOUT || '1800000', 10),
    monitorInterval: parseInt(process.env.SWARM_MONITOR_INTERVAL || '5000', 10),
  };
}

let config: CLIConfig = loadConfig();

// =============================================================================
// Output Functions
// =============================================================================

/**
 * Apply color to text if colors are enabled.
 */
function colorize(text: string, color: keyof typeof COLORS): string {
  if (!config.color) {
    return text;
  }
  return `${COLORS[color]}${text}${COLORS.reset}`;
}

/**
 * Print a message with optional level styling.
 */
function print(message: string, level?: OutputLevel): void {
  if (level === 'debug' && !config.verbose) {
    return;
  }

  let prefix = '';
  let coloredMessage = message;

  switch (level) {
    case 'info':
      prefix = colorize(SYMBOLS.info, 'blue');
      break;
    case 'success':
      prefix = colorize(SYMBOLS.success, 'green');
      coloredMessage = colorize(message, 'green');
      break;
    case 'warning':
      prefix = colorize(SYMBOLS.warning, 'yellow');
      coloredMessage = colorize(message, 'yellow');
      break;
    case 'error':
      prefix = colorize(SYMBOLS.error, 'red');
      coloredMessage = colorize(message, 'red');
      break;
    case 'debug':
      prefix = colorize(SYMBOLS.debug, 'gray');
      coloredMessage = colorize(message, 'gray');
      break;
  }

  if (prefix) {
    console.log(`${prefix} ${coloredMessage}`);
  } else {
    console.log(coloredMessage);
  }
}

/**
 * Print a table with headers and rows.
 */
function printTable(headers: string[], rows: string[][], options?: { minWidth?: number[] }): void {
  if (config.json) {
    const jsonRows = rows.map(row => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => {
        obj[h.toLowerCase().replace(/\s+/g, '_')] = row[i] || '';
      });
      return obj;
    });
    console.log(JSON.stringify(jsonRows, null, 2));
    return;
  }

  // Calculate column widths
  const widths = headers.map((h, i) => {
    const minWidth = options?.minWidth?.[i] || 0;
    const maxRowWidth = Math.max(...rows.map(r => (r[i] || '').length));
    return Math.max(h.length, maxRowWidth, minWidth);
  });

  // Print headers
  const headerRow = headers.map((h, i) => h.padEnd(widths[i])).join('  ');
  console.log(colorize(headerRow, 'bold'));

  // Print rows
  for (const row of rows) {
    const dataRow = row.map((cell, i) => (cell || '').padEnd(widths[i])).join('  ');
    console.log(dataRow);
  }
}

/**
 * Print a progress bar.
 * Reserved for future workflow progress display.
 * @internal
 */
export function printProgress(current: number, total: number, label?: string): void {
  if (config.json) {
    return;
  }

  const width = 20;
  const percent = Math.round((current / total) * 100);
  const filled = Math.round((current / total) * width);
  const empty = width - filled;

  const bar = colorize('█'.repeat(filled), 'green') + colorize('░'.repeat(empty), 'gray');
  const text = label ? `${label}: ` : '';
  process.stdout.write(`\r${text}${bar} ${percent}%`);

  if (current >= total) {
    console.log();
  }
}

/**
 * Print JSON output.
 */
function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Format duration in human-readable form.
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Format relative time.
 */
function formatRelativeTime(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return `${seconds}s ago`;
}

// =============================================================================
// Error Handling
// =============================================================================

/**
 * Display a CLI error with suggestions.
 */
function displayError(error: CLIError): void {
  print(`Error: ${error.message}`, 'error');

  if (error.details) {
    print(`Details: ${error.details}`, 'error');
  }

  if (error.suggestion) {
    print(`Suggestion: ${error.suggestion}`, 'info');
  }
}

/**
 * Handle an error and exit.
 */
function handleError(error: unknown): never {
  if (typeof error === 'object' && error !== null && 'exitCode' in error) {
    displayError(error as CLIError);
    process.exit((error as CLIError).exitCode);
  }

  // Unexpected error
  print(`Unexpected error: ${String(error)}`, 'error');
  if (config.verbose && error instanceof Error) {
    console.error(error.stack);
  }
  process.exit(EXIT_CODES.WORKFLOW_FAILED);
}

/**
 * Create a CLI error.
 */
function createCLIError(
  type: CLIError['type'],
  message: string,
  exitCode: number,
  suggestion?: string,
  details?: string
): CLIError {
  return { type, message, suggestion, details, exitCode };
}

// =============================================================================
// Prerequisites
// =============================================================================

const PREREQUISITES: PrerequisiteCheck[] = [
  {
    name: 'tmux',
    check: async () => tmux.isTmuxAvailable(),
    errorMessage: 'tmux is not installed',
    remediation: 'Install with: sudo apt install tmux (Linux) or brew install tmux (Mac)',
  },
  {
    name: 'git_repo',
    check: async () => {
      try {
        const proc = Bun.spawn(['git', 'rev-parse', '--is-inside-work-tree'], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        await proc.exited;
        return proc.exitCode === 0;
      } catch {
        return false;
      }
    },
    errorMessage: 'Not in a git repository',
    remediation: 'Initialize with: git init && git add -A && git commit -m "Initial commit"',
  },
  {
    name: 'claude_cli',
    check: async () => {
      try {
        const proc = Bun.spawn(['claude', '--version'], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        await proc.exited;
        return proc.exitCode === 0;
      } catch {
        return false;
      }
    },
    errorMessage: 'Claude Code CLI is not installed',
    remediation: 'Install with: npm install -g @anthropic-ai/claude-code',
  },
];

/**
 * Check prerequisites for a command.
 */
async function checkPrerequisites(required: string[]): Promise<PrerequisiteCheck[]> {
  const failed: PrerequisiteCheck[] = [];

  for (const prereq of PREREQUISITES) {
    if (required.includes(prereq.name)) {
      const ok = await prereq.check();
      if (!ok) {
        failed.push(prereq);
      }
    }
  }

  return failed;
}

// =============================================================================
// Argument Parsing
// =============================================================================

/**
 * Parse command-line arguments.
 */
function parseArgs(argv: string[], commands: Map<string, Command>): ParseResult {
  // Remove 'bun' and script name
  const args = argv.slice(2);

  if (args.length === 0) {
    return { success: false, error: { type: 'missing_argument', message: 'No command specified', suggestion: "Run 'bun swarm.ts help' for usage" } };
  }

  const commandName = args[0];

  // Check for help flags
  if (commandName === '-h' || commandName === '--help') {
    return { success: true, command: 'help', args: { command: 'help', positional: [], options: {} } };
  }

  // Check for version flags
  if (commandName === '-v' || commandName === '--version') {
    console.log(`claude-swarm v${VERSION}`);
    process.exit(0);
  }

  // Find command by name or alias
  let command: Command | undefined;
  for (const [name, cmd] of commands) {
    if (name === commandName || cmd.aliases?.includes(commandName)) {
      command = cmd;
      break;
    }
  }

  if (!command) {
    const available = Array.from(commands.keys()).join(', ');
    return {
      success: false,
      error: {
        type: 'unknown_command',
        message: `Unknown command: ${commandName}`,
        suggestion: `Available commands: ${available}`,
      },
    };
  }

  // Parse remaining arguments
  const positional: string[] = [];
  const options: Record<string, boolean | string | number> = {};

  // Set defaults
  for (const opt of command.options) {
    if (opt.default !== undefined) {
      options[opt.name] = opt.default;
    }
  }

  let i = 1;
  while (i < args.length) {
    const arg = args[i];

    if (arg === '--') {
      // Stop parsing options
      positional.push(...args.slice(i + 1));
      break;
    }

    if (arg.startsWith('--')) {
      // Long option
      const [name, value] = arg.slice(2).split('=');

      // Handle --no-* pattern for booleans
      if (name.startsWith('no-')) {
        const actualName = name.slice(3);
        const opt = command.options.find(o => o.name === actualName || o.name === name);
        if (opt && opt.type === 'boolean') {
          options[actualName] = false;
          i++;
          continue;
        }
      }

      const opt = command.options.find(o => o.name === name);
      if (!opt) {
        return {
          success: false,
          error: {
            type: 'invalid_option',
            message: `Unknown option: --${name}`,
            suggestion: `Run 'bun swarm.ts help ${command.name}' for available options`,
          },
        };
      }

      if (opt.type === 'boolean') {
        options[name] = true;
      } else if (value !== undefined) {
        options[name] = opt.type === 'number' ? parseInt(value, 10) : value;
      } else {
        // Value is next argument
        i++;
        if (i >= args.length) {
          return {
            success: false,
            error: { type: 'invalid_option', message: `Option --${name} requires a value` },
          };
        }
        options[name] = opt.type === 'number' ? parseInt(args[i], 10) : args[i];
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      // Short option
      const short = arg[1];
      const opt = command.options.find(o => o.short === short);
      if (!opt) {
        return {
          success: false,
          error: { type: 'invalid_option', message: `Unknown option: -${short}` },
        };
      }

      if (opt.type === 'boolean') {
        options[opt.name] = true;
      } else {
        i++;
        if (i >= args.length) {
          return {
            success: false,
            error: { type: 'invalid_option', message: `Option -${short} requires a value` },
          };
        }
        options[opt.name] = opt.type === 'number' ? parseInt(args[i], 10) : args[i];
      }
    } else {
      // Positional argument
      positional.push(arg);
    }

    i++;
  }

  // Validate required arguments
  for (let j = 0; j < command.arguments.length; j++) {
    const cmdArg = command.arguments[j];
    if (cmdArg.required && positional[j] === undefined) {
      return {
        success: false,
        error: {
          type: 'missing_argument',
          message: `Missing required argument: ${cmdArg.name}`,
          suggestion: `Usage: ${command.usage}`,
        },
      };
    }
  }

  return {
    success: true,
    command: command.name,
    args: { command: command.name, positional, options },
  };
}

// =============================================================================
// Signal Handling
// =============================================================================

let activeOrchestrator: Orchestrator | null = null;
let stopping = false;

/**
 * Set up signal handlers for graceful shutdown.
 */
function setupSignalHandlers(): void {
  process.on('SIGINT', async () => {
    if (stopping) {
      // Second Ctrl+C: force exit
      print('\nForce stopping...', 'warning');
      process.exit(EXIT_CODES.INTERRUPTED);
    }

    stopping = true;
    print('\nStopping gracefully... (Ctrl+C again to force)', 'warning');

    if (activeOrchestrator) {
      try {
        await activeOrchestrator.stop();
        process.exit(EXIT_CODES.SUCCESS);
      } catch {
        process.exit(EXIT_CODES.WORKFLOW_FAILED);
      }
    } else {
      process.exit(EXIT_CODES.SUCCESS);
    }
  });

  process.on('SIGTERM', async () => {
    if (activeOrchestrator) {
      await activeOrchestrator.stop();
    }
    process.exit(EXIT_CODES.SUCCESS);
  });
}

// =============================================================================
// Event Handling
// =============================================================================

/**
 * Subscribe to orchestrator events and display progress.
 */
function subscribeToEvents(orchestrator: Orchestrator): void {
  orchestrator.on((event: OrchestratorEvent) => {
    switch (event.type) {
      case 'session_started':
        print(`Session started: ${event.sessionId}`, 'info');
        break;

      case 'agent_spawned':
        print(`Spawned agent: ${event.role}`, 'success');
        break;

      case 'agent_ready':
        if (config.verbose) {
          print(`Agent ${event.role} ready`, 'debug');
        }
        break;

      case 'agent_working':
        print(`${SYMBOLS.arrow} ${event.role}: ${event.task}`, 'info');
        break;

      case 'agent_complete':
        print(`${event.role} complete: ${event.summary}`, 'success');
        break;

      case 'agent_error':
        print(`${event.role}: ${event.error}`, 'error');
        break;

      case 'message_routed':
        if (config.verbose) {
          print(`Routed ${event.messageType} from ${event.from} to ${event.to}`, 'debug');
        }
        break;

      case 'stage_transition':
        print(`Stage: ${event.from} ${SYMBOLS.arrow} ${event.to}`, 'info');
        break;

      case 'workflow_complete':
        if (event.success) {
          print('Workflow complete', 'success');
        } else {
          print('Workflow failed', 'error');
        }
        break;

      case 'session_ended':
        displayResults(event.result);
        break;
    }
  });
}

/**
 * Display final results.
 */
function displayResults(result: SessionResult): void {
  if (config.json) {
    printJson({
      success: result.success,
      summary: result.summary,
      duration: result.duration,
      durationFormatted: formatDuration(result.duration),
      artifacts: result.artifacts,
      errors: result.errors,
    });
    return;
  }

  console.log();
  print(colorize('Summary:', 'bold'));
  print(`  Status: ${result.success ? colorize('Success', 'green') : colorize('Failed', 'red')}`);
  print(`  Duration: ${formatDuration(result.duration)}`);

  if (result.artifacts.length > 0) {
    print(`  Artifacts: ${result.artifacts.length}`);
    for (const artifact of result.artifacts) {
      print(`    ${SYMBOLS.bullet} ${artifact}`);
    }
  }

  if (result.errors.length > 0) {
    print(`  Errors: ${result.errors.length}`, 'warning');
    for (const error of result.errors) {
      print(`    ${SYMBOLS.bullet} [${error.type}] ${error.message}`, 'warning');
    }
  }
}

// =============================================================================
// Command Handlers
// =============================================================================

/**
 * Handle the 'start' command.
 */
async function handleStart(args: ParsedArgs): Promise<number> {
  const workflow = args.positional[0];
  const goal = args.positional[1];

  // Validate workflow type
  if (!VALID_WORKFLOWS.includes(workflow)) {
    throw createCLIError(
      'argument',
      `Invalid workflow type: ${workflow}`,
      EXIT_CODES.INVALID_ARGS,
      `Valid types: ${VALID_WORKFLOWS.join(', ')}`
    );
  }

  // Validate goal is non-empty
  if (!goal || goal.trim().length === 0) {
    throw createCLIError('argument', 'Goal cannot be empty', EXIT_CODES.INVALID_ARGS);
  }

  // Check for existing session
  const swarmSessions = await tmux.listSwarmSessions();
  if (swarmSessions.length > 0 && !args.options['force']) {
    throw createCLIError(
      'session',
      `A swarm session is already running: ${swarmSessions[0].name}`,
      EXIT_CODES.SESSION_EXISTS,
      "Use 'bun swarm.ts stop' to stop it, or run with --force"
    );
  }

  // Display startup info
  print(`Starting ${workflow} workflow...`);
  print(`Goal: ${goal}`);

  // Create orchestrator config
  const orchestratorConfig: OrchestratorConfig = {
    sessionId: args.options['session-id'] as string | undefined,
    workflowTimeout: (args.options['timeout'] as number) || config.defaultTimeout,
    verboseLogging: config.verbose || (args.options['verbose'] as boolean),
    autoCleanup: !args.options['no-cleanup'],
  };

  // Create and start orchestrator
  const orchestrator = createOrchestrator(orchestratorConfig);
  activeOrchestrator = orchestrator;

  // Subscribe to events
  subscribeToEvents(orchestrator);

  // Start workflow
  const result = await orchestrator.startWorkflow(workflow, goal);

  if (!result.ok) {
    throw createCLIError('workflow', result.error.message, EXIT_CODES.WORKFLOW_FAILED, undefined, result.error.details);
  }

  const session = result.value;
  print(`Session ID: ${session.id}`, 'info');

  // Wait for completion by polling
  return new Promise<number>((resolve) => {
    const checkInterval = setInterval(async () => {
      if (!orchestrator.isRunning()) {
        clearInterval(checkInterval);
        const finalSession = orchestrator.getSession();
        activeOrchestrator = null;

        if (finalSession?.result?.success) {
          resolve(EXIT_CODES.SUCCESS);
        } else {
          resolve(EXIT_CODES.WORKFLOW_FAILED);
        }
      }
    }, 1000);
  });
}

/**
 * Handle the 'attach' command.
 */
async function handleAttach(args: ParsedArgs): Promise<number> {
  const sessionId = args.options['session'] as string | undefined;

  // Find swarm sessions
  const sessions = await tmux.listSwarmSessions();

  if (sessions.length === 0) {
    print('No active swarm session found.', 'warning');
    print("Run 'bun swarm.ts start <workflow> \"<goal>\"' to begin.");
    return EXIT_CODES.WORKFLOW_FAILED;
  }

  let targetSession: string;

  if (sessionId) {
    // Look for specific session
    const match = sessions.find(s => s.name === sessionId || s.name === `swarm_${sessionId}`);
    if (!match) {
      throw createCLIError('session', `Session not found: ${sessionId}`, EXIT_CODES.WORKFLOW_FAILED);
    }
    targetSession = match.name;
  } else if (sessions.length === 1) {
    targetSession = sessions[0].name;
  } else {
    // Multiple sessions - show list
    print('Multiple sessions found. Specify one with --session:', 'info');
    for (const session of sessions) {
      print(`  ${SYMBOLS.bullet} ${session.name}`);
    }
    return EXIT_CODES.INVALID_ARGS;
  }

  print(`Attaching to session ${targetSession}...`);
  print('Detach with: Ctrl+B, D');

  // Attach to session
  await tmux.attachSession(targetSession);

  return EXIT_CODES.SUCCESS;
}

/**
 * Handle the 'status' command.
 */
async function handleStatus(args: ParsedArgs): Promise<number> {
  const watchMode = args.options['watch'] as boolean;
  const jsonOutput = args.options['json'] as boolean || config.json;

  const showStatus = async (): Promise<boolean> => {
    // Find active sessions
    const sessions = await tmux.listSwarmSessions();

    if (sessions.length === 0) {
      if (jsonOutput) {
        printJson({ active: false, message: 'No active session' });
      } else {
        print('No active swarm session.', 'info');
      }
      return false;
    }

    const session = sessions[0];
    const sessionId = session.name.replace('swarm_', '');

    // Get session from database
    const dbSession = db.getSession(sessionId);
    const stats = db.getSessionStats(sessionId);

    // Get panes
    const panes = await tmux.listPanes(session.name);

    if (jsonOutput) {
      printJson({
        active: true,
        sessionId,
        sessionName: session.name,
        workflow: dbSession?.workflowType || 'unknown',
        status: dbSession?.status || 'unknown',
        startedAt: dbSession?.createdAt,
        panes: panes.length,
        stats,
      });
    } else {
      console.log();
      print(colorize(`Session: ${session.name}`, 'bold'));
      if (dbSession) {
        print(`Workflow: ${dbSession.workflowType}`);
        print(`Status: ${dbSession.status}`);
        print(`Started: ${formatRelativeTime(dbSession.createdAt)}`);
        print(`Goal: ${dbSession.goal.substring(0, 60)}${dbSession.goal.length > 60 ? '...' : ''}`);
      }

      console.log();
      print(colorize('Agents:', 'bold'));
      if (panes.length > 0) {
        const headers = ['PANE', 'TITLE', 'SIZE'];
        const rows = panes.map(p => [
          p.id,
          p.title || '(unnamed)',
          `${p.width}x${p.height}`,
        ]);
        printTable(headers, rows);
      } else {
        print('  No agents running');
      }

      if (stats) {
        console.log();
        print(colorize('Stats:', 'bold'));
        print(`  Messages: ${stats.messages}`);
        print(`  Tasks: ${stats.tasks.complete}/${stats.tasks.total} complete`);
        print(`  Findings: ${stats.findings.verified}/${stats.findings.total} verified`);
        print(`  Artifacts: ${stats.artifacts.approved}/${stats.artifacts.total} approved`);
      }
    }

    return true;
  };

  if (watchMode) {
    // Continuous update mode
    console.clear();
    let running = true;

    process.on('SIGINT', () => {
      running = false;
    });

    while (running) {
      console.clear();
      const hasSession = await showStatus();
      if (!hasSession) {
        break;
      }
      print(colorize('\nPress Ctrl+C to exit watch mode', 'dim'));
      await new Promise(r => setTimeout(r, 2000));
    }
  } else {
    await showStatus();
  }

  return EXIT_CODES.SUCCESS;
}

/**
 * Handle the 'logs' command.
 */
async function handleLogs(args: ParsedArgs): Promise<number> {
  const agent = args.positional[0] as AgentRole;
  const lines = (args.options['lines'] as number) || 100;
  const follow = args.options['follow'] as boolean;

  // Find active session
  const sessions = await tmux.listSwarmSessions();
  if (sessions.length === 0) {
    throw createCLIError('session', 'No active swarm session', EXIT_CODES.WORKFLOW_FAILED);
  }

  const sessionName = sessions[0].name;
  const panes = await tmux.listPanes(sessionName);

  // Find agent's pane
  const pane = panes.find(p => p.title === agent);
  if (!pane) {
    throw createCLIError(
      'session',
      `Agent '${agent}' is not active`,
      EXIT_CODES.WORKFLOW_FAILED,
      `Active agents: ${panes.map(p => p.title).filter(Boolean).join(', ') || 'none'}`
    );
  }

  const showLogs = async (): Promise<void> => {
    const result = await tmux.capturePane(sessionName, pane.id, { lines });
    if (result.ok) {
      console.log(result.value);
    } else {
      throw createCLIError('system', `Failed to capture logs: ${result.error.message}`, EXIT_CODES.WORKFLOW_FAILED);
    }
  };

  if (follow) {
    // Follow mode
    let running = true;
    process.on('SIGINT', () => {
      running = false;
    });

    let lastOutput = '';
    while (running) {
      const result = await tmux.capturePane(sessionName, pane.id, { lines: 50 });
      if (result.ok && result.value !== lastOutput) {
        console.clear();
        console.log(result.value);
        lastOutput = result.value;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  } else {
    await showLogs();
  }

  return EXIT_CODES.SUCCESS;
}

/**
 * Handle the 'messages' command.
 */
async function handleMessages(args: ParsedArgs): Promise<number> {
  const agent = args.positional[0];
  const inboxOnly = args.options['inbox'] as boolean;
  const outboxOnly = args.options['outbox'] as boolean;
  const countOnly = args.options['count'] as boolean;

  const agents = agent ? [agent] : messageBus.VALID_AGENTS;

  if (countOnly) {
    const summary = messageBus.getQueueSummary();

    if (config.json) {
      printJson(summary);
    } else {
      const headers = ['AGENT', 'INBOX', 'OUTBOX'];
      const rows = Object.entries(summary).map(([a, counts]) => [
        a,
        counts.inbox.toString(),
        counts.outbox.toString(),
      ]);
      printTable(headers, rows);
    }

    return EXIT_CODES.SUCCESS;
  }

  for (const a of agents) {
    if (!messageBus.isValidAgent(a)) {
      print(`Skipping invalid agent: ${a}`, 'warning');
      continue;
    }

    console.log();
    print(colorize(`${a}:`, 'bold'));

    if (!outboxOnly) {
      const inbox = messageBus.readInbox(a);
      print(`  INBOX (${inbox.length}):`);
      if (inbox.length === 0) {
        print('    empty', 'info');
      } else {
        for (const msg of inbox.slice(-10)) {
          print(`    [${msg.type}] ${formatRelativeTime(msg.timestamp)} - ${msg.content.subject.substring(0, 40)}`);
        }
      }
    }

    if (!inboxOnly) {
      const outbox = messageBus.readOutbox(a);
      print(`  OUTBOX (${outbox.length}):`);
      if (outbox.length === 0) {
        print('    empty', 'info');
      } else {
        for (const msg of outbox.slice(-10)) {
          print(`    [${msg.type}] ${formatRelativeTime(msg.timestamp)} - ${msg.content.subject.substring(0, 40)}`);
        }
      }
    }
  }

  return EXIT_CODES.SUCCESS;
}

/**
 * Handle the 'stop' command.
 */
async function handleStop(args: ParsedArgs): Promise<number> {
  // Timeout for graceful shutdown (reserved for future implementation)
  const _timeout = (args.options['timeout'] as number) || 10000;
  void _timeout; // Suppress unused warning

  // Find active session
  const sessions = await tmux.listSwarmSessions();
  if (sessions.length === 0) {
    print('No active swarm session to stop.', 'info');
    return EXIT_CODES.SUCCESS;
  }

  const sessionName = sessions[0].name;
  print(`Stopping session ${sessionName}...`);

  // Kill tmux session
  const result = await tmux.killSession(sessionName);
  if (!result.ok) {
    throw createCLIError('system', `Failed to stop session: ${result.error.message}`, EXIT_CODES.WORKFLOW_FAILED);
  }

  print('Session stopped.', 'success');
  return EXIT_CODES.SUCCESS;
}

/**
 * Handle the 'kill' command.
 */
async function handleKill(args: ParsedArgs): Promise<number> {
  const killAll = args.options['all'] as boolean;

  const sessions = await tmux.listSwarmSessions();

  if (sessions.length === 0) {
    print('No swarm sessions to kill.', 'info');
    return EXIT_CODES.SUCCESS;
  }

  if (killAll) {
    await tmux.killAllSwarmSessions();
    print(`Killed ${sessions.length} session(s).`, 'success');
  } else {
    await tmux.killSession(sessions[0].name);
    print(`Killed session: ${sessions[0].name}`, 'success');
  }

  return EXIT_CODES.SUCCESS;
}

/**
 * Handle the 'clean' command.
 */
async function handleClean(args: ParsedArgs): Promise<number> {
  const cleanAll = args.options['all'] as boolean;
  const cleanWorktrees = args.options['worktrees'] as boolean;
  const cleanMessages = args.options['messages'] as boolean;
  const cleanSessions = args.options['sessions'] as boolean;

  // Default to all if no specific option
  const shouldCleanAll = cleanAll || (!cleanWorktrees && !cleanMessages && !cleanSessions);

  let cleaned = 0;

  // Clean message queues
  if (shouldCleanAll || cleanMessages) {
    messageBus.clearAllQueues();
    print('Cleared message queues', 'success');
    cleaned++;
  }

  // Clean worktrees
  if (shouldCleanAll || cleanWorktrees) {
    const worktreePath = '.worktrees';
    if (existsSync(worktreePath)) {
      try {
        rmSync(worktreePath, { recursive: true, force: true });
        print('Removed worktrees directory', 'success');
        cleaned++;
      } catch (e) {
        print(`Failed to remove worktrees: ${e}`, 'warning');
      }
    }
  }

  // Clean session state
  if (shouldCleanAll || cleanSessions) {
    const sessionPath = join(SWARM_DIR, 'sessions');
    if (existsSync(sessionPath)) {
      try {
        rmSync(sessionPath, { recursive: true, force: true });
        print('Removed session state', 'success');
        cleaned++;
      } catch (e) {
        print(`Failed to remove sessions: ${e}`, 'warning');
      }
    }
  }

  print(`Cleaned ${cleaned} artifact type(s).`, 'success');
  return EXIT_CODES.SUCCESS;
}

/**
 * Handle the 'history' command.
 */
async function handleHistory(args: ParsedArgs): Promise<number> {
  const limit = (args.options['limit'] as number) || 10;
  const jsonOutput = args.options['json'] as boolean || config.json;

  const sessions = db.listSessions();
  const limited = sessions.slice(0, limit);

  if (jsonOutput) {
    printJson(limited.map(s => ({
      id: s.id,
      workflowType: s.workflowType,
      goal: s.goal,
      status: s.status,
      createdAt: s.createdAt,
      completedAt: s.completedAt,
    })));
  } else if (limited.length === 0) {
    print('No session history found.', 'info');
  } else {
    const headers = ['SESSION', 'WORKFLOW', 'GOAL', 'STATUS', 'CREATED'];
    const rows = limited.map(s => [
      s.id.substring(0, 15),
      s.workflowType,
      s.goal.substring(0, 30) + (s.goal.length > 30 ? '...' : ''),
      s.status,
      formatRelativeTime(s.createdAt),
    ]);
    printTable(headers, rows, { minWidth: [15, 10, 30, 10, 10] });
  }

  return EXIT_CODES.SUCCESS;
}

/**
 * Handle the 'help' command.
 */
async function handleHelp(args: ParsedArgs, commands: Map<string, Command>): Promise<number> {
  const commandName = args.positional[0];

  if (commandName) {
    // Show help for specific command
    const command = commands.get(commandName);
    if (!command) {
      print(`Unknown command: ${commandName}`, 'error');
      return EXIT_CODES.INVALID_ARGS;
    }

    console.log();
    console.log(colorize('Usage:', 'bold'));
    console.log(`  ${command.usage}`);
    console.log();
    console.log(command.description);
    console.log();

    if (command.arguments.length > 0) {
      console.log(colorize('Arguments:', 'bold'));
      for (const arg of command.arguments) {
        const reqStr = arg.required ? '(required)' : '(optional)';
        console.log(`  ${arg.name.padEnd(15)} ${arg.description} ${colorize(reqStr, 'dim')}`);
        if (arg.choices) {
          console.log(`                  Choices: ${arg.choices.join(', ')}`);
        }
      }
      console.log();
    }

    if (command.options.length > 0) {
      console.log(colorize('Options:', 'bold'));
      for (const opt of command.options) {
        const shortStr = opt.short ? `-${opt.short}, ` : '    ';
        const defaultStr = opt.default !== undefined ? ` (default: ${opt.default})` : '';
        console.log(`  ${shortStr}--${opt.name.padEnd(15)} ${opt.description}${colorize(defaultStr, 'dim')}`);
      }
      console.log();
    }

    if (command.examples.length > 0) {
      console.log(colorize('Examples:', 'bold'));
      for (const example of command.examples) {
        console.log(`  ${example}`);
      }
      console.log();
    }
  } else {
    // Show general help
    console.log();
    console.log(colorize('Claude Swarm - Multi-Agent Collaboration', 'bold'));
    console.log();
    console.log('Usage:');
    console.log('  bun swarm.ts <command> [options]');
    console.log();
    console.log(colorize('Commands:', 'bold'));

    const commandList = Array.from(commands.values());
    const maxLen = Math.max(...commandList.map(c => c.name.length));

    for (const cmd of commandList) {
      console.log(`  ${cmd.name.padEnd(maxLen + 2)} ${cmd.description}`);
    }

    console.log();
    console.log(colorize('Workflows:', 'bold'));
    const templates = listWorkflowTemplates();
    for (const t of templates) {
      console.log(`  ${t.name.padEnd(12)} ${t.description.substring(0, 50)}...`);
    }

    console.log();
    console.log("Run 'bun swarm.ts help <command>' for detailed information.");
    console.log();
  }

  return EXIT_CODES.SUCCESS;
}

// =============================================================================
// Command Definitions
// =============================================================================

/**
 * Define all CLI commands.
 */
function defineCommands(): Map<string, Command> {
  const commands = new Map<string, Command>();

  commands.set('start', {
    name: 'start',
    description: 'Start a new workflow session',
    usage: 'bun swarm.ts start <workflow> "<goal>"',
    arguments: [
      {
        name: 'workflow',
        description: 'Workflow type',
        required: true,
        type: 'choice',
        choices: VALID_WORKFLOWS,
      },
      {
        name: 'goal',
        description: 'The goal or query for the workflow',
        required: true,
        type: 'string',
      },
    ],
    options: [
      { name: 'session-id', short: 's', description: 'Custom session ID', type: 'string' },
      { name: 'timeout', short: 't', description: 'Workflow timeout in ms', type: 'number', default: 1800000 },
      { name: 'verbose', short: 'v', description: 'Enable verbose logging', type: 'boolean', default: false },
      { name: 'no-cleanup', description: 'Keep artifacts after completion', type: 'boolean', default: false },
      { name: 'force', short: 'f', description: 'Force start even if session exists', type: 'boolean', default: false },
    ],
    examples: [
      'bun swarm.ts start research "quantum computing basics"',
      'bun swarm.ts start implement "rate limiter middleware" --verbose',
      'bun swarm.ts start full "distributed task queue" -t 3600000',
    ],
    prerequisites: ['tmux', 'git_repo', 'claude_cli'],
    handler: handleStart,
  });

  commands.set('attach', {
    name: 'attach',
    description: 'Attach to active tmux session',
    usage: 'bun swarm.ts attach',
    arguments: [],
    options: [
      { name: 'session', short: 's', description: 'Specific session ID to attach', type: 'string' },
      { name: 'readonly', short: 'r', description: 'Read-only attachment', type: 'boolean', default: false },
    ],
    examples: [
      'bun swarm.ts attach',
      'bun swarm.ts attach -s swarm_1703702400',
    ],
    prerequisites: ['tmux'],
    handler: handleAttach,
  });

  commands.set('status', {
    name: 'status',
    description: 'Show current session status',
    usage: 'bun swarm.ts status',
    arguments: [],
    options: [
      { name: 'json', short: 'j', description: 'Output as JSON', type: 'boolean', default: false },
      { name: 'watch', short: 'w', description: 'Continuous update', type: 'boolean', default: false },
    ],
    examples: [
      'bun swarm.ts status',
      'bun swarm.ts status --watch',
      'bun swarm.ts status --json',
    ],
    prerequisites: ['tmux'],
    handler: handleStatus,
  });

  commands.set('logs', {
    name: 'logs',
    description: "Show agent's terminal output",
    usage: 'bun swarm.ts logs <agent>',
    arguments: [
      {
        name: 'agent',
        description: 'Agent role',
        required: true,
        type: 'choice',
        choices: ['researcher', 'developer', 'reviewer', 'architect'],
      },
    ],
    options: [
      { name: 'lines', short: 'n', description: 'Number of lines to show', type: 'number', default: 100 },
      { name: 'follow', short: 'f', description: 'Continuously show new output', type: 'boolean', default: false },
    ],
    examples: [
      'bun swarm.ts logs researcher',
      'bun swarm.ts logs developer -n 50',
      'bun swarm.ts logs reviewer --follow',
    ],
    prerequisites: ['tmux'],
    handler: handleLogs,
  });

  commands.set('messages', {
    name: 'messages',
    description: 'Show message queue contents',
    usage: 'bun swarm.ts messages [agent]',
    arguments: [
      {
        name: 'agent',
        description: 'Specific agent to show (all if omitted)',
        required: false,
        type: 'string',
      },
    ],
    options: [
      { name: 'inbox', short: 'i', description: 'Show inbox only', type: 'boolean', default: false },
      { name: 'outbox', short: 'o', description: 'Show outbox only', type: 'boolean', default: false },
      { name: 'count', short: 'c', description: 'Show counts only', type: 'boolean', default: false },
    ],
    examples: [
      'bun swarm.ts messages',
      'bun swarm.ts messages researcher',
      'bun swarm.ts messages --count',
    ],
    prerequisites: [],
    handler: handleMessages,
  });

  commands.set('stop', {
    name: 'stop',
    description: 'Gracefully stop the current session',
    usage: 'bun swarm.ts stop',
    arguments: [],
    options: [
      { name: 'save', short: 's', description: 'Save current state', type: 'boolean', default: true },
      { name: 'timeout', short: 't', description: 'Shutdown timeout in ms', type: 'number', default: 10000 },
    ],
    examples: [
      'bun swarm.ts stop',
      'bun swarm.ts stop --no-save',
    ],
    prerequisites: ['tmux'],
    handler: handleStop,
  });

  commands.set('kill', {
    name: 'kill',
    description: 'Force terminate all agents',
    usage: 'bun swarm.ts kill',
    arguments: [],
    options: [
      { name: 'all', short: 'a', description: 'Kill all swarm sessions', type: 'boolean', default: false },
    ],
    examples: [
      'bun swarm.ts kill',
      'bun swarm.ts kill --all',
    ],
    prerequisites: ['tmux'],
    handler: handleKill,
  });

  commands.set('clean', {
    name: 'clean',
    description: 'Remove session artifacts',
    usage: 'bun swarm.ts clean',
    arguments: [],
    options: [
      { name: 'all', short: 'a', description: 'Clean all artifacts', type: 'boolean', default: false },
      { name: 'worktrees', short: 'w', description: 'Clean worktrees only', type: 'boolean', default: false },
      { name: 'messages', short: 'm', description: 'Clean messages only', type: 'boolean', default: false },
      { name: 'sessions', short: 's', description: 'Clean session state only', type: 'boolean', default: false },
    ],
    examples: [
      'bun swarm.ts clean',
      'bun swarm.ts clean --worktrees',
      'bun swarm.ts clean --messages',
    ],
    prerequisites: [],
    handler: handleClean,
  });

  commands.set('history', {
    name: 'history',
    description: 'Show past sessions',
    usage: 'bun swarm.ts history',
    arguments: [],
    options: [
      { name: 'limit', short: 'n', description: 'Number of sessions to show', type: 'number', default: 10 },
      { name: 'json', short: 'j', description: 'Output as JSON', type: 'boolean', default: false },
    ],
    examples: [
      'bun swarm.ts history',
      'bun swarm.ts history -n 20',
      'bun swarm.ts history --json',
    ],
    prerequisites: [],
    handler: handleHistory,
  });

  commands.set('help', {
    name: 'help',
    aliases: ['h', '?'],
    description: 'Show help documentation',
    usage: 'bun swarm.ts help [command]',
    arguments: [
      {
        name: 'command',
        description: 'Command to show help for',
        required: false,
        type: 'string',
      },
    ],
    options: [],
    examples: [
      'bun swarm.ts help',
      'bun swarm.ts help start',
    ],
    prerequisites: [],
    handler: async (args) => handleHelp(args, commands),
  });

  return commands;
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  // Set up signal handlers
  setupSignalHandlers();

  // Load configuration
  config = loadConfig();

  // Define commands
  const commands = defineCommands();

  // Parse arguments
  const parseResult = parseArgs(process.argv, commands);

  if (!parseResult.success) {
    if (parseResult.error) {
      print(`Error: ${parseResult.error.message}`, 'error');
      if (parseResult.error.suggestion) {
        print(parseResult.error.suggestion, 'info');
      }
    }
    process.exit(EXIT_CODES.INVALID_ARGS);
  }

  const { command: commandName, args } = parseResult;
  if (!commandName || !args) {
    process.exit(EXIT_CODES.INVALID_ARGS);
  }

  const command = commands.get(commandName);
  if (!command) {
    print(`Unknown command: ${commandName}`, 'error');
    process.exit(EXIT_CODES.INVALID_ARGS);
  }

  // Update config from command options
  if (args.options['verbose']) {
    config.verbose = true;
  }
  if (args.options['json']) {
    config.json = true;
  }

  // Check prerequisites
  if (command.prerequisites && command.prerequisites.length > 0) {
    const failed = await checkPrerequisites(command.prerequisites);
    if (failed.length > 0) {
      for (const prereq of failed) {
        print(`${prereq.errorMessage}`, 'error');
        print(`${prereq.remediation}`, 'info');
      }
      process.exit(EXIT_CODES.WORKFLOW_FAILED);
    }
  }

  // Execute command
  try {
    const exitCode = await command.handler(args);
    process.exit(exitCode);
  } catch (error) {
    handleError(error);
  }
}

// Run main
main().catch(handleError);
