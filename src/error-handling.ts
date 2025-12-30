/**
 * Claude Swarm - Error Handling & Recovery
 *
 * Cross-cutting concern that provides robust error detection, recovery strategies,
 * graceful degradation, and state persistence across all Claude Swarm components.
 */

import {
  type Result,
  ok,
  err,
  generateId,
  now,
} from './types.js';

import { getDb } from './db.js';
import { type Logger, createNoopLogger } from './logger.js';

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
// Safe JSON Utilities
// =============================================================================

/**
 * Safely stringify an object, handling circular references and large objects.
 * Returns a truncated/sanitized version if serialization fails.
 */
function safeJsonStringify(obj: unknown, maxLength: number = 1024 * 1024): string {
  const seen = new WeakSet();

  try {
    const result = JSON.stringify(obj, (_key, value) => {
      // Handle circular references
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular Reference]';
        }
        seen.add(value);
      }
      // Handle BigInt
      if (typeof value === 'bigint') {
        return value.toString();
      }
      // Handle functions
      if (typeof value === 'function') {
        return '[Function]';
      }
      return value;
    });

    // Truncate if too large
    if (result.length > maxLength) {
      return JSON.stringify({
        _truncated: true,
        _originalLength: result.length,
        _message: 'Object too large to serialize fully',
      });
    }

    return result;
  } catch (error) {
    return JSON.stringify({
      _serializationError: true,
      _message: String(error),
    });
  }
}

/**
 * Safely parse JSON, returning a default value on failure.
 */
function safeJsonParse<T>(json: string | null | undefined, defaultValue: T): T {
  if (!json) {
    return defaultValue;
  }

  try {
    return JSON.parse(json) as T;
  } catch {
    moduleLogger.orchestrator.warn('json_parse_failed', {}, `Failed to parse JSON: ${json.substring(0, 100)}...`);
    return defaultValue;
  }
}

// =============================================================================
// Error Types and Taxonomy
// =============================================================================

/**
 * Categories of errors in the swarm system.
 */
export type ErrorCategory =
  | 'AGENT_ERROR'      // Agent-related failures
  | 'WORKFLOW_ERROR'   // Workflow execution failures
  | 'SYSTEM_ERROR'     // System/infrastructure failures
  | 'USER_ERROR'       // User input/action errors
  | 'EXTERNAL_ERROR';  // External service failures

/**
 * Severity levels for errors.
 */
export type ErrorSeverity =
  | 'fatal'    // Cannot continue, must stop
  | 'error'    // Serious, may require intervention
  | 'warning'  // Issue detected, continuing
  | 'info';    // Informational only

/**
 * A structured error in the swarm system.
 */
export interface SwarmError {
  // Identification
  id: string;
  code: string;
  category: ErrorCategory;
  severity: ErrorSeverity;

  // Context
  message: string;
  details?: string;
  component: string;
  sessionId?: string;
  agentRole?: string;

  // Timing
  timestamp: string;
  duration?: number;

  // Recovery
  recoverable: boolean;
  retryable: boolean;
  retryCount?: number;
  recoveryStrategy?: string;

  // Debugging
  stack?: string;
  context?: Record<string, unknown>;
  cause?: SwarmError;
}

/**
 * Error code definition with default properties.
 */
export interface ErrorCodeDefinition {
  code: string;
  category: ErrorCategory;
  severity: ErrorSeverity;
  message: string;
  recoverable: boolean;
  retryable: boolean;
}

// =============================================================================
// Error Code Definitions
// =============================================================================

/**
 * Agent-related error codes.
 */
export const AGENT_ERRORS: Record<string, ErrorCodeDefinition> = {
  AGENT_SPAWN_FAILED: {
    code: 'AGENT_SPAWN_FAILED',
    category: 'AGENT_ERROR',
    severity: 'error',
    message: 'Failed to spawn agent',
    recoverable: true,
    retryable: true,
  },
  AGENT_TIMEOUT: {
    code: 'AGENT_TIMEOUT',
    category: 'AGENT_ERROR',
    severity: 'error',
    message: 'Agent did not respond within timeout',
    recoverable: true,
    retryable: true,
  },
  AGENT_CRASHED: {
    code: 'AGENT_CRASHED',
    category: 'AGENT_ERROR',
    severity: 'error',
    message: 'Agent process terminated unexpectedly',
    recoverable: true,
    retryable: true,
  },
  AGENT_INVALID_OUTPUT: {
    code: 'AGENT_INVALID_OUTPUT',
    category: 'AGENT_ERROR',
    severity: 'warning',
    message: 'Agent produced invalid or malformed output',
    recoverable: true,
    retryable: true,
  },
  AGENT_BLOCKED: {
    code: 'AGENT_BLOCKED',
    category: 'AGENT_ERROR',
    severity: 'warning',
    message: 'Agent is blocked waiting for input',
    recoverable: true,
    retryable: false,
  },
};

/**
 * Workflow-related error codes.
 */
export const WORKFLOW_ERRORS: Record<string, ErrorCodeDefinition> = {
  WORKFLOW_NOT_FOUND: {
    code: 'WORKFLOW_NOT_FOUND',
    category: 'WORKFLOW_ERROR',
    severity: 'fatal',
    message: 'Specified workflow type does not exist',
    recoverable: false,
    retryable: false,
  },
  WORKFLOW_TIMEOUT: {
    code: 'WORKFLOW_TIMEOUT',
    category: 'WORKFLOW_ERROR',
    severity: 'error',
    message: 'Workflow exceeded maximum duration',
    recoverable: true,
    retryable: false,
  },
  MAX_ITERATIONS: {
    code: 'MAX_ITERATIONS',
    category: 'WORKFLOW_ERROR',
    severity: 'warning',
    message: 'Maximum revision iterations reached',
    recoverable: true,
    retryable: false,
  },
  STAGE_FAILED: {
    code: 'STAGE_FAILED',
    category: 'WORKFLOW_ERROR',
    severity: 'error',
    message: 'Workflow stage failed to complete',
    recoverable: true,
    retryable: true,
  },
  ROUTING_FAILED: {
    code: 'ROUTING_FAILED',
    category: 'WORKFLOW_ERROR',
    severity: 'error',
    message: 'Failed to route message to target agent',
    recoverable: true,
    retryable: true,
  },
};

/**
 * System-related error codes.
 */
export const SYSTEM_ERRORS: Record<string, ErrorCodeDefinition> = {
  TMUX_NOT_FOUND: {
    code: 'TMUX_NOT_FOUND',
    category: 'SYSTEM_ERROR',
    severity: 'fatal',
    message: 'tmux is not installed',
    recoverable: false,
    retryable: false,
  },
  TMUX_SESSION_FAILED: {
    code: 'TMUX_SESSION_FAILED',
    category: 'SYSTEM_ERROR',
    severity: 'error',
    message: 'Failed to create tmux session',
    recoverable: true,
    retryable: true,
  },
  GIT_WORKTREE_FAILED: {
    code: 'GIT_WORKTREE_FAILED',
    category: 'SYSTEM_ERROR',
    severity: 'error',
    message: 'Failed to create git worktree',
    recoverable: true,
    retryable: true,
  },
  DATABASE_ERROR: {
    code: 'DATABASE_ERROR',
    category: 'SYSTEM_ERROR',
    severity: 'error',
    message: 'Database operation failed',
    recoverable: true,
    retryable: true,
  },
  FILESYSTEM_ERROR: {
    code: 'FILESYSTEM_ERROR',
    category: 'SYSTEM_ERROR',
    severity: 'error',
    message: 'File system operation failed',
    recoverable: true,
    retryable: true,
  },
  PERMISSION_DENIED: {
    code: 'PERMISSION_DENIED',
    category: 'SYSTEM_ERROR',
    severity: 'fatal',
    message: 'Permission denied for operation',
    recoverable: false,
    retryable: false,
  },
};

/**
 * External service error codes.
 */
export const EXTERNAL_ERRORS: Record<string, ErrorCodeDefinition> = {
  RATE_LIMITED: {
    code: 'RATE_LIMITED',
    category: 'EXTERNAL_ERROR',
    severity: 'warning',
    message: 'API rate limit exceeded',
    recoverable: true,
    retryable: true,
  },
  CLAUDE_API_ERROR: {
    code: 'CLAUDE_API_ERROR',
    category: 'EXTERNAL_ERROR',
    severity: 'error',
    message: 'Claude API returned an error',
    recoverable: true,
    retryable: true,
  },
  NETWORK_ERROR: {
    code: 'NETWORK_ERROR',
    category: 'EXTERNAL_ERROR',
    severity: 'error',
    message: 'Network connection failed',
    recoverable: true,
    retryable: true,
  },
  CIRCUIT_OPEN: {
    code: 'CIRCUIT_OPEN',
    category: 'EXTERNAL_ERROR',
    severity: 'warning',
    message: 'Circuit breaker is open, operation blocked',
    recoverable: true,
    retryable: false,
  },
};

/**
 * User-related error codes.
 */
/**
 * Sensitive keys that should be sanitized from error context.
 */
const SENSITIVE_KEYS = [
  'password',
  'secret',
  'token',
  'key',
  'credential',
  'auth',
  'apikey',
  'api_key',
  'api-key',
  'bearer',
  'authorization',
];

/**
 * Sanitize sensitive data from an object.
 * Recursively removes or masks values for keys that may contain credentials.
 */
function sanitizeContext(context: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(context)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = SENSITIVE_KEYS.some(s => lowerKey.includes(s));

    if (isSensitive) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = sanitizeContext(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }

  return result;
}

export const USER_ERRORS: Record<string, ErrorCodeDefinition> = {
  INVALID_ARGUMENT: {
    code: 'INVALID_ARGUMENT',
    category: 'USER_ERROR',
    severity: 'error',
    message: 'Invalid command argument',
    recoverable: false,
    retryable: false,
  },
  SESSION_EXISTS: {
    code: 'SESSION_EXISTS',
    category: 'USER_ERROR',
    severity: 'error',
    message: 'A session is already running',
    recoverable: false,
    retryable: false,
  },
  SESSION_NOT_FOUND: {
    code: 'SESSION_NOT_FOUND',
    category: 'USER_ERROR',
    severity: 'error',
    message: 'No active session found',
    recoverable: false,
    retryable: false,
  },
};

/**
 * All error codes combined.
 */
export const ALL_ERROR_CODES: Record<string, ErrorCodeDefinition> = {
  ...AGENT_ERRORS,
  ...WORKFLOW_ERRORS,
  ...SYSTEM_ERRORS,
  ...EXTERNAL_ERRORS,
  ...USER_ERRORS,
};

// =============================================================================
// Error Factory Functions
// =============================================================================

/**
 * Create a SwarmError from an error code.
 */
export function createSwarmError(
  code: string,
  options: {
    message?: string;
    details?: string;
    component: string;
    sessionId?: string;
    agentRole?: string;
    duration?: number;
    context?: Record<string, unknown>;
    cause?: SwarmError;
    stack?: string;
  }
): SwarmError {
  const definition = ALL_ERROR_CODES[code];

  // Sanitize context to prevent credential leakage
  const sanitizedContext = options.context ? sanitizeContext(options.context) : undefined;

  if (!definition) {
    // Unknown error code, create a generic error
    return {
      id: generateId(),
      code,
      category: 'SYSTEM_ERROR',
      severity: 'error',
      message: options.message ?? `Unknown error: ${code}`,
      details: options.details,
      component: options.component,
      sessionId: options.sessionId,
      agentRole: options.agentRole,
      timestamp: now(),
      duration: options.duration,
      recoverable: false,
      retryable: false,
      context: sanitizedContext,
      cause: options.cause,
      stack: options.stack,
    };
  }

  return {
    id: generateId(),
    code: definition.code,
    category: definition.category,
    severity: definition.severity,
    message: options.message ?? definition.message,
    details: options.details,
    component: options.component,
    sessionId: options.sessionId,
    agentRole: options.agentRole,
    timestamp: now(),
    duration: options.duration,
    recoverable: definition.recoverable,
    retryable: definition.retryable,
    context: sanitizedContext,
    cause: options.cause,
    stack: options.stack,
  };
}

/**
 * Wrap a native Error or unknown value as a SwarmError.
 */
export function wrapError(
  error: unknown,
  options: {
    code?: string;
    component: string;
    sessionId?: string;
    agentRole?: string;
    context?: Record<string, unknown>;
  }
): SwarmError {
  if (isSwarmError(error)) {
    return error;
  }

  const code = options.code ?? 'SYSTEM_ERROR';

  if (error instanceof Error) {
    return createSwarmError(code, {
      message: error.message,
      details: error.stack,
      component: options.component,
      sessionId: options.sessionId,
      agentRole: options.agentRole,
      context: options.context,
      stack: error.stack,
    });
  }

  return createSwarmError(code, {
    message: String(error),
    component: options.component,
    sessionId: options.sessionId,
    agentRole: options.agentRole,
    context: options.context,
  });
}

/**
 * Type guard for SwarmError.
 */
export function isSwarmError(value: unknown): value is SwarmError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.code === 'string' &&
    typeof obj.category === 'string' &&
    typeof obj.severity === 'string' &&
    typeof obj.message === 'string' &&
    typeof obj.timestamp === 'string' &&
    typeof obj.recoverable === 'boolean' &&
    typeof obj.retryable === 'boolean'
  );
}

// =============================================================================
// Retry Logic
// =============================================================================

/**
 * Configuration for retry behavior.
 */
export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterPercent: number;
  retryableErrors: string[];
}

/**
 * Default retry configuration.
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitterPercent: 20,
  retryableErrors: [
    'AGENT_SPAWN_FAILED',
    'AGENT_TIMEOUT',
    'AGENT_CRASHED',
    'TMUX_SESSION_FAILED',
    'GIT_WORKTREE_FAILED',
    'DATABASE_ERROR',
    'RATE_LIMITED',
    'NETWORK_ERROR',
  ],
};

/**
 * Per-operation retry configuration overrides.
 */
export const RETRY_CONFIGS: Record<string, Partial<RetryConfig>> = {
  agentSpawn: {
    maxRetries: 2,
    initialDelayMs: 2000,
  },
  messageSend: {
    maxRetries: 3,            // Reduced from 5 to prevent storm
    initialDelayMs: 1000,     // Increased from 500ms to reduce storm risk
    maxDelayMs: 10000,        // Add cap
  },
  databaseWrite: {
    maxRetries: 3,
    initialDelayMs: 200,      // Increased from 100ms
    maxDelayMs: 5000,
  },
  rateLimited: {
    maxRetries: 5,
    initialDelayMs: 5000,
    maxDelayMs: 60000,
  },
};

/**
 * Context passed to retryable operations.
 */
export interface RetryContext {
  operation: string;
  attempt: number;
  maxAttempts: number;
  errors: SwarmError[];
  startTime: number;
}

/**
 * Result of a retry operation.
 */
export interface RetryResult<T> {
  success: boolean;
  result?: T;
  attempts: number;
  totalDuration: number;
  errors: SwarmError[];
}

/**
 * A function that can be retried.
 */
export type RetryableOperation<T> = (context: RetryContext) => Promise<T>;

/**
 * Calculate delay with exponential backoff and jitter.
 */
export function calculateDelay(attempt: number, config: RetryConfig): number {
  // Base delay with exponential backoff
  const baseDelay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt - 1);

  // Cap at max delay
  const cappedDelay = Math.min(baseDelay, config.maxDelayMs);

  // Add jitter
  const jitterRange = cappedDelay * (config.jitterPercent / 100);
  const jitter = Math.random() * jitterRange;

  return cappedDelay + jitter;
}

/**
 * Check if an error is retryable.
 */
export function isRetryable(error: SwarmError, config: RetryConfig): boolean {
  if (!error.retryable) {
    return false;
  }

  return config.retryableErrors.includes(error.code);
}

/**
 * Wait for a specified duration with optional abort signal.
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(resolve, ms);

    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timeoutId);
        reject(new Error('Operation aborted'));
      });
    }
  });
}

/**
 * Execute an operation with retry logic.
 */
export async function withRetry<T>(
  operation: RetryableOperation<T>,
  config: Partial<RetryConfig>,
  operationName: string
): Promise<RetryResult<T>> {
  const fullConfig: RetryConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
  const maxAttempts = fullConfig.maxRetries + 1;
  const errors: SwarmError[] = [];
  const startTime = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const context: RetryContext = {
      operation: operationName,
      attempt,
      maxAttempts,
      errors: [...errors],
      startTime,
    };

    try {
      const result = await operation(context);
      return {
        success: true,
        result,
        attempts: attempt,
        totalDuration: Date.now() - startTime,
        errors,
      };
    } catch (error) {
      const swarmError = wrapError(error, {
        component: 'retry',
        context: { operation: operationName, attempt },
      });
      swarmError.retryCount = attempt;
      errors.push(swarmError);

      // Check if we should retry
      if (attempt < maxAttempts && isRetryable(swarmError, fullConfig)) {
        const delayMs = calculateDelay(attempt, fullConfig);
        await delay(delayMs);
      }
    }
  }

  return {
    success: false,
    attempts: maxAttempts,
    totalDuration: Date.now() - startTime,
    errors,
  };
}

// =============================================================================
// Circuit Breaker Pattern
// =============================================================================

/**
 * State of a circuit breaker.
 */
export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Configuration for circuit breaker.
 */
export interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  timeout: number;
}

/**
 * Default circuit breaker configuration.
 */
export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  successThreshold: 2,
  timeout: 30000,
};

/**
 * Circuit breaker for protecting against repeated failures.
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private config: CircuitBreakerConfig;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
  }

  /**
   * Get current circuit state.
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Check if the circuit allows operations.
   */
  canExecute(): boolean {
    switch (this.state) {
      case 'closed':
        return true;
      case 'open':
        // Check if timeout has elapsed
        if (Date.now() - this.lastFailureTime >= this.config.timeout) {
          this.state = 'half-open';
          return true;
        }
        return false;
      case 'half-open':
        return true;
    }
  }

  /**
   * Record a successful operation.
   */
  recordSuccess(): void {
    this.failureCount = 0;

    if (this.state === 'half-open') {
      this.successCount++;
      if (this.successCount >= this.config.successThreshold) {
        this.state = 'closed';
        this.successCount = 0;
      }
    }
  }

  /**
   * Record a failed operation.
   */
  recordFailure(): void {
    this.successCount = 0;
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'half-open') {
      this.state = 'open';
    } else if (this.failureCount >= this.config.failureThreshold) {
      this.state = 'open';
    }
  }

  /**
   * Reset the circuit breaker.
   */
  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
  }

  /**
   * Execute an operation through the circuit breaker.
   */
  async execute<T>(operation: () => Promise<T>): Promise<Result<T, SwarmError>> {
    if (!this.canExecute()) {
      return err(createSwarmError('CIRCUIT_OPEN', {
        message: 'Circuit breaker is open',
        component: 'circuit-breaker',
        context: {
          state: this.state,
          failureCount: this.failureCount,
          lastFailureTime: this.lastFailureTime,
        },
      }));
    }

    try {
      const result = await operation();
      this.recordSuccess();
      return ok(result);
    } catch (error) {
      this.recordFailure();
      return err(wrapError(error, { component: 'circuit-breaker' }));
    }
  }
}

// =============================================================================
// Recovery Strategies
// =============================================================================

/**
 * Types of recovery strategies.
 */
export type RecoveryStrategy =
  | 'retry'       // Retry the failed operation
  | 'restart'     // Restart the component
  | 'skip'        // Skip and continue without
  | 'substitute'  // Use alternative component
  | 'rollback'    // Undo and try different approach
  | 'escalate'    // Escalate to user/orchestrator
  | 'abort';      // Give up, fail gracefully

/**
 * Action to take during recovery.
 */
export interface RecoveryAction {
  type: 'wait' | 'execute' | 'notify' | 'log' | 'cleanup';
  description: string;
  parameters?: Record<string, unknown>;
}

/**
 * A plan for recovery from an error.
 */
export interface RecoveryPlan {
  strategy: RecoveryStrategy;
  maxAttempts?: number;
  timeout?: number;
  fallbackStrategy?: RecoveryStrategy;
  actions: RecoveryAction[];
}

/**
 * Result of executing a recovery plan.
 */
export interface RecoveryOutcome {
  success: boolean;
  strategyUsed: RecoveryStrategy;
  actionsExecuted: number;
  duration: number;
  result?: unknown;
  fallbackUsed: boolean;
  finalError?: SwarmError;
}

/**
 * Maximum recovery attempts to prevent infinite loops.
 */
const MAX_RECOVERY_ATTEMPTS_PER_ERROR = 3;
const MAX_TOTAL_RECOVERY_ATTEMPTS = 10;

/**
 * Context for recovery operations.
 */
export interface RecoveryContext {
  sessionId: string;
  workflowState?: Record<string, unknown>;
  agentStates: Map<string, { status: string; lastActivity: string }>;
  errorHistory: SwarmError[];
  attemptHistory: Map<string, number>;
  totalAttempts: number;
}

/**
 * Selector for choosing recovery strategy based on error code.
 */
export interface StrategySelector {
  errorCode: string;
  condition?: (error: SwarmError, context: RecoveryContext) => boolean;
  strategy: RecoveryPlan;
}

/**
 * Recovery strategy mappings.
 */
export const RECOVERY_STRATEGIES: StrategySelector[] = [
  // Agent Errors
  {
    errorCode: 'AGENT_TIMEOUT',
    strategy: {
      strategy: 'retry',
      maxAttempts: 2,
      fallbackStrategy: 'restart',
      actions: [
        { type: 'log', description: 'Log timeout occurrence' },
        { type: 'notify', description: 'Send nudge to agent' },
        { type: 'wait', description: 'Wait for response', parameters: { ms: 30000 } },
        { type: 'execute', description: 'Check for new messages' },
      ],
    },
  },
  {
    errorCode: 'AGENT_CRASHED',
    // Only attempt restart if agent hasn't crashed repeatedly
    condition: (error, context) => {
      const crashKey = `AGENT_CRASHED:${error.agentRole}`;
      const previousCrashes = context.attemptHistory.get(crashKey) ?? 0;
      // Skip restart if agent has crashed more than twice - likely a persistent issue
      return previousCrashes < 2;
    },
    strategy: {
      strategy: 'restart',
      maxAttempts: 2,
      fallbackStrategy: 'skip',
      actions: [
        { type: 'cleanup', description: 'Terminate crashed pane' },
        { type: 'wait', description: 'Cool-down period', parameters: { ms: 3000 } },  // Increased cool-down
        { type: 'execute', description: 'Respawn agent' },
        { type: 'execute', description: 'Resend last task' },
      ],
    },
  },
  {
    // Fallback for agents that keep crashing - skip instead of restart loop
    errorCode: 'AGENT_CRASHED',
    condition: (error, context) => {
      const crashKey = `AGENT_CRASHED:${error.agentRole}`;
      const previousCrashes = context.attemptHistory.get(crashKey) ?? 0;
      return previousCrashes >= 2;
    },
    strategy: {
      strategy: 'skip',
      actions: [
        { type: 'log', description: 'Agent crash loop detected - skipping agent' },
        { type: 'notify', description: 'Alert user of persistent crash' },
        { type: 'cleanup', description: 'Terminate crashed pane' },
      ],
    },
  },
  {
    errorCode: 'AGENT_INVALID_OUTPUT',
    strategy: {
      strategy: 'retry',
      maxAttempts: 2,
      fallbackStrategy: 'escalate',
      actions: [
        { type: 'log', description: 'Log invalid output for debugging' },
        { type: 'execute', description: 'Request clarification from agent' },
      ],
    },
  },

  // Rate Limiting
  {
    errorCode: 'RATE_LIMITED',
    strategy: {
      strategy: 'retry',
      maxAttempts: 5,
      fallbackStrategy: 'abort',
      actions: [
        { type: 'log', description: 'Log rate limit hit' },
        { type: 'wait', description: 'Exponential backoff', parameters: { base: 5000 } },
        { type: 'execute', description: 'Retry operation' },
      ],
    },
  },

  // Workflow Errors
  {
    errorCode: 'MAX_ITERATIONS',
    strategy: {
      strategy: 'skip',
      actions: [
        { type: 'log', description: 'Log iteration limit reached' },
        { type: 'notify', description: 'Mark output as partial' },
        { type: 'execute', description: 'Continue to next stage' },
      ],
    },
  },
  {
    errorCode: 'WORKFLOW_TIMEOUT',
    strategy: {
      strategy: 'abort',
      actions: [
        { type: 'log', description: 'Log timeout' },
        { type: 'execute', description: 'Synthesize partial results' },
        { type: 'cleanup', description: 'Cleanup resources' },
      ],
    },
  },

  // System Errors
  {
    errorCode: 'TMUX_SESSION_FAILED',
    strategy: {
      strategy: 'retry',
      maxAttempts: 2,
      fallbackStrategy: 'abort',
      actions: [
        { type: 'cleanup', description: 'Kill any stale sessions' },
        { type: 'wait', description: 'Brief pause', parameters: { ms: 1000 } },
        { type: 'execute', description: 'Retry session creation' },
      ],
    },
  },
  {
    errorCode: 'GIT_WORKTREE_FAILED',
    strategy: {
      strategy: 'retry',
      maxAttempts: 2,
      fallbackStrategy: 'abort',
      actions: [
        { type: 'execute', description: 'Prune stale worktrees' },
        { type: 'cleanup', description: 'Remove partial worktree' },
        { type: 'execute', description: 'Retry worktree creation' },
      ],
    },
  },
];

/**
 * Select the appropriate recovery strategy for an error.
 */
export function selectStrategy(
  error: SwarmError,
  context: RecoveryContext
): RecoveryPlan {
  // Find matching strategy selector
  for (const selector of RECOVERY_STRATEGIES) {
    if (selector.errorCode === error.code) {
      // Check condition if present
      if (selector.condition && !selector.condition(error, context)) {
        continue;
      }
      return selector.strategy;
    }
  }

  // Default strategy based on error properties
  if (!error.recoverable) {
    return {
      strategy: 'abort',
      actions: [
        { type: 'log', description: 'Log unrecoverable error' },
        { type: 'cleanup', description: 'Cleanup resources' },
      ],
    };
  }

  if (error.retryable) {
    return {
      strategy: 'retry',
      maxAttempts: 2,
      fallbackStrategy: 'escalate',
      actions: [
        { type: 'log', description: 'Log error' },
        { type: 'wait', description: 'Brief pause', parameters: { ms: 1000 } },
        { type: 'execute', description: 'Retry operation' },
      ],
    };
  }

  return {
    strategy: 'escalate',
    actions: [
      { type: 'log', description: 'Log error for review' },
      { type: 'notify', description: 'Alert user' },
    ],
  };
}

/**
 * Check if recovery should continue.
 */
export function shouldContinueRecovery(
  error: SwarmError,
  context: RecoveryContext,
  attemptsSoFar: number,
  maxAttempts: number = 3
): boolean {
  // Check maximum attempts
  if (attemptsSoFar >= maxAttempts) {
    return false;
  }

  // Check if error is fatal
  if (error.severity === 'fatal') {
    return false;
  }

  // Check if error is not recoverable
  if (!error.recoverable) {
    return false;
  }

  // Check attempt history for this error code
  const previousAttempts = context.attemptHistory.get(error.code) ?? 0;
  if (previousAttempts >= maxAttempts) {
    return false;
  }

  return true;
}

/**
 * Callback type for executing custom recovery operations.
 */
export type RecoveryActionExecutor = (
  action: RecoveryAction,
  error: SwarmError,
  context: RecoveryContext
) => Promise<void>;

/**
 * Registry for custom action executors.
 */
const actionExecutors: Map<string, RecoveryActionExecutor> = new Map();

/**
 * Register a custom action executor.
 * Use this to register handlers for 'execute' and 'cleanup' action types.
 */
export function registerActionExecutor(
  actionDescription: string,
  executor: RecoveryActionExecutor
): void {
  actionExecutors.set(actionDescription, executor);
}

/**
 * Execute a single recovery action.
 * This function handles the concrete execution of recovery actions:
 * - wait: Delays for specified milliseconds
 * - log: Logs the error to the database
 * - notify: Emits a notification event (console for now)
 * - execute: Runs a registered executor or logs intent
 * - cleanup: Runs cleanup executor or logs intent
 */
export async function executeAction(
  action: RecoveryAction,
  error: SwarmError,
  context: RecoveryContext
): Promise<void> {
  switch (action.type) {
    case 'wait': {
      const ms = (action.parameters?.ms as number) ?? 1000;
      await delay(ms);
      break;
    }

    case 'log': {
      // Log the error to the database for persistence
      await logError(error);
      break;
    }

    case 'notify': {
      // Emit notification - in the future this could integrate with external systems
      const message = `[Recovery] ${action.description}: ${error.code} - ${error.message}`;
      if (error.agentRole) {
        moduleLogger.orchestrator.info('recovery_notify', { agent: error.agentRole, code: error.code }, `Agent ${error.agentRole}: ${message}`);
      } else {
        moduleLogger.orchestrator.info('recovery_notify', { code: error.code }, message);
      }
      break;
    }

    case 'execute': {
      // Check if there's a registered executor for this action
      const executor = actionExecutors.get(action.description);
      if (executor) {
        await executor(action, error, context);
      } else {
        // Log the intent for actions without registered executors
        // This allows the orchestrator to handle specific actions
        moduleLogger.orchestrator.debug('recovery_execute', { action: action.description }, `Recovery action: ${action.description}`);
      }
      break;
    }

    case 'cleanup': {
      // Check if there's a registered cleanup executor
      const cleanupExecutor = actionExecutors.get(`cleanup:${action.description}`);
      if (cleanupExecutor) {
        await cleanupExecutor(action, error, context);
      } else {
        // Log cleanup intent
        moduleLogger.orchestrator.debug('recovery_cleanup', { action: action.description }, `Recovery cleanup: ${action.description}`);
      }
      break;
    }
  }
}

/**
 * Execute a recovery plan.
 */
export async function executeRecovery(
  error: SwarmError,
  plan: RecoveryPlan,
  context: RecoveryContext
): Promise<RecoveryOutcome> {
  const startTime = Date.now();
  let actionsExecuted = 0;
  let fallbackUsed = false;

  // Check for infinite loop prevention BEFORE incrementing
  const previousAttempts = context.attemptHistory.get(error.code) ?? 0;
  const totalAttempts = context.totalAttempts ?? 0;

  if (previousAttempts >= MAX_RECOVERY_ATTEMPTS_PER_ERROR) {
    return {
      success: false,
      strategyUsed: plan.strategy,
      actionsExecuted: 0,
      duration: Date.now() - startTime,
      fallbackUsed: false,
      finalError: createSwarmError('MAX_ITERATIONS', {
        message: `Recovery loop detected: ${error.code} failed ${previousAttempts} times`,
        component: 'recovery',
        sessionId: context.sessionId,
        context: { errorCode: error.code, attempts: previousAttempts },
      }),
    };
  }

  if (totalAttempts >= MAX_TOTAL_RECOVERY_ATTEMPTS) {
    return {
      success: false,
      strategyUsed: plan.strategy,
      actionsExecuted: 0,
      duration: Date.now() - startTime,
      fallbackUsed: false,
      finalError: createSwarmError('MAX_ITERATIONS', {
        message: `Maximum total recovery attempts (${MAX_TOTAL_RECOVERY_ATTEMPTS}) exceeded`,
        component: 'recovery',
        sessionId: context.sessionId,
        context: { totalAttempts },
      }),
    };
  }

  // Update attempt history
  context.attemptHistory.set(error.code, previousAttempts + 1);
  context.totalAttempts = totalAttempts + 1;

  try {
    // Execute actions
    for (const action of plan.actions) {
      await executeAction(action, error, context);
      actionsExecuted++;
    }

    return {
      success: true,
      strategyUsed: plan.strategy,
      actionsExecuted,
      duration: Date.now() - startTime,
      fallbackUsed: false,
    };
  } catch (recoveryError) {
    // If fallback is available, try it
    if (plan.fallbackStrategy) {
      fallbackUsed = true;
      const fallbackPlan = selectStrategy(
        { ...error, code: `FALLBACK_${error.code}` },
        context
      );
      fallbackPlan.strategy = plan.fallbackStrategy;

      try {
        for (const action of fallbackPlan.actions) {
          await executeAction(action, error, context);
          actionsExecuted++;
        }

        return {
          success: true,
          strategyUsed: plan.fallbackStrategy,
          actionsExecuted,
          duration: Date.now() - startTime,
          fallbackUsed: true,
        };
      } catch (fallbackError) {
        return {
          success: false,
          strategyUsed: plan.fallbackStrategy,
          actionsExecuted,
          duration: Date.now() - startTime,
          fallbackUsed: true,
          finalError: wrapError(fallbackError, { component: 'recovery' }),
        };
      }
    }

    return {
      success: false,
      strategyUsed: plan.strategy,
      actionsExecuted,
      duration: Date.now() - startTime,
      fallbackUsed,
      finalError: wrapError(recoveryError, { component: 'recovery' }),
    };
  }
}

// =============================================================================
// Graceful Degradation
// =============================================================================

/**
 * Levels of service degradation.
 */
export type DegradationLevel =
  | 'full'     // All features available
  | 'reduced'  // Some features unavailable
  | 'minimal'  // Basic functionality only
  | 'failed';  // Cannot continue

/**
 * State of system degradation.
 */
export interface DegradationState {
  level: DegradationLevel;
  unavailableAgents: string[];
  skippedStages: string[];
  partialOutputs: string[];
  warnings: string[];
}

/**
 * Rule for applying degradation.
 */
export interface DegradationRule {
  trigger: string;
  impact: string;
  mitigation: string;
  userMessage: string;
}

/**
 * Degradation rules for different error scenarios.
 */
export const DEGRADATION_RULES: DegradationRule[] = [
  {
    trigger: 'AGENT_CRASHED:researcher',
    impact: 'Research capability unavailable',
    mitigation: 'Continue with cached findings or user input',
    userMessage: 'Researcher agent failed. Research stage will be skipped.',
  },
  {
    trigger: 'AGENT_CRASHED:reviewer',
    impact: 'Review capability unavailable',
    mitigation: 'Mark outputs as unverified',
    userMessage: 'Reviewer agent failed. Outputs will not be verified.',
  },
  {
    trigger: 'AGENT_CRASHED:developer',
    impact: 'Development capability unavailable',
    mitigation: 'Cannot continue development workflow',
    userMessage: 'Developer agent failed. Cannot complete development.',
  },
  {
    trigger: 'MAX_ITERATIONS',
    impact: 'Revision cycle incomplete',
    mitigation: 'Use best available output',
    userMessage: 'Maximum revisions reached. Using current version.',
  },
  {
    trigger: 'WORKFLOW_TIMEOUT',
    impact: 'Workflow incomplete',
    mitigation: 'Synthesize partial results',
    userMessage: 'Workflow timed out. Showing partial results.',
  },
];

/**
 * Create an initial degradation state.
 */
export function createDegradationState(): DegradationState {
  return {
    level: 'full',
    unavailableAgents: [],
    skippedStages: [],
    partialOutputs: [],
    warnings: [],
  };
}

/**
 * Check if workflow can continue given an error and current state.
 */
export function canContinue(
  error: SwarmError,
  _workflowState: Record<string, unknown>,
  degradation: DegradationState
): boolean {
  // Fatal errors cannot continue
  if (error.severity === 'fatal') {
    return false;
  }

  // Check if already at minimal level
  if (degradation.level === 'failed') {
    return false;
  }

  // Check specific error scenarios
  const trigger = error.agentRole
    ? `${error.code}:${error.agentRole}`
    : error.code;

  const rule = DEGRADATION_RULES.find(r => r.trigger === trigger);

  if (rule) {
    // Developer agent is critical
    if (trigger.includes('developer') && trigger.includes('CRASHED')) {
      return false;
    }
  }

  // Check if too many agents unavailable
  if (degradation.unavailableAgents.length >= 2) {
    return false;
  }

  return true;
}

/**
 * Apply degradation based on an error.
 */
export function applyDegradation(
  error: SwarmError,
  degradation: DegradationState
): DegradationState {
  const newState = { ...degradation };
  const trigger = error.agentRole
    ? `${error.code}:${error.agentRole}`
    : error.code;

  const rule = DEGRADATION_RULES.find(r => r.trigger === trigger);

  if (rule) {
    newState.warnings.push(rule.userMessage);
  }

  // Update unavailable agents
  if (error.agentRole && error.code === 'AGENT_CRASHED') {
    if (!newState.unavailableAgents.includes(error.agentRole)) {
      newState.unavailableAgents.push(error.agentRole);
    }
  }

  // Determine new degradation level
  if (newState.unavailableAgents.length === 0 && newState.skippedStages.length === 0) {
    newState.level = 'full';
  } else if (newState.unavailableAgents.length <= 1) {
    newState.level = 'reduced';
  } else if (newState.unavailableAgents.length <= 2) {
    newState.level = 'minimal';
  } else {
    newState.level = 'failed';
  }

  return newState;
}

/**
 * Get available capabilities given current degradation.
 */
export function getAvailableCapabilities(degradation: DegradationState): string[] {
  const allCapabilities = ['research', 'development', 'review', 'architecture'];

  return allCapabilities.filter(cap => {
    const agentMap: Record<string, string> = {
      research: 'researcher',
      development: 'developer',
      review: 'reviewer',
      architecture: 'architect',
    };

    return !degradation.unavailableAgents.includes(agentMap[cap]);
  });
}

/**
 * Check if a specific feature is available.
 */
export function isFeatureAvailable(
  feature: string,
  degradation: DegradationState
): boolean {
  return getAvailableCapabilities(degradation).includes(feature);
}

/**
 * Generate a summary of the current degradation state.
 */
export function generateDegradationSummary(degradation: DegradationState): string {
  if (degradation.level === 'full') {
    return 'All features available.';
  }

  let summary = `System operating at ${degradation.level} capacity.\n`;

  if (degradation.unavailableAgents.length > 0) {
    summary += `Unavailable agents: ${degradation.unavailableAgents.join(', ')}\n`;
  }

  if (degradation.skippedStages.length > 0) {
    summary += `Skipped stages: ${degradation.skippedStages.join(', ')}\n`;
  }

  if (degradation.warnings.length > 0) {
    summary += `Warnings:\n`;
    degradation.warnings.forEach(w => {
      summary += `  - ${w}\n`;
    });
  }

  return summary;
}

/**
 * Check if workflow can continue after an error.
 */
export function canContinueWorkflow(
  error: SwarmError,
  context: RecoveryContext
): boolean {
  // Create a dummy workflow state and degradation state for checking
  const degradation = createDegradationState();
  context.errorHistory.forEach(e => {
    if (e.agentRole && e.code === 'AGENT_CRASHED') {
      degradation.unavailableAgents.push(e.agentRole);
    }
  });

  return canContinue(error, context.workflowState ?? {}, degradation);
}

// =============================================================================
// Checkpointing and State Persistence
// =============================================================================

/**
 * Types of checkpoints.
 */
export type CheckpointType =
  | 'session_start'   // Initial checkpoint
  | 'stage_complete'  // After stage completion
  | 'periodic'        // Regular interval
  | 'before_retry'    // Before recovery attempt
  | 'error_recovery'  // After error recovery
  | 'manual';         // User-requested

/**
 * Serialized agent state for checkpointing.
 */
export interface SerializedAgentState {
  role: string;
  status: string;
  lastTask?: string;
  messageCount: number;
  lastActivityAt: string;
}

/**
 * Snapshot of message queue state.
 */
export interface MessageQueueSnapshot {
  inboxes: Record<string, number>;
  outboxes: Record<string, number>;
  lastProcessedTimestamps: Record<string, string>;
}

/**
 * Record of a recovery attempt.
 */
export interface RecoveryAttempt {
  errorId: string;
  strategy: RecoveryStrategy;
  outcome: 'success' | 'failed' | 'partial';
  timestamp: string;
}

/**
 * A checkpoint of session state.
 */
export interface Checkpoint {
  id: string;
  sessionId: string;
  timestamp: string;
  type: CheckpointType;

  // State snapshots
  workflowState: Record<string, unknown>;
  agentStates: Map<string, SerializedAgentState>;
  messageQueueState: MessageQueueSnapshot;

  // Progress
  completedStages: string[];
  pendingStages: string[];
  processedMessageIds: string[];

  // Errors
  errors: SwarmError[];
  recoveryAttempts: RecoveryAttempt[];

  // Metadata
  createdBy: 'auto' | 'manual' | 'error';
  notes?: string;
}

/**
 * Configuration for automatic checkpointing.
 */
export interface CheckpointConfig {
  enabled: boolean;
  intervalMs: number;
  onStageComplete: boolean;
  onError: boolean;
  maxCheckpoints: number;
}

/**
 * Default checkpoint configuration.
 */
export const DEFAULT_CHECKPOINT_CONFIG: CheckpointConfig = {
  enabled: true,
  intervalMs: 60000,
  onStageComplete: true,
  onError: true,
  maxCheckpoints: 10,
};

/**
 * Create a checkpoint from session state.
 */
export function createCheckpoint(
  sessionId: string,
  type: CheckpointType,
  state: {
    workflowState: Record<string, unknown>;
    agentStates: Map<string, SerializedAgentState>;
    messageQueueState: MessageQueueSnapshot;
    completedStages: string[];
    pendingStages: string[];
    processedMessageIds: string[];
    errors: SwarmError[];
    recoveryAttempts: RecoveryAttempt[];
  },
  createdBy: 'auto' | 'manual' | 'error' = 'auto',
  notes?: string
): Checkpoint {
  return {
    id: generateId(),
    sessionId,
    timestamp: now(),
    type,
    workflowState: state.workflowState,
    agentStates: state.agentStates,
    messageQueueState: state.messageQueueState,
    completedStages: state.completedStages,
    pendingStages: state.pendingStages,
    processedMessageIds: state.processedMessageIds,
    errors: state.errors,
    recoveryAttempts: state.recoveryAttempts,
    createdBy,
    notes,
  };
}

/**
 * Save a checkpoint to the database and auto-prune old checkpoints.
 */
export async function saveCheckpoint(
  checkpoint: Checkpoint,
  maxCheckpoints: number = DEFAULT_CHECKPOINT_CONFIG.maxCheckpoints
): Promise<void> {
  const db = getDb();

  // Convert Map to object for JSON serialization
  const agentStatesObj: Record<string, SerializedAgentState> = {};
  checkpoint.agentStates.forEach((value, key) => {
    agentStatesObj[key] = value;
  });

  db.run(
    `INSERT INTO checkpoints (
      id, session_id, type, created_at, created_by,
      workflow_state_json, agent_states_json, message_queue_json,
      completed_stages_json, pending_stages_json, errors_json, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      checkpoint.id,
      checkpoint.sessionId,
      checkpoint.type,
      checkpoint.timestamp,
      checkpoint.createdBy,
      safeJsonStringify(checkpoint.workflowState),
      safeJsonStringify(agentStatesObj),
      safeJsonStringify(checkpoint.messageQueueState),
      safeJsonStringify(checkpoint.completedStages),
      safeJsonStringify(checkpoint.pendingStages),
      safeJsonStringify(checkpoint.errors),
      checkpoint.notes ?? null,
    ]
  );

  // Auto-prune old checkpoints to prevent unbounded growth
  await pruneCheckpoints(checkpoint.sessionId, maxCheckpoints);
}

/**
 * Database row type for checkpoints.
 */
interface CheckpointRow {
  id: string;
  session_id: string;
  type: string;
  created_at: string;
  created_by: string;
  workflow_state_json: string | null;
  agent_states_json: string | null;
  message_queue_json: string | null;
  completed_stages_json: string | null;
  pending_stages_json: string | null;
  errors_json: string | null;
  notes: string | null;
}

/**
 * Convert a database row to a Checkpoint object.
 * Uses safe JSON parsing to handle corrupted data gracefully.
 */
function rowToCheckpoint(row: CheckpointRow): Checkpoint {
  const agentStatesObj = safeJsonParse<Record<string, SerializedAgentState>>(
    row.agent_states_json,
    {}
  );

  const agentStates = new Map<string, SerializedAgentState>();
  Object.entries(agentStatesObj).forEach(([key, value]) => {
    agentStates.set(key, value);
  });

  return {
    id: row.id,
    sessionId: row.session_id,
    timestamp: row.created_at,
    type: row.type as CheckpointType,
    workflowState: safeJsonParse<Record<string, unknown>>(row.workflow_state_json, {}),
    agentStates,
    messageQueueState: safeJsonParse<MessageQueueSnapshot>(
      row.message_queue_json,
      { inboxes: {}, outboxes: {}, lastProcessedTimestamps: {} }
    ),
    completedStages: safeJsonParse<string[]>(row.completed_stages_json, []),
    pendingStages: safeJsonParse<string[]>(row.pending_stages_json, []),
    processedMessageIds: [],
    errors: safeJsonParse<SwarmError[]>(row.errors_json, []),
    recoveryAttempts: [],
    createdBy: row.created_by as 'auto' | 'manual' | 'error',
    notes: row.notes ?? undefined,
  };
}

/**
 * Load the most recent checkpoint for a session.
 */
export async function loadLatestCheckpoint(sessionId: string): Promise<Checkpoint | null> {
  const db = getDb();

  const row = db.query<CheckpointRow, [string]>(
    `SELECT * FROM checkpoints
     WHERE session_id = ?
     ORDER BY created_at DESC
     LIMIT 1`
  ).get(sessionId);

  if (!row) {
    return null;
  }

  return rowToCheckpoint(row);
}

/**
 * Load a specific checkpoint by ID.
 */
export async function loadCheckpoint(checkpointId: string): Promise<Checkpoint | null> {
  const db = getDb();

  const row = db.query<CheckpointRow, [string]>(
    'SELECT * FROM checkpoints WHERE id = ?'
  ).get(checkpointId);

  if (!row) {
    return null;
  }

  return rowToCheckpoint(row);
}

/**
 * List all checkpoints for a session.
 */
export async function listCheckpoints(sessionId: string): Promise<Checkpoint[]> {
  const db = getDb();

  const rows = db.query<CheckpointRow, [string]>(
    `SELECT * FROM checkpoints
     WHERE session_id = ?
     ORDER BY created_at DESC`
  ).all(sessionId);

  return rows.map(rowToCheckpoint);
}

/**
 * Delete old checkpoints, keeping the most recent N.
 */
export async function pruneCheckpoints(sessionId: string, keepCount: number): Promise<number> {
  const db = getDb();

  // Get IDs of checkpoints to keep
  const keepRows = db.query<{ id: string }, [string, number]>(
    `SELECT id FROM checkpoints
     WHERE session_id = ?
     ORDER BY created_at DESC
     LIMIT ?`
  ).all(sessionId, keepCount);

  const keepIds = keepRows.map(r => r.id);

  if (keepIds.length === 0) {
    return 0;
  }

  // Delete all others
  const placeholders = keepIds.map(() => '?').join(',');
  const result = db.run(
    `DELETE FROM checkpoints
     WHERE session_id = ? AND id NOT IN (${placeholders})`,
    [sessionId, ...keepIds]
  );

  return result.changes;
}

/**
 * Checkpoint on stage completion.
 */
export async function checkpointOnStage(
  sessionId: string,
  stageName: string,
  state: {
    workflowState: Record<string, unknown>;
    agentStates: Map<string, SerializedAgentState>;
    messageQueueState: MessageQueueSnapshot;
    completedStages: string[];
    pendingStages: string[];
    processedMessageIds: string[];
    errors: SwarmError[];
    recoveryAttempts: RecoveryAttempt[];
  }
): Promise<void> {
  const checkpoint = createCheckpoint(
    sessionId,
    'stage_complete',
    state,
    'auto',
    `Stage completed: ${stageName}`
  );

  await saveCheckpoint(checkpoint);
}

/**
 * Checkpoint before error recovery.
 */
export async function checkpointBeforeRecovery(
  sessionId: string,
  error: SwarmError,
  state: {
    workflowState: Record<string, unknown>;
    agentStates: Map<string, SerializedAgentState>;
    messageQueueState: MessageQueueSnapshot;
    completedStages: string[];
    pendingStages: string[];
    processedMessageIds: string[];
    errors: SwarmError[];
    recoveryAttempts: RecoveryAttempt[];
  }
): Promise<void> {
  const checkpoint = createCheckpoint(
    sessionId,
    'before_retry',
    state,
    'error',
    `Before recovery from: ${error.code}`
  );

  await saveCheckpoint(checkpoint);
}

// =============================================================================
// Session Recovery
// =============================================================================

/**
 * Options for session recovery.
 */
export interface RecoveryOptions {
  checkpointId?: string;
  skipFailedStage: boolean;
  resetAgents: boolean;
  preserveMessages: boolean;
}

/**
 * Result of session recovery.
 */
export interface SessionRecoveryResult {
  success: boolean;
  resumedFrom: string;
  restoredState: Record<string, unknown>;
  skippedStages: string[];
  warnings: string[];
  error?: SwarmError;
}

/**
 * Check if a session can be recovered.
 */
export async function canRecover(sessionId: string): Promise<boolean> {
  const checkpoint = await loadLatestCheckpoint(sessionId);
  return checkpoint !== null;
}

/**
 * Recover a session from a checkpoint.
 * This function restores the full session state including:
 * - Workflow state and progress
 * - Agent states (for respawning if needed)
 * - Message queue state (for resuming message processing)
 */
export async function recoverSession(
  sessionId: string,
  options: RecoveryOptions
): Promise<SessionRecoveryResult> {
  // Load checkpoint
  let checkpoint: Checkpoint | null;

  if (options.checkpointId) {
    checkpoint = await loadCheckpoint(options.checkpointId);
  } else {
    checkpoint = await loadLatestCheckpoint(sessionId);
  }

  if (!checkpoint) {
    return {
      success: false,
      resumedFrom: '',
      restoredState: {},
      skippedStages: [],
      warnings: [],
      error: createSwarmError('SESSION_NOT_FOUND', {
        message: 'No checkpoint found for session',
        component: 'recovery',
        sessionId,
      }),
    };
  }

  const warnings: string[] = [];
  const skippedStages: string[] = [];

  // If skipFailedStage is true, add the last stage to skipped
  if (options.skipFailedStage && checkpoint.errors.length > 0) {
    const lastError = checkpoint.errors[checkpoint.errors.length - 1];
    if (lastError.context?.stage) {
      skippedStages.push(lastError.context.stage as string);
      warnings.push(`Skipping failed stage: ${lastError.context.stage}`);
    }
  }

  // Build agent restoration info
  const agentsToRestore: Record<string, SerializedAgentState> = {};
  const agentsToReset: string[] = [];

  checkpoint.agentStates.forEach((state, role) => {
    if (options.resetAgents) {
      // Mark all agents for fresh restart
      agentsToReset.push(role);
      warnings.push(`Agent ${role} will be restarted fresh`);
    } else if (state.status === 'error' || state.status === 'terminated') {
      // Mark failed agents for restart
      agentsToReset.push(role);
      warnings.push(`Agent ${role} was in '${state.status}' state and will be restarted`);
    } else {
      // Restore agent state
      agentsToRestore[role] = state;
    }
  });

  // Build message queue restoration info
  let messageQueueState: MessageQueueSnapshot | null = null;
  if (options.preserveMessages) {
    messageQueueState = checkpoint.messageQueueState;
  } else {
    warnings.push('Message queues will be cleared (preserveMessages=false)');
  }

  // Build restored state with full recovery information
  const restoredState: Record<string, unknown> = {
    // Workflow state
    ...checkpoint.workflowState,
    completedStages: checkpoint.completedStages,
    pendingStages: checkpoint.pendingStages.filter(s => !skippedStages.includes(s)),

    // Agent restoration info
    agentsToRestore,
    agentsToReset,

    // Message queue restoration info
    messageQueueState: options.preserveMessages ? messageQueueState : null,

    // Recovery metadata
    recoveryMetadata: {
      checkpointId: checkpoint.id,
      checkpointTimestamp: checkpoint.timestamp,
      checkpointType: checkpoint.type,
      previousErrors: checkpoint.errors.length,
      previousRecoveryAttempts: checkpoint.recoveryAttempts.length,
    },

    // Processed message IDs for deduplication
    processedMessageIds: checkpoint.processedMessageIds,
  };

  // Log successful recovery preparation
  moduleLogger.orchestrator.info('session_recovery', {
    checkpoint: checkpoint.id,
    completedStages: checkpoint.completedStages.length,
    pendingStages: (restoredState.pendingStages as string[]).length,
    agentsToRestore: Object.keys(agentsToRestore).length,
    agentsToReset: agentsToReset.length,
  }, `Prepared recovery from checkpoint ${checkpoint.id} - ${checkpoint.completedStages.length} completed, ${(restoredState.pendingStages as string[]).length} pending`);

  return {
    success: true,
    resumedFrom: checkpoint.id,
    restoredState,
    skippedStages,
    warnings,
  };
}

/**
 * Restore workflow state from a checkpoint.
 */
export function restoreWorkflowState(checkpoint: Checkpoint): Record<string, unknown> {
  return {
    ...checkpoint.workflowState,
    restoredFrom: checkpoint.id,
    restoredAt: now(),
  };
}

// =============================================================================
// Error Logging and Reporting
// =============================================================================

/**
 * Formatted error for display.
 */
export interface FormattedError {
  code: string;
  message: string;
  when: string;
  where: string;
  recovered: boolean;
}

/**
 * Formatted recovery attempt for display.
 */
export interface FormattedRecovery {
  error: string;
  strategy: string;
  outcome: string;
  when: string;
}

/**
 * Debug information for error reports.
 */
export interface DebugInfo {
  checkpointId?: string;
  logFile: string;
  stateFile: string;
  messageFiles: string[];
}

/**
 * Complete error report for a session.
 */
export interface ErrorReport {
  timestamp: string;
  sessionId: string;
  summary: string;
  errors: FormattedError[];
  recoveryAttempts: FormattedRecovery[];
  suggestions: string[];
  debugInfo?: DebugInfo;
}

/**
 * Log an error to the database.
 */
export async function logError(error: SwarmError): Promise<void> {
  const db = getDb();

  db.run(
    `INSERT INTO error_log (
      id, session_id, code, category, severity, message, details,
      component, agent_role, recoverable, recovered, recovery_strategy,
      stack, context_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      error.id,
      error.sessionId ?? null,
      error.code,
      error.category,
      error.severity,
      error.message,
      error.details ?? null,
      error.component,
      error.agentRole ?? null,
      error.recoverable ? 1 : 0,
      0, // Not recovered yet
      error.recoveryStrategy ?? null,
      error.stack ?? null,
      error.context ? JSON.stringify(error.context) : null,
      error.timestamp,
    ]
  );
}

/**
 * Mark an error as recovered.
 */
export async function markErrorRecovered(errorId: string, strategy: string): Promise<void> {
  const db = getDb();

  db.run(
    'UPDATE error_log SET recovered = 1, recovery_strategy = ? WHERE id = ?',
    [strategy, errorId]
  );
}

/**
 * Format an error for display.
 */
export function formatError(error: SwarmError, verbose: boolean = false): string {
  let output = `[${error.severity.toUpperCase()}] ${error.code}: ${error.message}`;

  if (error.agentRole) {
    output += ` (agent: ${error.agentRole})`;
  }

  if (verbose) {
    if (error.details) {
      output += `\n  Details: ${error.details}`;
    }
    if (error.stack) {
      output += `\n  Stack: ${error.stack.split('\n').slice(0, 3).join('\n    ')}`;
    }
    if (error.context) {
      output += `\n  Context: ${JSON.stringify(error.context)}`;
    }
  }

  return output;
}

/**
 * Format an error for log files.
 */
export function formatErrorLog(error: SwarmError): string {
  const parts = [
    `[${error.timestamp}]`,
    `[${error.severity.toUpperCase()}]`,
    `[${error.code}]`,
    error.message,
  ];

  if (error.component) {
    parts.push(`(${error.component})`);
  }

  if (error.agentRole) {
    parts.push(`[agent:${error.agentRole}]`);
  }

  return parts.join(' ');
}

/**
 * User-friendly error messages.
 */
export const ERROR_MESSAGES: Record<string, (error: SwarmError) => string> = {
  AGENT_TIMEOUT: (e) =>
    `Agent '${e.agentRole ?? 'unknown'}' did not respond within ${e.context?.timeout ?? 'the configured timeout'}ms. ` +
    `The agent may be processing a complex task.`,

  AGENT_CRASHED: (e) =>
    `Agent '${e.agentRole ?? 'unknown'}' terminated unexpectedly. ` +
    `Check the agent logs for details.`,

  RATE_LIMITED: (e) =>
    `API rate limit reached. Waiting ${e.context?.retryIn ?? 'some time'} before retry. ` +
    `Consider spacing out requests or upgrading your API plan.`,

  WORKFLOW_TIMEOUT: (e) =>
    `Workflow exceeded maximum duration of ${e.context?.timeout ?? 'the configured timeout'}ms. ` +
    `Partial results have been saved.`,

  TMUX_NOT_FOUND: () =>
    `tmux is required but not installed. ` +
    `Install with: sudo apt install tmux (Linux) or brew install tmux (Mac)`,

  GIT_WORKTREE_FAILED: (e) =>
    `Failed to create git worktree for agent '${e.agentRole ?? 'unknown'}'. ` +
    `Try: git worktree prune && clean up stale worktrees`,
};

/**
 * Get user-friendly error message.
 */
export function getUserMessage(error: SwarmError): string {
  const formatter = ERROR_MESSAGES[error.code];
  if (formatter) {
    return formatter(error);
  }
  return error.message;
}

/**
 * Get actionable suggestions for an error.
 */
export function getSuggestions(error: SwarmError): string[] {
  const suggestions: string[] = [];

  switch (error.code) {
    case 'AGENT_TIMEOUT':
      suggestions.push('Wait a bit longer - the agent may be working on a complex task');
      suggestions.push('Try restarting the agent');
      suggestions.push('Check if the agent is blocked on external resources');
      break;

    case 'AGENT_CRASHED':
      suggestions.push('Check the agent logs for crash details');
      suggestions.push('Try respawning the agent');
      suggestions.push('Verify system resources (memory, disk space)');
      break;

    case 'RATE_LIMITED':
      suggestions.push('Wait for the rate limit to reset');
      suggestions.push('Consider upgrading your API plan');
      suggestions.push('Reduce the number of concurrent agents');
      break;

    case 'TMUX_NOT_FOUND':
      suggestions.push('Install tmux: sudo apt install tmux (Linux)');
      suggestions.push('Install tmux: brew install tmux (macOS)');
      break;

    case 'GIT_WORKTREE_FAILED':
      suggestions.push('Run: git worktree prune');
      suggestions.push('Check for stale worktree directories');
      suggestions.push('Verify git repository is healthy: git fsck');
      break;

    case 'DATABASE_ERROR':
      suggestions.push('Check disk space availability');
      suggestions.push('Verify database file permissions');
      suggestions.push('Try deleting .swarm/memory.db and restarting');
      break;

    default:
      if (error.recoverable) {
        suggestions.push('Try the operation again');
      }
      if (error.retryable) {
        suggestions.push('Wait a moment and retry');
      }
  }

  return suggestions;
}

/**
 * Get remediation steps for an error.
 */
export function getRemediationSteps(error: SwarmError): string[] {
  const steps: string[] = [];
  let stepNumber = 1;

  if (error.recoverable) {
    steps.push(`${stepNumber++}. Review the error details above`);

    if (error.retryable) {
      steps.push(`${stepNumber++}. Wait a few seconds`);
      steps.push(`${stepNumber++}. Retry the operation`);
    }

    const suggestions = getSuggestions(error);
    suggestions.forEach((s) => {
      steps.push(`${stepNumber++}. ${s}`);
    });
  } else {
    steps.push(`${stepNumber++}. This error cannot be automatically recovered`);
    steps.push(`${stepNumber++}. Review the error details`);
    steps.push(`${stepNumber++}. Address the underlying cause`);
    steps.push(`${stepNumber++}. Restart the session`);
  }

  return steps;
}

/**
 * Generate a complete error report for a session.
 */
export async function generateErrorReport(sessionId: string): Promise<ErrorReport> {
  const db = getDb();

  interface ErrorLogRow {
    id: string;
    code: string;
    message: string;
    severity: string;
    component: string | null;
    agent_role: string | null;
    recovered: number;
    recovery_strategy: string | null;
    created_at: string;
  }

  const errorRows = db.query<ErrorLogRow, [string]>(
    `SELECT * FROM error_log
     WHERE session_id = ?
     ORDER BY created_at DESC`
  ).all(sessionId);

  const errors: FormattedError[] = errorRows.map(row => ({
    code: row.code,
    message: row.message,
    when: row.created_at,
    where: row.component ?? 'unknown',
    recovered: row.recovered === 1,
  }));

  const recoveryAttempts: FormattedRecovery[] = errorRows
    .filter(row => row.recovery_strategy)
    .map(row => ({
      error: row.code,
      strategy: row.recovery_strategy!,
      outcome: row.recovered === 1 ? 'success' : 'failed',
      when: row.created_at,
    }));

  // Collect unique suggestions
  const allSuggestions = new Set<string>();
  errorRows.forEach(row => {
    const error = createSwarmError(row.code, {
      message: row.message,
      component: row.component ?? 'unknown',
      agentRole: row.agent_role ?? undefined,
    });
    getSuggestions(error).forEach(s => allSuggestions.add(s));
  });

  // Build summary
  let summary: string;
  if (errors.length === 0) {
    summary = 'No errors recorded for this session.';
  } else {
    const recovered = errors.filter(e => e.recovered).length;
    summary = `${errors.length} error(s) occurred. ${recovered} recovered.`;
  }

  return {
    timestamp: now(),
    sessionId,
    summary,
    errors,
    recoveryAttempts,
    suggestions: Array.from(allSuggestions),
  };
}

// =============================================================================
// Error Handling Configuration
// =============================================================================

/**
 * Complete error handling configuration.
 */
export interface ErrorHandlingConfig {
  retry: RetryConfig;
  recovery: {
    maxAttemptsPerError: number;
    maxTotalAttempts: number;
    cooldownMs: number;
  };
  checkpoint: CheckpointConfig;
  logging: {
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    logToFile: boolean;
    logFilePath: string;
    maxLogSize: number;
  };
  degradation: {
    allowPartialResults: boolean;
    continueWithoutReviewer: boolean;
    continueWithoutResearcher: boolean;
  };
}

/**
 * Default error handling configuration.
 */
export const DEFAULT_ERROR_CONFIG: ErrorHandlingConfig = {
  retry: DEFAULT_RETRY_CONFIG,
  recovery: {
    maxAttemptsPerError: 3,
    maxTotalAttempts: 10,
    cooldownMs: 5000,
  },
  checkpoint: DEFAULT_CHECKPOINT_CONFIG,
  logging: {
    logLevel: 'info',
    logToFile: true,
    logFilePath: 'logs/error.log',
    maxLogSize: 10 * 1024 * 1024, // 10MB
  },
  degradation: {
    allowPartialResults: true,
    continueWithoutReviewer: true,
    continueWithoutResearcher: false,
  },
};

/**
 * Get error handling configuration from environment.
 */
export function getConfigFromEnv(): Partial<ErrorHandlingConfig> {
  const config: Partial<ErrorHandlingConfig> = {};

  if (process.env.SWARM_MAX_RETRIES) {
    config.retry = {
      ...DEFAULT_RETRY_CONFIG,
      maxRetries: parseInt(process.env.SWARM_MAX_RETRIES, 10),
    };
  }

  if (process.env.SWARM_RETRY_DELAY) {
    config.retry = {
      ...DEFAULT_RETRY_CONFIG,
      ...config.retry,
      initialDelayMs: parseInt(process.env.SWARM_RETRY_DELAY, 10),
    };
  }

  if (process.env.SWARM_CHECKPOINT_ENABLED) {
    config.checkpoint = {
      ...DEFAULT_CHECKPOINT_CONFIG,
      enabled: process.env.SWARM_CHECKPOINT_ENABLED === 'true',
    };
  }

  if (process.env.SWARM_LOG_LEVEL) {
    config.logging = {
      ...DEFAULT_ERROR_CONFIG.logging,
      logLevel: process.env.SWARM_LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error',
    };
  }

  return config;
}
