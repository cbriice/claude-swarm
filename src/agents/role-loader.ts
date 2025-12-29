/**
 * Claude Swarm - Role Loader
 *
 * Provides functions to load and validate agent role configurations.
 * Role configurations are CLAUDE.md files that define agent personas,
 * responsibilities, and communication protocols.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { Result, ok, err, type AgentRole } from '../types.js';

// =============================================================================
// Constants
// =============================================================================

/** Base directory for role configurations relative to project root */
export const ROLES_DIR = 'roles';

/** Expected filename for role configuration */
export const ROLE_CONFIG_FILENAME = 'CLAUDE.md';

/** Valid agent roles that can be loaded */
export const VALID_ROLES: readonly string[] = [
  'orchestrator',
  'researcher',
  'developer',
  'reviewer',
  'architect',
] as const;

/** Type for extended role names (includes orchestrator) */
export type ExtendedRole = AgentRole | 'orchestrator';

// =============================================================================
// Error Types
// =============================================================================

/**
 * Structured error for role loading operations.
 */
export interface RoleLoaderError extends Error {
  code: RoleLoaderErrorCode;
  role?: string;
  details?: string;
}

export type RoleLoaderErrorCode =
  | 'ROLE_NOT_FOUND'      // Role directory doesn't exist
  | 'CONFIG_NOT_FOUND'    // CLAUDE.md file doesn't exist
  | 'READ_ERROR'          // Failed to read file
  | 'INVALID_ROLE'        // Role name is not valid
  | 'PARSE_ERROR';        // Failed to parse frontmatter

/**
 * Create a typed RoleLoaderError.
 */
function createRoleLoaderError(
  code: RoleLoaderErrorCode,
  message: string,
  role?: string,
  details?: string
): RoleLoaderError {
  const error = new Error(message) as RoleLoaderError;
  error.code = code;
  error.role = role;
  error.details = details;
  error.name = 'RoleLoaderError';
  return error;
}

// =============================================================================
// Metadata Types
// =============================================================================

/**
 * Optional frontmatter metadata from a role config.
 * Frontmatter is YAML between --- delimiters at the start of the file.
 */
export interface RoleMetadata {
  /** Role display name */
  name?: string;
  /** Brief description */
  description?: string;
  /** Version of the role config */
  version?: string;
  /** Author of the role config */
  author?: string;
  /** Custom metadata fields */
  [key: string]: unknown;
}

/**
 * Complete role configuration with content and metadata.
 */
export interface RoleConfig {
  /** The role identifier */
  role: string;
  /** Full path to the CLAUDE.md file */
  path: string;
  /** Raw content of the CLAUDE.md file */
  content: string;
  /** Parsed frontmatter metadata (if present) */
  metadata: RoleMetadata;
  /** Content without frontmatter */
  body: string;
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Get the project root directory.
 * Walks up from current working directory to find the roles/ directory.
 */
function getProjectRoot(): string {
  let current = process.cwd();

  // Walk up until we find a directory with roles/
  while (current !== '/') {
    if (existsSync(join(current, ROLES_DIR))) {
      return current;
    }
    current = resolve(current, '..');
  }

  // Fall back to cwd if we can't find roles/
  return process.cwd();
}

/**
 * Parse YAML frontmatter from markdown content.
 * Returns the metadata object and the content without frontmatter.
 */
function parseFrontmatter(content: string): { metadata: RoleMetadata; body: string } {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { metadata: {}, body: content };
  }

  const frontmatterText = match[1];
  const body = content.slice(match[0].length);

  // Simple YAML parsing for key: value pairs
  const metadata: RoleMetadata = {};
  const lines = frontmatterText.split('\n');

  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    let value = line.slice(colonIndex + 1).trim();

    // Remove quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key && value) {
      metadata[key] = value;
    }
  }

  return { metadata, body };
}

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Get the filesystem path for a role's directory.
 *
 * @param role - The role identifier (e.g., 'researcher', 'developer')
 * @returns Absolute path to the role directory
 *
 * @example
 * const path = getRolePath('researcher');
 * // Returns: '/path/to/project/roles/researcher'
 */
export function getRolePath(role: string): string {
  const root = getProjectRoot();
  return join(root, ROLES_DIR, role);
}

/**
 * Get the filesystem path for a role's CLAUDE.md file.
 *
 * @param role - The role identifier
 * @returns Absolute path to the CLAUDE.md file
 */
export function getRoleConfigPath(role: string): string {
  return join(getRolePath(role), ROLE_CONFIG_FILENAME);
}

/**
 * Check if a role name is valid.
 *
 * @param role - The role name to validate
 * @returns true if the role is a known valid role
 *
 * @example
 * validateRole('researcher'); // true
 * validateRole('invalid');    // false
 */
export function validateRole(role: string): boolean {
  return VALID_ROLES.includes(role);
}

/**
 * Check if a role's configuration exists on disk.
 *
 * @param role - The role identifier
 * @returns true if both the role directory and CLAUDE.md exist
 *
 * @example
 * if (roleExists('researcher')) {
 *   const config = loadRoleConfig('researcher');
 * }
 */
export function roleExists(role: string): boolean {
  const rolePath = getRolePath(role);
  const configPath = getRoleConfigPath(role);

  return existsSync(rolePath) && existsSync(configPath);
}

/**
 * List all available roles that have configurations.
 *
 * @returns Array of role names that have CLAUDE.md files
 *
 * @example
 * const roles = listRoles();
 * // Returns: ['researcher', 'developer', 'reviewer', 'architect']
 */
export function listRoles(): string[] {
  const root = getProjectRoot();
  const rolesDir = join(root, ROLES_DIR);

  if (!existsSync(rolesDir)) {
    return [];
  }

  try {
    const entries = readdirSync(rolesDir);
    const roles: string[] = [];

    for (const entry of entries) {
      const entryPath = join(rolesDir, entry);
      const configPath = join(entryPath, ROLE_CONFIG_FILENAME);

      // Only include directories that contain CLAUDE.md
      if (statSync(entryPath).isDirectory() && existsSync(configPath)) {
        roles.push(entry);
      }
    }

    return roles.sort();
  } catch {
    return [];
  }
}

/**
 * Load a role's CLAUDE.md content.
 *
 * @param role - The role identifier to load
 * @returns Result containing the raw file content or an error
 *
 * @example
 * const result = loadRoleConfig('researcher');
 * if (result.ok) {
 *   console.log(result.value); // CLAUDE.md content
 * } else {
 *   console.error(result.error.message);
 * }
 */
export function loadRoleConfig(role: string): Result<string, RoleLoaderError> {
  // Validate role name
  if (!validateRole(role)) {
    return err(
      createRoleLoaderError(
        'INVALID_ROLE',
        `Invalid role: ${role}. Valid roles are: ${VALID_ROLES.join(', ')}`,
        role
      )
    );
  }

  const configPath = getRoleConfigPath(role);

  // Check if file exists
  if (!existsSync(configPath)) {
    return err(
      createRoleLoaderError(
        'CONFIG_NOT_FOUND',
        `Role configuration not found: ${configPath}`,
        role,
        configPath
      )
    );
  }

  // Read file content
  try {
    const content = readFileSync(configPath, 'utf-8');
    return ok(content);
  } catch (error) {
    return err(
      createRoleLoaderError(
        'READ_ERROR',
        `Failed to read role configuration: ${error}`,
        role,
        String(error)
      )
    );
  }
}

/**
 * Extract metadata from a role's CLAUDE.md frontmatter.
 *
 * @param role - The role identifier
 * @returns Result containing parsed metadata or an error
 *
 * @example
 * const result = getRoleMetadata('researcher');
 * if (result.ok) {
 *   console.log(result.value.name);        // 'Research Specialist'
 *   console.log(result.value.description); // 'Thorough researcher...'
 * }
 */
export function getRoleMetadata(role: string): Result<RoleMetadata, RoleLoaderError> {
  const contentResult = loadRoleConfig(role);

  if (!contentResult.ok) {
    return contentResult;
  }

  try {
    const { metadata } = parseFrontmatter(contentResult.value);
    return ok(metadata);
  } catch (error) {
    return err(
      createRoleLoaderError(
        'PARSE_ERROR',
        `Failed to parse role metadata: ${error}`,
        role,
        String(error)
      )
    );
  }
}

/**
 * Load a complete role configuration with parsed metadata.
 *
 * @param role - The role identifier
 * @returns Result containing full role config or an error
 *
 * @example
 * const result = loadFullRoleConfig('developer');
 * if (result.ok) {
 *   const { content, metadata, body } = result.value;
 *   // content: full file including frontmatter
 *   // metadata: parsed frontmatter object
 *   // body: content without frontmatter
 * }
 */
export function loadFullRoleConfig(role: string): Result<RoleConfig, RoleLoaderError> {
  const contentResult = loadRoleConfig(role);

  if (!contentResult.ok) {
    return contentResult;
  }

  const content = contentResult.value;

  try {
    const { metadata, body } = parseFrontmatter(content);

    return ok({
      role,
      path: getRoleConfigPath(role),
      content,
      metadata,
      body,
    });
  } catch (error) {
    return err(
      createRoleLoaderError(
        'PARSE_ERROR',
        `Failed to parse role configuration: ${error}`,
        role,
        String(error)
      )
    );
  }
}

/**
 * Validate that all required roles have configurations.
 *
 * @param roles - Array of role names to validate
 * @returns Result with void on success, or error listing missing roles
 *
 * @example
 * const result = validateRolesExist(['researcher', 'developer']);
 * if (!result.ok) {
 *   console.error('Missing roles:', result.error.details);
 * }
 */
export function validateRolesExist(roles: string[]): Result<void, RoleLoaderError> {
  const missing: string[] = [];

  for (const role of roles) {
    if (!roleExists(role)) {
      missing.push(role);
    }
  }

  if (missing.length > 0) {
    return err(
      createRoleLoaderError(
        'CONFIG_NOT_FOUND',
        `Missing role configurations: ${missing.join(', ')}`,
        undefined,
        missing.join(', ')
      )
    );
  }

  return ok(undefined);
}

/**
 * Get a summary of all available roles and their status.
 *
 * @returns Map of role name to existence status
 */
export function getRolesSummary(): Map<string, boolean> {
  const summary = new Map<string, boolean>();

  for (const role of VALID_ROLES) {
    summary.set(role, roleExists(role));
  }

  return summary;
}
