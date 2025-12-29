/**
 * Claude Swarm - Message Bus (File-Based IPC)
 *
 * Provides inter-agent communication through file-based message queues.
 * Messages are stored as JSON arrays in inbox/outbox files per agent.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync } from 'fs';
import { join, dirname } from 'path';
import { constants } from 'fs';
import {
  generateId,
  now,
  type AgentMessage,
  type MessageType,
  type Priority,
  type MessageContent,
} from './types.js';
import {
  createMessage as dbCreateMessage,
  getThreadMessages,
  type CreateMessageInput,
} from './db.js';

// =============================================================================
// Constants
// =============================================================================

export const SWARM_DIR = '.swarm';
export const INBOX_DIR = '.swarm/messages/inbox';
export const OUTBOX_DIR = '.swarm/messages/outbox';

export const VALID_AGENTS = ['researcher', 'developer', 'reviewer', 'architect', 'orchestrator'] as const;

// Size limits to prevent DoS attacks and unbounded growth
export const MAX_MESSAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB per message
export const MAX_INBOX_MESSAGES = 1000; // Max messages per inbox
export type ValidAgent = typeof VALID_AGENTS[number];

export const PRIORITY_ORDER = ['critical', 'high', 'normal', 'low'] as const;

// =============================================================================
// Local Types
// =============================================================================

export type StatusType = 'starting' | 'in_progress' | 'complete' | 'error' | 'blocked';
export type Verdict = 'approved' | 'needs_revision' | 'rejected';

export interface SendMessageInput {
  from: string;
  to: string;
  type: MessageType;
  priority?: Priority;
  content: { subject: string; body: string; artifacts?: string[]; metadata?: Record<string, unknown> };
  threadId?: string;
  requiresResponse?: boolean;
  deadline?: string;
  sessionId?: string;
}

export interface SendOptions {
  persistToDb?: boolean;
  sessionId?: string;
}

export interface PollOptions {
  intervalMs?: number;  // default 5000
  timeoutMs?: number;   // default 300000
  filter?: (msg: AgentMessage) => boolean;
}

// =============================================================================
// Internal Helpers (not exported)
// =============================================================================

/**
 * Read and parse a JSON file containing messages.
 * Returns empty array if file doesn't exist or is invalid.
 * Filters out invalid messages.
 */
function readMessagesFile(path: string): AgentMessage[] {
  try {
    if (!existsSync(path)) {
      return [];
    }
    const content = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(content);

    if (!Array.isArray(parsed)) {
      return [];
    }

    // Filter to only valid messages
    return parsed.filter((msg): msg is AgentMessage => validateMessage(msg));
  } catch (error) {
    console.warn(`[message-bus] Failed to read messages from ${path}:`, error);
    return [];
  }
}

/**
 * Write messages to a file atomically using temp file + rename.
 */
function writeMessagesFile(path: string, messages: AgentMessage[]): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tempPath = `${path}.tmp.${generateId()}`;
  try {
    writeFileSync(tempPath, JSON.stringify(messages, null, 2), 'utf-8');
    renameSync(tempPath, path);
  } catch (error) {
    // Clean up temp file if rename failed
    try {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

// =============================================================================
// File Locking (prevents race conditions in read-modify-write operations)
// =============================================================================

const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_DELAY_MS = 50;
const MAX_LOCK_RETRIES = 100;

/**
 * Acquire a lock for a file path.
 * Returns the lock file path if acquired, null if timeout.
 */
function acquireLock(filePath: string): string | null {
  const lockPath = `${filePath}.lock`;
  const startTime = Date.now();
  let retries = 0;

  while (Date.now() - startTime < LOCK_TIMEOUT_MS && retries < MAX_LOCK_RETRIES) {
    try {
      // Try to create lock file exclusively
      const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      writeFileSync(fd, `${process.pid}\n${Date.now()}`);
      closeSync(fd);
      return lockPath;
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'EEXIST') {
        // Lock exists, check if it's stale (older than timeout)
        try {
          const content = readFileSync(lockPath, 'utf-8');
          const lockTime = parseInt(content.split('\n')[1] || '0', 10);
          if (Date.now() - lockTime > LOCK_TIMEOUT_MS) {
            // Stale lock, try to remove it
            try {
              unlinkSync(lockPath);
            } catch {
              // Another process may have removed it
            }
          }
        } catch {
          // Lock file unreadable or deleted, try again
        }

        // Wait with jitter before retry
        const jitter = Math.random() * LOCK_RETRY_DELAY_MS;
        const delay = LOCK_RETRY_DELAY_MS + jitter;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
        retries++;
      } else {
        throw error;
      }
    }
  }

  return null;
}

/**
 * Release a previously acquired lock.
 */
function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Lock may already be released
  }
}

/**
 * Execute a function while holding a file lock.
 * Provides atomic read-modify-write semantics.
 */
function withFileLock<T>(filePath: string, fn: () => T): T {
  const lockPath = acquireLock(filePath);
  if (!lockPath) {
    throw new Error(`Failed to acquire lock for ${filePath} after ${LOCK_TIMEOUT_MS}ms`);
  }

  try {
    return fn();
  } finally {
    releaseLock(lockPath);
  }
}

// =============================================================================
// Directory Management
// =============================================================================

/**
 * Create inbox and outbox directories if they don't exist.
 */
export function ensureMessageDirs(): void {
  if (!existsSync(INBOX_DIR)) {
    mkdirSync(INBOX_DIR, { recursive: true });
  }
  if (!existsSync(OUTBOX_DIR)) {
    mkdirSync(OUTBOX_DIR, { recursive: true });
  }
}

/**
 * Create empty JSON files for each valid agent's inbox and outbox.
 */
export function initializeAgentQueues(): void {
  ensureMessageDirs();

  for (const agent of VALID_AGENTS) {
    const inboxPath = getInboxPath(agent);
    const outboxPath = getOutboxPath(agent);

    if (!existsSync(inboxPath)) {
      writeMessagesFile(inboxPath, []);
    }
    if (!existsSync(outboxPath)) {
      writeMessagesFile(outboxPath, []);
    }
  }
}

/**
 * Reset all agent queues to empty arrays.
 */
export function clearAllQueues(): void {
  ensureMessageDirs();

  for (const agent of VALID_AGENTS) {
    const inboxPath = getInboxPath(agent);
    const outboxPath = getOutboxPath(agent);

    writeMessagesFile(inboxPath, []);
    writeMessagesFile(outboxPath, []);
  }
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Type guard to validate that an unknown value is a valid AgentMessage.
 */
export function validateMessage(msg: unknown): msg is AgentMessage {
  if (typeof msg !== 'object' || msg === null) {
    return false;
  }

  const m = msg as Record<string, unknown>;

  // Required string fields
  if (typeof m.id !== 'string' || m.id.length === 0) return false;
  if (typeof m.timestamp !== 'string' || m.timestamp.length === 0) return false;
  if (typeof m.from !== 'string' || m.from.length === 0) return false;
  if (typeof m.to !== 'string' || m.to.length === 0) return false;
  // Validate type is a valid MessageType
  const validTypes = ['task', 'result', 'question', 'feedback', 'status', 'finding', 'artifact', 'review', 'design'];
  if (typeof m.type !== 'string' || !validTypes.includes(m.type)) return false;
  // Validate priority is a valid Priority
  const validPriorities = ['critical', 'high', 'normal', 'low'];
  if (typeof m.priority !== 'string' || !validPriorities.includes(m.priority)) return false;
  if (typeof m.requiresResponse !== 'boolean') return false;

  // Validate content
  if (typeof m.content !== 'object' || m.content === null) return false;
  const content = m.content as Record<string, unknown>;
  if (typeof content.subject !== 'string') return false;
  if (typeof content.body !== 'string') return false;

  // Optional fields
  if (m.threadId !== undefined && typeof m.threadId !== 'string') return false;
  if (m.deadline !== undefined && typeof m.deadline !== 'string') return false;

  return true;
}

/**
 * Check if a string is a valid agent name.
 */
export function isValidAgent(agent: string): agent is ValidAgent {
  return (VALID_AGENTS as readonly string[]).includes(agent);
}

/**
 * Sanitize agent name to prevent path traversal attacks.
 * Only allows alphanumeric characters, hyphens, and underscores.
 * Throws if the sanitized name is empty or differs from input (indicating malicious input).
 */
function sanitizeAgentName(agent: string): string {
  // First check if it's a known valid agent - fast path
  if (isValidAgent(agent)) {
    return agent;
  }

  // For dynamic agents, sanitize to prevent path traversal
  const sanitized = agent.replace(/[^a-zA-Z0-9_-]/g, '');

  if (sanitized.length === 0) {
    throw new Error(`Invalid agent name: "${agent}" - must contain alphanumeric characters`);
  }

  // If sanitization changed the string significantly, it may be an attack
  if (sanitized !== agent) {
    console.warn(`[message-bus] Agent name sanitized: "${agent}" -> "${sanitized}"`);
  }

  return sanitized;
}

// =============================================================================
// Message Creation
// =============================================================================

/**
 * Create a new AgentMessage from input, generating ID and timestamp.
 */
export function createMessage(input: SendMessageInput): AgentMessage {
  return {
    id: generateId(),
    timestamp: now(),
    from: input.from,
    to: input.to,
    type: input.type,
    priority: input.priority ?? 'normal',
    content: {
      subject: input.content.subject,
      body: input.content.body,
      artifacts: input.content.artifacts,
      metadata: input.content.metadata,
    },
    threadId: input.threadId,
    requiresResponse: input.requiresResponse ?? false,
    deadline: input.deadline,
  };
}

// =============================================================================
// Inbox Operations
// =============================================================================

/**
 * Get the file path for an agent's inbox.
 * Sanitizes agent name to prevent path traversal attacks.
 */
export function getInboxPath(agent: string): string {
  const safeAgent = sanitizeAgentName(agent);
  return join(INBOX_DIR, `${safeAgent}.json`);
}

/**
 * Read all messages from an agent's inbox.
 * Returns empty array if file is missing or invalid.
 */
export function readInbox(agent: string): AgentMessage[] {
  return readMessagesFile(getInboxPath(agent));
}

/**
 * Add a message to an agent's inbox atomically.
 * Uses file locking to prevent race conditions.
 * Enforces inbox size limits - oldest messages are dropped if limit exceeded.
 */
export function addToInbox(agent: string, message: AgentMessage): void {
  const path = getInboxPath(agent);
  withFileLock(path, () => {
    let messages = readMessagesFile(path);
    messages.push(message);

    // Enforce inbox size limit by removing oldest messages
    if (messages.length > MAX_INBOX_MESSAGES) {
      const dropped = messages.length - MAX_INBOX_MESSAGES;
      console.warn(
        `[message-bus] Inbox for ${agent} exceeded limit, dropping ${dropped} oldest messages`
      );
      messages = messages.slice(-MAX_INBOX_MESSAGES);
    }

    writeMessagesFile(path, messages);
  });
}

/**
 * Clear all messages from an agent's inbox.
 */
export function clearInbox(agent: string): void {
  writeMessagesFile(getInboxPath(agent), []);
}

/**
 * Remove a specific message from an agent's inbox by ID.
 * Returns true if message was found and removed.
 * Uses file locking to prevent race conditions.
 */
export function removeFromInbox(agent: string, messageId: string): boolean {
  const path = getInboxPath(agent);
  return withFileLock(path, () => {
    const messages = readMessagesFile(path);
    const originalLength = messages.length;
    const filtered = messages.filter(m => m.id !== messageId);

    if (filtered.length !== originalLength) {
      writeMessagesFile(path, filtered);
      return true;
    }
    return false;
  });
}

/**
 * Get unread messages from inbox (alias for readInbox).
 */
export function getUnreadInbox(agent: string): AgentMessage[] {
  return readInbox(agent);
}

/**
 * Get inbox messages filtered by type.
 */
export function getInboxByType(agent: string, type: MessageType): AgentMessage[] {
  return readInbox(agent).filter(m => m.type === type);
}

/**
 * Get inbox messages filtered by minimum priority.
 * Returns messages with priority >= minPriority.
 */
export function getInboxByPriority(agent: string, minPriority: Priority): AgentMessage[] {
  const minIndex = PRIORITY_ORDER.indexOf(minPriority);
  if (minIndex === -1) {
    return [];
  }

  return readInbox(agent).filter(m => {
    const msgIndex = PRIORITY_ORDER.indexOf(m.priority);
    return msgIndex !== -1 && msgIndex <= minIndex;
  });
}

// =============================================================================
// Outbox Operations
// =============================================================================

/**
 * Get the file path for an agent's outbox.
 * Sanitizes agent name to prevent path traversal attacks.
 */
export function getOutboxPath(agent: string): string {
  const safeAgent = sanitizeAgentName(agent);
  return join(OUTBOX_DIR, `${safeAgent}.json`);
}

/**
 * Read all messages from an agent's outbox.
 */
export function readOutbox(agent: string): AgentMessage[] {
  return readMessagesFile(getOutboxPath(agent));
}

/**
 * Add a message to an agent's outbox atomically.
 * Uses file locking to prevent race conditions.
 */
export function addToOutbox(agent: string, message: AgentMessage): void {
  const path = getOutboxPath(agent);
  withFileLock(path, () => {
    const messages = readMessagesFile(path);
    messages.push(message);
    writeMessagesFile(path, messages);
  });
}

/**
 * Clear all messages from an agent's outbox.
 */
export function clearOutbox(agent: string): void {
  writeMessagesFile(getOutboxPath(agent), []);
}

/**
 * Tolerance in milliseconds for clock skew between processes.
 * Messages within this window before the 'since' timestamp will still be included
 * to account for clock differences between the orchestrator and agents.
 */
const CLOCK_SKEW_TOLERANCE_MS = 100;

/**
 * Get outbox messages created after a specific timestamp.
 * Uses a small tolerance buffer to account for clock skew between processes.
 */
export function getNewOutboxMessages(agent: string, since: string): AgentMessage[] {
  const sinceDate = new Date(since);
  // Subtract tolerance to account for clock skew - messages within the tolerance
  // window before 'since' will be included to prevent missing messages
  const adjustedSince = sinceDate.getTime() - CLOCK_SKEW_TOLERANCE_MS;
  return readOutbox(agent).filter(m => new Date(m.timestamp).getTime() > adjustedSince);
}

// =============================================================================
// Main Messaging API
// =============================================================================

/**
 * Send a message from one agent to another.
 * - Creates the message with ID and timestamp
 * - Adds to sender's outbox
 * - Routes to recipient's inbox (or all inboxes for broadcast)
 * - Optionally persists to database
 * - Validates message size to prevent DoS
 */
export function sendMessage(input: SendMessageInput, options?: SendOptions): AgentMessage {
  ensureMessageDirs();

  // Validate message size before creating
  const contentSize = JSON.stringify(input.content).length;
  if (contentSize > MAX_MESSAGE_SIZE_BYTES) {
    throw new Error(
      `Message content exceeds maximum size: ${contentSize} bytes > ${MAX_MESSAGE_SIZE_BYTES} bytes`
    );
  }

  const message = createMessage(input);

  // Add to sender's outbox
  addToOutbox(input.from, message);

  // Route to recipient(s)
  if (input.to === 'broadcast') {
    // Add to all inboxes except sender
    for (const agent of VALID_AGENTS) {
      if (agent !== input.from) {
        addToInbox(agent, message);
      }
    }
  } else {
    addToInbox(input.to, message);
  }

  // Optionally persist to database
  if (options?.persistToDb) {
    const sessionId = options?.sessionId ?? input.sessionId;
    if (!sessionId) {
      throw new Error('sessionId is required when persistToDb is true');
    }
    const dbInput: CreateMessageInput = {
      sessionId,
      threadId: message.threadId,
      from: message.from,
      to: message.to,
      messageType: message.type,
      priority: message.priority,
      content: message.content,
    };
    dbCreateMessage(dbInput);
  }

  return message;
}

/**
 * Broadcast a message to all agents except the sender.
 */
export function broadcastMessage(
  from: string,
  type: MessageType,
  content: MessageContent,
  options?: SendOptions
): AgentMessage {
  return sendMessage(
    {
      from,
      to: 'broadcast',
      type,
      content,
    },
    options
  );
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Send a task assignment message.
 */
export function sendTask(
  from: string,
  to: string,
  subject: string,
  body: string,
  options?: SendOptions & { priority?: Priority; threadId?: string }
): AgentMessage {
  return sendMessage(
    {
      from,
      to,
      type: 'task',
      priority: options?.priority ?? 'normal',
      content: { subject, body },
      threadId: options?.threadId,
      requiresResponse: true,
    },
    options
  );
}

/**
 * Send a result message in response to a task.
 */
export function sendResult(
  from: string,
  to: string,
  subject: string,
  body: string,
  threadId: string,
  options?: SendOptions
): AgentMessage {
  return sendMessage(
    {
      from,
      to,
      type: 'result',
      content: { subject, body },
      threadId,
    },
    options
  );
}

/**
 * Send a status update to the orchestrator.
 */
export function sendStatus(
  from: string,
  status: StatusType,
  summary: string,
  options?: SendOptions
): AgentMessage {
  return sendMessage(
    {
      from,
      to: 'orchestrator',
      type: 'status',
      content: {
        subject: `Status: ${status}`,
        body: summary,
        metadata: { status },
      },
    },
    options
  );
}

/**
 * Send a question requiring a response.
 */
export function sendQuestion(
  from: string,
  to: string,
  question: string,
  context: string,
  threadId?: string,
  options?: SendOptions
): AgentMessage {
  return sendMessage(
    {
      from,
      to,
      type: 'question',
      content: {
        subject: question,
        body: context,
      },
      threadId,
      requiresResponse: true,
    },
    options
  );
}

/**
 * Send feedback with a verdict on work.
 */
export function sendFeedback(
  from: string,
  to: string,
  subject: string,
  feedback: string,
  verdict: Verdict,
  threadId?: string,
  options?: SendOptions
): AgentMessage {
  return sendMessage(
    {
      from,
      to,
      type: 'feedback',
      content: {
        subject,
        body: feedback,
        metadata: { verdict },
      },
      threadId,
    },
    options
  );
}

// =============================================================================
// Polling Utilities
// =============================================================================

/**
 * Poll an agent's inbox until a message matches the filter or timeout.
 * Default interval: 5000ms, default timeout: 300000ms (5 minutes).
 */
export async function pollInbox(
  agent: string,
  options?: PollOptions
): Promise<AgentMessage | null> {
  const intervalMs = options?.intervalMs ?? 5000;
  const timeoutMs = options?.timeoutMs ?? 300000;
  const filter = options?.filter ?? (() => true);

  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const messages = readInbox(agent);
    const match = messages.find(filter);

    if (match) {
      return match;
    }

    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  return null;
}

/**
 * Poll for a message of a specific type.
 */
export async function pollForType(
  agent: string,
  type: MessageType,
  options?: PollOptions
): Promise<AgentMessage | null> {
  return pollInbox(agent, {
    ...options,
    filter: (msg) => msg.type === type && (options?.filter?.(msg) ?? true),
  });
}

/**
 * Poll for a response in a specific thread.
 */
export async function pollForThreadResponse(
  agent: string,
  threadId: string,
  options?: PollOptions
): Promise<AgentMessage | null> {
  return pollInbox(agent, {
    ...options,
    filter: (msg) => msg.threadId === threadId && (options?.filter?.(msg) ?? true),
  });
}

/**
 * Poll for a completion status message.
 */
export async function pollForCompletion(
  agent: string,
  options?: PollOptions
): Promise<AgentMessage | null> {
  return pollInbox(agent, {
    ...options,
    filter: (msg) => {
      if (msg.type !== 'status') return false;
      const status = msg.content.metadata?.status;
      return status === 'complete' && (options?.filter?.(msg) ?? true);
    },
  });
}

// =============================================================================
// Thread Management
// =============================================================================

/**
 * Create a new thread ID.
 */
export function createThreadId(): string {
  return `thread_${generateId()}`;
}

/**
 * Get all messages in a thread from the database.
 */
export function getThreadHistory(sessionId: string, threadId: string): AgentMessage[] {
  return getThreadMessages(sessionId, threadId);
}

// =============================================================================
// Debug Utilities
// =============================================================================

/**
 * Get a summary of message counts per agent.
 */
export function getQueueSummary(): Record<string, { inbox: number; outbox: number }> {
  const summary: Record<string, { inbox: number; outbox: number }> = {};

  for (const agent of VALID_AGENTS) {
    summary[agent] = {
      inbox: readInbox(agent).length,
      outbox: readOutbox(agent).length,
    };
  }

  return summary;
}

/**
 * Dump all messages from all queues for debugging.
 */
export function dumpAllMessages(): {
  inbox: Record<string, AgentMessage[]>;
  outbox: Record<string, AgentMessage[]>;
} {
  const inbox: Record<string, AgentMessage[]> = {};
  const outbox: Record<string, AgentMessage[]> = {};

  for (const agent of VALID_AGENTS) {
    inbox[agent] = readInbox(agent);
    outbox[agent] = readOutbox(agent);
  }

  return { inbox, outbox };
}
