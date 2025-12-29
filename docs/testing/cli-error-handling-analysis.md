# CLI and Error Handling Test Case Analysis

## Overview

This document provides a comprehensive analysis of test cases for the CLI interface (`src/swarm.ts`) and error handling module (`src/error-handling.ts`) of claude-swarm. The analysis covers base cases, edge cases, potentially suboptimal behaviors, user experience issues, and security concerns.

---

## Module 1: CLI Interface (`src/swarm.ts`)

### 1.1 Base Cases (Happy Path)

#### Command: `start`
| Test Case | Input | Expected Behavior | Exit Code |
|-----------|-------|-------------------|-----------|
| TC-CLI-001 | `start research "quantum computing"` | Spawns orchestrator, starts research workflow | 0 |
| TC-CLI-002 | `start implement "rate limiter" --verbose` | Starts implementation with verbose logging | 0 |
| TC-CLI-003 | `start development "new feature" -t 3600000` | Starts with custom 1-hour timeout | 0 |
| TC-CLI-004 | `start review "code analysis"` | Starts review workflow | 0 |
| TC-CLI-005 | `start full "distributed queue"` | Starts full development workflow | 0 |
| TC-CLI-006 | `start architecture "microservices design"` | Starts architecture workflow | 0 |
| TC-CLI-007 | `start research "test" --session-id my-session` | Uses custom session ID | 0 |
| TC-CLI-008 | `start research "test" --no-cleanup` | Keeps artifacts after completion | 0 |
| TC-CLI-009 | `start research "test" --force` | Forces start even if session exists | 0 |

#### Command: `attach`
| Test Case | Input | Expected Behavior | Exit Code |
|-----------|-------|-------------------|-----------|
| TC-CLI-010 | `attach` (single session) | Attaches to active tmux session | 0 |
| TC-CLI-011 | `attach -s swarm_12345` | Attaches to specific session | 0 |

#### Command: `status`
| Test Case | Input | Expected Behavior | Exit Code |
|-----------|-------|-------------------|-----------|
| TC-CLI-012 | `status` | Displays current session status | 0 |
| TC-CLI-013 | `status --json` | Outputs JSON format | 0 |
| TC-CLI-014 | `status --watch` | Continuous status updates | 0 |

#### Command: `logs`
| Test Case | Input | Expected Behavior | Exit Code |
|-----------|-------|-------------------|-----------|
| TC-CLI-015 | `logs researcher` | Shows researcher agent output | 0 |
| TC-CLI-016 | `logs developer -n 50` | Shows last 50 lines | 0 |
| TC-CLI-017 | `logs reviewer --follow` | Continuous log output | 0 |

#### Command: `messages`
| Test Case | Input | Expected Behavior | Exit Code |
|-----------|-------|-------------------|-----------|
| TC-CLI-018 | `messages` | Shows all agent message queues | 0 |
| TC-CLI-019 | `messages researcher` | Shows specific agent messages | 0 |
| TC-CLI-020 | `messages --count` | Shows message counts only | 0 |
| TC-CLI-021 | `messages --inbox` | Shows inbox only | 0 |
| TC-CLI-022 | `messages --outbox` | Shows outbox only | 0 |

#### Command: `stop`
| Test Case | Input | Expected Behavior | Exit Code |
|-----------|-------|-------------------|-----------|
| TC-CLI-023 | `stop` | Gracefully stops session | 0 |
| TC-CLI-024 | `stop --no-save` | Stops without saving state | 0 |
| TC-CLI-025 | `stop -t 5000` | Uses 5s shutdown timeout | 0 |

#### Command: `kill`
| Test Case | Input | Expected Behavior | Exit Code |
|-----------|-------|-------------------|-----------|
| TC-CLI-026 | `kill` | Force terminates current session | 0 |
| TC-CLI-027 | `kill --all` | Terminates all swarm sessions | 0 |

#### Command: `clean`
| Test Case | Input | Expected Behavior | Exit Code |
|-----------|-------|-------------------|-----------|
| TC-CLI-028 | `clean` | Cleans all artifacts | 0 |
| TC-CLI-029 | `clean --worktrees` | Cleans worktrees only | 0 |
| TC-CLI-030 | `clean --messages` | Cleans messages only | 0 |
| TC-CLI-031 | `clean --sessions` | Cleans session state only | 0 |

#### Command: `history`
| Test Case | Input | Expected Behavior | Exit Code |
|-----------|-------|-------------------|-----------|
| TC-CLI-032 | `history` | Shows last 10 sessions | 0 |
| TC-CLI-033 | `history -n 20` | Shows last 20 sessions | 0 |
| TC-CLI-034 | `history --json` | JSON output format | 0 |

#### Command: `help`
| Test Case | Input | Expected Behavior | Exit Code |
|-----------|-------|-------------------|-----------|
| TC-CLI-035 | `help` | Shows general help | 0 |
| TC-CLI-036 | `help start` | Shows start command help | 0 |
| TC-CLI-037 | `-h` | Shows general help (short form) | 0 |
| TC-CLI-038 | `--help` | Shows general help (long form) | 0 |
| TC-CLI-039 | `-v` / `--version` | Shows version | 0 |

---

### 1.2 Edge Cases

#### Invalid Command Names
| Test Case | Input | Expected Behavior | Severity | Exit Code |
|-----------|-------|-------------------|----------|-----------|
| TC-CLI-E001 | `statr research "test"` | Error: Unknown command with suggestion | Medium | 2 |
| TC-CLI-E002 | `START research "test"` | Error: Unknown command (case-sensitive) | Medium | 2 |
| TC-CLI-E003 | `""` (empty string) | Error: No command specified | Medium | 2 |
| TC-CLI-E004 | `123` | Error: Unknown command | Low | 2 |
| TC-CLI-E005 | `--start` | Treated as option, not command | Medium | 2 |

#### Missing Required Arguments
| Test Case | Input | Expected Behavior | Severity | Exit Code |
|-----------|-------|-------------------|----------|-----------|
| TC-CLI-E006 | `start` | Error: Missing workflow argument | High | 2 |
| TC-CLI-E007 | `start research` | Error: Missing goal argument | High | 2 |
| TC-CLI-E008 | `logs` | Error: Missing agent argument | Medium | 2 |

#### Invalid Argument Values
| Test Case | Input | Expected Behavior | Severity | Exit Code |
|-----------|-------|-------------------|----------|-----------|
| TC-CLI-E009 | `start invalid "test"` | Error: Invalid workflow type | High | 2 |
| TC-CLI-E010 | `start research ""` | Error: Goal cannot be empty | High | 2 |
| TC-CLI-E011 | `logs invalid-agent` | Error: Agent not found | Medium | 1 |
| TC-CLI-E012 | `start research "test" -t abc` | Error: Invalid timeout value | Medium | 2 |
| TC-CLI-E013 | `start research "test" -t -1` | Negative timeout parsed as number | Low | - |
| TC-CLI-E014 | `history -n 0` | Zero limit - may show nothing | Low | 0 |
| TC-CLI-E015 | `history -n -5` | Negative limit - undefined behavior | Medium | - |

#### Signal Handling (Ctrl+C, SIGTERM)
| Test Case | Scenario | Expected Behavior | Severity |
|-----------|----------|-------------------|----------|
| TC-CLI-E016 | Single Ctrl+C during workflow | Graceful shutdown with message | High |
| TC-CLI-E017 | Double Ctrl+C | Force exit with code 130 | High |
| TC-CLI-E018 | SIGTERM signal | Graceful shutdown | High |
| TC-CLI-E019 | Ctrl+C during attach | Returns to CLI | Medium |
| TC-CLI-E020 | Ctrl+C during `--watch` mode | Stops watch, returns to CLI | Medium |

#### Running Without Prerequisites
| Test Case | Missing Prerequisite | Expected Behavior | Severity |
|-----------|---------------------|-------------------|----------|
| TC-CLI-E021 | tmux not installed | Clear error with installation instructions | Critical |
| TC-CLI-E022 | Not in git repository | Error with remediation steps | Critical |
| TC-CLI-E023 | Claude CLI not installed | Error with installation command | Critical |

#### Multiple Simultaneous Swarm Instances
| Test Case | Scenario | Expected Behavior | Severity |
|-----------|----------|-------------------|----------|
| TC-CLI-E024 | Start while session exists | Error: Session already running | High |
| TC-CLI-E025 | Start with --force while exists | Allows starting (may cause conflicts) | Medium |
| TC-CLI-E026 | Attach with multiple sessions | Lists sessions for selection | Medium |

#### Very Long Goal Strings
| Test Case | Input | Expected Behavior | Severity |
|-----------|-------|-------------------|----------|
| TC-CLI-E027 | Goal > 10,000 chars | Should handle without crash | Medium |
| TC-CLI-E028 | Goal > 100,000 chars | May hit shell argument limits | Low |
| TC-CLI-E029 | Goal truncated in display | Truncation at 60 chars in status | Low |

#### Unicode/Special Characters in Inputs
| Test Case | Input | Expected Behavior | Severity |
|-----------|-------|-------------------|----------|
| TC-CLI-E030 | Goal with emoji | Should handle correctly | Low |
| TC-CLI-E031 | Goal with CJK characters | Should preserve encoding | Low |
| TC-CLI-E032 | Goal with newlines | May cause parsing issues | Medium |
| TC-CLI-E033 | Goal with shell metacharacters ($, \`, \\) | Should not interpret as shell | High |
| TC-CLI-E034 | Goal with quotes | May cause parsing issues | Medium |
| TC-CLI-E035 | Session ID with special chars | May cause tmux issues | Medium |

---

### 1.3 Potentially Suboptimal/Harmful Behaviors

#### Unclear Error Messages
| Issue ID | Location | Issue | Impact | Recommendation |
|----------|----------|-------|--------|----------------|
| CLI-SUB-001 | `handleError()` | Generic "Unexpected error" for non-CLIError exceptions | User confusion | Wrap all errors with context |
| CLI-SUB-002 | `parseArgs()` | Short option suggestion points to `bun swarm.ts help` | Inconsistent with shebang | Use consistent command reference |
| CLI-SUB-003 | Unknown command | Lists all commands - may be overwhelming | Minor confusion | Consider fuzzy matching for suggestions |

#### Exit Codes Not Matching Error Types
| Issue ID | Scenario | Current Code | Expected | Impact |
|----------|----------|--------------|----------|--------|
| CLI-SUB-004 | Session not found in attach | 1 (WORKFLOW_FAILED) | Could use dedicated code | Scripts may misinterpret |
| CLI-SUB-005 | Multiple sessions in attach | 2 (INVALID_ARGS) | Arguable correctness | Minor |
| CLI-SUB-006 | Graceful stop fails | 1 | Could differentiate reasons | Debug difficulty |

#### Resource Issues
| Issue ID | Location | Issue | Impact |
|----------|----------|-------|--------|
| CLI-SUB-007 | `handleStart()` | Polling every 1 second until complete | CPU overhead for long workflows |
| CLI-SUB-008 | `handleStatus()` watch mode | 2 second interval, clears console | May lose history |
| CLI-SUB-009 | `handleLogs()` follow mode | 1 second polling | Could miss rapid output |

---

### 1.4 User Experience Issues

#### Help Text Accuracy
| Issue ID | Location | Issue | Severity |
|----------|----------|-------|----------|
| CLI-UX-001 | `handleHelp()` | Examples reference `bun swarm.ts` but shebang allows `./swarm.ts` | Low |
| CLI-UX-002 | Workflow list | `develop` vs `development` inconsistency in docs | Medium |
| CLI-UX-003 | Help for `logs` | Lists 4 agents but `architect` may not always be active | Low |

#### Progress Display Edge Cases
| Issue ID | Scenario | Issue | Severity |
|----------|----------|-------|----------|
| CLI-UX-004 | `printProgress()` with total=0 | Division by zero risk | High |
| CLI-UX-005 | Progress bar | Uses Unicode block chars - terminal compatibility | Low |
| CLI-UX-006 | Very long stage names | May break table formatting | Low |

#### JSON Output Malformed in Edge Cases
| Issue ID | Scenario | Issue | Severity |
|----------|----------|-------|----------|
| CLI-UX-007 | `printJson()` with circular references | JSON.stringify will throw | Medium |
| CLI-UX-008 | `printTable()` with undefined cells | Outputs empty string | Low |
| CLI-UX-009 | Messages with very long subjects | Truncation at 40 chars may lose context | Low |

#### Color Output Issues
| Issue ID | Scenario | Issue | Severity |
|----------|----------|-------|----------|
| CLI-UX-010 | `NO_COLOR` not uppercase | May not be recognized | Low |
| CLI-UX-011 | Piped output | ANSI codes in piped output without TTY check | Medium |
| CLI-UX-012 | Windows terminals | Some ANSI codes may not render correctly | Low |

---

### 1.5 Security Concerns

#### Argument Injection
| Issue ID | Vector | Risk | Severity |
|----------|--------|------|----------|
| CLI-SEC-001 | Goal passed to external commands | If goal reaches shell, injection possible | Medium |
| CLI-SEC-002 | Session ID used in tmux commands | Could inject tmux commands | Medium |
| CLI-SEC-003 | Agent role in log capture | Used in tmux pane lookup | Low |

**Analysis**: The code uses `Bun.spawn()` with arrays (not shell strings), which mitigates most injection risks. However, session IDs and goals that reach tmux or git commands should be validated.

#### Log Injection
| Issue ID | Vector | Risk | Severity |
|----------|--------|------|----------|
| CLI-SEC-004 | ANSI escape sequences in output | Could alter terminal display | Low |
| CLI-SEC-005 | User-provided strings in error messages | May contain control characters | Low |

#### Information Disclosure in Errors
| Issue ID | Vector | Risk | Severity |
|----------|--------|------|----------|
| CLI-SEC-006 | Stack traces in verbose mode | May reveal file paths | Low |
| CLI-SEC-007 | Database query errors | May reveal schema | Low |
| CLI-SEC-008 | Config values in debug output | May reveal environment vars | Medium |

---

## Module 2: Error Handling (`src/error-handling.ts`)

### 2.1 Base Cases (Happy Path)

#### Error Creation
| Test Case | Input | Expected Behavior |
|-----------|-------|-------------------|
| TC-ERR-001 | `createSwarmError('AGENT_TIMEOUT', {...})` | Creates properly structured SwarmError |
| TC-ERR-002 | `wrapError(new Error(...), {...})` | Wraps native Error with context |
| TC-ERR-003 | `wrapError(swarmError, {...})` | Returns existing SwarmError unchanged |
| TC-ERR-004 | `isSwarmError(obj)` | Correctly identifies SwarmError objects |

#### Retry Logic
| Test Case | Scenario | Expected Behavior |
|-----------|----------|-------------------|
| TC-ERR-005 | `withRetry()` success on first attempt | Returns immediately with success |
| TC-ERR-006 | `withRetry()` success on 3rd attempt | Retries with backoff, returns success |
| TC-ERR-007 | `withRetry()` all attempts fail | Returns failure with all errors |
| TC-ERR-008 | `calculateDelay()` with defaults | Exponential backoff with jitter |
| TC-ERR-009 | `isRetryable()` for retryable error | Returns true |
| TC-ERR-010 | `isRetryable()` for non-retryable | Returns false |

#### Circuit Breaker
| Test Case | Scenario | Expected Behavior |
|-----------|----------|-------------------|
| TC-ERR-011 | Circuit closed, operation succeeds | Executes and returns result |
| TC-ERR-012 | Circuit closed, failures reach threshold | Opens circuit |
| TC-ERR-013 | Circuit open, operation attempted | Returns CIRCUIT_OPEN error |
| TC-ERR-014 | Circuit open, timeout elapsed | Transitions to half-open |
| TC-ERR-015 | Circuit half-open, success | Increments success counter |
| TC-ERR-016 | Circuit half-open, success threshold reached | Closes circuit |
| TC-ERR-017 | Circuit half-open, failure | Returns to open state |
| TC-ERR-018 | `reset()` called | Resets to closed state |

#### Recovery Strategies
| Test Case | Scenario | Expected Behavior |
|-----------|----------|-------------------|
| TC-ERR-019 | `selectStrategy()` for AGENT_TIMEOUT | Returns retry strategy |
| TC-ERR-020 | `selectStrategy()` for AGENT_CRASHED | Returns restart strategy |
| TC-ERR-021 | `selectStrategy()` for unknown code | Returns default based on properties |
| TC-ERR-022 | `executeRecovery()` success | Executes all actions, returns success |
| TC-ERR-023 | `executeRecovery()` uses fallback | Falls back to alternative strategy |

#### Graceful Degradation
| Test Case | Scenario | Expected Behavior |
|-----------|----------|-------------------|
| TC-ERR-024 | `createDegradationState()` | Returns fresh state at 'full' level |
| TC-ERR-025 | `canContinue()` for recoverable error | Returns true |
| TC-ERR-026 | `canContinue()` for fatal error | Returns false |
| TC-ERR-027 | `applyDegradation()` for crashed agent | Adds to unavailableAgents |
| TC-ERR-028 | `getAvailableCapabilities()` | Returns non-unavailable capabilities |

#### Checkpointing
| Test Case | Scenario | Expected Behavior |
|-----------|----------|-------------------|
| TC-ERR-029 | `createCheckpoint()` | Creates checkpoint with all state |
| TC-ERR-030 | `saveCheckpoint()` | Persists to database |
| TC-ERR-031 | `loadLatestCheckpoint()` | Returns most recent |
| TC-ERR-032 | `loadCheckpoint()` by ID | Returns specific checkpoint |
| TC-ERR-033 | `listCheckpoints()` | Returns all for session |
| TC-ERR-034 | `pruneCheckpoints()` | Keeps only N most recent |

#### Session Recovery
| Test Case | Scenario | Expected Behavior |
|-----------|----------|-------------------|
| TC-ERR-035 | `canRecover()` with checkpoint | Returns true |
| TC-ERR-036 | `canRecover()` without checkpoint | Returns false |
| TC-ERR-037 | `recoverSession()` success | Restores full state |
| TC-ERR-038 | `recoverSession()` with skipFailedStage | Skips problematic stage |

#### Error Logging and Reporting
| Test Case | Scenario | Expected Behavior |
|-----------|----------|-------------------|
| TC-ERR-039 | `logError()` | Persists error to database |
| TC-ERR-040 | `markErrorRecovered()` | Updates recovered flag |
| TC-ERR-041 | `formatError()` verbose | Includes stack, context |
| TC-ERR-042 | `getUserMessage()` | Returns human-friendly message |
| TC-ERR-043 | `getSuggestions()` | Returns actionable suggestions |
| TC-ERR-044 | `generateErrorReport()` | Aggregates session errors |

---

### 2.2 Edge Cases

#### Error Code Handling
| Test Case | Scenario | Expected Behavior | Severity |
|-----------|----------|-------------------|----------|
| TC-ERR-E001 | Unknown error code in `createSwarmError()` | Creates generic error with code | Medium |
| TC-ERR-E002 | Null/undefined passed to `wrapError()` | Stringifies to "undefined"/"null" | Low |
| TC-ERR-E003 | Error with missing required fields | Uses defaults | Medium |

#### Retry Edge Cases
| Test Case | Scenario | Expected Behavior | Severity |
|-----------|----------|-------------------|----------|
| TC-ERR-E004 | `maxRetries: 0` | Should execute once, no retries | Low |
| TC-ERR-E005 | `maxRetries: -1` | Undefined behavior | Medium |
| TC-ERR-E006 | Operation throws after abort signal | Should not retry | Medium |
| TC-ERR-E007 | Very long delay (maxDelayMs very high) | May appear hung | Low |
| TC-ERR-E008 | `initialDelayMs: 0` | Immediate retry (retry storm risk) | High |
| TC-ERR-E009 | Jitter calculation with negative result | Should still be positive | Low |

#### Circuit Breaker Edge Cases
| Test Case | Scenario | Expected Behavior | Severity |
|-----------|----------|-------------------|----------|
| TC-ERR-E010 | `failureThreshold: 0` | Opens immediately on first failure | Medium |
| TC-ERR-E011 | `successThreshold: 0` | Closes immediately in half-open | Medium |
| TC-ERR-E012 | `timeout: 0` | Immediately transitions to half-open | Medium |
| TC-ERR-E013 | Concurrent operations in half-open | Race condition on state | Medium |
| TC-ERR-E014 | Clock skew affecting timeout | May not open/close correctly | Low |

#### Recovery Edge Cases
| Test Case | Scenario | Expected Behavior | Severity |
|-----------|----------|-------------------|----------|
| TC-ERR-E015 | Recovery action executor not registered | Logs intent, continues | Medium |
| TC-ERR-E016 | Fallback strategy also fails | Returns failure with both errors | High |
| TC-ERR-E017 | Infinite recovery loop prevention | `attemptHistory` tracking | Critical |
| TC-ERR-E018 | Recovery with empty actions array | Returns success immediately | Low |

#### Checkpoint Edge Cases
| Test Case | Scenario | Expected Behavior | Severity |
|-----------|----------|-------------------|----------|
| TC-ERR-E019 | Checkpoint with very large Map | Serialization may fail | Medium |
| TC-ERR-E020 | Checkpoint with circular references | JSON.stringify fails | High |
| TC-ERR-E021 | Load checkpoint with corrupted JSON | Parse error | High |
| TC-ERR-E022 | Prune with keepCount=0 | Deletes all checkpoints | Medium |
| TC-ERR-E023 | Session recovery with no pending stages | May complete immediately | Low |

---

### 2.3 Potentially Suboptimal/Harmful Behaviors

#### Recovery Strategies That Make Things Worse
| Issue ID | Scenario | Problem | Impact |
|----------|----------|---------|--------|
| ERR-SUB-001 | Retry with same parameters | If failure is deterministic, retries waste time | Medium |
| ERR-SUB-002 | Restart crashed agent repeatedly | If crash cause persists, endless cycle | High |
| ERR-SUB-003 | Skip without user confirmation | User may lose important work | High |
| ERR-SUB-004 | Substitute strategy mentioned but not implemented | May leave workflow in undefined state | Medium |

#### Retry Storms Overwhelming Resources
| Issue ID | Scenario | Problem | Impact |
|----------|----------|---------|--------|
| ERR-SUB-005 | Multiple components retrying simultaneously | CPU/network spike | High |
| ERR-SUB-006 | `initialDelayMs` too low in config | Hammers resources | High |
| ERR-SUB-007 | No global rate limiting | Each component independent | Medium |
| ERR-SUB-008 | Rate limit retries stacking | Exponential resource use | Medium |

**Analysis**: The `messageSend` retry config has `initialDelayMs: 500` which could cause issues with high message volumes. The `rateLimited` config has proper 5s initial delay.

#### Circuit Breaker Never Recovering
| Issue ID | Scenario | Problem | Impact |
|----------|----------|---------|--------|
| ERR-SUB-009 | Timeout too short | Opens/closes rapidly | Medium |
| ERR-SUB-010 | Success threshold too high | Never fully closes | High |
| ERR-SUB-011 | No external reset mechanism | Stuck in open state | High |
| ERR-SUB-012 | Half-open immediately fails | Cycles between half-open/open | Medium |

**Analysis**: Default `timeout: 30000` and `successThreshold: 2` are reasonable. The `reset()` method exists for manual recovery.

#### Checkpoint Files Growing Unbounded
| Issue ID | Scenario | Problem | Impact |
|----------|----------|---------|--------|
| ERR-SUB-013 | `maxCheckpoints` not enforced automatically | Disk space exhaustion | High |
| ERR-SUB-014 | Large checkpoint payloads | Database bloat | Medium |
| ERR-SUB-015 | Errors array grows unbounded | Memory/storage issues | Medium |
| ERR-SUB-016 | `processedMessageIds` grows unbounded | May become very large | Medium |

**Analysis**: `pruneCheckpoints()` exists but must be called explicitly. Default `maxCheckpoints: 10` in config but not auto-enforced.

#### Sensitive Data in Error Logs
| Issue ID | Scenario | Problem | Impact |
|----------|----------|---------|--------|
| ERR-SUB-017 | Goal text in error context | May contain sensitive queries | Medium |
| ERR-SUB-018 | Stack traces with file paths | Reveals directory structure | Low |
| ERR-SUB-019 | API keys in error context | Critical exposure | Critical |
| ERR-SUB-020 | Session state in checkpoints | May contain sensitive data | Medium |

---

### 2.4 User Experience Issues

#### Error Message Quality
| Issue ID | Error Code | Issue | Severity |
|----------|------------|-------|----------|
| ERR-UX-001 | PERMISSION_DENIED | Generic message, no path shown | Medium |
| ERR-UX-002 | DATABASE_ERROR | Technical, not user-friendly | Medium |
| ERR-UX-003 | FILESYSTEM_ERROR | No specific file mentioned | Medium |
| ERR-UX-004 | Unknown code | Falls back to `Unknown error: ${code}` | Medium |

#### Suggestions Completeness
| Issue ID | Error Code | Missing Suggestion | Severity |
|----------|------------|-------------------|----------|
| ERR-UX-005 | AGENT_BLOCKED | No suggestion provided | Medium |
| ERR-UX-006 | STAGE_FAILED | No specific remediation | Medium |
| ERR-UX-007 | ROUTING_FAILED | No debugging guidance | Medium |

#### Recovery Reporting
| Issue ID | Scenario | Issue | Severity |
|----------|----------|-------|----------|
| ERR-UX-008 | Console.log in `executeAction()` | Not using structured logging | Low |
| ERR-UX-009 | Recovery progress not reported | User may think system is stuck | Medium |
| ERR-UX-010 | Fallback usage not clear | User may not know original strategy failed | Medium |

---

### 2.5 Security Concerns

#### Log Injection
| Issue ID | Vector | Risk | Severity |
|----------|--------|------|----------|
| ERR-SEC-001 | Error message contains user input | Log file pollution | Low |
| ERR-SEC-002 | Stack trace manipulation | Misleading debug info | Low |
| ERR-SEC-003 | Context JSON with malicious content | If rendered in HTML, XSS | Low |

#### Information Disclosure
| Issue ID | Vector | Risk | Severity |
|----------|--------|------|----------|
| ERR-SEC-004 | Full stack traces in verbose mode | Path disclosure | Low |
| ERR-SEC-005 | Context object may contain credentials | Credential exposure | High |
| ERR-SEC-006 | Session state in checkpoints | Business logic exposure | Medium |
| ERR-SEC-007 | Error reports may reveal system architecture | Intelligence gathering | Low |

---

## Severity Summary

### Critical Issues (Require Immediate Attention)
| ID | Module | Issue |
|----|--------|-------|
| TC-CLI-E021-E023 | CLI | Missing prerequisite errors must be clear |
| ERR-SUB-017 | Recovery | Infinite recovery loop possibility |
| ERR-SEC-005 | Error Handling | Credentials in context object |

### High Severity Issues
| ID | Module | Issue |
|----|--------|-------|
| TC-CLI-E016-E018 | CLI | Signal handling must be robust |
| CLI-UX-004 | CLI | Division by zero in progress bar |
| ERR-SUB-001-002 | Error Handling | Recovery making things worse |
| ERR-SUB-005-007 | Error Handling | Retry storms |
| ERR-SUB-013 | Error Handling | Unbounded checkpoint growth |
| ERR-E020-021 | Error Handling | JSON serialization failures |

### Medium Severity Issues
| Count | Category |
|-------|----------|
| 25 | Edge case handling |
| 12 | User experience |
| 8 | Error message quality |
| 5 | Security concerns |

### Low Severity Issues
| Count | Category |
|-------|----------|
| 15 | Minor edge cases |
| 8 | Terminal compatibility |
| 5 | Documentation accuracy |

---

## Test Implementation Recommendations

### Unit Tests Priority
1. **Retry logic boundary conditions** - Zero/negative retries, abort signals
2. **Circuit breaker state transitions** - All state combinations
3. **Error serialization** - Circular references, large objects
4. **Input validation** - Special characters, injection attempts

### Integration Tests Priority
1. **Signal handling** - Ctrl+C, SIGTERM during various states
2. **Session lifecycle** - Start, stop, recovery flow
3. **Multiple instance detection** - Concurrent swarm sessions
4. **Prerequisite checking** - Missing tmux, git, claude

### Property-Based Tests
1. **Backoff calculation** - Always positive, bounded
2. **Error wrapping** - Idempotent for SwarmError
3. **Checkpoint round-trip** - Serialize/deserialize preserves data

### Chaos Testing
1. **Kill agent processes randomly** - Verify recovery
2. **Inject filesystem errors** - Verify graceful degradation
3. **Simulate rate limiting** - Verify backoff works

---

## Files Analyzed

- `/home/carso/code/claude-swarm/src/swarm.ts` (1657 lines)
- `/home/carso/code/claude-swarm/src/error-handling.ts` (2375 lines)
- `/home/carso/code/claude-swarm/docs/plans/steps/09-cli-interface.md`
- `/home/carso/code/claude-swarm/docs/plans/steps/10-error-handling.md`

---

*Generated: 2025-12-29*
*Analysis Type: READ-ONLY test case documentation*
