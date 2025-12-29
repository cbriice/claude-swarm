/**
 * Claude Swarm - Database Layer (SQLite)
 *
 * Provides persistent storage for swarm sessions, findings, artifacts,
 * decisions, tasks, and messages using SQLite with WAL mode.
 */

import { Database } from 'bun:sqlite';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import {
  generateId,
  now,
  type Confidence,
  type TaskStatus,
  type ReviewStatus,
  type WorkflowType,
  type SessionStatus,
  type SwarmSession,
  type Finding,
  type Artifact,
  type Decision,
  type Task,
  type AgentMessage,
  type Priority,
  type MessageType,
  type MessageContent,
  type ArtifactType,
  type Alternative,
} from './types.js';

// =============================================================================
// Database Connection Management
// =============================================================================

const DB_DIR = '.swarm';
const DB_FILE = 'memory.db';

let dbInstance: Database | null = null;

/**
 * Get the singleton database connection.
 * Creates the .swarm directory and database file if needed.
 * Enables WAL mode and foreign keys.
 */
export function getDb(): Database {
  if (dbInstance) {
    return dbInstance;
  }

  // Ensure .swarm directory exists
  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }

  const dbPath = join(DB_DIR, DB_FILE);
  dbInstance = new Database(dbPath);

  // Enable WAL mode for better concurrency
  dbInstance.run('PRAGMA journal_mode = WAL');

  // Enable foreign key constraints
  dbInstance.run('PRAGMA foreign_keys = ON');

  // Initialize schema
  initializeSchema(dbInstance);

  return dbInstance;
}

/**
 * Close the database connection and reset the singleton.
 */
export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

// =============================================================================
// Schema Definition
// =============================================================================

function initializeSchema(db: Database): void {
  // Sessions table
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      workflow_type TEXT NOT NULL,
      goal TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at)`);

  // Findings table
  db.run(`
    CREATE TABLE IF NOT EXISTS findings (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      claim TEXT NOT NULL,
      confidence TEXT NOT NULL,
      sources TEXT NOT NULL,
      contradicting_evidence TEXT,
      verified_by TEXT,
      verified_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_findings_session_id ON findings(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_findings_verified_by ON findings(verified_by)`);

  // Artifacts table
  db.run(`
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      artifact_type TEXT NOT NULL,
      filepath TEXT NOT NULL,
      content TEXT,
      summary TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      review_status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_artifacts_session_id ON artifacts(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_artifacts_review_status ON artifacts(review_status)`);

  // Decisions table
  db.run(`
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      decision TEXT NOT NULL,
      rationale TEXT NOT NULL,
      alternatives_considered TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_decisions_session_id ON decisions(session_id)`);

  // Tasks table
  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      parent_task_id TEXT,
      assigned_to TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      description TEXT NOT NULL,
      input_data TEXT,
      output_data TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE SET NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to)`);

  // Messages table
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      thread_id TEXT,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      message_type TEXT NOT NULL,
      priority TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON messages(to_agent)`);

  // Checkpoints table
  db.run(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      workflow_state_json TEXT,
      agent_states_json TEXT,
      message_queue_json TEXT,
      completed_stages_json TEXT,
      pending_stages_json TEXT,
      errors_json TEXT,
      notes TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_checkpoints_session_id ON checkpoints(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_checkpoints_created_at ON checkpoints(created_at)`);

  // Error log table
  db.run(`
    CREATE TABLE IF NOT EXISTS error_log (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      code TEXT NOT NULL,
      category TEXT NOT NULL,
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      details TEXT,
      component TEXT,
      agent_role TEXT,
      recoverable INTEGER NOT NULL DEFAULT 0,
      recovered INTEGER NOT NULL DEFAULT 0,
      recovery_strategy TEXT,
      stack TEXT,
      context_json TEXT,
      created_at TEXT NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_error_log_session_id ON error_log(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_error_log_severity ON error_log(severity)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_error_log_code ON error_log(code)`);

  // Agent activity table
  db.run(`
    CREATE TABLE IF NOT EXISTS agent_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      agent_role TEXT NOT NULL,
      event_type TEXT NOT NULL,
      details_json TEXT,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_agent_activity_session_id ON agent_activity(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_agent_activity_agent_role ON agent_activity(agent_role)`);
}

// =============================================================================
// Row Types (snake_case to match SQLite)
// =============================================================================

export interface SessionRow {
  id: string;
  workflow_type: string;
  goal: string;
  status: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface FindingRow {
  id: string;
  session_id: string;
  agent: string;
  claim: string;
  confidence: string;
  sources: string; // JSON array
  contradicting_evidence: string | null;
  verified_by: string | null;
  verified_at: string | null;
  created_at: string;
}

export interface ArtifactRow {
  id: string;
  session_id: string;
  agent: string;
  artifact_type: string;
  filepath: string;
  content: string | null;
  summary: string | null;
  version: number;
  review_status: string;
  created_at: string;
}

export interface DecisionRow {
  id: string;
  session_id: string;
  agent: string;
  decision: string;
  rationale: string;
  alternatives_considered: string; // JSON array
  created_at: string;
}

export interface TaskRow {
  id: string;
  session_id: string;
  parent_task_id: string | null;
  assigned_to: string;
  status: string;
  priority: string;
  description: string;
  input_data: string | null; // JSON
  output_data: string | null; // JSON
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  session_id: string;
  thread_id: string | null;
  from_agent: string;
  to_agent: string;
  message_type: string;
  priority: string;
  content: string; // JSON
  created_at: string;
}

// =============================================================================
// Input Types
// =============================================================================

export interface CreateSessionInput {
  workflowType: WorkflowType;
  goal: string;
}

export interface CreateFindingInput {
  sessionId: string;
  agent: string;
  claim: string;
  confidence: Confidence;
  sources: string[];
  contradictingEvidence?: string;
}

export interface CreateArtifactInput {
  sessionId: string;
  agent: string;
  artifactType: ArtifactType;
  filepath: string;
  content?: string;
  summary?: string;
}

export interface CreateDecisionInput {
  sessionId: string;
  agent: string;
  decision: string;
  rationale: string;
  alternativesConsidered: Alternative[];
}

export interface CreateTaskInput {
  sessionId: string;
  parentTaskId?: string;
  assignedTo: string;
  priority: Priority;
  description: string;
  inputData?: Record<string, unknown>;
}

export interface CreateMessageInput {
  sessionId: string;
  threadId?: string;
  from: string;
  to: string;
  messageType: MessageType;
  priority: Priority;
  content: MessageContent;
}

// =============================================================================
// SessionStats Interface
// =============================================================================

export interface SessionStats {
  findings: { total: number; verified: number };
  artifacts: { total: number; approved: number; pending: number; rejected: number };
  tasks: { total: number; complete: number; in_progress: number; failed: number };
  messages: number;
  decisions: number;
}

// =============================================================================
// Type Mapping Functions (Row -> Domain types)
// =============================================================================

export function sessionRowToSwarmSession(row: SessionRow): SwarmSession {
  return {
    id: row.id,
    workflowType: row.workflow_type as WorkflowType,
    goal: row.goal,
    status: row.status as SessionStatus,
    agents: new Map(), // Agents are runtime-only, not persisted
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

export function findingRowToFinding(row: FindingRow): Finding {
  return {
    id: row.id,
    sessionId: row.session_id,
    agent: row.agent,
    claim: row.claim,
    confidence: row.confidence as Confidence,
    sources: JSON.parse(row.sources) as string[],
    contradictingEvidence: row.contradicting_evidence ?? undefined,
    verifiedBy: row.verified_by ?? undefined,
    verifiedAt: row.verified_at ?? undefined,
    createdAt: row.created_at,
  };
}

export function artifactRowToArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    sessionId: row.session_id,
    agent: row.agent,
    artifactType: row.artifact_type as ArtifactType,
    filepath: row.filepath,
    content: row.content ?? undefined,
    summary: row.summary ?? undefined,
    version: row.version,
    reviewStatus: row.review_status as ReviewStatus,
    createdAt: row.created_at,
  };
}

export function decisionRowToDecision(row: DecisionRow): Decision {
  return {
    id: row.id,
    sessionId: row.session_id,
    agent: row.agent,
    decision: row.decision,
    rationale: row.rationale,
    alternativesConsidered: JSON.parse(row.alternatives_considered) as Alternative[],
    createdAt: row.created_at,
  };
}

export function taskRowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    sessionId: row.session_id,
    parentTaskId: row.parent_task_id ?? undefined,
    assignedTo: row.assigned_to as Task['assignedTo'],
    status: row.status as TaskStatus,
    priority: row.priority as Priority,
    description: row.description,
    inputData: row.input_data ? (JSON.parse(row.input_data) as Record<string, unknown>) : undefined,
    outputData: row.output_data ? (JSON.parse(row.output_data) as Record<string, unknown>) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function messageRowToAgentMessage(row: MessageRow): AgentMessage {
  const content = JSON.parse(row.content) as MessageContent;
  return {
    id: row.id,
    timestamp: row.created_at,
    from: row.from_agent,
    to: row.to_agent,
    type: row.message_type as MessageType,
    priority: row.priority as Priority,
    content,
    threadId: row.thread_id ?? undefined,
    requiresResponse: false, // Default, not stored in DB
  };
}

// =============================================================================
// Session CRUD Functions
// =============================================================================

export function createSession(input: CreateSessionInput): SwarmSession {
  const db = getDb();
  const id = generateId();
  const timestamp = now();

  db.run(
    `INSERT INTO sessions (id, workflow_type, goal, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.workflowType, input.goal, 'initializing', timestamp, timestamp]
  );

  return {
    id,
    workflowType: input.workflowType,
    goal: input.goal,
    status: 'initializing',
    agents: new Map(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function getSession(id: string): SwarmSession | null {
  const db = getDb();
  const row = db.query<SessionRow, [string]>(
    'SELECT * FROM sessions WHERE id = ?'
  ).get(id);

  return row ? sessionRowToSwarmSession(row) : null;
}

export function updateSessionStatus(id: string, status: SessionStatus): void {
  const db = getDb();
  const timestamp = now();
  const completedAt = status === 'complete' || status === 'failed' ? timestamp : null;

  db.run(
    `UPDATE sessions SET status = ?, updated_at = ?, completed_at = COALESCE(?, completed_at)
     WHERE id = ?`,
    [status, timestamp, completedAt, id]
  );
}

export function listSessions(status?: SessionStatus): SwarmSession[] {
  const db = getDb();
  let rows: SessionRow[];

  if (status) {
    rows = db.query<SessionRow, [string]>(
      'SELECT * FROM sessions WHERE status = ? ORDER BY created_at DESC'
    ).all(status);
  } else {
    rows = db.query<SessionRow, []>(
      'SELECT * FROM sessions ORDER BY created_at DESC'
    ).all();
  }

  return rows.map(sessionRowToSwarmSession);
}

// =============================================================================
// Finding CRUD Functions
// =============================================================================

export function createFinding(input: CreateFindingInput): Finding {
  const db = getDb();
  const id = generateId();
  const timestamp = now();

  db.run(
    `INSERT INTO findings (id, session_id, agent, claim, confidence, sources, contradicting_evidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.sessionId,
      input.agent,
      input.claim,
      input.confidence,
      JSON.stringify(input.sources),
      input.contradictingEvidence ?? null,
      timestamp,
    ]
  );

  return {
    id,
    sessionId: input.sessionId,
    agent: input.agent,
    claim: input.claim,
    confidence: input.confidence,
    sources: input.sources,
    contradictingEvidence: input.contradictingEvidence,
    createdAt: timestamp,
  };
}

export function getFinding(id: string): Finding | null {
  const db = getDb();
  const row = db.query<FindingRow, [string]>(
    'SELECT * FROM findings WHERE id = ?'
  ).get(id);

  return row ? findingRowToFinding(row) : null;
}

export function getSessionFindings(sessionId: string): Finding[] {
  const db = getDb();
  const rows = db.query<FindingRow, [string]>(
    'SELECT * FROM findings WHERE session_id = ? ORDER BY created_at DESC'
  ).all(sessionId);

  return rows.map(findingRowToFinding);
}

export function getUnverifiedFindings(sessionId: string): Finding[] {
  const db = getDb();
  const rows = db.query<FindingRow, [string]>(
    'SELECT * FROM findings WHERE session_id = ? AND verified_by IS NULL ORDER BY created_at ASC'
  ).all(sessionId);

  return rows.map(findingRowToFinding);
}

export function verifyFinding(id: string, verifiedBy: string): void {
  const db = getDb();
  const timestamp = now();

  db.run(
    'UPDATE findings SET verified_by = ?, verified_at = ? WHERE id = ?',
    [verifiedBy, timestamp, id]
  );
}

// =============================================================================
// Artifact CRUD Functions
// =============================================================================

export function createArtifact(input: CreateArtifactInput): Artifact {
  const db = getDb();
  const id = generateId();
  const timestamp = now();

  db.run(
    `INSERT INTO artifacts (id, session_id, agent, artifact_type, filepath, content, summary, version, review_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.sessionId,
      input.agent,
      input.artifactType,
      input.filepath,
      input.content ?? null,
      input.summary ?? null,
      1,
      'pending',
      timestamp,
    ]
  );

  return {
    id,
    sessionId: input.sessionId,
    agent: input.agent,
    artifactType: input.artifactType,
    filepath: input.filepath,
    content: input.content,
    summary: input.summary,
    version: 1,
    reviewStatus: 'pending',
    createdAt: timestamp,
  };
}

export function getArtifact(id: string): Artifact | null {
  const db = getDb();
  const row = db.query<ArtifactRow, [string]>(
    'SELECT * FROM artifacts WHERE id = ?'
  ).get(id);

  return row ? artifactRowToArtifact(row) : null;
}

export function getSessionArtifacts(sessionId: string): Artifact[] {
  const db = getDb();
  const rows = db.query<ArtifactRow, [string]>(
    'SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at DESC'
  ).all(sessionId);

  return rows.map(artifactRowToArtifact);
}

export function getArtifactsByStatus(sessionId: string, status: ReviewStatus): Artifact[] {
  const db = getDb();
  const rows = db.query<ArtifactRow, [string, string]>(
    'SELECT * FROM artifacts WHERE session_id = ? AND review_status = ? ORDER BY created_at DESC'
  ).all(sessionId, status);

  return rows.map(artifactRowToArtifact);
}

export function updateArtifactReviewStatus(id: string, status: ReviewStatus): void {
  const db = getDb();
  db.run('UPDATE artifacts SET review_status = ? WHERE id = ?', [status, id]);
}

export function updateArtifactContent(id: string, content: string, summary?: string): void {
  const db = getDb();

  // Increment version
  db.run(
    `UPDATE artifacts SET content = ?, summary = COALESCE(?, summary), version = version + 1 WHERE id = ?`,
    [content, summary ?? null, id]
  );
}

// =============================================================================
// Decision CRUD Functions
// =============================================================================

export function createDecision(input: CreateDecisionInput): Decision {
  const db = getDb();
  const id = generateId();
  const timestamp = now();

  db.run(
    `INSERT INTO decisions (id, session_id, agent, decision, rationale, alternatives_considered, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.sessionId,
      input.agent,
      input.decision,
      input.rationale,
      JSON.stringify(input.alternativesConsidered),
      timestamp,
    ]
  );

  return {
    id,
    sessionId: input.sessionId,
    agent: input.agent,
    decision: input.decision,
    rationale: input.rationale,
    alternativesConsidered: input.alternativesConsidered,
    createdAt: timestamp,
  };
}

export function getDecision(id: string): Decision | null {
  const db = getDb();
  const row = db.query<DecisionRow, [string]>(
    'SELECT * FROM decisions WHERE id = ?'
  ).get(id);

  return row ? decisionRowToDecision(row) : null;
}

export function getSessionDecisions(sessionId: string): Decision[] {
  const db = getDb();
  const rows = db.query<DecisionRow, [string]>(
    'SELECT * FROM decisions WHERE session_id = ? ORDER BY created_at DESC'
  ).all(sessionId);

  return rows.map(decisionRowToDecision);
}

// =============================================================================
// Task CRUD Functions
// =============================================================================

export function createTask(input: CreateTaskInput): Task {
  const db = getDb();
  const id = generateId();
  const timestamp = now();

  db.run(
    `INSERT INTO tasks (id, session_id, parent_task_id, assigned_to, status, priority, description, input_data, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.sessionId,
      input.parentTaskId ?? null,
      input.assignedTo,
      'created',
      input.priority,
      input.description,
      input.inputData ? JSON.stringify(input.inputData) : null,
      timestamp,
      timestamp,
    ]
  );

  return {
    id,
    sessionId: input.sessionId,
    parentTaskId: input.parentTaskId,
    assignedTo: input.assignedTo as Task['assignedTo'],
    status: 'created',
    priority: input.priority,
    description: input.description,
    inputData: input.inputData,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function getTask(id: string): Task | null {
  const db = getDb();
  const row = db.query<TaskRow, [string]>(
    'SELECT * FROM tasks WHERE id = ?'
  ).get(id);

  return row ? taskRowToTask(row) : null;
}

export function getSessionTasks(sessionId: string): Task[] {
  const db = getDb();
  const rows = db.query<TaskRow, [string]>(
    'SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at DESC'
  ).all(sessionId);

  return rows.map(taskRowToTask);
}

export function getTasksByStatus(sessionId: string, status: TaskStatus): Task[] {
  const db = getDb();
  const rows = db.query<TaskRow, [string, string]>(
    'SELECT * FROM tasks WHERE session_id = ? AND status = ? ORDER BY created_at DESC'
  ).all(sessionId, status);

  return rows.map(taskRowToTask);
}

export function getAgentTasks(sessionId: string, agent: string): Task[] {
  const db = getDb();
  const rows = db.query<TaskRow, [string, string]>(
    'SELECT * FROM tasks WHERE session_id = ? AND assigned_to = ? ORDER BY created_at DESC'
  ).all(sessionId, agent);

  return rows.map(taskRowToTask);
}

export function updateTaskStatus(id: string, status: TaskStatus, outputData?: Record<string, unknown>): void {
  const db = getDb();
  const timestamp = now();

  db.run(
    `UPDATE tasks SET status = ?, output_data = COALESCE(?, output_data), updated_at = ? WHERE id = ?`,
    [status, outputData ? JSON.stringify(outputData) : null, timestamp, id]
  );
}

// =============================================================================
// Message CRUD Functions
// =============================================================================

export function createMessage(input: CreateMessageInput): AgentMessage {
  const db = getDb();
  const id = generateId();
  const timestamp = now();

  db.run(
    `INSERT INTO messages (id, session_id, thread_id, from_agent, to_agent, message_type, priority, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.sessionId,
      input.threadId ?? null,
      input.from,
      input.to,
      input.messageType,
      input.priority,
      JSON.stringify(input.content),
      timestamp,
    ]
  );

  return {
    id,
    timestamp,
    from: input.from,
    to: input.to,
    type: input.messageType,
    priority: input.priority,
    content: input.content,
    threadId: input.threadId,
    requiresResponse: false,
  };
}

export function getSessionMessages(sessionId: string): AgentMessage[] {
  const db = getDb();
  const rows = db.query<MessageRow, [string]>(
    'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC'
  ).all(sessionId);

  return rows.map(messageRowToAgentMessage);
}

export function getThreadMessages(sessionId: string, threadId: string): AgentMessage[] {
  const db = getDb();
  const rows = db.query<MessageRow, [string, string]>(
    'SELECT * FROM messages WHERE session_id = ? AND thread_id = ? ORDER BY created_at ASC'
  ).all(sessionId, threadId);

  return rows.map(messageRowToAgentMessage);
}

export function getAgentMessages(sessionId: string, agent: string): AgentMessage[] {
  const db = getDb();
  const rows = db.query<MessageRow, [string, string, string]>(
    'SELECT * FROM messages WHERE session_id = ? AND (from_agent = ? OR to_agent = ?) ORDER BY created_at ASC'
  ).all(sessionId, agent, agent);

  return rows.map(messageRowToAgentMessage);
}

// =============================================================================
// Utility Functions
// =============================================================================

export function deleteSession(id: string): void {
  const db = getDb();
  // Foreign keys with CASCADE will handle related records
  db.run('DELETE FROM sessions WHERE id = ?', [id]);
}

export function getSessionStats(sessionId: string): SessionStats {
  const db = getDb();

  // Findings stats
  const findingsTotal = db.query<{ count: number }, [string]>(
    'SELECT COUNT(*) as count FROM findings WHERE session_id = ?'
  ).get(sessionId)?.count ?? 0;

  const findingsVerified = db.query<{ count: number }, [string]>(
    'SELECT COUNT(*) as count FROM findings WHERE session_id = ? AND verified_by IS NOT NULL'
  ).get(sessionId)?.count ?? 0;

  // Artifacts stats
  const artifactsTotal = db.query<{ count: number }, [string]>(
    'SELECT COUNT(*) as count FROM artifacts WHERE session_id = ?'
  ).get(sessionId)?.count ?? 0;

  const artifactsApproved = db.query<{ count: number }, [string]>(
    "SELECT COUNT(*) as count FROM artifacts WHERE session_id = ? AND review_status = 'approved'"
  ).get(sessionId)?.count ?? 0;

  const artifactsPending = db.query<{ count: number }, [string]>(
    "SELECT COUNT(*) as count FROM artifacts WHERE session_id = ? AND review_status = 'pending'"
  ).get(sessionId)?.count ?? 0;

  const artifactsRejected = db.query<{ count: number }, [string]>(
    "SELECT COUNT(*) as count FROM artifacts WHERE session_id = ? AND review_status = 'rejected'"
  ).get(sessionId)?.count ?? 0;

  // Tasks stats
  const tasksTotal = db.query<{ count: number }, [string]>(
    'SELECT COUNT(*) as count FROM tasks WHERE session_id = ?'
  ).get(sessionId)?.count ?? 0;

  const tasksComplete = db.query<{ count: number }, [string]>(
    "SELECT COUNT(*) as count FROM tasks WHERE session_id = ? AND status = 'complete'"
  ).get(sessionId)?.count ?? 0;

  const tasksInProgress = db.query<{ count: number }, [string]>(
    "SELECT COUNT(*) as count FROM tasks WHERE session_id = ? AND status = 'in_progress'"
  ).get(sessionId)?.count ?? 0;

  const tasksFailed = db.query<{ count: number }, [string]>(
    "SELECT COUNT(*) as count FROM tasks WHERE session_id = ? AND status = 'failed'"
  ).get(sessionId)?.count ?? 0;

  // Messages count
  const messagesCount = db.query<{ count: number }, [string]>(
    'SELECT COUNT(*) as count FROM messages WHERE session_id = ?'
  ).get(sessionId)?.count ?? 0;

  // Decisions count
  const decisionsCount = db.query<{ count: number }, [string]>(
    'SELECT COUNT(*) as count FROM decisions WHERE session_id = ?'
  ).get(sessionId)?.count ?? 0;

  return {
    findings: { total: findingsTotal, verified: findingsVerified },
    artifacts: {
      total: artifactsTotal,
      approved: artifactsApproved,
      pending: artifactsPending,
      rejected: artifactsRejected,
    },
    tasks: {
      total: tasksTotal,
      complete: tasksComplete,
      in_progress: tasksInProgress,
      failed: tasksFailed,
    },
    messages: messagesCount,
    decisions: decisionsCount,
  };
}
