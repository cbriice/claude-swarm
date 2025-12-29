/**
 * Claude Swarm - Message Bus (File-Based IPC)
 *
 * Provides inter-agent communication through file-based message queues.
 * Messages are stored as JSON arrays in inbox/outbox files per agent.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
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
 */
export function getInboxPath(agent: string): string {
  return join(INBOX_DIR, `${agent}.json`);
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
 */
export function addToInbox(agent: string, message: AgentMessage): void {
  const path = getInboxPath(agent);
  const messages = readMessagesFile(path);
  messages.push(message);
  writeMessagesFile(path, messages);
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
 */
export function removeFromInbox(agent: string, messageId: string): boolean {
  const path = getInboxPath(agent);
  const messages = readMessagesFile(path);
  const originalLength = messages.length;
  const filtered = messages.filter(m => m.id !== messageId);

  if (filtered.length !== originalLength) {
    writeMessagesFile(path, filtered);
    return true;
  }
  return false;
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
 */
export function getOutboxPath(agent: string): string {
  return join(OUTBOX_DIR, `${agent}.json`);
}

/**
 * Read all messages from an agent's outbox.
 */
export function readOutbox(agent: string): AgentMessage[] {
  return readMessagesFile(getOutboxPath(agent));
}

/**
 * Add a message to an agent's outbox atomically.
 */
export function addToOutbox(agent: string, message: AgentMessage): void {
  const path = getOutboxPath(agent);
  const messages = readMessagesFile(path);
  messages.push(message);
  writeMessagesFile(path, messages);
}

/**
 * Clear all messages from an agent's outbox.
 */
export function clearOutbox(agent: string): void {
  writeMessagesFile(getOutboxPath(agent), []);
}

/**
 * Get outbox messages created after a specific timestamp.
 */
export function getNewOutboxMessages(agent: string, since: string): AgentMessage[] {
  const sinceDate = new Date(since);
  return readOutbox(agent).filter(m => new Date(m.timestamp) > sinceDate);
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
 */
export function sendMessage(input: SendMessageInput, options?: SendOptions): AgentMessage {
  ensureMessageDirs();

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
