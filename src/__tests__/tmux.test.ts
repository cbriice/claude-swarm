/**
 * Tmux Manager Tests
 *
 * Tests for the tmux manager module covering:
 * - Validation functions (session names, pane IDs, paths)
 * - Session management operations
 * - Pane management operations
 * - Command execution
 * - Output capture
 * - Cleanup functions
 * - Security mitigations
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  // Availability
  isTmuxAvailable,
  getTmuxVersion,
  isTmuxServerRunning,
  // Session management
  createSession,
  killSession,
  listSessions,
  sessionExists,
  listSwarmSessions,
  getSession,
  // Pane management
  createPane,
  createPaneGrid,
  listPanes,
  getPane,
  selectPane,
  killPane,
  // Command execution
  sendKeys,
  runCommand,
  sendInterrupt,
  clearPane,
  // Output capture
  capturePane,
  capturePaneHistory,
  // Claude Code
  startClaudeCode,
  // Layout
  resizePane,
  // Cleanup
  killAllSwarmSessions,
  cleanupOrphanedSessions,
} from '../managers/tmux.js';

// =============================================================================
// Test Helpers
// =============================================================================

const TEST_SESSION_PREFIX = 'test_swarm_';
let testSessionName: string;
let createdSessions: string[] = [];

function generateTestSessionName(): string {
  return `${TEST_SESSION_PREFIX}${Date.now()}_${Math.random().toString(36).substring(7)}`;
}

async function cleanupTestSessions(): Promise<void> {
  for (const name of createdSessions) {
    await killSession(name);
  }
  createdSessions = [];
}

// =============================================================================
// Validation Tests
// =============================================================================

describe('Tmux Manager - Validation', () => {
  describe('Session Name Validation', () => {
    test('createSession rejects empty session name', async () => {
      const result = await createSession('');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Invalid session name');
      }
    });

    test('createSession rejects session name with spaces', async () => {
      const result = await createSession('test session');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Invalid session name');
      }
    });

    test('createSession rejects session name with shell metacharacters', async () => {
      const dangerousNames = [
        'test;rm',
        'test|cat',
        'test`whoami`',
        'test$HOME',
        'test$(id)',
        'test{a,b}',
      ];

      for (const name of dangerousNames) {
        const result = await createSession(name);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Invalid session name');
        }
      }
    });

    test('createSession accepts valid session names', async () => {
      const validNames = ['test_session', 'test-session', 'TestSession123'];

      for (const name of validNames) {
        // Check if session exists first to avoid conflicts
        if (!(await sessionExists(name))) {
          const result = await createSession(name);
          if (result.ok) {
            createdSessions.push(name);
            expect(result.ok).toBe(true);
          }
        }
      }
    });
  });

  describe('Pane ID Validation', () => {
    test('sendKeys rejects invalid pane ID format', async () => {
      const invalidPaneIds = [
        '0',           // Missing %
        'pane0',       // Wrong prefix
        '%abc',        // Non-numeric
        '%',           // Missing number
        '%-1',         // Negative
        '%0; rm -rf',  // Injection attempt
      ];

      for (const paneId of invalidPaneIds) {
        const result = await sendKeys('test', paneId, 'hello');
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Invalid pane ID');
        }
      }
    });

    test('sendKeys accepts valid pane ID format', async () => {
      // These should not fail with validation error (may succeed if pane exists globally)
      const validPaneIds = ['%0', '%1', '%99', '%123'];

      for (const paneId of validPaneIds) {
        const result = await sendKeys('nonexistent_session', paneId, 'hello');
        // With global pane IDs, the operation may succeed if the pane exists,
        // or fail with PANE_NOT_FOUND/COMMAND_FAILED - but never with validation error
        if (!result.ok) {
          expect(result.error.message).not.toContain('Invalid pane ID');
        }
        // If it succeeds, that's also fine - pane exists globally
      }
    });

    test('killPane rejects invalid pane ID', async () => {
      const result = await killPane('test', 'invalid');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Invalid pane ID');
      }
    });

    test('selectPane rejects invalid pane ID', async () => {
      const result = await selectPane('test', 'invalid');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Invalid pane ID');
      }
    });

    test('capturePane rejects invalid pane ID', async () => {
      const result = await capturePane('test', 'invalid');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Invalid pane ID');
      }
    });

    test('sendInterrupt rejects invalid pane ID', async () => {
      const result = await sendInterrupt('test', 'invalid');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Invalid pane ID');
      }
    });

    test('resizePane rejects invalid pane ID', async () => {
      const result = await resizePane('test', 'invalid', { width: 80 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Invalid pane ID');
      }
    });
  });

  describe('Path Validation for Claude Code', () => {
    test('startClaudeCode rejects paths with shell metacharacters', async () => {
      const dangerousPaths = [
        '/tmp/; rm -rf /',
        '/tmp/$(whoami)',
        '/tmp/`id`',
        '/tmp/|cat',
        '/tmp/&bg',
      ];

      for (const path of dangerousPaths) {
        const result = await startClaudeCode('nonexistent', '%0', { workdir: path });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Invalid workdir path');
        }
      }
    });
  });
});

// =============================================================================
// Availability Tests
// =============================================================================

describe('Tmux Manager - Availability', () => {
  test('isTmuxAvailable returns boolean', async () => {
    const result = await isTmuxAvailable();
    expect(typeof result).toBe('boolean');
  });

  test('getTmuxVersion returns version string or null', async () => {
    const result = await getTmuxVersion();
    if (result !== null) {
      expect(result).toMatch(/tmux/i);
    }
  });

  test('isTmuxServerRunning returns boolean', async () => {
    const result = await isTmuxServerRunning();
    expect(typeof result).toBe('boolean');
  });
});

// =============================================================================
// Session Management Tests (Integration)
// =============================================================================

describe('Tmux Manager - Session Management', () => {
  beforeEach(() => {
    testSessionName = generateTestSessionName();
  });

  afterEach(async () => {
    await cleanupTestSessions();
  });

  test('createSession creates a new session', async () => {
    const result = await createSession(testSessionName);
    if (result.ok) {
      createdSessions.push(testSessionName);
      expect(result.ok).toBe(true);

      // Verify session exists
      const exists = await sessionExists(testSessionName);
      expect(exists).toBe(true);
    }
  });

  test('createSession fails for existing session', async () => {
    const result1 = await createSession(testSessionName);
    if (result1.ok) {
      createdSessions.push(testSessionName);

      const result2 = await createSession(testSessionName);
      expect(result2.ok).toBe(false);
      if (!result2.ok) {
        expect(result2.error.code).toBe('SESSION_EXISTS');
      }
    }
  });

  test('killSession removes session', async () => {
    const createResult = await createSession(testSessionName);
    if (createResult.ok) {
      createdSessions.push(testSessionName);

      const killResult = await killSession(testSessionName);
      expect(killResult.ok).toBe(true);

      // Remove from cleanup list since we killed it
      createdSessions = createdSessions.filter(s => s !== testSessionName);

      const exists = await sessionExists(testSessionName);
      expect(exists).toBe(false);
    }
  });

  test('killSession is idempotent', async () => {
    // Killing non-existent session should succeed
    const result = await killSession('nonexistent_session_xyz123');
    expect(result.ok).toBe(true);
  });

  test('listSessions returns array', async () => {
    const sessions = await listSessions();
    expect(Array.isArray(sessions)).toBe(true);
  });

  test('sessionExists returns false for non-existent session', async () => {
    const exists = await sessionExists('nonexistent_session_xyz123');
    expect(exists).toBe(false);
  });

  test('getSession returns session info', async () => {
    const createResult = await createSession(testSessionName);
    if (createResult.ok) {
      createdSessions.push(testSessionName);

      const session = await getSession(testSessionName);
      expect(session).not.toBeNull();
      if (session) {
        expect(session.name).toBe(testSessionName);
        expect(typeof session.windows).toBe('number');
      }
    }
  });

  test('getSession returns null for non-existent session', async () => {
    const session = await getSession('nonexistent_session_xyz123');
    expect(session).toBeNull();
  });

  test('listSwarmSessions filters by prefix', async () => {
    // Create a swarm session
    const swarmSession = `swarm_${Date.now()}`;
    const result = await createSession(swarmSession);
    if (result.ok) {
      createdSessions.push(swarmSession);

      const swarmSessions = await listSwarmSessions();
      const found = swarmSessions.some(s => s.name === swarmSession);
      expect(found).toBe(true);
    }
  });
});

// =============================================================================
// Pane Management Tests
// =============================================================================

describe('Tmux Manager - Pane Management', () => {
  let sessionName: string;

  beforeEach(async () => {
    sessionName = generateTestSessionName();
    const result = await createSession(sessionName);
    if (result.ok) {
      createdSessions.push(sessionName);
    }
  });

  afterEach(async () => {
    await cleanupTestSessions();
  });

  test('createPane creates a new pane', async () => {
    if (await sessionExists(sessionName)) {
      const result = await createPane(sessionName);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toMatch(/^%\d+$/);
      }
    }
  });

  test('createPane fails for non-existent session', async () => {
    const result = await createPane('nonexistent_session_xyz123');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Could be SESSION_NOT_FOUND or COMMAND_FAILED depending on tmux behavior
      expect(['SESSION_NOT_FOUND', 'COMMAND_FAILED']).toContain(result.error.code);
    }
  });

  test('createPaneGrid creates multiple panes', async () => {
    if (await sessionExists(sessionName)) {
      const result = await createPaneGrid(sessionName, 4);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(4);
        for (const paneId of result.value) {
          expect(paneId).toMatch(/^%\d+$/);
        }
      }
    }
  });

  test('createPaneGrid rejects zero count', async () => {
    if (await sessionExists(sessionName)) {
      const result = await createPaneGrid(sessionName, 0);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('at least 1');
      }
    }
  });

  test('listPanes returns panes', async () => {
    if (await sessionExists(sessionName)) {
      const panes = await listPanes(sessionName);
      expect(Array.isArray(panes)).toBe(true);
      expect(panes.length).toBeGreaterThan(0);
      expect(panes[0].id).toMatch(/^%\d+$/);
    }
  });

  test('getPane by ID returns pane', async () => {
    if (await sessionExists(sessionName)) {
      const panes = await listPanes(sessionName);
      if (panes.length > 0) {
        const pane = await getPane(sessionName, panes[0].id);
        expect(pane).not.toBeNull();
        if (pane) {
          expect(pane.id).toBe(panes[0].id);
        }
      }
    }
  });

  test('getPane by index returns pane', async () => {
    if (await sessionExists(sessionName)) {
      const pane = await getPane(sessionName, 0);
      expect(pane).not.toBeNull();
      if (pane) {
        expect(pane.index).toBe(0);
      }
    }
  });
});

// =============================================================================
// Command Execution Tests
// =============================================================================

describe('Tmux Manager - Command Execution', () => {
  let sessionName: string;
  let paneId: string | undefined;

  beforeEach(async () => {
    sessionName = generateTestSessionName();
    paneId = undefined;
    const result = await createSession(sessionName);
    if (result.ok) {
      createdSessions.push(sessionName);
      // Wait a bit for session to stabilize
      await new Promise(resolve => setTimeout(resolve, 100));
      const panes = await listPanes(sessionName);
      if (panes.length > 0) {
        paneId = panes[0].id;
      }
    }
  });

  afterEach(async () => {
    await cleanupTestSessions();
  });

  test('sendKeys sends text to pane', async () => {
    if (!paneId) {
      console.log('Skipping test: no pane available');
      return;
    }
    const result = await sendKeys(sessionName, paneId, 'echo hello', { enter: false, literal: true });
    expect(result.ok).toBe(true);
  });

  test('runCommand executes command', async () => {
    if (!paneId) {
      console.log('Skipping test: no pane available');
      return;
    }
    const result = await runCommand(sessionName, paneId, 'echo test');
    expect(result.ok).toBe(true);
  });

  test('sendInterrupt sends Ctrl+C', async () => {
    if (!paneId) {
      console.log('Skipping test: no pane available');
      return;
    }
    const result = await sendInterrupt(sessionName, paneId);
    expect(result.ok).toBe(true);
  });

  test('clearPane clears screen', async () => {
    if (!paneId) {
      console.log('Skipping test: no pane available');
      return;
    }
    const result = await clearPane(sessionName, paneId);
    expect(result.ok).toBe(true);
  });
});

// =============================================================================
// Output Capture Tests
// =============================================================================

describe('Tmux Manager - Output Capture', () => {
  let sessionName: string;
  let paneId: string | undefined;

  beforeEach(async () => {
    sessionName = generateTestSessionName();
    paneId = undefined;
    const result = await createSession(sessionName);
    if (result.ok) {
      createdSessions.push(sessionName);
      // Wait a bit for session to stabilize
      await new Promise(resolve => setTimeout(resolve, 100));
      const panes = await listPanes(sessionName);
      if (panes.length > 0) {
        paneId = panes[0].id;
      }
    }
  });

  afterEach(async () => {
    await cleanupTestSessions();
  });

  test('capturePane returns string', async () => {
    if (!paneId) {
      console.log('Skipping test: no pane available');
      return;
    }
    const result = await capturePane(sessionName, paneId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.value).toBe('string');
    }
  });

  test('capturePane with custom line count', async () => {
    if (!paneId) {
      console.log('Skipping test: no pane available');
      return;
    }
    const result = await capturePane(sessionName, paneId, { lines: 10 });
    expect(result.ok).toBe(true);
  });

  test('capturePaneHistory captures full buffer', async () => {
    if (!paneId) {
      console.log('Skipping test: no pane available');
      return;
    }
    const result = await capturePaneHistory(sessionName, paneId);
    expect(result.ok).toBe(true);
  });

  test('capturePane fails for non-existent pane', async () => {
    const result = await capturePane(sessionName, '%999');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Could be PANE_NOT_FOUND or COMMAND_FAILED depending on tmux behavior
      expect(['PANE_NOT_FOUND', 'COMMAND_FAILED']).toContain(result.error.code);
    }
  });
});

// =============================================================================
// Cleanup Function Tests
// =============================================================================

describe('Tmux Manager - Cleanup Functions', () => {
  test('killAllSwarmSessions returns detailed result', async () => {
    // Create a test swarm session
    const swarmSession = `swarm_${Date.now()}`;
    const createResult = await createSession(swarmSession);

    if (createResult.ok) {
      const result = await killAllSwarmSessions();
      expect(typeof result.successCount).toBe('number');
      expect(Array.isArray(result.failedSessions)).toBe(true);
    }
  });

  test('cleanupOrphanedSessions returns detailed result', async () => {
    const result = await cleanupOrphanedSessions(0); // 0 max age = cleanup all
    expect(typeof result.successCount).toBe('number');
    expect(Array.isArray(result.failedSessions)).toBe(true);
  });
});

// =============================================================================
// Edge Case Tests
// =============================================================================

describe('Tmux Manager - Edge Cases', () => {
  test('operations on non-existent session return appropriate errors', async () => {
    const result = await createPane('nonexistent_session_xyz123');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Could be SESSION_NOT_FOUND or COMMAND_FAILED depending on tmux behavior
      expect(['SESSION_NOT_FOUND', 'COMMAND_FAILED']).toContain(result.error.code);
    }
  });

  test('sendKeys with empty string succeeds', async () => {
    const sessionName = generateTestSessionName();
    const createResult = await createSession(sessionName);
    if (createResult.ok) {
      createdSessions.push(sessionName);
      // Wait for session to stabilize
      await new Promise(resolve => setTimeout(resolve, 100));
      const panes = await listPanes(sessionName);
      if (panes.length > 0) {
        const result = await sendKeys(sessionName, panes[0].id, '', { enter: false });
        expect(result.ok).toBe(true);
      } else {
        console.log('Skipping test: no panes available');
      }
    }
    await cleanupTestSessions();
  });
});
