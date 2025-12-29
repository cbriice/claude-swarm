# MCP Integration Research for Claude-Swarm

## Executive Summary

This document provides research findings on integrating Model Context Protocol (MCP) into your claude-swarm multi-agent system. MCP can significantly enhance your current file-based IPC architecture by providing standardized tool discovery, semantic search capabilities, and more efficient inter-agent communication.

---

## 1. MCP SQLite Server

### Official Anthropic SQLite Server

**Yes, there is an official Anthropic MCP server for SQLite.** It's part of the reference implementation servers.

**Package:** `@modelcontextprotocol/server-sqlite`

**Installation with Bun:**
```bash
# Direct usage (no install needed)
bunx @modelcontextprotocol/server-sqlite /path/to/your/memory.db

# Or install globally
bun add -g @modelcontextprotocol/server-sqlite
```

**Configuration for Claude Desktop / MCP Clients:**
```json
{
  "mcpServers": {
    "sqlite": {
      "command": "bunx",
      "args": ["@modelcontextprotocol/server-sqlite", ".swarm/memory.db"]
    }
  }
}
```

**Capabilities:**
- Read and write queries
- Table creation and schema inspection
- Business intelligence queries
- Full SQL execution support

**Note:** The official SQLite server is in the `servers-archived` repo (moved from active development), but still functional. For production use, consider the community-maintained alternatives:

**Alternative - Better Maintained Options:**
```bash
# Python-based with more features
pip install mcp-server-sqlite --break-system-packages
# or
uvx mcp-server-sqlite
```

### Wrapping Your memory.db

Your current SQLite schema for research findings, code artifacts, decision logs, and task status would work directly. Example configuration:

```json
{
  "mcpServers": {
    "swarm-memory": {
      "command": "bunx",
      "args": [
        "@modelcontextprotocol/server-sqlite", 
        ".swarm/memory.db"
      ],
      "env": {
        "SQLITE_READONLY": "false"
      }
    }
  }
}
```

---

## 2. Recommended MCP Servers for Agent Collaboration

### 2.1 Knowledge Base / Semantic Search

| Server | Install | Purpose | Production Ready |
|--------|---------|---------|------------------|
| **Memory** (Official) | `bunx @modelcontextprotocol/server-memory` | Knowledge graph-based persistent memory | ✅ Yes |
| **mcp-rag-local** | `uvx mcp-rag-local` | Local semantic search with ChromaDB + Ollama | ⚠️ Experimental |
| **knowledge-base-mcp** | See GitHub | Hybrid search (dense + sparse + rerank) with Qdrant | ⚠️ Advanced |
| **MCP-Markdown-RAG** | `uv run server.py` | Semantic search for markdown files (Milvus) | ✅ Stable |

**Recommended for Your Use Case:**

```bash
# Official Memory Server (knowledge graph approach)
bunx @modelcontextprotocol/server-memory

# For sharing research findings between agents
# This creates a knowledge graph that persists
```

**Memory Server Configuration:**
```json
{
  "mcpServers": {
    "memory": {
      "command": "bunx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    }
  }
}
```

### 2.2 File System Access

**Official Filesystem Server:**
```bash
bunx @modelcontextprotocol/server-filesystem /path/to/allowed/directory
```

**Configuration (for worktree access):**
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "bunx",
      "args": [
        "-y", 
        "@modelcontextprotocol/server-filesystem",
        ".worktrees",
        ".swarm",
        "src"
      ]
    }
  }
}
```

**Capabilities:**
- Read/write files
- Directory listing
- File search
- Configurable access controls

### 2.3 Web Search / Fetch (For Researcher Agent)

**Official Fetch Server:**
```bash
bunx @modelcontextprotocol/server-fetch
```

**For Web Search (Brave Search):**
```bash
bunx @modelcontextprotocol/server-brave-search
```

**Configuration:**
```json
{
  "mcpServers": {
    "fetch": {
      "command": "bunx",
      "args": ["-y", "@modelcontextprotocol/server-fetch"]
    },
    "brave-search": {
      "command": "bunx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": {
        "BRAVE_API_KEY": "<your-key>"
      }
    }
  }
}
```

### 2.4 Git Operations (For Developer Agent)

**Official Git Server:**
```bash
bunx @modelcontextprotocol/server-git
# or Python version
uvx mcp-server-git
```

**Configuration:**
```json
{
  "mcpServers": {
    "git": {
      "command": "bunx",
      "args": ["-y", "@modelcontextprotocol/server-git", "--repository", "."]
    }
  }
}
```

**Capabilities:**
- Repository operations (clone, checkout, branch)
- Commit history and diffs
- File status tracking
- Search within repositories

### 2.5 GitHub Integration (For Developer Agent)

```json
{
  "mcpServers": {
    "github": {
      "command": "bunx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "<your-token>"
      }
    }
  }
}
```

---

## 3. MCP Tool Definition Best Practices

### Creating Custom Tools for Your Agents

**TypeScript SDK Installation:**
```bash
bun add @modelcontextprotocol/sdk zod
```

**Basic Tool Definition Pattern:**
```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'swarm-orchestrator',
  version: '1.0.0'
});

// Define a tool for agent-to-agent communication
server.registerTool(
  'send_task',
  {
    title: 'Send Task to Agent',
    description: 'Delegates a task to another agent in the swarm',
    inputSchema: {
      targetAgent: z.enum(['researcher', 'developer', 'reviewer', 'architect']),
      taskType: z.enum(['research', 'implement', 'review', 'design']),
      payload: z.string(),
      priority: z.number().optional()
    },
    outputSchema: {
      taskId: z.string(),
      status: z.enum(['queued', 'accepted', 'rejected'])
    }
  },
  async ({ targetAgent, taskType, payload, priority }) => {
    // Write to file-based message queue (your current approach)
    const task = {
      id: `task_${Date.now()}`,
      type: taskType,
      payload,
      priority: priority ?? 1,
      timestamp: new Date().toISOString()
    };
    
    // Integration with your existing file-based IPC
    await Bun.write(
      `.swarm/messages/inbox/${targetAgent}.json`,
      JSON.stringify(task)
    );
    
    return {
      content: [{ type: 'text', text: `Task ${task.id} queued for ${targetAgent}` }],
      structuredContent: { taskId: task.id, status: 'queued' }
    };
  }
);

// Connect via stdio (for Claude Code integration)
const transport = new StdioServerTransport();
await server.connect(transport);
```

### Best Practices

1. **Use Zod for Schema Validation** - Both input and output schemas benefit from runtime validation

2. **Structured Content Returns** - Always return both `content` (for display) and `structuredContent` (for programmatic use):
```typescript
return {
  content: [{ type: 'text', text: 'Human readable result' }],
  structuredContent: { key: 'machine parseable data' }
};
```

3. **Error Handling Within Results** - Report errors in the result object, not as protocol-level errors:
```typescript
try {
  const result = await doWork();
  return { content: [{ type: 'text', text: result }] };
} catch (error) {
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${error.message}` }]
  };
}
```

4. **Tool Annotations** - Add metadata for better discovery:
```typescript
server.registerTool('my_tool', {
  title: 'Human-Readable Title',
  description: 'What this tool does and when to use it',
  inputSchema: { ... },
  // Annotations for UI display
  readOnlyHint: true,       // Tool doesn't modify state
  destructiveHint: false,   // Tool doesn't delete data
  idempotentHint: true,     // Safe to retry
  openWorldHint: false      // Doesn't access external resources
}, handler);
```

### Multi-Agent MCP Setup Example

For your 5-agent swarm, consider this architecture:

```
┌─────────────────────────────────────────────────────────────┐
│                    Orchestrator Process                      │
│  ┌─────────────────────────────────────────────────────────┐│
│  │              MCP Client (connects to all)               ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
           │          │          │          │
           ▼          ▼          ▼          ▼
    ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
    │ Memory   │ │ SQLite   │ │ Git      │ │ Custom   │
    │ Server   │ │ Server   │ │ Server   │ │ Swarm    │
    │          │ │          │ │          │ │ Server   │
    └──────────┘ └──────────┘ └──────────┘ └──────────┘
```

---

## 4. Integration Pattern: MCP + File-Based IPC

### Recommendation: Layer MCP on Top

**Don't replace your file-based IPC immediately.** Instead, layer MCP as an abstraction:

```
┌─────────────────────────────────────────────────────────────┐
│                      MCP Layer                               │
│  - Standardized tool discovery                               │
│  - Semantic search via Memory server                         │
│  - Type-safe tool invocations                                │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              Existing File-Based IPC Layer                   │
│  - .swarm/messages/inbox/*.json                              │
│  - .swarm/messages/outbox/*.json                             │
│  - SQLite persistence (memory.db)                            │
└─────────────────────────────────────────────────────────────┘
```

### Migration Path

**Phase 1: Add MCP for Tool Discovery**
```typescript
// Create an MCP server that wraps your existing functionality
const swarmServer = new McpServer({
  name: 'claude-swarm',
  version: '1.0.0'
});

// Expose existing capabilities as MCP tools
swarmServer.registerTool('query_memory', { ... }, async (args) => {
  // Use your existing SQLite queries
  const db = new Database('.swarm/memory.db');
  return db.query(args.sql);
});

swarmServer.registerTool('send_message', { ... }, async (args) => {
  // Use your existing file-based messaging
  await writeMessage(args.target, args.message);
});
```

**Phase 2: Add Official MCP Servers Alongside**
```json
{
  "mcpServers": {
    "swarm": {
      "command": "bun",
      "args": ["run", "src/mcp-server.ts"]
    },
    "memory": {
      "command": "bunx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    },
    "git": {
      "command": "bunx", 
      "args": ["-y", "@modelcontextprotocol/server-git"]
    }
  }
}
```

**Phase 3: Gradual Feature Migration**
- Move semantic search to MCP Memory server
- Move file operations to MCP Filesystem server
- Keep message routing in your custom implementation (more control)

### Integration with Claude Code

Claude Code natively supports MCP. Your agents (which are Claude Code instances) can use MCP tools directly. Add to each agent's environment:

```bash
# In each tmux pane / worktree
export MCP_SERVER_CONFIG=".swarm/mcp-config.json"
claude --resume  # Claude Code will pick up MCP servers
```

---

## 5. Official MCP Server Registry

### Primary Sources

| Source | URL | Description |
|--------|-----|-------------|
| **Official Registry** | `registry.modelcontextprotocol.io` | Canonical MCP server registry (launched Sept 2025) |
| **GitHub Repo** | `github.com/modelcontextprotocol/servers` | Reference implementations |
| **NPM Packages** | `@modelcontextprotocol/*` | Official packages |
| **PyPI Packages** | `mcp-server-*` | Python implementations |

### Registry API

```bash
# List servers
curl "https://registry.modelcontextprotocol.io/v0/servers?limit=10"

# Search
curl "https://registry.modelcontextprotocol.io/v0/servers?search=sqlite"

# Get specific server
curl "https://registry.modelcontextprotocol.io/v0/servers/{server-id}"
```

### Production-Ready vs Experimental

**Production Ready (Official Anthropic):**
- `@modelcontextprotocol/server-filesystem` ✅
- `@modelcontextprotocol/server-memory` ✅
- `@modelcontextprotocol/server-git` ✅
- `@modelcontextprotocol/server-fetch` ✅
- `@modelcontextprotocol/server-github` ✅
- `@modelcontextprotocol/server-postgres` ✅

**Stable Community:**
- `@modelcontextprotocol/server-brave-search` ✅
- `mcp-server-git` (Python) ✅
- `@modelcontextprotocol/server-slack` ✅

**Experimental:**
- Most RAG/semantic search servers ⚠️
- SQLite server (archived but functional) ⚠️
- Custom A2A bridges ⚠️

### Discovering Servers

```bash
# Using mcp-get (deprecated but still works)
bunx @michaellatman/mcp-get list

# Or browse
# - https://www.pulsemcp.com/servers (community directory)
# - https://github.com/punkpeye/awesome-mcp-servers (curated list)
# - https://smithery.ai (recommended replacement for mcp-get)
```

---

## 6. MCP vs A2A for Multi-Agent Systems

### When to Use Each

| Protocol | Use Case | Your Swarm Application |
|----------|----------|------------------------|
| **MCP** | Tool access, resource fetching, structured data | SQLite queries, file ops, git ops, web search |
| **A2A** | Agent-to-agent coordination, task delegation | Complex multi-step workflows between agents |

### Recommendation for Claude-Swarm

Your current architecture (file-based messaging + SQLite) maps well to MCP's tool model. Consider:

1. **Use MCP for:** Each agent's access to external resources (files, git, search)
2. **Keep file-based IPC for:** Agent-to-agent messaging (simpler, more control)
3. **Consider A2A later for:** If you need agents to negotiate or have multi-turn conversations

### A2A Bridge MCP Server

There's a community A2A-to-MCP bridge if you want to explore:
```bash
# A2A MCP Server - bridges MCP clients to A2A agents
# See: github.com/modelcontextprotocol/servers (community section)
```

---

## 7. Complete Configuration Example

### `.swarm/mcp-config.json`

```json
{
  "mcpServers": {
    "swarm-memory": {
      "command": "bunx",
      "args": ["@modelcontextprotocol/server-sqlite", ".swarm/memory.db"]
    },
    "knowledge": {
      "command": "bunx", 
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    },
    "filesystem": {
      "command": "bunx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        ".",
        ".worktrees",
        ".swarm"
      ]
    },
    "git": {
      "command": "bunx",
      "args": ["-y", "@modelcontextprotocol/server-git", "--repository", "."]
    },
    "fetch": {
      "command": "bunx",
      "args": ["-y", "@modelcontextprotocol/server-fetch"]
    }
  }
}
```

### Installation Commands (Bun-focused)

```bash
# Core SDK for building custom servers
bun add @modelcontextprotocol/sdk zod

# Testing and debugging
bunx @modelcontextprotocol/inspector bun run src/mcp-server.ts

# No need to install servers globally - bunx handles it
# Each server runs on-demand via bunx
```

---

## 8. Quick Start Checklist

- [ ] Create `.swarm/mcp-config.json` with desired servers
- [ ] Test servers individually with MCP Inspector: `bunx @modelcontextprotocol/inspector`
- [ ] Create custom MCP server wrapping your existing SQLite queries
- [ ] Update CLAUDE.md files to reference MCP tools (instead of file polling)
- [ ] Test with single agent before full swarm deployment
- [ ] Consider adding Memory server for semantic search of findings

---

## Appendix: Key Links

- **MCP Specification:** https://modelcontextprotocol.io/specification
- **TypeScript SDK:** https://github.com/modelcontextprotocol/typescript-sdk
- **Official Servers:** https://github.com/modelcontextprotocol/servers
- **Registry:** https://registry.modelcontextprotocol.io
- **A2A Protocol:** https://a2a-protocol.org (for future agent-to-agent needs)
- **MCP Inspector:** `bunx @modelcontextprotocol/inspector`

---

*Research compiled: December 29, 2025*