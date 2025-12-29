/**
 * Claude Swarm - Shared Type Definitions
 *
 * This file defines all shared TypeScript interfaces used across the system.
 * Types are contracts between all modules.
 */

// =============================================================================
// Message Types
// =============================================================================

/**
 * Base message for all inter-agent communication.
 * Messages flow through the file-based message bus.
 */
export interface AgentMessage {
  /** UUID v4 identifier */
  id: string;
  /** ISO 8601 timestamp of creation */
  timestamp: string;
  /** Agent role that sent this message */
  from: string;
  /** Target agent role or "broadcast" for all */
  to: string;
  /** Categorization for routing logic */
  type: MessageType;
  /** Urgency level for processing order */
  priority: Priority;
  /** The actual message payload */
  content: MessageContent;
  /** Optional: links related messages together */
  threadId?: string;
  /** Whether sender expects a response */
  requiresResponse: boolean;
  /** Optional: ISO 8601 deadline for response */
  deadline?: string;
}

export type MessageType =
  | 'task'      // Assignment from orchestrator
  | 'result'    // Completed work output
  | 'question'  // Clarification request
  | 'feedback'  // Review comments
  | 'status'    // Progress/completion signal
  | 'finding'   // Research discovery
  | 'artifact'  // Code/document produced
  | 'review'    // Review verdict
  | 'design';   // Architecture proposal

export type Priority = 'critical' | 'high' | 'normal' | 'low';

export interface MessageContent {
  /** Brief description (for logging/display) */
  subject: string;
  /** Full message content */
  body: string;
  /** Optional: file paths or inline content */
  artifacts?: string[];
  /** Optional: extensible metadata */
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Agent Types
// =============================================================================

/**
 * Runtime information about a spawned agent.
 * Tracked by the orchestrator during session lifecycle.
 */
export interface AgentInfo {
  /** The role this agent is playing */
  role: AgentRole;
  /** tmux pane identifier (e.g., "%3") */
  paneId: string;
  /** Absolute path to agent's worktree */
  worktreePath: string;
  /** Current lifecycle state */
  status: AgentStatus;
  /** ISO 8601 timestamp when spawned */
  spawnedAt: string;
  /** ISO 8601 timestamp of last detected activity */
  lastActivity?: string;
}

/** The five defined agent roles */
export type AgentRole = 'orchestrator' | 'researcher' | 'developer' | 'reviewer' | 'architect';

/** Agent lifecycle states */
export type AgentStatus =
  | 'starting'  // Worktree created, Claude launching
  | 'running'   // Actively processing
  | 'complete'  // Sent completion signal
  | 'error'     // Encountered fatal error
  | 'idle';     // Waiting for work

// =============================================================================
// Task Types
// =============================================================================

/**
 * A discrete unit of work assigned to an agent.
 * Tasks are persisted in SQLite for tracking and recovery.
 */
export interface Task {
  /** UUID v4 identifier */
  id: string;
  /** Session this task belongs to */
  sessionId: string;
  /** Optional: parent task for subtask hierarchy */
  parentTaskId?: string;
  /** Agent role responsible for this task */
  assignedTo: AgentRole;
  /** Current progress state */
  status: TaskStatus;
  /** Processing urgency */
  priority: Priority;
  /** Human-readable task description */
  description: string;
  /** Optional: structured input data */
  inputData?: Record<string, unknown>;
  /** Optional: structured output data (set on completion) */
  outputData?: Record<string, unknown>;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** ISO 8601 last update timestamp */
  updatedAt: string;
}

/** Task lifecycle states following the defined flow */
export type TaskStatus =
  | 'created'     // Just created, not yet assigned
  | 'assigned'    // Sent to agent
  | 'in_progress' // Agent actively working
  | 'review'      // Submitted for review
  | 'revision'    // Returned for changes
  | 'complete'    // Successfully finished
  | 'failed';     // Unrecoverable error

// =============================================================================
// Finding Types
// =============================================================================

/**
 * A research finding from the researcher agent.
 * Findings require verification before being considered reliable.
 */
export interface Finding {
  id: string;
  sessionId: string;
  /** Agent that discovered this (usually "researcher") */
  agent: string;
  /** The specific assertion being made */
  claim: string;
  /** Self-assessed reliability level */
  confidence: Confidence;
  /** URLs or references supporting the claim */
  sources: string[];
  /** Optional: evidence that contradicts the claim */
  contradictingEvidence?: string;
  /** Agent that verified this finding */
  verifiedBy?: string;
  /** ISO 8601 verification timestamp */
  verifiedAt?: string;
  createdAt: string;
}

export type Confidence = 'high' | 'medium' | 'low';

// =============================================================================
// Artifact Types
// =============================================================================

/**
 * A code, document, or other artifact created by an agent.
 * Artifacts go through a review cycle before approval.
 */
export interface Artifact {
  id: string;
  sessionId: string;
  /** Agent that created this artifact */
  agent: string;
  /** Category of artifact */
  artifactType: ArtifactType;
  /** Relative path within worktree */
  filepath: string;
  /** Optional: file content (may be large) */
  content?: string;
  /** Optional: brief description of what this does */
  summary?: string;
  /** Revision number, increments on updates */
  version: number;
  /** Review workflow state */
  reviewStatus: ReviewStatus;
  createdAt: string;
}

export type ArtifactType =
  | 'code'          // Source code files
  | 'test'          // Test files
  | 'documentation' // Docs, READMEs
  | 'diagram'       // Architecture diagrams
  | 'config';       // Configuration files

export type ReviewStatus =
  | 'pending'        // Awaiting review
  | 'approved'       // Passed review
  | 'needs_revision' // Changes requested
  | 'rejected';      // Not acceptable

// =============================================================================
// Decision Types
// =============================================================================

/**
 * A recorded decision made during the workflow.
 * Provides audit trail and rationale for choices.
 */
export interface Decision {
  id: string;
  sessionId: string;
  /** Agent that made the decision */
  agent: string;
  /** The choice that was made */
  decision: string;
  /** Why this choice was made */
  rationale: string;
  /** Other options that were considered */
  alternativesConsidered: Alternative[];
  createdAt: string;
}

export interface Alternative {
  name: string;
  pros: string[];
  cons: string[];
}

// =============================================================================
// Workflow Types
// =============================================================================

/**
 * Configuration for a multi-stage workflow.
 * Defines which agents participate and in what order.
 */
export interface WorkflowConfig {
  /** Unique workflow identifier */
  name: string;
  /** Human-readable description */
  description: string;
  /** Agent roles involved in this workflow */
  agents: AgentRole[];
  /** Ordered stages of execution */
  stages: WorkflowStage[];
  /** Max times to repeat the full workflow */
  maxIterations?: number;
  /** Max revision cycles for individual stages */
  maxRevisions?: number;
}

export interface WorkflowStage {
  /** Stage identifier */
  name: string;
  /** Agent responsible for this stage */
  agent: AgentRole;
  /** Input from previous stage(s) */
  input?: string | string[];
  /** Output key for next stages */
  output: string;
  /** Optional: condition expression for running this stage */
  condition?: string;
  /** Max times to repeat this specific stage */
  maxIterations?: number;
}

export type WorkflowType = 'research' | 'development' | 'architecture';

// =============================================================================
// Session Types
// =============================================================================

/**
 * A swarm session represents one run of a workflow.
 * Sessions are persisted for recovery and reporting.
 */
export interface SwarmSession {
  /** UUID v4 identifier */
  id: string;
  /** Type of workflow being executed */
  workflowType: WorkflowType;
  /** User-provided objective */
  goal: string;
  /** Current session state */
  status: SessionStatus;
  /** Map of role -> agent runtime info */
  agents: Map<AgentRole, AgentInfo>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export type SessionStatus =
  | 'initializing' // Setting up agents
  | 'running'      // Workflow in progress
  | 'paused'       // User-requested pause
  | 'complete'     // All stages done
  | 'failed';      // Unrecoverable error

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Global swarm configuration options.
 * Can be loaded from config.json or use defaults.
 */
export interface SwarmConfig {
  /** Maximum concurrent agents */
  maxAgents: number;
  /** Default operation timeout in ms */
  defaultTimeout: number;
  /** How often agents check for messages (ms) */
  messagePollingInterval: number;
  /** tmux-specific settings */
  tmux: TmuxConfig;
  /** Worktree-specific settings */
  worktrees: WorktreeConfig;
  /** Per-workflow settings */
  workflows: Record<WorkflowType, WorkflowConfig>;
}

export interface TmuxConfig {
  /** Prefix for tmux session names */
  sessionPrefix: string;
}

export interface WorktreeConfig {
  /** Base directory for worktrees */
  basePath: string;
}

// =============================================================================
// Utility Types and Functions
// =============================================================================

/**
 * Result type for operations that can fail.
 * Use instead of throwing exceptions for expected failures.
 */
export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

/** Create a success result */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Create an error result */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Generate a UUID v4 identifier */
export function generateId(): string {
  return crypto.randomUUID();
}

/** Get current timestamp in ISO 8601 format */
export function now(): string {
  return new Date().toISOString();
}
