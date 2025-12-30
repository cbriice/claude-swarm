Claude Swarm Architecture Review

  The Core Problem

  Your instinct is correct: the tmux-based architecture for inter-agent communication is fundamentally fragile. Here's why your Claude Code instances sit idle with "nothing happening":

  Root Cause: Passive Agent Model

  Agents wait for explicit "kick" messages from the orchestrator rather than autonomously polling their inboxes.

  Current Flow:
    1. Orchestrator sends task to agent's inbox (file write)
    2. Orchestrator sends tmux "kick" message: "Read your inbox"
    3. Agent processes task, writes to outbox
    4. Agent sits IDLE waiting for next kick
    5. Orchestrator polls outboxes every 5 seconds
    6. Orchestrator sends next kick

  Problem: 5+ seconds latency per step, and if ANY kick is lost, agent hangs forever

  Critical Issues Found in Your Code

  | Issue                       | Location                                                                               | Impact                                |
  |-----------------------------|----------------------------------------------------------------------------------------|---------------------------------------|
  | No autonomous inbox polling | CLAUDE.md instructions say "periodically read inbox" but agents don't actually do this | Agents sit idle between kicks         |
  | 5-second monitor interval   | orchestrator.ts:98                                                                     | Large latency gap                     |
  | Clock skew boundary         | message-bus.ts:531-537 uses > not >=                                                   | Edge-case message loss                |
  | Kick verification missing   | No feedback loop                                                                       | No way to know if agent received kick |
  | 2s prompt wait hardcoded    | orchestrator.ts:1546                                                                   | May not be enough on slow systems     |
  | File lock contention        | message-bus.ts:157-200                                                                 | Silent failures on lock timeout       |

  Why tmux send-keys is Inherently Fragile

  The fundamental problem is that Claude Code CLI was designed for human interaction, not programmatic control:

  1. tmux send-keys sends keystrokes literally - no acknowledgment
  2. If Claude Code's input buffer isn't ready, keystrokes are lost
  3. Prompt detection (> ) is heuristic - can false-positive
  4. No way to verify the message was received and parsed
  5. Race conditions between sending and Claude Code's readiness

  ---
  Alternative Approaches Researched

  1. Direct Anthropic API (No Claude Code CLI)

  Approach: Bypass Claude Code entirely, call the API directly.

  // Each "agent" is just an API client with a system prompt
  const researcher = new Anthropic();
  const response = await researcher.messages.create({
    model: 'claude-sonnet-4-20250514',
    system: "You are a researcher agent...",
    messages: [{ role: "user", content: "Research X" }]
  });

  Pros:
  - Full programmatic control
  - No tmux/terminal dependency
  - Works in containers, serverless, anywhere
  - Instant inter-agent messaging

  Cons:
  - Must implement all tools yourself (no built-in file editing, bash, etc.)
  - Loses Claude Code's sophisticated file operations
  - Higher complexity for tool implementation

  2. Claude Agent SDK (Official Anthropic)

  Repo: github.com/anthropics/anthropic-quickstarts/autonomous-coding

  Approach: File-based state machine with Git progress tracking.

  Key Insight: Even Anthropic's official multi-agent example uses sequential agents with file-based state, not concurrent terminal simulation. They avoid the problem you're facing by design.

  3. PTY (node-pty) Instead of tmux

  Approach: Use pseudo-terminal emulation for better control.

  import * as pty from 'node-pty';
  const shell = pty.spawn('claude', ['--dangerously-skip-permissions'], {
    name: 'xterm-color', cols: 120, rows: 30, cwd: worktreePath
  });
  shell.onData((data) => { /* handle output */ });
  shell.write('Your task here\r');

  Pros:
  - Event-driven output handling (no polling)
  - Better than tmux send-keys for programmatic control
  - Cross-platform

  Cons:
  - Native dependency (compilation required)
  - Still terminal simulation (still fragile)
  - Loses tmux's visual monitoring

  4. MCP Integration (Recommended Enhancement)

  Your MCP-integration-research.md is on the right track. MCP can:
  - Provide standardized tool discovery
  - Enable agents to use same MCP servers (SQLite, filesystem, git)
  - Layer on top of current file-based IPC

  But MCP doesn't solve the core problem - you still need a way to run and coordinate the Claude Code instances.

  ---
  Similar Projects Comparison

  | Project                | Approach                             | Same Problem?                    |
  |------------------------|--------------------------------------|----------------------------------|
  | claude-squad           | tmux + git worktrees                 | Yes, same architecture           |
  | claude_code_agent_farm | tmux orchestration, 20+ agents       | Yes, scales the problem          |
  | Anthropic Agent SDK    | Sequential file-based, no concurrent | No - avoids real-time messaging  |
  | CrewAI                 | Direct API, shared memory            | No - doesn't use Claude Code CLI |
  | AutoGen                | Direct API, agent framework          | No - pure API approach           |
  | LangGraph              | Graph-based orchestration, API       | No - doesn't use Claude Code CLI |

  Key Finding: The projects that work well either:
  1. Use direct API calls (no CLI)
  2. Use sequential file-based state (avoid real-time messaging)
  3. Accept the tmux latency/fragility as a trade-off for visual monitoring

  ---
  The Honest Assessment

  Is This the Best We Can Do Within Constraints?

  Constraint: Must use Claude Code CLI (for its built-in tools)

  Answer: No, there are improvements possible, but fundamental limitations remain.

  What you CAN improve:
  1. Add autonomous inbox polling to CLAUDE.md instructions (agents self-check every 1-2 seconds)
  2. Reduce monitor interval to 1-2 seconds
  3. Add retry logic for kick messages
  4. Implement heartbeat pattern (agents periodically signal "I'm alive")
  5. Switch from tmux to PTY for better event handling

  What you CANNOT fix:
  - Claude Code CLI requires terminal input
  - No way to get acknowledgment that input was received
  - Prompt detection is always heuristic
  - Terminal simulation is inherently racy

  Is There a Better Architecture?

  Yes, but with trade-offs:

  | Architecture                                     | Pros                   | Cons                   | Recommended?               |
  |--------------------------------------------------|------------------------|------------------------|----------------------------|
  | Direct API                                       | Full control, reliable | Lose Claude Code tools | If you can implement tools |
  | Sequential file-based                            | Avoid messaging issues | No parallelism         | For simpler workflows      |
  | Hybrid (API orchestration + Claude Code workers) | Best of both           | Complex                | For this project           |
  | Wait for SDK mode                                | Official solution      | Doesn't exist yet      | Ideal future               |

  ---
  Recommended Path Forward

  Option A: Quick Fixes (Keep Current Architecture)

  1. Add retry logic for kicks (orchestrator.ts:561-569)
    - Retry 3x with exponential backoff
    - Verify receipt by checking for activity
  2. Reduce polling interval to 1-2 seconds
    - Trade-off: more CPU usage
    - Worth it for responsiveness
  3. Add heartbeat pattern
    - Agents write "heartbeat" to outbox every 30 seconds
    - Orchestrator detects dead agents faster
  4. Fix clock skew boundary
    - Change > to >= in message-bus.ts:531-537
  5. Add continuous nudging
    - Every 10 seconds, remind idle agents to check inbox

  Option B: Hybrid Architecture (Recommended)

  Use API for orchestration, Claude Code for work:

  ┌─────────────────────────────────────────────────────────────┐
  │                 Orchestrator (API-based)                     │
  │  - Direct Anthropic API for coordination                     │
  │  - In-memory message passing                                 │
  │  - Real-time state management                                │
  └─────────────────────────────────────────────────────────────┘
                             │
                (assigns tasks via CLI args)
                             │
           ┌─────────────────┼─────────────────┐
           ▼                 ▼                 ▼
      ┌─────────┐       ┌─────────┐       ┌─────────┐
      │Claude   │       │Claude   │       │Claude   │
      │Code     │       │Code     │       │Code     │
      │Worker   │       │Worker   │       │Worker   │
      │         │       │         │       │         │
      │(tmux)   │       │(tmux)   │       │(tmux)   │
      └────┬────┘       └────┬────┘       └────┬────┘
           │                 │                 │
           └────────┬────────┴─────────────────┘
                    │
           (writes results to git)
                    │
                    ▼
             Git Worktrees

  How it works:
  1. Orchestrator uses direct API to decide task assignments
  2. Claude Code instances receive ONE task at startup via -p flag
  3. They complete the task and EXIT (not idle)
  4. Orchestrator spawns next agent for next task
  5. Git commits serve as handoff points

  Pros:
  - Orchestration is reliable (API-based)
  - Claude Code does what it's good at (isolated work)
  - No real-time messaging between agents needed
  - Git provides natural checkpoints

  Option C: Wait for / Advocate for SDK Mode

  The ideal solution would be a headless/SDK mode for Claude Code where:
  - Programmatic input/output (no terminal)
  - Event-based communication
  - Built-in multi-agent coordination

  This doesn't exist yet, but you could:
  1. Open a feature request on github.com/anthropics/claude-code
  2. Build a proof-of-concept of what you need
  3. Contribute to the discussion

  ---
  Summary

  | Question                                | Answer                                                                                                    |
  |-----------------------------------------|-----------------------------------------------------------------------------------------------------------|
  | Why are instances idling?               | Passive kick-based model + 5s polling + unreliable tmux messaging                                         |
  | Is tmux the problem?                    | Partially - terminal simulation is inherently fragile for programmatic use                                |
  | Better approach within constraints?     | Option B: Hybrid architecture with API orchestration                                                      |
  | Better approach if constraints relaxed? | Direct API with custom tools, or wait for SDK mode                                                        |
  | Are there better repos?                 | None that solve this problem elegantly with Claude Code CLI - they either use API or accept the fragility |

  The core insight: Claude Code CLI wasn't designed for multi-agent orchestration. You're fighting the tool's design. The most sustainable path is to use Claude Code for what it's good at (isolated work with its tools) and use the API for coordination.