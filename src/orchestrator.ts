/**
 * Claude Swarm - Orchestrator
 *
 * The central coordination component that manages the entire lifecycle of a
 * multi-agent workflow. It spawns agents, routes messages between them,
 * monitors progress, detects completion, and synthesizes final results.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  type AgentRole,
  type AgentMessage,
  type Result,
  ok,
  err,
  now,
} from './types.js';

import * as tmux from './managers/tmux.js';
import * as worktree from './managers/worktree.js';
import * as messageBus from './message-bus.js';
import * as db from './db.js';

import {
  type WorkflowInstance,
  getWorkflowTemplate,
  createWorkflowInstance,
  isWorkflowComplete,
} from './workflows/templates.js';

import {
  startStep,
  completeStep,
  transitionWorkflow,
  createInitialTaskMessage,
  routeMessage as engineRouteMessage,
  synthesizeResult as engineSynthesizeResult,
  getWorkflowProgress,
  getActiveAgents,
  type RoutingDecision,
} from './workflows/engine.js';

import {
  createSwarmError,
  type SwarmError,
  withRetry,
  RETRY_CONFIGS,
  checkpointOnStage,
  type SerializedAgentState,
  type MessageQueueSnapshot,
  type RecoveryContext,
  selectStrategy,
  executeRecovery,
  type RecoveryAttempt,
} from './error-handling.js';

// =============================================================================
// Type Definitions
// =============================================================================

/**
 * Configuration for the Orchestrator.
 */
export interface OrchestratorConfig {
  /** Custom session ID (auto-generated if omitted) */
  sessionId?: string;
  /** How often to check agents (ms), default 5000 */
  monitorInterval?: number;
  /** Max time for agent response (ms), default 300000 (5 min) */
  agentTimeout?: number;
  /** Max total workflow time (ms), default 1800000 (30 min) */
  workflowTimeout?: number;
  /** Clean up on completion, default true */
  autoCleanup?: boolean;
  /** Capture agent terminal output, default true */
  captureOutput?: boolean;
  /** Detailed logging, default false */
  verboseLogging?: boolean;
  /** Maximum concurrent agents, default 4 */
  maxAgents?: number;
  /** Retries per agent operation, default 3 */
  maxRetries?: number;
}

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG: Required<OrchestratorConfig> = {
  sessionId: '',
  monitorInterval: 5000,
  agentTimeout: 300000,    // 5 minutes
  workflowTimeout: 1800000, // 30 minutes
  autoCleanup: true,
  captureOutput: true,
  verboseLogging: false,
  maxAgents: 4,
  maxRetries: 3,
};

/**
 * Extended agent status for orchestrator management.
 */
export type AgentStatus =
  | 'spawning'      // Being created
  | 'starting'      // tmux pane created, Claude Code starting
  | 'ready'         // Claude Code running, waiting for input
  | 'working'       // Processing a task
  | 'complete'      // Signaled completion
  | 'blocked'       // Waiting on external input
  | 'error'         // Encountered an error
  | 'terminated';   // Shut down

/**
 * Information about an agent managed by the orchestrator.
 */
export interface ManagedAgent {
  role: AgentRole;
  paneId: string;
  worktreePath: string;
  status: AgentStatus;
  spawnedAt: string;
  lastActivityAt: string;
  lastCapturedOutput?: string;
  messageCount: number;
  errorCount: number;
}

/**
 * Session status types.
 */
export type SessionStatus =
  | 'initializing'  // Setting up resources
  | 'running'       // Workflow executing
  | 'synthesizing'  // Creating final output
  | 'complete'      // Successfully finished
  | 'failed'        // Encountered fatal error
  | 'cancelled';    // User cancelled

/**
 * An active session managed by the orchestrator.
 */
export interface Session {
  id: string;
  workflowType: string;
  goal: string;
  status: SessionStatus;
  startedAt: string;
  completedAt?: string;
  agents: Map<AgentRole, ManagedAgent>;
  workflowInstance: WorkflowInstance;
  result?: SessionResult;
}

/**
 * Summary of a completed agent's work.
 */
export interface AgentSummary {
  role: AgentRole;
  messagesProduced: number;
  tasksCompleted: number;
  reviewsPerformed?: number;
  findings?: number;
  artifacts?: string[];
}

/**
 * Error that occurred during the session.
 */
export interface SessionError {
  timestamp: string;
  agent?: AgentRole;
  type: 'agent_error' | 'routing_error' | 'timeout' | 'system_error';
  message: string;
  recoverable: boolean;
  recovered: boolean;
}

/**
 * Final result of a completed session.
 */
export interface SessionResult {
  success: boolean;
  summary: string;
  duration: number;
  agentSummaries: Map<AgentRole, AgentSummary>;
  artifacts: string[];
  errors: SessionError[];
}

/**
 * Events emitted by the orchestrator.
 */
export type OrchestratorEvent =
  | { type: 'session_started'; sessionId: string; workflow: string }
  | { type: 'agent_spawned'; role: AgentRole; paneId: string }
  | { type: 'agent_ready'; role: AgentRole }
  | { type: 'agent_working'; role: AgentRole; task: string }
  | { type: 'agent_complete'; role: AgentRole; summary: string }
  | { type: 'agent_error'; role: AgentRole; error: string }
  | { type: 'message_routed'; from: AgentRole; to: AgentRole; messageType: string }
  | { type: 'stage_transition'; from: string; to: string }
  | { type: 'workflow_complete'; success: boolean }
  | { type: 'session_ended'; result: SessionResult };

export type EventHandler = (event: OrchestratorEvent) => void;

/**
 * State for tracking agent outboxes.
 */
interface OutboxState {
  role: AgentRole;
  lastReadTimestamp: string;
  lastMessageCount: number;
}

/**
 * Typed error for orchestrator operations.
 */
export interface OrchestratorError extends Error {
  code: OrchestratorErrorCode;
  details?: string;
}

export type OrchestratorErrorCode =
  | 'SESSION_EXISTS'
  | 'SESSION_NOT_FOUND'
  | 'WORKFLOW_NOT_FOUND'
  | 'AGENT_SPAWN_FAILED'
  | 'AGENT_NOT_FOUND'
  | 'ROUTING_FAILED'
  | 'TIMEOUT'
  | 'SYSTEM_ERROR';

// =============================================================================
// Constants
// =============================================================================

const READY_INDICATORS = [
  '> ',           // Claude Code prompt
  'Claude Code',  // Startup banner
  'What would',   // "What would you like to do?"
  'Human:',       // Alternative prompt style
];

const SWARM_DIR = '.swarm';
const OUTPUTS_DIR = 'outputs';
const LOGS_DIR = 'logs';

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Creates a typed OrchestratorError object.
 */
function createOrchestratorError(
  code: OrchestratorErrorCode,
  message: string,
  details?: string
): OrchestratorError {
  const error = new Error(message) as OrchestratorError;
  error.code = code;
  error.details = details;
  error.name = 'OrchestratorError';
  return error;
}

/**
 * Sleep utility for delays.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if Claude Code appears to be ready based on output.
 */
function detectAgentReady(output: string): boolean {
  return READY_INDICATORS.some((indicator) => output.includes(indicator));
}

// =============================================================================
// Orchestrator Class
// =============================================================================

export class Orchestrator {
  // Private state
  private session: Session | null = null;
  private monitorIntervalId: ReturnType<typeof setInterval> | null = null;
  private eventHandlers: Set<EventHandler> = new Set();
  private outboxStates: Map<AgentRole, OutboxState> = new Map();
  private sessionErrors: SessionError[] = [];
  private _config: Required<OrchestratorConfig>;
  private recoveryAttempts: RecoveryAttempt[] = [];
  private attemptHistory: Map<string, number> = new Map();
  private swarmErrors: SwarmError[] = [];

  // Public readonly properties
  public get sessionId(): string {
    return this._config.sessionId || this.session?.id || '';
  }

  public get config(): Required<OrchestratorConfig> {
    return { ...this._config };
  }

  /**
   * Create a new Orchestrator instance.
   */
  constructor(config?: OrchestratorConfig) {
    this._config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
  }

  // ===========================================================================
  // Session Lifecycle
  // ===========================================================================

  /**
   * Start a new workflow session.
   *
   * @param type - Workflow type ('research', 'development', 'architecture')
   * @param goal - User's goal or query string
   * @returns The initialized Session
   */
  async startWorkflow(type: string, goal: string): Promise<Result<Session, OrchestratorError>> {
    // Validate no session already running
    if (this.session && this.session.status === 'running') {
      return err(createOrchestratorError('SESSION_EXISTS', 'A session is already running'));
    }

    // Validate workflow type exists
    const templateResult = getWorkflowTemplate(type);
    if (!templateResult.ok) {
      return err(
        createOrchestratorError('WORKFLOW_NOT_FOUND', `Workflow type not found: ${type}`)
      );
    }

    // Validate goal is non-empty
    if (!goal || goal.trim().length === 0) {
      return err(createOrchestratorError('SYSTEM_ERROR', 'Goal cannot be empty'));
    }

    // Template is valid, proceed with workflow creation
    void templateResult.value; // Template validated but not used directly

    // Generate session ID if not provided
    const sessionId = this._config.sessionId || Date.now().toString();
    this._config.sessionId = sessionId;

    // Initialize workflow instance
    const workflowInstanceResult = createWorkflowInstance(type, sessionId, goal);
    if (!workflowInstanceResult.ok) {
      return err(
        createOrchestratorError(
          'SYSTEM_ERROR',
          `Failed to create workflow instance: ${workflowInstanceResult.error.message}`
        )
      );
    }

    // Create session object
    const session: Session = {
      id: sessionId,
      workflowType: type,
      goal,
      status: 'initializing',
      startedAt: now(),
      agents: new Map(),
      workflowInstance: workflowInstanceResult.value,
    };

    this.session = session;
    this.sessionErrors = [];
    this.outboxStates.clear();

    // Initialize database and message directories
    await this.initializeResources();

    // Store session in database
    db.createSession({
      workflowType: type as 'research' | 'development' | 'architecture',
      goal,
    });

    try {
      // Create tmux session
      const tmuxResult = await tmux.createSession(`swarm_${sessionId}`);
      if (!tmuxResult.ok) {
        await this.cleanup();
        return err(
          createOrchestratorError('SYSTEM_ERROR', `Failed to create tmux session: ${tmuxResult.error.message}`)
        );
      }

      // Get roles from workflow
      const rolesResult = getActiveAgents(workflowInstanceResult.value);
      if (!rolesResult.ok) {
        await this.cleanup();
        return err(
          createOrchestratorError('SYSTEM_ERROR', `Failed to get workflow roles: ${rolesResult.error.message}`)
        );
      }
      const roles = rolesResult.value;

      // Create worktrees for all agents
      const worktreeResult = await worktree.createWorktrees(roles, { sessionId });
      if (!worktreeResult.ok) {
        await this.cleanup();
        return err(
          createOrchestratorError('SYSTEM_ERROR', `Failed to create worktrees: ${worktreeResult.error.message}`)
        );
      }

      // Spawn agents
      for (const role of roles) {
        const spawnResult = await this.spawnAgent(role);
        if (!spawnResult.ok) {
          await this.cleanup();
          return err(spawnResult.error);
        }
      }

      // Create and send initial task
      const taskResult = createInitialTaskMessage(workflowInstanceResult.value);
      if (!taskResult.ok) {
        await this.cleanup();
        return err(
          createOrchestratorError('SYSTEM_ERROR', `Failed to create initial task: ${taskResult.error.message}`)
        );
      }

      const taskMessage = taskResult.value;

      // Start the first step
      const startStepResult = startStep(
        this.session.workflowInstance,
        this.session.workflowInstance.currentStep
      );
      if (startStepResult.ok) {
        this.session.workflowInstance = startStepResult.value;
      }

      // Send to entry agent
      messageBus.sendMessage(
        {
          from: taskMessage.from,
          to: taskMessage.to,
          type: taskMessage.type,
          priority: taskMessage.priority,
          content: taskMessage.content,
          threadId: taskMessage.threadId,
          requiresResponse: taskMessage.requiresResponse,
        },
        { persistToDb: true, sessionId }
      );

      // Update session status
      this.session.status = 'running';
      db.updateSessionStatus(sessionId, 'running');

      // Start monitoring
      this.startMonitoring();

      // Emit event
      this.emit({ type: 'session_started', sessionId, workflow: type });

      if (this._config.verboseLogging) {
        console.log(`[orchestrator] Started workflow '${type}' with session ID: ${sessionId}`);
      }

      return ok(this.session);
    } catch (error) {
      await this.cleanup();
      return err(
        createOrchestratorError(
          'SYSTEM_ERROR',
          `Unexpected error starting workflow: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * Stop the current session gracefully.
   */
  async stop(): Promise<Result<SessionResult, OrchestratorError>> {
    if (!this.session) {
      return err(createOrchestratorError('SESSION_NOT_FOUND', 'No session is running'));
    }

    // Stop monitoring
    this.stopMonitoring();

    // Mark session as cancelled
    this.session.status = 'cancelled';

    // Synthesize whatever results we have
    const result = await this.synthesizeResults();
    if (result.ok) {
      this.session.result = result.value;
    }

    // Cleanup if configured
    if (this._config.autoCleanup) {
      await this.cleanup();
    }

    if (result.ok) {
      return ok(result.value);
    }

    // Return a minimal result if synthesis failed
    const fallbackResult: SessionResult = {
      success: false,
      summary: 'Session stopped before completion',
      duration: Date.now() - new Date(this.session.startedAt).getTime(),
      agentSummaries: new Map(),
      artifacts: [],
      errors: this.sessionErrors,
    };

    return ok(fallbackResult);
  }

  /**
   * Force stop (immediate termination).
   */
  async kill(): Promise<void> {
    this.stopMonitoring();

    if (this.session) {
      this.session.status = 'failed';
    }

    await this.cleanup();
  }

  /**
   * Get current session status.
   */
  getSession(): Session | null {
    return this.session;
  }

  /**
   * Check if orchestrator is running.
   */
  isRunning(): boolean {
    return this.session !== null && this.session.status === 'running';
  }

  /**
   * Get recovery context for error recovery operations.
   * Used by the error-handling module to make recovery decisions.
   */
  getRecoveryContext(): RecoveryContext {
    const agentStates = new Map<string, { status: string; lastActivity: string }>();

    if (this.session) {
      for (const [role, agent] of this.session.agents) {
        agentStates.set(role, {
          status: agent.status,
          lastActivity: agent.lastActivityAt,
        });
      }
    }

    return {
      sessionId: this.sessionId,
      workflowState: this.session?.workflowInstance
        ? {
            currentStep: this.session.workflowInstance.currentStep,
            status: this.session.workflowInstance.status,
          }
        : undefined,
      agentStates,
      errorHistory: this.swarmErrors,
      attemptHistory: this.attemptHistory,
    };
  }

  // ===========================================================================
  // Agent Management
  // ===========================================================================

  /**
   * Spawn a single agent with retry logic.
   */
  async spawnAgent(role: AgentRole): Promise<Result<ManagedAgent, OrchestratorError>> {
    // Use withRetry for resilient agent spawning
    const retryConfig = { ...RETRY_CONFIGS.agentSpawn };
    const retryResult = await withRetry<ManagedAgent>(
      async (context) => {
        if (this._config.verboseLogging && context.attempt > 1) {
          console.log(`[orchestrator] Retry ${context.attempt}/${context.maxAttempts} spawning agent ${role}`);
        }

        const result = await this.doSpawnAgent(role);
        if (!result.ok) {
          // Convert OrchestratorError to throw for retry handling
          throw new Error(result.error.message);
        }
        return result.value;
      },
      retryConfig,
      `spawn_${role}`
    );

    if (retryResult.success && retryResult.result) {
      return ok(retryResult.result);
    }

    // All retries exhausted, return the last error
    const lastError = retryResult.errors[retryResult.errors.length - 1];
    return err(
      createOrchestratorError(
        'AGENT_SPAWN_FAILED',
        `Failed to spawn agent ${role} after ${retryResult.attempts} attempts: ${lastError?.message ?? 'Unknown error'}`
      )
    );
  }

  /**
   * Internal implementation of agent spawning (used by spawnAgent with retry).
   */
  private async doSpawnAgent(role: AgentRole): Promise<Result<ManagedAgent, OrchestratorError>> {
    if (!this.session) {
      return err(createOrchestratorError('SESSION_NOT_FOUND', 'No session is running'));
    }

    // Check if agent already spawned
    if (this.session.agents.has(role)) {
      return err(createOrchestratorError('SYSTEM_ERROR', `Agent ${role} already spawned`));
    }

    // Check agent limit
    if (this.session.agents.size >= this._config.maxAgents) {
      return err(createOrchestratorError('SYSTEM_ERROR', `Maximum agents (${this._config.maxAgents}) reached`));
    }

    // Get worktree path
    let worktreePath: string;
    try {
      worktreePath = await worktree.getWorktreePath(role);
    } catch (error) {
      return err(createOrchestratorError('AGENT_SPAWN_FAILED', `Failed to get worktree path: ${error}`));
    }

    // Verify worktree exists
    if (!existsSync(worktreePath)) {
      return err(
        createOrchestratorError('AGENT_SPAWN_FAILED', `Worktree does not exist for role: ${role}`)
      );
    }

    const sessionName = `swarm_${this.session.id}`;

    // Create tmux pane
    const paneResult = await tmux.createPane(sessionName, { name: role });
    if (!paneResult.ok) {
      return err(
        createOrchestratorError('AGENT_SPAWN_FAILED', `Failed to create pane: ${paneResult.error.message}`)
      );
    }

    const paneId = paneResult.value;

    // Create managed agent record
    const agent: ManagedAgent = {
      role,
      paneId,
      worktreePath,
      status: 'starting',
      spawnedAt: now(),
      lastActivityAt: now(),
      messageCount: 0,
      errorCount: 0,
    };

    this.session.agents.set(role, agent);
    this.emit({ type: 'agent_spawned', role, paneId });

    // Initialize outbox state
    this.outboxStates.set(role, {
      role,
      lastReadTimestamp: now(),
      lastMessageCount: 0,
    });

    // Start Claude Code in the pane
    const startResult = await tmux.startClaudeCode(sessionName, paneId, {
      resume: true,
      workdir: worktreePath,
    });

    if (!startResult.ok) {
      agent.status = 'error';
      return err(
        createOrchestratorError('AGENT_SPAWN_FAILED', `Failed to start Claude Code: ${startResult.error.message}`)
      );
    }

    // Wait for Claude Code to be ready
    const readyResult = await this.waitForAgentReady(role);
    if (!readyResult.ok) {
      agent.status = 'error';
      return err(readyResult.error);
    }

    agent.status = 'ready';
    this.emit({ type: 'agent_ready', role });

    if (this._config.verboseLogging) {
      console.log(`[orchestrator] Agent ${role} spawned and ready in pane ${paneId}`);
    }

    return ok(agent);
  }

  /**
   * Get agent info.
   */
  getAgent(role: AgentRole): ManagedAgent | undefined {
    return this.session?.agents.get(role);
  }

  /**
   * List all active agents.
   */
  listAgents(): ManagedAgent[] {
    if (!this.session) {
      return [];
    }
    return Array.from(this.session.agents.values());
  }

  /**
   * Send a message to an agent.
   */
  async sendToAgent(role: AgentRole, message: AgentMessage): Promise<Result<void, OrchestratorError>> {
    if (!this.session) {
      return err(createOrchestratorError('SESSION_NOT_FOUND', 'No session is running'));
    }

    const agent = this.session.agents.get(role);
    if (!agent) {
      return err(createOrchestratorError('AGENT_NOT_FOUND', `Agent ${role} not found`));
    }

    // Write to agent's inbox
    messageBus.sendMessage(
      {
        from: message.from,
        to: role,
        type: message.type,
        priority: message.priority,
        content: message.content,
        threadId: message.threadId,
        requiresResponse: message.requiresResponse,
        deadline: message.deadline,
      },
      { persistToDb: true, sessionId: this.session.id }
    );

    agent.status = 'working';
    this.emit({ type: 'agent_working', role, task: message.content.subject });

    return ok(undefined);
  }

  /**
   * Capture agent's current terminal output.
   */
  async captureAgentOutput(role: AgentRole, lines?: number): Promise<Result<string, OrchestratorError>> {
    if (!this.session) {
      return err(createOrchestratorError('SESSION_NOT_FOUND', 'No session is running'));
    }

    const agent = this.session.agents.get(role);
    if (!agent) {
      return err(createOrchestratorError('AGENT_NOT_FOUND', `Agent ${role} not found`));
    }

    const sessionName = `swarm_${this.session.id}`;
    const captureResult = await tmux.capturePane(sessionName, agent.paneId, { lines: lines ?? 100 });

    if (!captureResult.ok) {
      return err(
        createOrchestratorError('SYSTEM_ERROR', `Failed to capture output: ${captureResult.error.message}`)
      );
    }

    agent.lastCapturedOutput = captureResult.value;
    return ok(captureResult.value);
  }

  /**
   * Terminate a specific agent.
   */
  async terminateAgent(role: AgentRole): Promise<Result<void, OrchestratorError>> {
    if (!this.session) {
      return err(createOrchestratorError('SESSION_NOT_FOUND', 'No session is running'));
    }

    const agent = this.session.agents.get(role);
    if (!agent) {
      return err(createOrchestratorError('AGENT_NOT_FOUND', `Agent ${role} not found`));
    }

    await this.terminateAgentGracefully(agent);
    agent.status = 'terminated';
    this.session.agents.delete(role);

    return ok(undefined);
  }

  // ===========================================================================
  // Message Handling
  // ===========================================================================

  /**
   * Route a message according to workflow rules.
   */
  async routeMessage(from: AgentRole, message: AgentMessage): Promise<Result<void, OrchestratorError>> {
    if (!this.session) {
      return err(createOrchestratorError('SESSION_NOT_FOUND', 'No session is running'));
    }

    // Log message to database
    db.createMessage({
      sessionId: this.session.id,
      threadId: message.threadId,
      from: message.from,
      to: message.to,
      messageType: message.type,
      priority: message.priority,
      content: message.content,
    });

    // Complete the current step
    const completeResult = completeStep(
      this.session.workflowInstance,
      this.session.workflowInstance.currentStep,
      {
        type: message.type,
        summary: message.content.body.substring(0, 200),
        verdict: message.content.metadata?.verdict as 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED' | undefined,
      }
    );

    if (completeResult.ok) {
      this.session.workflowInstance = completeResult.value;
    }

    // Get routing decision from workflow engine
    const routingResult = engineRouteMessage(this.session.workflowInstance, message);
    if (!routingResult.ok) {
      this.recordError({
        timestamp: now(),
        agent: from,
        type: 'routing_error',
        message: routingResult.error.message,
        recoverable: true,
        recovered: false,
      });
      return err(
        createOrchestratorError('ROUTING_FAILED', `Failed to route message: ${routingResult.error.message}`)
      );
    }

    const decisions = routingResult.value;

    // Apply routing decisions
    for (const decision of decisions) {
      await this.applyRoutingDecision(from, decision);
    }

    // Transition workflow
    const verdict = message.content.metadata?.verdict as 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED' | undefined;
    const transitionResult = transitionWorkflow(this.session.workflowInstance, { verdict });
    if (transitionResult.ok) {
      const previousStep = this.session.workflowInstance.currentStep;
      this.session.workflowInstance = transitionResult.value;

      if (this.session.workflowInstance.currentStep !== previousStep) {
        this.emit({
          type: 'stage_transition',
          from: previousStep,
          to: this.session.workflowInstance.currentStep,
        });

        // Checkpoint the completed stage for recovery
        await this.createStageCheckpoint(previousStep);

        // Start the new step
        const newStepResult = startStep(
          this.session.workflowInstance,
          this.session.workflowInstance.currentStep
        );
        if (newStepResult.ok) {
          this.session.workflowInstance = newStepResult.value;
        }
      }
    }

    // Check for workflow completion
    if (isWorkflowComplete(this.session.workflowInstance)) {
      await this.handleWorkflowComplete();
    }

    return ok(undefined);
  }

  /**
   * Get pending messages for an agent.
   */
  getPendingMessages(role: AgentRole): AgentMessage[] {
    return messageBus.readInbox(role);
  }

  /**
   * Get message history for session.
   */
  getMessageHistory(): AgentMessage[] {
    if (!this.session) {
      return [];
    }
    return db.getSessionMessages(this.session.id);
  }

  // ===========================================================================
  // Monitoring
  // ===========================================================================

  /**
   * Start the monitoring loop.
   */
  startMonitoring(): void {
    if (this.monitorIntervalId) {
      return; // Already monitoring
    }

    this.monitorIntervalId = setInterval(
      () => this.monitorLoop(),
      this._config.monitorInterval
    );

    if (this._config.verboseLogging) {
      console.log(`[orchestrator] Started monitoring at ${this._config.monitorInterval}ms interval`);
    }
  }

  /**
   * Stop the monitoring loop.
   */
  stopMonitoring(): void {
    if (this.monitorIntervalId) {
      clearInterval(this.monitorIntervalId);
      this.monitorIntervalId = null;

      if (this._config.verboseLogging) {
        console.log('[orchestrator] Stopped monitoring');
      }
    }
  }

  /**
   * Check agent health and execute recovery if needed.
   */
  async checkAgentHealth(role: AgentRole): Promise<AgentStatus> {
    if (!this.session) {
      return 'terminated';
    }

    const agent = this.session.agents.get(role);
    if (!agent) {
      return 'terminated';
    }

    // Capture current output
    const outputResult = await this.captureAgentOutput(role, 20);
    if (outputResult.ok) {
      agent.lastActivityAt = now();
    }

    // Check for timeout
    const lastActivity = new Date(agent.lastActivityAt).getTime();
    if (Date.now() - lastActivity > this._config.agentTimeout) {
      agent.status = 'error';

      // Create a SwarmError for proper error handling integration
      const swarmError = createSwarmError('AGENT_TIMEOUT', {
        message: `Agent ${role} timed out after ${this._config.agentTimeout}ms`,
        component: 'orchestrator',
        sessionId: this.session.id,
        agentRole: role,
        context: {
          timeout: this._config.agentTimeout,
          lastActivity: agent.lastActivityAt,
        },
      });

      // Track the error
      this.swarmErrors.push(swarmError);

      // Record in session errors for backward compatibility
      this.recordError({
        timestamp: now(),
        agent: role,
        type: 'timeout',
        message: swarmError.message,
        recoverable: swarmError.recoverable,
        recovered: false,
      });

      // Execute recovery using error-handling module
      const recoveryContext = this.getRecoveryContext();
      const recoveryPlan = selectStrategy(swarmError, recoveryContext);
      const recoveryOutcome = await executeRecovery(swarmError, recoveryPlan, recoveryContext);

      // Track recovery attempt
      this.recoveryAttempts.push({
        errorId: swarmError.id,
        strategy: recoveryOutcome.strategyUsed,
        outcome: recoveryOutcome.success ? 'success' : 'failed',
        timestamp: now(),
      });

      if (recoveryOutcome.success) {
        // Mark error as recovered in session errors
        const sessionError = this.sessionErrors.find(e => e.message === swarmError.message);
        if (sessionError) {
          sessionError.recovered = true;
        }

        if (this._config.verboseLogging) {
          console.log(`[orchestrator] Recovery successful for agent ${role} using strategy: ${recoveryOutcome.strategyUsed}`);
        }
      }
    }

    return agent.status;
  }

  /**
   * Get workflow progress percentage.
   */
  getProgress(): number {
    if (!this.session) {
      return 0;
    }

    const progressResult = getWorkflowProgress(this.session.workflowInstance);
    if (!progressResult.ok) {
      return 0;
    }

    return progressResult.value;
  }

  // ===========================================================================
  // Results
  // ===========================================================================

  /**
   * Synthesize results from all agents.
   */
  async synthesizeResults(): Promise<Result<SessionResult, OrchestratorError>> {
    if (!this.session) {
      return err(createOrchestratorError('SESSION_NOT_FOUND', 'No session is running'));
    }

    this.session.status = 'synthesizing';

    // Get workflow result
    const workflowResult = engineSynthesizeResult(this.session.workflowInstance);

    // Build agent summaries
    const agentSummaries = new Map<AgentRole, AgentSummary>();
    for (const [role, agent] of this.session.agents) {
      agentSummaries.set(role, {
        role,
        messagesProduced: agent.messageCount,
        tasksCompleted: 1, // Simplified
      });
    }

    // Collect artifacts
    const artifacts = db.getSessionArtifacts(this.session.id).map((a) => a.filepath);

    // Calculate duration
    const duration = Date.now() - new Date(this.session.startedAt).getTime();

    // Build summary
    let summary: string;
    if (workflowResult.ok) {
      summary = workflowResult.value.summary;
    } else {
      summary = `Workflow '${this.session.workflowType}' ${this.session.status}. Goal: ${this.session.goal}`;
    }

    const result: SessionResult = {
      success: workflowResult.ok && workflowResult.value.success,
      summary,
      duration,
      agentSummaries,
      artifacts,
      errors: this.sessionErrors,
    };

    this.session.result = result;
    this.session.completedAt = now();
    this.session.status = result.success ? 'complete' : 'failed';

    // Update database
    db.updateSessionStatus(this.session.id, result.success ? 'complete' : 'failed');

    // Export results if configured
    if (this._config.autoCleanup) {
      await this.exportResults('json');
    }

    return ok(result);
  }

  /**
   * Get results for a specific agent.
   */
  async getAgentResults(role: AgentRole): Promise<Result<AgentSummary | null, OrchestratorError>> {
    if (!this.session) {
      return err(createOrchestratorError('SESSION_NOT_FOUND', 'No session is running'));
    }

    if (!this.session.result) {
      return ok(null);
    }

    const summary = this.session.result.agentSummaries.get(role);
    return ok(summary ?? null);
  }

  /**
   * Export results to file.
   */
  async exportResults(format: 'json' | 'markdown'): Promise<Result<string, OrchestratorError>> {
    if (!this.session || !this.session.result) {
      return err(createOrchestratorError('SESSION_NOT_FOUND', 'No session or results available'));
    }

    const outputDir = join(OUTPUTS_DIR, this.session.id);
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    const result = this.session.result;
    let filename: string;
    let content: string;

    if (format === 'json') {
      filename = join(outputDir, 'result.json');
      content = JSON.stringify(
        {
          ...result,
          agentSummaries: Object.fromEntries(result.agentSummaries),
        },
        null,
        2
      );
    } else {
      filename = join(outputDir, 'summary.md');
      content = this.generateMarkdownSummary(result);
    }

    writeFileSync(filename, content, 'utf-8');
    return ok(filename);
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  /**
   * Clean up all resources.
   */
  async cleanup(): Promise<void> {
    this.stopMonitoring();

    if (!this.session) {
      return;
    }

    const sessionId = this.session.id;
    const sessionName = `swarm_${sessionId}`;

    // Terminate all agents
    for (const agent of this.session.agents.values()) {
      await this.terminateAgentGracefully(agent);
    }

    // Kill tmux session
    await tmux.killSession(sessionName);

    // Remove worktrees
    await worktree.removeAllWorktrees({ force: true, deleteBranches: true });
    await worktree.pruneWorktrees();

    // Clear message queues if autoCleanup
    if (this._config.autoCleanup) {
      messageBus.clearAllQueues();
    }

    // Emit session ended event
    if (this.session.result) {
      this.emit({ type: 'session_ended', result: this.session.result });
    }

    if (this._config.verboseLogging) {
      console.log(`[orchestrator] Cleaned up session ${sessionId}`);
    }
  }

  /**
   * Clean up a specific agent's resources.
   */
  async cleanupAgent(role: AgentRole): Promise<Result<void, OrchestratorError>> {
    if (!this.session) {
      return err(createOrchestratorError('SESSION_NOT_FOUND', 'No session is running'));
    }

    const agent = this.session.agents.get(role);
    if (!agent) {
      return ok(undefined); // Already cleaned up
    }

    await this.terminateAgentGracefully(agent);
    await worktree.removeWorktree(role, { force: true, deleteBranch: true });
    this.session.agents.delete(role);

    return ok(undefined);
  }

  // ===========================================================================
  // Events
  // ===========================================================================

  /**
   * Subscribe to orchestrator events.
   */
  on(handler: EventHandler): void {
    this.eventHandlers.add(handler);
  }

  /**
   * Unsubscribe from events.
   */
  off(handler: EventHandler): void {
    this.eventHandlers.delete(handler);
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Emit an event to all handlers.
   */
  private emit(event: OrchestratorEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        console.error('[orchestrator] Event handler error:', error);
      }
    }
  }

  /**
   * Initialize resources needed for the session.
   */
  private async initializeResources(): Promise<void> {
    // Ensure directories exist
    if (!existsSync(SWARM_DIR)) {
      mkdirSync(SWARM_DIR, { recursive: true });
    }

    if (!existsSync(OUTPUTS_DIR)) {
      mkdirSync(OUTPUTS_DIR, { recursive: true });
    }

    if (!existsSync(LOGS_DIR)) {
      mkdirSync(LOGS_DIR, { recursive: true });
    }

    // Initialize message bus
    messageBus.initializeAgentQueues();

    // Ensure database is initialized
    db.getDb();
  }

  /**
   * Wait for an agent to become ready.
   */
  private async waitForAgentReady(role: AgentRole): Promise<Result<void, OrchestratorError>> {
    if (!this.session) {
      return err(createOrchestratorError('SESSION_NOT_FOUND', 'No session is running'));
    }

    const agent = this.session.agents.get(role);
    if (!agent) {
      return err(createOrchestratorError('AGENT_NOT_FOUND', `Agent ${role} not found`));
    }

    const sessionName = `swarm_${this.session.id}`;
    const startTime = Date.now();
    const timeout = this._config.agentTimeout;

    while (Date.now() - startTime < timeout) {
      const captureResult = await tmux.capturePane(sessionName, agent.paneId, { lines: 30 });

      if (captureResult.ok && detectAgentReady(captureResult.value)) {
        return ok(undefined);
      }

      await sleep(1000);
    }

    return err(
      createOrchestratorError('TIMEOUT', `Agent ${role} did not become ready within ${timeout}ms`)
    );
  }

  /**
   * Terminate an agent gracefully.
   */
  private async terminateAgentGracefully(agent: ManagedAgent): Promise<void> {
    if (!this.session) {
      return;
    }

    const sessionName = `swarm_${this.session.id}`;

    // Send Ctrl+C to interrupt
    await tmux.sendInterrupt(sessionName, agent.paneId);
    await sleep(1000);

    // Check if terminated
    const captureResult = await tmux.capturePane(sessionName, agent.paneId, { lines: 5 });
    if (captureResult.ok && !captureResult.value.includes('$')) {
      // Still running, send another Ctrl+C
      await tmux.sendInterrupt(sessionName, agent.paneId);
      await sleep(500);
    }

    // Kill the pane
    await tmux.killPane(sessionName, agent.paneId);
  }

  /**
   * Main monitoring loop.
   */
  private async monitorLoop(): Promise<void> {
    if (!this.session || this.session.status !== 'running') {
      return;
    }

    // Check workflow timeout
    const elapsed = Date.now() - new Date(this.session.startedAt).getTime();
    if (elapsed > this._config.workflowTimeout) {
      this.recordError({
        timestamp: now(),
        type: 'timeout',
        message: 'Workflow timeout exceeded',
        recoverable: false,
        recovered: false,
      });
      await this.handleWorkflowTimeout();
      return;
    }

    // Check each agent
    for (const [role] of this.session.agents) {
      // Capture output
      if (this._config.captureOutput) {
        await this.captureAgentOutput(role);
      }

      // Check agent health
      await this.checkAgentHealth(role);
    }

    // Check outboxes for new messages
    await this.checkOutboxes();

    // Check for workflow completion
    if (isWorkflowComplete(this.session.workflowInstance)) {
      await this.handleWorkflowComplete();
    }
  }

  /**
   * Check all agent outboxes for new messages.
   */
  private async checkOutboxes(): Promise<void> {
    if (!this.session) {
      return;
    }

    for (const [role, agent] of this.session.agents) {
      const state = this.outboxStates.get(role);
      if (!state) {
        continue;
      }

      const newMessages = messageBus.getNewOutboxMessages(role, state.lastReadTimestamp);

      for (const message of newMessages) {
        agent.messageCount++;
        agent.lastActivityAt = now();

        // Route the message
        await this.routeMessage(role, message);

        // Update state
        state.lastReadTimestamp = message.timestamp;
        state.lastMessageCount++;
      }
    }
  }

  /**
   * Apply a routing decision.
   */
  private async applyRoutingDecision(from: AgentRole, decision: RoutingDecision): Promise<void> {
    if (!this.session) {
      return;
    }

    const targetAgent = this.session.agents.get(decision.to);
    if (!targetAgent) {
      this.recordError({
        timestamp: now(),
        agent: from,
        type: 'routing_error',
        message: `Target agent ${decision.to} not found`,
        recoverable: true,
        recovered: false,
      });
      return;
    }

    // Send message to target agent's inbox
    messageBus.sendMessage(
      {
        from: decision.message.from,
        to: decision.to,
        type: decision.message.type,
        priority: decision.message.priority,
        content: decision.message.content,
        threadId: decision.message.threadId,
        requiresResponse: decision.message.requiresResponse,
      },
      { persistToDb: true, sessionId: this.session.id }
    );

    this.emit({
      type: 'message_routed',
      from,
      to: decision.to,
      messageType: decision.message.type,
    });

    if (this._config.verboseLogging) {
      console.log(`[orchestrator] Routed ${decision.message.type} from ${from} to ${decision.to}`);
    }
  }

  /**
   * Handle workflow completion.
   */
  private async handleWorkflowComplete(): Promise<void> {
    if (!this.session) {
      return;
    }

    this.stopMonitoring();

    this.emit({ type: 'workflow_complete', success: true });

    const result = await this.synthesizeResults();
    if (result.ok) {
      this.session.result = result.value;
    }

    if (this._config.autoCleanup) {
      await this.cleanup();
    }

    if (this._config.verboseLogging) {
      console.log('[orchestrator] Workflow completed successfully');
    }
  }

  /**
   * Handle workflow timeout.
   */
  private async handleWorkflowTimeout(): Promise<void> {
    if (!this.session) {
      return;
    }

    this.stopMonitoring();
    this.session.status = 'failed';

    this.emit({ type: 'workflow_complete', success: false });

    await this.synthesizeResults();

    if (this._config.autoCleanup) {
      await this.cleanup();
    }
  }

  /**
   * Record an error.
   */
  private recordError(error: SessionError): void {
    this.sessionErrors.push(error);

    if (error.agent) {
      const agent = this.session?.agents.get(error.agent);
      if (agent) {
        agent.errorCount++;
      }
      this.emit({ type: 'agent_error', role: error.agent, error: error.message });
    }

    if (this._config.verboseLogging) {
      console.error(`[orchestrator] Error: ${error.message}`);
    }
  }

  /**
   * Create a checkpoint after a stage completes.
   */
  private async createStageCheckpoint(stageName: string): Promise<void> {
    if (!this.session) {
      return;
    }

    try {
      // Build serialized agent states
      const agentStates = new Map<string, SerializedAgentState>();
      for (const [role, agent] of this.session.agents) {
        agentStates.set(role, {
          role,
          status: agent.status,
          messageCount: agent.messageCount,
          lastActivityAt: agent.lastActivityAt,
        });
      }

      // Build message queue snapshot
      const queueSummary = messageBus.getQueueSummary();
      const messageQueueState: MessageQueueSnapshot = {
        inboxes: {},
        outboxes: {},
        lastProcessedTimestamps: {},
      };
      for (const [agent, counts] of Object.entries(queueSummary)) {
        messageQueueState.inboxes[agent] = counts.inbox;
        messageQueueState.outboxes[agent] = counts.outbox;
        const outboxState = this.outboxStates.get(agent as AgentRole);
        if (outboxState) {
          messageQueueState.lastProcessedTimestamps[agent] = outboxState.lastReadTimestamp;
        }
      }

      // Get completed and pending stages from workflow step history
      const completedStages = this.session.workflowInstance.stepHistory
        .filter((record) => record.status === 'complete')
        .map((record) => record.stepId);

      // Get all step IDs from the workflow template
      const templateResult = getWorkflowTemplate(this.session.workflowType);
      let allStages: string[] = [];
      if (templateResult.ok) {
        allStages = templateResult.value.steps.map((step) => step.id);
      }

      const pendingStages = allStages.filter((stepId) => !completedStages.includes(stepId));

      // Convert SwarmErrors to serializable format
      const errorsForCheckpoint = this.swarmErrors.map((e) => ({
        ...e,
        // Remove non-serializable fields
        context: e.context ? JSON.parse(JSON.stringify(e.context)) : undefined,
      }));

      await checkpointOnStage(this.session.id, stageName, {
        workflowState: {
          currentStep: this.session.workflowInstance.currentStep,
          status: this.session.workflowInstance.status,
          workflowType: this.session.workflowType,
          goal: this.session.goal,
        },
        agentStates,
        messageQueueState,
        completedStages,
        pendingStages,
        processedMessageIds: [],
        errors: errorsForCheckpoint,
        recoveryAttempts: this.recoveryAttempts,
      });

      if (this._config.verboseLogging) {
        console.log(`[orchestrator] Created checkpoint for stage: ${stageName}`);
      }
    } catch (error) {
      // Log but don't fail the workflow on checkpoint errors
      if (this._config.verboseLogging) {
        console.error(`[orchestrator] Failed to create checkpoint: ${error}`);
      }
    }
  }

  /**
   * Generate markdown summary of results.
   */
  private generateMarkdownSummary(result: SessionResult): string {
    let md = `# Workflow Results\n\n`;
    md += `**Status**: ${result.success ? 'Success' : 'Failed'}\n`;
    md += `**Duration**: ${Math.round(result.duration / 1000)}s\n\n`;

    md += `## Summary\n\n${result.summary}\n\n`;

    if (result.artifacts.length > 0) {
      md += `## Artifacts\n\n`;
      for (const artifact of result.artifacts) {
        md += `- ${artifact}\n`;
      }
      md += '\n';
    }

    md += `## Agent Summaries\n\n`;
    for (const [role, summary] of result.agentSummaries) {
      md += `### ${role}\n`;
      md += `- Messages produced: ${summary.messagesProduced}\n`;
      md += `- Tasks completed: ${summary.tasksCompleted}\n`;
      md += '\n';
    }

    if (result.errors.length > 0) {
      md += `## Errors\n\n`;
      for (const error of result.errors) {
        md += `- [${error.type}] ${error.message}\n`;
      }
    }

    return md;
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a new Orchestrator instance with optional configuration.
 */
export function createOrchestrator(config?: OrchestratorConfig): Orchestrator {
  return new Orchestrator(config);
}
