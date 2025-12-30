/**
 * Claude Swarm - Comprehensive Logging System
 *
 * Provides structured logging with file output organized by session and module.
 * Console output stays minimal; detailed logs go to files.
 *
 * Log format: [ISO-timestamp] [module] [level] [event:name] [key:value]... Message
 */

import { existsSync, mkdirSync, appendFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// =============================================================================
// Type Definitions
// =============================================================================

/**
 * Log severity levels.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Module names for categorizing logs.
 */
export type LogModule = 'orchestrator' | 'messages' | 'subprocess' | 'workflow' | 'errors';

/**
 * Tags for structured log entries.
 */
export type LogTags = Record<string, string | number | boolean | undefined>;

/**
 * Module-specific logger interface.
 */
export interface ModuleLogger {
  debug(event: string, tags: LogTags, message: string): void;
  info(event: string, tags: LogTags, message: string): void;
  warn(event: string, tags: LogTags, message: string): void;
  error(event: string, tags: LogTags, message: string): void;
}

/**
 * Main logger interface providing module-specific loggers.
 */
export interface Logger {
  orchestrator: ModuleLogger;
  messages: ModuleLogger;
  subprocess: ModuleLogger;
  workflow: ModuleLogger;
  close(): Promise<void>;
}

/**
 * Logger configuration options.
 */
export interface LoggerOptions {
  /** Minimum level for console output (default: 'info') */
  consoleLevel?: LogLevel;
  /** Minimum level for file output (default: 'debug') */
  fileLevel?: LogLevel;
  /** Base directory for log files (default: 'logs/') */
  logDir?: string;
}

// =============================================================================
// Constants
// =============================================================================

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const DEFAULT_LOG_DIR = 'logs';

// Environment variable overrides
const ENV_LOG_LEVEL = process.env.SWARM_LOG_LEVEL as LogLevel | undefined;
const ENV_CONSOLE_LEVEL = process.env.SWARM_CONSOLE_LEVEL as LogLevel | undefined;
const ENV_LOG_DIR = process.env.SWARM_LOG_DIR;


// =============================================================================
// Formatting Functions
// =============================================================================

/**
 * Format a log entry in the standard format.
 * Format: [ISO-timestamp] [module] [level] [event:name] [key:value]... Message
 */
function formatLogEntry(
  timestamp: string,
  module: LogModule,
  level: LogLevel,
  event: string,
  tags: LogTags,
  message: string
): string {
  const parts: string[] = [
    `[${timestamp}]`,
    `[${module}]`,
    `[${level}]`,
    `[event:${event}]`,
  ];

  // Add tags
  for (const [key, value] of Object.entries(tags)) {
    if (value !== undefined) {
      parts.push(`[${key}:${value}]`);
    }
  }

  // Add message
  parts.push(message);

  return parts.join(' ');
}

/**
 * Format a console message (minimal output).
 */
function formatConsoleMessage(level: LogLevel, message: string): string {
  const symbols: Record<LogLevel, string> = {
    debug: '*',
    info: '[ok]',
    warn: '[!]',
    error: '[x]',
  };

  return `${symbols[level]} ${message}`;
}

/**
 * Get current ISO timestamp.
 */
function getTimestamp(): string {
  return new Date().toISOString();
}

// =============================================================================
// File Operations
// =============================================================================

/**
 * Ensure the log directory exists.
 */
function ensureLogDir(logDir: string): void {
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
}

/**
 * Get the log file path for a module.
 */
function getLogFilePath(logDir: string, module: LogModule | 'errors'): string {
  return join(logDir, `${module}.log`);
}

/**
 * Write to a log file (append mode).
 */
function writeToFile(filePath: string, content: string): void {
  try {
    appendFileSync(filePath, content + '\n', 'utf-8');
  } catch (error) {
    // Fallback to console if file write fails
    console.error(`[logger] Failed to write to ${filePath}: ${error}`);
  }
}

/**
 * Initialize a log file with a header.
 */
function initializeLogFile(filePath: string, module: string, sessionId: string): void {
  const header = [
    `# ${module.toUpperCase()} LOG`,
    `# Session: ${sessionId}`,
    `# Started: ${getTimestamp()}`,
    '#',
    '',
  ].join('\n');

  try {
    writeFileSync(filePath, header, 'utf-8');
  } catch (error) {
    console.error(`[logger] Failed to initialize ${filePath}: ${error}`);
  }
}

// =============================================================================
// Logger Implementation
// =============================================================================

/**
 * Create a module-specific logger.
 */
function createModuleLogger(
  module: LogModule,
  sessionLogDir: string,
  fileLevel: LogLevel,
  consoleLevel: LogLevel
): ModuleLogger {
  const logFilePath = getLogFilePath(sessionLogDir, module);
  const errorsFilePath = getLogFilePath(sessionLogDir, 'errors');

  const shouldLogToFile = (level: LogLevel): boolean => {
    return LOG_LEVELS[level] >= LOG_LEVELS[fileLevel];
  };

  const shouldLogToConsole = (level: LogLevel): boolean => {
    return LOG_LEVELS[level] >= LOG_LEVELS[consoleLevel];
  };

  const log = (level: LogLevel, event: string, tags: LogTags, message: string): void => {
    const timestamp = getTimestamp();

    // File logging
    if (shouldLogToFile(level)) {
      const entry = formatLogEntry(timestamp, module, level, event, tags, message);
      writeToFile(logFilePath, entry);

      // Duplicate errors and warnings to errors.log
      if (level === 'error' || level === 'warn') {
        writeToFile(errorsFilePath, entry);
      }
    }

    // Console logging (minimal)
    if (shouldLogToConsole(level)) {
      const consoleMsg = formatConsoleMessage(level, message);
      if (level === 'error') {
        console.error(consoleMsg);
      } else if (level === 'warn') {
        console.warn(consoleMsg);
      } else {
        console.log(consoleMsg);
      }
    }
  };

  return {
    debug: (event, tags, message) => log('debug', event, tags, message),
    info: (event, tags, message) => log('info', event, tags, message),
    warn: (event, tags, message) => log('warn', event, tags, message),
    error: (event, tags, message) => log('error', event, tags, message),
  };
}

/**
 * Create a new logger instance for a session.
 *
 * @param sessionId - Unique session identifier
 * @param options - Logger configuration options
 * @returns Logger instance with module-specific loggers
 */
export function createLogger(sessionId: string, options?: LoggerOptions): Logger {
  // Determine configuration with environment overrides
  const fileLevel = ENV_LOG_LEVEL ?? options?.fileLevel ?? 'debug';
  const consoleLevel = ENV_CONSOLE_LEVEL ?? options?.consoleLevel ?? 'info';
  const baseLogDir = ENV_LOG_DIR ?? options?.logDir ?? DEFAULT_LOG_DIR;

  // Create session-specific log directory
  const sessionLogDir = join(baseLogDir, sessionId);
  ensureLogDir(sessionLogDir);

  // Initialize log files
  const modules: (LogModule | 'errors')[] = ['orchestrator', 'messages', 'subprocess', 'workflow', 'errors'];
  for (const module of modules) {
    const filePath = getLogFilePath(sessionLogDir, module);
    initializeLogFile(filePath, module, sessionId);
  }

  // Create module loggers
  const orchestrator = createModuleLogger('orchestrator', sessionLogDir, fileLevel, consoleLevel);
  const messages = createModuleLogger('messages', sessionLogDir, fileLevel, consoleLevel);
  const subprocess = createModuleLogger('subprocess', sessionLogDir, fileLevel, consoleLevel);
  const workflow = createModuleLogger('workflow', sessionLogDir, fileLevel, consoleLevel);

  // Log session start
  orchestrator.info('session_start', { session: sessionId }, `Session ${sessionId} started`);

  return {
    orchestrator,
    messages,
    subprocess,
    workflow,
    close: async () => {
      // Log session end and flush
      orchestrator.info('session_end', { session: sessionId }, `Session ${sessionId} ended`);
      // No file handles to close with appendFileSync approach
    },
  };
}

/**
 * Create a no-op logger for testing or when logging is disabled.
 */
export function createNoopLogger(): Logger {
  const noopModule: ModuleLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  return {
    orchestrator: noopModule,
    messages: noopModule,
    subprocess: noopModule,
    workflow: noopModule,
    close: async () => {},
  };
}

/**
 * Format file size for logging.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}b`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}kb`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}mb`;
}

/**
 * Format duration for logging.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

/**
 * Truncate output for logging (prevents huge log entries).
 */
export function truncateOutput(output: string, maxLength: number = 10240): string {
  if (output.length <= maxLength) return output;
  return output.substring(0, maxLength) + `... [truncated ${output.length - maxLength} chars]`;
}
