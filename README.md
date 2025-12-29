# Claude Swarm

A lightweight multi-agent orchestration system for Claude Code instances. Enables 3+ Claude agents to collaborate on software engineering tasks with distinct roles, isolated workspaces, and structured communication.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                              CLI                                     │
│                    bun run start <workflow>                          │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         ORCHESTRATOR                                 │
│  - Spawns agents in isolated git worktrees                          │
│  - Routes messages between agents                                    │
│  - Monitors health and handles failures                              │
│  - Synthesizes final outputs                                         │
└─────────────────────────────────────────────────────────────────────┘
           │              │              │              │
           ▼              ▼              ▼              ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  RESEARCHER  │ │  DEVELOPER   │ │   REVIEWER   │ │  ARCHITECT   │
│  (tmux pane) │ │  (tmux pane) │ │  (tmux pane) │ │  (tmux pane) │
│              │ │              │ │              │ │              │
│ .worktrees/  │ │ .worktrees/  │ │ .worktrees/  │ │ .worktrees/  │
│  researcher/ │ │  developer/  │ │   reviewer/  │ │  architect/  │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
           │              │              │              │
           └──────────────┴──────────────┴──────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         SHARED STATE                                 │
│  .swarm/                                                             │
│  ├── memory.db          SQLite: findings, artifacts, decisions       │
│  └── messages/          File-based message bus                       │
│      ├── inbox/         Per-agent incoming messages                  │
│      └── outbox/        Per-agent outgoing messages                  │
└─────────────────────────────────────────────────────────────────────┘
```

## Key Features

- **Isolated Workspaces**: Each agent works in its own git worktree with a dedicated branch
- **Structured Communication**: JSON message bus with typed message formats
- **Persistent Memory**: SQLite database for findings, artifacts, and decisions
- **Role-Based Agents**: Specialized prompts for researcher, developer, reviewer, architect
- **Session Recovery**: Checkpoint system for fault tolerance
- **Zero External Dependencies**: Built on tmux, git, and Bun's native SQLite

## Prerequisites

```bash
# Bun runtime (includes native SQLite)
curl -fsSL https://bun.sh/install | bash

# Claude Code CLI
npm install -g @anthropic-ai/claude-code

# tmux (session management)
# Ubuntu/Debian
sudo apt install tmux
# macOS
brew install tmux

# Git 2.20+ (for worktree support)
git --version
```

## Quick Start

```bash
# Clone and install
git clone <repo-url>
cd claude-swarm
bun install

# Run a workflow
bun run start research "Evaluate OAuth 2.0 vs JWT for API authentication"
bun run start development "Implement user authentication service"
bun run start architecture "Design scalable notification system"
```

## Agent Roles

| Role | Purpose | Outputs |
|------|---------|---------|
| **Researcher** | Find and verify information with citations | Findings with confidence levels |
| **Developer** | Write clean, tested implementations | Code artifacts with tests |
| **Reviewer** | Quality gate for code and research | Verdicts: APPROVED/NEEDS_REVISION/REJECTED |
| **Architect** | Design systems, coordinate implementations | Design documents, task assignments |
| **Orchestrator** | Coordinate agents, route messages | Workflow management |

## Workflow Types

### Research Workflow
```
User Query → Researcher → Reviewer → Synthesis
```
Best for: Fact-finding, technology evaluation, competitive analysis

### Development Workflow
```
Spec → Architect → Developer → Reviewer → Integration
```
Best for: Feature implementation, bug fixes, refactoring

### Autonomous Development
```
Spec → Architect (delegator mode) ←→ Developer ←→ Reviewer (cycles until complete)
```
Best for: Complex multi-step implementations

## Project Structure

```
claude-swarm/
├── src/
│   ├── orchestrator.ts      # Main coordination logic
│   ├── cli.ts               # Command-line interface
│   ├── db.ts                # SQLite database layer
│   ├── message-bus.ts       # Inter-agent messaging
│   └── managers/
│       ├── tmux.ts          # tmux session management
│       └── worktree.ts      # Git worktree management
├── roles/
│   ├── orchestrator/CLAUDE.md
│   ├── researcher/CLAUDE.md
│   ├── developer/CLAUDE.md
│   ├── reviewer/CLAUDE.md
│   └── architect/CLAUDE.md
├── docs/
│   ├── info/ARCHITECTURE.md # Full specification
│   └── plans/               # Implementation plans
└── .swarm/                  # Runtime state (created at runtime)
    ├── memory.db
    └── messages/
```

## Message Protocol

Agents communicate via typed JSON messages:

```json
{
  "id": "unique-uuid",
  "timestamp": "ISO8601",
  "from": "developer",
  "to": "reviewer",
  "type": "artifact",
  "priority": "normal",
  "threadId": "feature-auth-v2",
  "content": {
    "subject": "Implementation: User authentication",
    "body": "Details...",
    "artifacts": ["src/auth.ts"],
    "metadata": { ... }
  }
}
```

**Message Types**: task, result, question, feedback, status, finding, artifact, review, design

## Database Schema

The SQLite database (`memory.db`) stores:

| Table | Purpose |
|-------|---------|
| `sessions` | Workflow runs and configuration |
| `findings` | Research discoveries with confidence levels |
| `artifacts` | Code and documents created by agents |
| `decisions` | Architectural choices and rationale |
| `tasks` | Work assignments and status |
| `messages` | Full message history |
| `checkpoints` | Recovery snapshots |

## Development

```bash
# Type checking
bun run typecheck

# Run tests
bun test

# Watch mode
bun run dev
```

## How Agent Isolation Works

1. **Git Worktrees**: Each agent gets a separate worktree at `.worktrees/{role}/`
2. **Isolated Branches**: Each worktree has its own branch: `swarm/{role}-{sessionId}`
3. **tmux Panes**: Each agent runs in a separate tmux pane
4. **No Direct File Access**: Agents communicate only through the message bus
5. **Atomic Creation**: All worktrees created together or none (rollback on failure)

## Configuration

Role prompts are in `roles/{role}/CLAUDE.md`. Each prompt includes:
- Core responsibilities and communication style
- Message format specifications with examples
- Database query examples for shared memory access
- Error handling patterns
- Workflow continuity with threadId

## Roadmap

- [ ] MCP integration for enhanced tool access
- [ ] Semantic search over findings
- [ ] Web UI for session monitoring
- [ ] Plugin system for custom agent roles

## Inspiration

Built on patterns from:
- [claude-squad](https://github.com/smtg-ai/claude-squad): tmux + git worktrees
- [claude_code_agent_farm](https://github.com/Dicklesworthstone/claude_code_agent_farm): Parallel agent orchestration

## License

MIT
