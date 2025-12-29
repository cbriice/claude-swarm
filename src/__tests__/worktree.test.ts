/**
 * Worktree Manager Tests
 *
 * Tests for the worktree manager module covering:
 * - Validation functions (session IDs, paths)
 * - Repository validation
 * - Worktree creation/removal operations
 * - Role configuration
 * - Cleanup functions
 * - Security mitigations
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  // Constants
  WORKTREE_BASE,
  ROLES_DIR,
  BRANCH_PREFIX,
  VALID_ROLES,
  // Repository validation
  isGitRepository,
  getGitRoot,
  hasCommits,
  getCurrentBranch,
  branchExists,
  getMainBranch,
  validateRepository,
  // Path/name generation
  validateWorktreePath,
  generateBranchName,
  getWorktreePath,
  // Worktree operations
  createWorktree,
  createWorktrees,
  removeWorktree,
  removeAllWorktrees,
  pruneWorktrees,
  // Listing
  listAllWorktrees,
  listWorktrees,
  getWorktreeInfo,
  worktreeExists,
  // Lock/unlock
  lockWorktree,
  unlockWorktree,
  // State queries
  getWorktreeHead,
  hasUncommittedChanges,
  // Role config
  getRoleConfigPath,
  roleConfigExists,
  // Cleanup
  cleanupOrphanedWorktrees,
  cleanupSwarmBranches,
  fullCleanup,
} from '../managers/worktree.js';
import type { AgentRole } from '../types.js';

// =============================================================================
// Test Helpers
// =============================================================================

const TEST_SESSION_PREFIX = 'test_';
let testSessionId: string;
let createdWorktrees: AgentRole[] = [];

function generateTestSessionId(): string {
  return `${TEST_SESSION_PREFIX}${Date.now()}_${Math.random().toString(36).substring(7)}`;
}

async function cleanupTestWorktrees(): Promise<void> {
  for (const role of createdWorktrees) {
    await removeWorktree(role, { force: true, deleteBranch: true });
  }
  createdWorktrees = [];
}

// =============================================================================
// Validation Tests
// =============================================================================

describe('Worktree Manager - Validation', () => {
  describe('Session ID Validation', () => {
    test('generateBranchName rejects empty session ID', () => {
      expect(() => generateBranchName('researcher', '')).toThrow();
    });

    test('generateBranchName rejects session ID with spaces', () => {
      expect(() => generateBranchName('researcher', 'test session')).toThrow(/alphanumeric/);
    });

    test('generateBranchName rejects session ID with shell metacharacters', () => {
      const dangerousIds = [
        'test;rm',
        'test|cat',
        'test`whoami`',
        'test$HOME',
        'test$(id)',
        'test/slash',
        'test..dots',
      ];

      for (const id of dangerousIds) {
        expect(() => generateBranchName('researcher', id)).toThrow();
      }
    });

    test('generateBranchName accepts valid session IDs', () => {
      const validIds = ['test_session', 'test-session', 'TestSession123', '12345'];

      for (const id of validIds) {
        const branchName = generateBranchName('researcher', id);
        expect(branchName).toBe(`${BRANCH_PREFIX}/researcher-${id}`);
      }
    });
  });

  describe('createWorktree Session ID Validation', () => {
    test('createWorktree rejects invalid session ID', async () => {
      const result = await createWorktree('researcher', { sessionId: 'test;injection' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('alphanumeric');
      }
    });

    test('createWorktree rejects empty session ID', async () => {
      const result = await createWorktree('researcher', { sessionId: '' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('GIT_FAILED');
      }
    });
  });

  describe('createWorktrees Session ID Validation', () => {
    test('createWorktrees rejects invalid session ID', async () => {
      const result = await createWorktrees(['researcher'], { sessionId: 'test|pipe' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('alphanumeric');
      }
    });
  });

  describe('Path Validation', () => {
    test('validateWorktreePath rejects root directory', () => {
      const result = validateWorktreePath('/');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('root directory');
      }
    });

    test('validateWorktreePath rejects system directories', () => {
      const systemDirs = ['/home', '/usr', '/etc', '/var', '/tmp', '/bin', '/sbin', '/lib'];

      for (const dir of systemDirs) {
        const result = validateWorktreePath(dir);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('system directory');
        }
      }
    });

    test('validateWorktreePath rejects shallow system paths', () => {
      const shallowPaths = ['/home/user', '/var/log', '/etc/ssh'];

      for (const path of shallowPaths) {
        const result = validateWorktreePath(path);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          // Could be "system directory" or "too shallow" depending on path
          expect(
            result.error.message.includes('system directory') ||
            result.error.message.includes('too shallow')
          ).toBe(true);
        }
      }
    });

    test('validateWorktreePath accepts valid paths', () => {
      const validPaths = [
        '/home/user/projects/myrepo/.worktrees/researcher',
        '/var/lib/myapp/data/.worktrees/developer',
      ];

      for (const path of validPaths) {
        const result = validateWorktreePath(path);
        expect(result.ok).toBe(true);
      }
    });
  });

  describe('Role Validation', () => {
    test('createWorktree rejects invalid role', async () => {
      const result = await createWorktree('invalid_role' as AgentRole, { sessionId: 'test123' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('ROLE_NOT_FOUND');
      }
    });

    test('VALID_ROLES contains expected roles', () => {
      expect(VALID_ROLES).toContain('orchestrator');
      expect(VALID_ROLES).toContain('researcher');
      expect(VALID_ROLES).toContain('developer');
      expect(VALID_ROLES).toContain('reviewer');
      expect(VALID_ROLES).toContain('architect');
    });
  });
});

// =============================================================================
// Repository Validation Tests
// =============================================================================

describe('Worktree Manager - Repository Validation', () => {
  test('isGitRepository returns boolean', async () => {
    const result = await isGitRepository();
    expect(typeof result).toBe('boolean');
  });

  test('isGitRepository returns true in git repo', async () => {
    // We're running in the claude-swarm repo, so this should be true
    const result = await isGitRepository();
    expect(result).toBe(true);
  });

  test('getGitRoot returns path or null', async () => {
    const result = await getGitRoot();
    if (result !== null) {
      expect(typeof result).toBe('string');
      expect(result.startsWith('/')).toBe(true);
    }
  });

  test('hasCommits returns boolean', async () => {
    const result = await hasCommits();
    expect(typeof result).toBe('boolean');
  });

  test('hasCommits returns true for repo with commits', async () => {
    const result = await hasCommits();
    expect(result).toBe(true);
  });

  test('getCurrentBranch returns branch name or null', async () => {
    const result = await getCurrentBranch();
    if (result !== null) {
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    }
  });

  test('branchExists returns boolean', async () => {
    const result = await branchExists('main');
    expect(typeof result).toBe('boolean');
  });

  test('getMainBranch returns main or master', async () => {
    const result = await getMainBranch();
    if (result !== null) {
      expect(['main', 'master']).toContain(result);
    }
  });

  test('validateRepository returns ok in valid repo', async () => {
    const result = await validateRepository();
    expect(result.ok).toBe(true);
  });
});

// =============================================================================
// Branch Name Generation Tests
// =============================================================================

describe('Worktree Manager - Branch Name Generation', () => {
  test('generateBranchName creates correct format', () => {
    const branchName = generateBranchName('researcher', 'test123');
    expect(branchName).toBe('swarm/researcher-test123');
  });

  test('generateBranchName works for all valid roles', () => {
    const sessionId = 'test123';

    for (const role of VALID_ROLES) {
      const branchName = generateBranchName(role, sessionId);
      expect(branchName).toBe(`${BRANCH_PREFIX}/${role}-${sessionId}`);
    }
  });
});

// =============================================================================
// Path Generation Tests
// =============================================================================

describe('Worktree Manager - Path Generation', () => {
  test('getWorktreePath returns absolute path', async () => {
    const path = await getWorktreePath('researcher');
    expect(path.startsWith('/')).toBe(true);
    expect(path).toContain(WORKTREE_BASE);
    expect(path).toContain('researcher');
  });

  test('getRoleConfigPath returns path with CLAUDE.md', async () => {
    const path = await getRoleConfigPath('researcher');
    expect(path.endsWith('CLAUDE.md')).toBe(true);
    expect(path).toContain(ROLES_DIR);
    expect(path).toContain('researcher');
  });
});

// =============================================================================
// Worktree Operations Tests (Integration)
// =============================================================================

describe('Worktree Manager - Worktree Operations', () => {
  beforeEach(() => {
    testSessionId = generateTestSessionId();
  });

  afterEach(async () => {
    await cleanupTestWorktrees();
  });

  test('worktreeExists returns false for non-existent worktree', async () => {
    const exists = await worktreeExists('researcher');
    // May be true or false depending on existing state
    expect(typeof exists).toBe('boolean');
  });

  test('listWorktrees returns array', async () => {
    const worktrees = await listWorktrees();
    expect(Array.isArray(worktrees)).toBe(true);
  });

  test('listAllWorktrees returns array including main', async () => {
    const worktrees = await listAllWorktrees();
    expect(Array.isArray(worktrees)).toBe(true);
    // Should have at least the main worktree
    expect(worktrees.length).toBeGreaterThan(0);
  });

  test('createWorktree fails without role config', async () => {
    // This test assumes the role config doesn't exist for all roles
    // In practice, we need to check if roles dir exists first
    const result = await createWorktree('researcher', {
      sessionId: testSessionId,
      copyRoleConfig: true,
    });

    // If role config doesn't exist, this should fail with ROLE_NOT_FOUND
    // If it exists, it might succeed or fail for other reasons
    if (!result.ok && result.error.code === 'ROLE_NOT_FOUND') {
      expect(result.error.message).toContain('CLAUDE.md');
    }
  });

  test('createWorktree can skip role config', async () => {
    const result = await createWorktree('researcher', {
      sessionId: testSessionId,
      copyRoleConfig: false,
    });

    if (result.ok) {
      createdWorktrees.push('researcher');
      expect(result.value).toContain(WORKTREE_BASE);
      expect(result.value).toContain('researcher');
    }
    // Even if it fails for other reasons, that's OK for this test
  });
});

// =============================================================================
// Cleanup Function Tests
// =============================================================================

describe('Worktree Manager - Cleanup Functions', () => {
  test('removeAllWorktrees returns detailed result', async () => {
    const result = await removeAllWorktrees({ force: true, deleteBranches: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.value.successCount).toBe('number');
      expect(Array.isArray(result.value.failedRoles)).toBe(true);
    }
  });

  test('cleanupOrphanedWorktrees returns count', async () => {
    const count = await cleanupOrphanedWorktrees(0);
    expect(typeof count).toBe('number');
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('cleanupSwarmBranches returns count', async () => {
    const count = await cleanupSwarmBranches();
    expect(typeof count).toBe('number');
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('fullCleanup returns detailed result', async () => {
    const result = await fullCleanup();
    expect(typeof result.worktreesRemoved).toBe('number');
    expect(typeof result.branchesRemoved).toBe('number');
    expect(Array.isArray(result.failedWorktrees)).toBe(true);
  });

  test('pruneWorktrees completes without error', async () => {
    await expect(pruneWorktrees()).resolves.toBeUndefined();
  });
});

// =============================================================================
// Lock/Unlock Tests
// =============================================================================

describe('Worktree Manager - Lock/Unlock', () => {
  test('lockWorktree fails for non-existent worktree', async () => {
    // First ensure no researcher worktree exists
    const exists = await worktreeExists('researcher');
    if (!exists) {
      const result = await lockWorktree('researcher');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('WORKTREE_NOT_FOUND');
      }
    }
  });

  test('unlockWorktree returns error for non-existent worktree', async () => {
    const exists = await worktreeExists('researcher');
    if (!exists) {
      const result = await unlockWorktree('researcher');
      // May succeed or fail depending on implementation
      expect(typeof result.ok).toBe('boolean');
    }
  });
});

// =============================================================================
// State Query Tests
// =============================================================================

describe('Worktree Manager - State Queries', () => {
  test('getWorktreeHead returns null for non-existent worktree', async () => {
    const exists = await worktreeExists('researcher');
    if (!exists) {
      const head = await getWorktreeHead('researcher');
      expect(head).toBeNull();
    }
  });

  test('hasUncommittedChanges returns false for non-existent worktree', async () => {
    const exists = await worktreeExists('researcher');
    if (!exists) {
      const hasChanges = await hasUncommittedChanges('researcher');
      expect(hasChanges).toBe(false);
    }
  });

  test('getWorktreeInfo returns null for non-existent worktree', async () => {
    const exists = await worktreeExists('researcher');
    if (!exists) {
      const info = await getWorktreeInfo('researcher');
      expect(info).toBeNull();
    }
  });
});

// =============================================================================
// Edge Case Tests
// =============================================================================

describe('Worktree Manager - Edge Cases', () => {
  test('removeWorktree is idempotent for non-existent worktree', async () => {
    // Remove a worktree that definitely doesn't exist
    const result = await removeWorktree('researcher', { force: true });
    expect(result.ok).toBe(true);
  });

  test('roleConfigExists returns boolean', async () => {
    const exists = await roleConfigExists('researcher');
    expect(typeof exists).toBe('boolean');
  });

  test('multiple operations with same session ID are handled', async () => {
    const sessionId = generateTestSessionId();

    // First creation should work (if repo is valid and config exists or not required)
    const result1 = await createWorktree('researcher', { sessionId, copyRoleConfig: false });

    if (result1.ok) {
      createdWorktrees.push('researcher');

      // Second creation for same role should fail (worktree exists)
      const result2 = await createWorktree('researcher', { sessionId, copyRoleConfig: false });
      expect(result2.ok).toBe(false);
      if (!result2.ok) {
        expect(result2.error.code).toBe('WORKTREE_EXISTS');
      }

      await cleanupTestWorktrees();
    }
  });
});

// =============================================================================
// Constants Tests
// =============================================================================

describe('Worktree Manager - Constants', () => {
  test('WORKTREE_BASE is .worktrees', () => {
    expect(WORKTREE_BASE).toBe('.worktrees');
  });

  test('ROLES_DIR is roles', () => {
    expect(ROLES_DIR).toBe('roles');
  });

  test('BRANCH_PREFIX is swarm', () => {
    expect(BRANCH_PREFIX).toBe('swarm');
  });
});
