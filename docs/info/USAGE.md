# Claude Swarm v1 Usage Guide

## Quick Start

```bash
# Prerequisites
bun --version      # Bun runtime required
claude --version   # Claude Code CLI required
tmux -V            # tmux required
git --version      # Git 2.20+ required

# Install
bun install

# Run a workflow
bun swarm.ts start <workflow> "<goal>"
```

## Available Workflows

| Workflow | Agents | Duration | Use Case |
|----------|--------|----------|----------|
| `research` | researcher, reviewer | 20 min | Fact-finding with verification |
| `implement` | architect, developer, reviewer | 1 hour | Feature development with review |
| `review` | reviewer | 15 min | Code analysis only |
| `full` | all 4 agents | 2 hours | Complete research-to-implementation |

Aliases: `development` = `implement`, `architecture` = `full`

## Example Commands

```bash
# Research workflow
bun swarm.ts start research "Compare OAuth 2.0 vs JWT for API auth"

# Development workflow
bun swarm.ts start implement "Add user authentication service"

# Full workflow with all agents
bun swarm.ts start full "Design and implement notification system"

# With options
bun swarm.ts start research "topic" --verbose --timeout 3600000
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `start <workflow> "<goal>"` | Start new workflow session |
| `attach` | Attach to active tmux session |
| `status` | Show current session status |
| `logs <agent>` | Show agent terminal output |
| `messages` | Display inter-agent messages |
| `history` | View session history |
| `kill` | Terminate session |
| `stop` | Graceful stop |
| `clean` | Clean up artifacts |

## Agent Roles

| Role | Purpose | Output |
|------|---------|--------|
| **Researcher** | Finds information, cross-references sources | Findings with confidence levels |
| **Architect** | Designs solutions, creates implementation plans | Design documents, task breakdown |
| **Developer** | Implements code, writes tests | Code artifacts with tests |
| **Reviewer** | Reviews work, issues verdicts | APPROVED / NEEDS_REVISION / REJECTED |

## How It Works

1. **Workflow starts** - Orchestrator creates tmux session and git worktrees
2. **Agents spawn** - Each agent gets isolated workspace in `.worktrees/{role}/`
3. **Messages route** - File-based IPC via `.swarm/messages/inbox/{agent}.json`
4. **Work progresses** - Workflow engine manages step transitions
5. **Results synthesize** - Findings and artifacts collected in `.swarm/memory.db`

## Directory Structure

```
.swarm/
├── memory.db              # SQLite: findings, artifacts, decisions
└── messages/
    ├── inbox/             # Incoming messages per agent
    └── outbox/            # Outgoing messages per agent

.worktrees/
├── researcher/            # Researcher's isolated workspace
├── developer/             # Developer's isolated workspace
├── architect/             # Architect's isolated workspace
└── reviewer/              # Reviewer's isolated workspace

roles/
├── orchestrator/CLAUDE.md # Role definitions
├── researcher/CLAUDE.md
├── developer/CLAUDE.md
├── architect/CLAUDE.md
└── reviewer/CLAUDE.md
```

## Monitoring & Debugging

```bash
# Watch session status
bun swarm.ts status --watch

# Follow agent logs
bun swarm.ts logs developer --follow

# Attach to tmux (see all agents)
bun swarm.ts attach

# Enable verbose logging
SWARM_VERBOSE=true bun swarm.ts start research "topic"

# Check messages manually
cat .swarm/messages/inbox/developer.json | jq
```

## Workflow Flow Examples

### Research Workflow
```
initial_research -> verification -> [deep_dive if needed] -> synthesis
     (researcher)     (reviewer)       (researcher)         (researcher)
```

### Implement Workflow
```
architecture -> design_review -> [revision?] -> implementation -> code_review -> [revision?] -> documentation
 (architect)     (reviewer)      (architect)     (developer)       (reviewer)     (developer)    (developer)
```

## Configuration Options

```bash
# Start command options
-s, --session-id    # Custom session ID
-t, --timeout       # Workflow timeout (ms), default: 1800000
-v, --verbose       # Enable verbose logging
--no-cleanup        # Keep artifacts after completion
-f, --force         # Force start if session exists

# Environment variables
SWARM_VERBOSE=true          # Verbose logging
SWARM_JSON=true             # JSON output
SWARM_DEFAULT_TIMEOUT=ms    # Default timeout
SWARM_LOG_LEVEL=debug       # Log level
```

## Testing v1 Capabilities

1. **Simple research test:**
   ```bash
   bun swarm.ts start research "What are best practices for error handling in TypeScript?"
   bun swarm.ts attach  # Watch agents work
   ```

2. **Implementation test:**
   ```bash
   bun swarm.ts start implement "Add a health check endpoint to the API"
   bun swarm.ts status --watch
   ```

3. **Full workflow test:**
   ```bash
   bun swarm.ts start full "Research and implement a caching layer"
   bun swarm.ts logs architect --follow
   ```

4. **Check results:**
   ```bash
   # View database
   sqlite3 .swarm/memory.db "SELECT * FROM findings;"
   sqlite3 .swarm/memory.db "SELECT * FROM artifacts;"

   # Check worktree changes
   cd .worktrees/developer && git diff
   ```

## Cleanup

```bash
bun swarm.ts kill     # Kill active session
bun swarm.ts clean    # Clean artifacts

# Manual cleanup
rm -rf .swarm/
rm -rf .worktrees/
tmux kill-server      # Kill all tmux sessions
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| tmux not found | Install: `apt install tmux` or `brew install tmux` |
| Claude CLI not found | Install: `npm install -g @anthropic-ai/claude-code` |
| Session exists | Use `--force` or run `bun swarm.ts kill` first |
| Agent timeout | Increase with `--timeout` or check agent logs |
| Git errors | Ensure repo has commits: `git log --oneline` |
