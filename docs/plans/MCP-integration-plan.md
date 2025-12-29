# MCP Integration Plan for Claude-Swarm

## Overview

Layer MCP on top of existing file-based IPC architecture to provide standardized tool access while preserving the message bus for agent coordination.

## Architecture Decision

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          MCP LAYER                                       │
│  Provides: Tool discovery, SQLite access, git ops, web fetch            │
│  Does NOT replace: File-based message bus (simpler, more control)       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     EXISTING FILE-BASED IPC                              │
│  .swarm/messages/inbox/*.json   .swarm/messages/outbox/*.json           │
│  .swarm/memory.db               Orchestrator polling                    │
└─────────────────────────────────────────────────────────────────────────┘
```

**Rationale:** Keep message routing in file-based system because:
1. Orchestrator needs explicit control over message flow
2. Simpler debugging (messages are plain JSON files)
3. MCP adds overhead for simple pub/sub patterns

## Implementation Phases

### Phase 1: Custom Swarm MCP Server (Priority: HIGH)

**Goal:** Wrap existing functionality as MCP tools that agents can call.

**Create:** `src/mcp/swarm-server.ts`

```typescript
// Tools to expose:
tools: {
  'swarm.query_findings': {
    description: 'Query research findings from memory.db',
    input: { sql: string, params?: array }
  },
  'swarm.query_decisions': {
    description: 'Query architectural decisions from memory.db',
    input: { sql: string }
  },
  'swarm.query_artifacts': {
    description: 'Query code artifacts from memory.db',
    input: { agent?: string, status?: string }
  },
  'swarm.get_task_status': {
    description: 'Get status of tasks in current session',
    input: { session_id: string }
  },
  'swarm.log_finding': {
    description: 'Record a research finding',
    input: { claim: string, confidence: 'high'|'medium'|'low', sources: array }
  },
  'swarm.log_decision': {
    description: 'Record an architectural decision',
    input: { decision: string, rationale: string, alternatives: array }
  }
}
```

**Why First:** Agents currently rely on raw sqlite3 commands in prompts. MCP tools provide:
- Type-safe interface
- Automatic schema validation
- Better error messages
- Discoverable via `tools/list`

**Files to create:**
- `src/mcp/swarm-server.ts` - Main MCP server
- `src/mcp/tools/query-memory.ts` - SQLite query tools
- `src/mcp/tools/log-data.ts` - Data logging tools
- `src/mcp/index.ts` - Entry point

**Configuration:** `.swarm/mcp-config.json`
```json
{
  "mcpServers": {
    "swarm": {
      "command": "bun",
      "args": ["run", "src/mcp/index.ts"]
    }
  }
}
```

### Phase 2: Add Official MCP Servers (Priority: MEDIUM)

**Goal:** Give agents access to production-ready MCP servers.

**Servers to add:**

| Server | Purpose | Agent(s) |
|--------|---------|----------|
| `@modelcontextprotocol/server-filesystem` | Worktree file access | All agents |
| `@modelcontextprotocol/server-git` | Git operations | Developer |
| `@modelcontextprotocol/server-fetch` | Web fetch | Researcher |
| `@modelcontextprotocol/server-memory` | Knowledge graph | All agents |

**Updated config:** `.swarm/mcp-config.json`
```json
{
  "mcpServers": {
    "swarm": {
      "command": "bun",
      "args": ["run", "src/mcp/index.ts"]
    },
    "filesystem": {
      "command": "bunx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", ".", ".worktrees", ".swarm"]
    },
    "git": {
      "command": "bunx",
      "args": ["-y", "@modelcontextprotocol/server-git", "--repository", "."]
    },
    "fetch": {
      "command": "bunx",
      "args": ["-y", "@modelcontextprotocol/server-fetch"]
    },
    "memory": {
      "command": "bunx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    }
  }
}
```

**Why Second:** These servers are production-ready and can replace manual bash commands for file/git/web operations. But our custom server (Phase 1) is more important because it wraps our domain-specific memory.db.

### Phase 3: Role-Specific MCP Configurations (Priority: MEDIUM)

**Goal:** Each agent role gets only the MCP servers it needs.

**Configurations:**

`.swarm/mcp-configs/researcher.json`:
```json
{
  "mcpServers": {
    "swarm": { "command": "bun", "args": ["run", "src/mcp/index.ts"] },
    "fetch": { "command": "bunx", "args": ["-y", "@modelcontextprotocol/server-fetch"] },
    "filesystem": { "command": "bunx", "args": ["-y", "@modelcontextprotocol/server-filesystem", ".worktrees/researcher"] }
  }
}
```

`.swarm/mcp-configs/developer.json`:
```json
{
  "mcpServers": {
    "swarm": { "command": "bun", "args": ["run", "src/mcp/index.ts"] },
    "git": { "command": "bunx", "args": ["-y", "@modelcontextprotocol/server-git", "--repository", ".worktrees/developer"] },
    "filesystem": { "command": "bunx", "args": ["-y", "@modelcontextprotocol/server-filesystem", ".worktrees/developer"] }
  }
}
```

`.swarm/mcp-configs/reviewer.json`:
```json
{
  "mcpServers": {
    "swarm": { "command": "bun", "args": ["run", "src/mcp/index.ts"] },
    "filesystem": { "command": "bunx", "args": ["-y", "@modelcontextprotocol/server-filesystem", ".worktrees/reviewer", ".worktrees/developer"] }
  }
}
```

**Why Third:** Reduces attack surface and prevents agents from accidentally accessing wrong worktrees.

### Phase 4: Update Role Prompts (Priority: HIGH - do with Phase 1)

**Goal:** Replace raw sqlite3 commands with MCP tool references.

**Changes to CLAUDE.md files:**

Before:
```bash
sqlite3 .swarm/memory.db "SELECT claim, sources FROM findings WHERE confidence='high'"
```

After:
```markdown
Use the `swarm.query_findings` MCP tool:
- Tool: swarm.query_findings
- Input: { "sql": "SELECT claim, sources FROM findings WHERE confidence='high'" }
```

Or better - provide semantic tools:
```markdown
Use the `swarm.get_high_confidence_findings` MCP tool to retrieve verified research.
```

### Phase 5: Knowledge Graph Migration (Priority: LOW)

**Goal:** Replace flat SQLite findings with semantic knowledge graph.

**Use:** `@modelcontextprotocol/server-memory` (official Memory server)

**Changes:**
- Research findings stored as knowledge graph entities
- Semantic relationships between findings, decisions, artifacts
- Enables queries like "what findings relate to authentication?"

**Why Last:** Current SQLite approach works. This is an optimization for better semantic search, not a requirement.

---

## Pre-Requisites (Before Any Implementation)

1. [ ] **Test existing codebase** - Verify message bus, SQLite, worktree creation all work
2. [ ] **Verify MCP SDK compatibility with Bun** - Run `bun add @modelcontextprotocol/sdk zod`
3. [ ] **Test official MCP servers standalone** - Verify `bunx @modelcontextprotocol/server-sqlite` works

---

## File Structure After Implementation

```
claude-swarm/
├── src/
│   ├── mcp/
│   │   ├── index.ts           # Entry point: bun run src/mcp/index.ts
│   │   ├── swarm-server.ts    # Custom MCP server
│   │   └── tools/
│   │       ├── query-memory.ts    # SQLite query tools
│   │       ├── log-data.ts        # Finding/decision logging
│   │       └── task-status.ts     # Task management
│   ├── orchestrator.ts        # Unchanged
│   ├── cli.ts                 # Unchanged
│   ├── db.ts                  # Unchanged (MCP server uses this)
│   └── message-bus.ts         # Unchanged
├── .swarm/
│   ├── mcp-config.json        # Shared MCP config
│   ├── mcp-configs/           # Role-specific configs
│   │   ├── researcher.json
│   │   ├── developer.json
│   │   ├── reviewer.json
│   │   └── architect.json
│   ├── memory.db              # Unchanged
│   └── messages/              # Unchanged
└── roles/
    └── */CLAUDE.md            # Updated to use MCP tools
```

---

## Agent Startup Changes

**Current:** Orchestrator spawns Claude Code in tmux pane
**After MCP:** Orchestrator spawns Claude Code with MCP config

```typescript
// src/managers/tmux.ts (modified)
async spawnAgent(role: AgentRole, sessionId: string) {
  const mcpConfig = `.swarm/mcp-configs/${role}.json`;
  const command = `cd .worktrees/${role} && MCP_SERVER_CONFIG=${mcpConfig} claude --resume`;
  // ... spawn in tmux pane
}
```

---

## Testing Strategy

1. **Unit tests for MCP server:**
   - Test each tool in isolation
   - Mock database for query tools
   - Verify input validation

2. **Integration tests:**
   - Start MCP server, connect client, invoke tools
   - Verify results match direct SQLite queries

3. **E2E tests:**
   - Single agent with MCP config
   - Full swarm with role-specific configs

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| MCP SDK not Bun-compatible | Low | High | Test before implementing |
| Performance overhead | Medium | Medium | Benchmark MCP vs direct SQLite |
| Agent confusion (tools vs bash) | Medium | Low | Clear prompt updates |
| MCP server crashes | Low | High | Orchestrator restart logic |

---

## Timeline (Effort, Not Calendar)

| Phase | Effort | Dependencies |
|-------|--------|--------------|
| Phase 1: Custom Swarm Server | 4-6 hours | Bun + SDK compatibility verified |
| Phase 2: Official Servers | 1-2 hours | Phase 1 working |
| Phase 3: Role Configs | 1 hour | Phase 2 working |
| Phase 4: Prompt Updates | 2-3 hours | Phase 1 working |
| Phase 5: Knowledge Graph | 4-6 hours | All above stable |

**Total:** ~12-18 hours of implementation work

---

## Success Criteria

- [ ] Agents can query memory.db via MCP tools (no raw sqlite3)
- [ ] Agents can log findings/decisions via MCP tools
- [ ] Each agent role has isolated MCP access to its worktree
- [ ] Orchestrator can monitor MCP server health
- [ ] Full workflow (research → develop → review) works with MCP
- [ ] Performance: MCP overhead < 100ms per tool call

---

## Next Steps (After Testing Existing Codebase)

1. Verify Bun + MCP SDK compatibility
2. Create minimal `src/mcp/swarm-server.ts` with one tool
3. Test with MCP Inspector: `bunx @modelcontextprotocol/inspector bun run src/mcp/index.ts`
4. Expand tools incrementally
5. Update one role prompt (researcher) as pilot
6. Test full researcher workflow with MCP
7. Roll out to remaining roles
