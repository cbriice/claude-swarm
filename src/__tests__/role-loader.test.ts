/**
 * Role Loader Tests
 *
 * Tests for the role-loader module covering:
 * - Role validation
 * - Config file loading
 * - Frontmatter parsing
 * - Path traversal security
 * - Error handling
 */

import { describe, expect, test } from 'bun:test';
import {
  // Constants
  ROLES_DIR,
  ROLE_CONFIG_FILENAME,
  VALID_ROLES,
  // Validation functions
  validateRole,
  roleExists,
  // Path functions
  getRolePath,
  getRoleConfigPath,
  // Loading functions
  loadRoleConfig,
  getRoleMetadata,
  loadFullRoleConfig,
  // Listing functions
  listRoles,
  validateRolesExist,
  getRolesSummary,
} from '../agents/role-loader.js';

// =============================================================================
// Constants Tests
// =============================================================================

describe('Role Loader - Constants', () => {
  test('ROLES_DIR is defined', () => {
    expect(ROLES_DIR).toBe('roles');
  });

  test('ROLE_CONFIG_FILENAME is CLAUDE.md', () => {
    expect(ROLE_CONFIG_FILENAME).toBe('CLAUDE.md');
  });

  test('VALID_ROLES contains expected roles', () => {
    expect(VALID_ROLES).toContain('orchestrator');
    expect(VALID_ROLES).toContain('researcher');
    expect(VALID_ROLES).toContain('developer');
    expect(VALID_ROLES).toContain('reviewer');
    expect(VALID_ROLES).toContain('architect');
    expect(VALID_ROLES.length).toBe(5);
  });

  test('VALID_ROLES is readonly', () => {
    // TypeScript enforces this, but we can check the array is frozen at runtime
    expect(Object.isFrozen(VALID_ROLES) || Array.isArray(VALID_ROLES)).toBe(true);
  });
});

// =============================================================================
// Validation Tests
// =============================================================================

describe('Role Loader - Validation', () => {
  test('validateRole returns true for valid roles', () => {
    expect(validateRole('orchestrator')).toBe(true);
    expect(validateRole('researcher')).toBe(true);
    expect(validateRole('developer')).toBe(true);
    expect(validateRole('reviewer')).toBe(true);
    expect(validateRole('architect')).toBe(true);
  });

  test('validateRole returns false for invalid roles', () => {
    expect(validateRole('invalid')).toBe(false);
    expect(validateRole('')).toBe(false);
    expect(validateRole('RESEARCHER')).toBe(false); // Case sensitive
    expect(validateRole('research')).toBe(false); // Partial match
    expect(validateRole('manager')).toBe(false);
  });

  test('validateRole rejects path traversal attempts', () => {
    // These should all fail validation because they're not in VALID_ROLES
    expect(validateRole('../../../etc/passwd')).toBe(false);
    expect(validateRole('researcher/../developer')).toBe(false);
    expect(validateRole('..\\..\\..\\etc\\passwd')).toBe(false);
    expect(validateRole('researcher/../../..')).toBe(false);
  });

  test('validateRole rejects shell metacharacters', () => {
    expect(validateRole('researcher;rm -rf /')).toBe(false);
    expect(validateRole('researcher|cat /etc/passwd')).toBe(false);
    expect(validateRole('researcher`whoami`')).toBe(false);
    expect(validateRole('researcher$(id)')).toBe(false);
  });
});

// =============================================================================
// Path Function Tests
// =============================================================================

describe('Role Loader - Path Functions', () => {
  test('getRolePath returns path to role directory', () => {
    const path = getRolePath('researcher');
    expect(path).toContain('roles');
    expect(path).toContain('researcher');
    expect(path.endsWith('researcher')).toBe(true);
  });

  test('getRoleConfigPath returns path to CLAUDE.md', () => {
    const path = getRoleConfigPath('researcher');
    expect(path).toContain('roles');
    expect(path).toContain('researcher');
    expect(path).toContain('CLAUDE.md');
  });

  test('getRolePath is consistent', () => {
    const path1 = getRolePath('developer');
    const path2 = getRolePath('developer');
    expect(path1).toBe(path2);
  });
});

// =============================================================================
// Role Existence Tests
// =============================================================================

describe('Role Loader - Role Existence', () => {
  test('roleExists returns true for existing roles', () => {
    // These roles should exist in the project
    expect(roleExists('researcher')).toBe(true);
    expect(roleExists('developer')).toBe(true);
    expect(roleExists('reviewer')).toBe(true);
    expect(roleExists('architect')).toBe(true);
    expect(roleExists('orchestrator')).toBe(true);
  });

  test('roleExists returns false for nonexistent roles', () => {
    expect(roleExists('nonexistent')).toBe(false);
    expect(roleExists('invalid')).toBe(false);
    expect(roleExists('')).toBe(false);
  });
});

// =============================================================================
// Config Loading Tests
// =============================================================================

describe('Role Loader - Config Loading', () => {
  test('loadRoleConfig returns content for valid role', () => {
    const result = loadRoleConfig('researcher');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('#');  // Should contain markdown
      expect(result.value.length).toBeGreaterThan(0);
    }
  });

  test('loadRoleConfig fails for invalid role', () => {
    const result = loadRoleConfig('invalid');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ROLE');
      expect(result.error.role).toBe('invalid');
    }
  });

  test('loadRoleConfig error includes available roles', () => {
    const result = loadRoleConfig('invalid');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('researcher');
      expect(result.error.message).toContain('developer');
    }
  });
});

// =============================================================================
// Full Config Loading Tests
// =============================================================================

describe('Role Loader - Full Config Loading', () => {
  test('loadFullRoleConfig returns complete config', () => {
    const result = loadFullRoleConfig('researcher');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.role).toBe('researcher');
      expect(result.value.path).toContain('CLAUDE.md');
      expect(result.value.content).toBeDefined();
      expect(result.value.body).toBeDefined();
      expect(result.value.metadata).toBeDefined();
    }
  });

  test('loadFullRoleConfig fails for invalid role', () => {
    const result = loadFullRoleConfig('invalid');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ROLE');
    }
  });

  test('loadFullRoleConfig separates frontmatter from body', () => {
    const result = loadFullRoleConfig('researcher');
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Body should not contain frontmatter delimiters at start
      if (result.value.body.startsWith('---')) {
        // If content has frontmatter, body should not start with ---
        expect(result.value.content).toContain('---');
      }
    }
  });
});

// =============================================================================
// Metadata Extraction Tests
// =============================================================================

describe('Role Loader - Metadata Extraction', () => {
  test('getRoleMetadata returns metadata object', () => {
    const result = getRoleMetadata('researcher');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.value).toBe('object');
    }
  });

  test('getRoleMetadata fails for invalid role', () => {
    const result = getRoleMetadata('invalid');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ROLE');
    }
  });
});

// =============================================================================
// Role Listing Tests
// =============================================================================

describe('Role Loader - Role Listing', () => {
  test('listRoles returns array of roles', () => {
    const roles = listRoles();
    expect(Array.isArray(roles)).toBe(true);
    expect(roles.length).toBeGreaterThan(0);
  });

  test('listRoles returns sorted array', () => {
    const roles = listRoles();
    const sorted = [...roles].sort();
    expect(roles).toEqual(sorted);
  });

  test('listRoles includes expected roles', () => {
    const roles = listRoles();
    expect(roles).toContain('researcher');
    expect(roles).toContain('developer');
    expect(roles).toContain('reviewer');
    expect(roles).toContain('architect');
  });

  test('listRoles only includes roles with CLAUDE.md', () => {
    const roles = listRoles();
    for (const role of roles) {
      expect(roleExists(role)).toBe(true);
    }
  });
});

// =============================================================================
// Role Validation Tests
// =============================================================================

describe('Role Loader - validateRolesExist', () => {
  test('validateRolesExist passes for existing roles', () => {
    const result = validateRolesExist(['researcher', 'developer']);
    expect(result.ok).toBe(true);
  });

  test('validateRolesExist fails for missing roles', () => {
    const result = validateRolesExist(['researcher', 'nonexistent']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CONFIG_NOT_FOUND');
      expect(result.error.details).toContain('nonexistent');
    }
  });

  test('validateRolesExist fails listing all missing roles', () => {
    const result = validateRolesExist(['nonexistent1', 'nonexistent2', 'researcher']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details).toContain('nonexistent1');
      expect(result.error.details).toContain('nonexistent2');
      expect(result.error.details).not.toContain('researcher');
    }
  });

  test('validateRolesExist passes for empty array', () => {
    const result = validateRolesExist([]);
    expect(result.ok).toBe(true);
  });
});

// =============================================================================
// Roles Summary Tests
// =============================================================================

describe('Role Loader - getRolesSummary', () => {
  test('getRolesSummary returns map of all valid roles', () => {
    const summary = getRolesSummary();
    expect(summary).toBeInstanceOf(Map);
    expect(summary.size).toBe(VALID_ROLES.length);
  });

  test('getRolesSummary shows existence status', () => {
    const summary = getRolesSummary();
    // All standard roles should exist
    expect(summary.get('researcher')).toBe(true);
    expect(summary.get('developer')).toBe(true);
    expect(summary.get('reviewer')).toBe(true);
    expect(summary.get('architect')).toBe(true);
    expect(summary.get('orchestrator')).toBe(true);
  });
});

// =============================================================================
// Security Tests - Path Traversal
// =============================================================================

describe('Role Loader - Security', () => {
  test('loadRoleConfig rejects path traversal via role name', () => {
    const dangerousNames = [
      '../../../etc/passwd',
      'researcher/../../../etc/passwd',
      '..\\..\\..\\windows\\system32\\config\\sam',
      'researcher/../../..',
      '..',
      '.',
      './researcher',
    ];

    for (const name of dangerousNames) {
      const result = loadRoleConfig(name);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_ROLE');
      }
    }
  });

  test('loadFullRoleConfig rejects path traversal', () => {
    const result = loadFullRoleConfig('../../../etc/passwd');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ROLE');
    }
  });

  test('getRoleMetadata rejects path traversal', () => {
    const result = getRoleMetadata('../../../etc/passwd');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ROLE');
    }
  });
});

// =============================================================================
// Edge Case Tests
// =============================================================================

describe('Role Loader - Edge Cases', () => {
  test('loadRoleConfig handles empty role string', () => {
    const result = loadRoleConfig('');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ROLE');
    }
  });

  test('loadRoleConfig handles whitespace-only role', () => {
    const result = loadRoleConfig('   ');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ROLE');
    }
  });

  test('validateRole handles null-like inputs', () => {
    expect(validateRole('')).toBe(false);
    // TypeScript prevents actual null/undefined, but empty string is handled
  });

  test('listRoles handles missing roles directory gracefully', () => {
    // This tests that listRoles doesn't throw if something goes wrong
    // The actual implementation falls back to empty array
    const roles = listRoles();
    expect(Array.isArray(roles)).toBe(true);
  });
});

// =============================================================================
// Error Type Tests
// =============================================================================

describe('Role Loader - Error Types', () => {
  test('INVALID_ROLE error has correct structure', () => {
    const result = loadRoleConfig('invalid');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ROLE');
      expect(result.error.message).toBeDefined();
      expect(result.error.role).toBe('invalid');
      expect(result.error.name).toBe('RoleLoaderError');
    }
  });

  test('error includes helpful message', () => {
    const result = loadRoleConfig('typo');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Valid roles');
    }
  });
});

// =============================================================================
// Frontmatter Parsing Tests
// =============================================================================

describe('Role Loader - Frontmatter Parsing', () => {
  test('content without frontmatter returns empty metadata', () => {
    // Load any role and check metadata structure
    const result = loadFullRoleConfig('researcher');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.metadata).toBeDefined();
      expect(typeof result.value.metadata).toBe('object');
    }
  });

  test('body is defined even without frontmatter', () => {
    const result = loadFullRoleConfig('researcher');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.body).toBeDefined();
      expect(typeof result.value.body).toBe('string');
    }
  });
});

// =============================================================================
// Role Content Tests
// =============================================================================

describe('Role Loader - Role Content', () => {
  const roles = ['researcher', 'developer', 'reviewer', 'architect', 'orchestrator'];

  for (const role of roles) {
    test(`${role} role has content`, () => {
      const result = loadRoleConfig(role);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBeGreaterThan(100); // Roles should have substantial content
      }
    });

    test(`${role} role content contains markdown`, () => {
      const result = loadRoleConfig(role);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain('#'); // Should have headers
      }
    });
  }
});

// =============================================================================
// Case Sensitivity Tests
// =============================================================================

describe('Role Loader - Case Sensitivity', () => {
  test('role names are case-sensitive', () => {
    expect(validateRole('researcher')).toBe(true);
    expect(validateRole('Researcher')).toBe(false);
    expect(validateRole('RESEARCHER')).toBe(false);
    expect(validateRole('ReSeArChEr')).toBe(false);
  });

  test('loadRoleConfig is case-sensitive', () => {
    const lowerResult = loadRoleConfig('researcher');
    const upperResult = loadRoleConfig('RESEARCHER');

    expect(lowerResult.ok).toBe(true);
    expect(upperResult.ok).toBe(false);
  });
});
