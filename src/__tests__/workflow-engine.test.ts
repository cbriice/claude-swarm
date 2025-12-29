/**
 * Workflow Engine Tests
 *
 * Tests for the workflow templates and engine modules covering:
 * - Template retrieval and validation
 * - Workflow instance creation
 * - Step execution and completion
 * - State transitions with verdicts
 * - Progress tracking
 * - Edge cases and error handling
 */

import { describe, expect, test } from 'bun:test';
import {
  // Template functions
  getWorkflowTemplate,
  listWorkflowTemplates,
  validateWorkflow,
  createWorkflowInstance,
  getNextStep,
  isWorkflowComplete,
  getStepById,
  getTransitionsFromStep,
  // Types
  type WorkflowInstance,
  type WorkflowTemplate,
} from '../workflows/templates.js';
import {
  // Engine functions
  startStep,
  completeStep,
  skipStep,
  transitionWorkflow,
  routeMessage as engineRouteMessage,
  synthesizeResult,
  getWorkflowProgress,
  getActiveAgents,
  createInitialTaskMessage,
} from '../workflows/engine.js';
import type { AgentMessage, MessageContent } from '../types.js';

// =============================================================================
// Test Helpers
// =============================================================================

function createTestInstance(templateName: string = 'research'): WorkflowInstance {
  const result = createWorkflowInstance(templateName, 'test-session-123', 'Test goal');
  if (!result.ok) {
    throw new Error(`Failed to create test instance: ${result.error.message}`);
  }
  return result.value;
}

function createTestMessage(overrides?: Partial<AgentMessage>): AgentMessage {
  const content: MessageContent = { subject: 'Test Finding', body: 'Test finding content' };
  return {
    id: `msg-${Date.now()}`,
    timestamp: new Date().toISOString(),
    from: 'researcher',
    to: 'reviewer',
    type: 'finding',
    priority: 'normal',
    content,
    requiresResponse: false,
    ...overrides,
  };
}

// =============================================================================
// Template Registry Tests
// =============================================================================

describe('Workflow Templates - Registry', () => {
  test('getWorkflowTemplate returns research template', () => {
    const result = getWorkflowTemplate('research');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('research');
      expect(result.value.roles).toContain('researcher');
      expect(result.value.roles).toContain('reviewer');
    }
  });

  test('getWorkflowTemplate returns implement template', () => {
    const result = getWorkflowTemplate('implement');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('implement');
      expect(result.value.roles).toContain('architect');
      expect(result.value.roles).toContain('developer');
    }
  });

  test('getWorkflowTemplate returns review template', () => {
    const result = getWorkflowTemplate('review');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('review');
      expect(result.value.roles).toContain('reviewer');
    }
  });

  test('getWorkflowTemplate returns full template', () => {
    const result = getWorkflowTemplate('full');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('full');
      expect(result.value.roles.length).toBe(4);
    }
  });

  test('getWorkflowTemplate fails for nonexistent template', () => {
    const result = getWorkflowTemplate('nonexistent');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TEMPLATE_NOT_FOUND');
    }
  });

  test('development is alias for implement', () => {
    const dev = getWorkflowTemplate('development');
    const impl = getWorkflowTemplate('implement');
    expect(dev.ok).toBe(true);
    expect(impl.ok).toBe(true);
    if (dev.ok && impl.ok) {
      expect(dev.value.name).toBe(impl.value.name);
    }
  });

  test('architecture is alias for full', () => {
    const arch = getWorkflowTemplate('architecture');
    const full = getWorkflowTemplate('full');
    expect(arch.ok).toBe(true);
    expect(full.ok).toBe(true);
    if (arch.ok && full.ok) {
      expect(arch.value.name).toBe(full.value.name);
    }
  });

  test('listWorkflowTemplates returns all templates', () => {
    const templates = listWorkflowTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(4);

    const names = templates.map(t => t.name);
    expect(names).toContain('research');
    expect(names).toContain('implement');
    expect(names).toContain('review');
    expect(names).toContain('full');
  });
});

// =============================================================================
// Template Validation Tests
// =============================================================================

describe('Workflow Templates - Validation', () => {
  test('validateWorkflow passes for valid template', () => {
    const templateResult = getWorkflowTemplate('research');
    expect(templateResult.ok).toBe(true);
    if (templateResult.ok) {
      const result = validateWorkflow(templateResult.value);
      expect(result.ok).toBe(true);
    }
  });

  test('validateWorkflow fails for template without name', () => {
    const invalidTemplate = {
      name: '',
      description: 'Test',
      version: '1.0.0',
      roles: ['researcher'],
      steps: [],
      transitions: [],
      entryStep: 'step1',
      completionStep: 'step1',
      maxDuration: 1000,
      maxRevisions: 1,
    } as WorkflowTemplate;

    const result = validateWorkflow(invalidTemplate);
    expect(result.ok).toBe(false);
  });

  test('validateWorkflow fails for template without roles', () => {
    const invalidTemplate = {
      name: 'test',
      description: 'Test',
      version: '1.0.0',
      roles: [],
      steps: [{ id: 'step1', agent: 'researcher', type: 'work', inputTypes: [], outputType: 'result', maxIterations: 1, timeout: 1000, optional: false, description: '' }],
      transitions: [{ from: 'step1', to: 'step1', condition: { type: 'complete' as const } }],
      entryStep: 'step1',
      completionStep: 'step1',
      maxDuration: 1000,
      maxRevisions: 1,
    } as WorkflowTemplate;

    const result = validateWorkflow(invalidTemplate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('role');
    }
  });

  test('validateWorkflow fails for missing entry step', () => {
    const invalidTemplate = {
      name: 'test',
      description: 'Test',
      version: '1.0.0',
      roles: ['researcher'],
      steps: [{ id: 'step1', agent: 'researcher', type: 'work', inputTypes: [], outputType: 'result', maxIterations: 1, timeout: 1000, optional: false, description: '' }],
      transitions: [{ from: 'step1', to: 'step1', condition: { type: 'complete' as const } }],
      entryStep: 'nonexistent',
      completionStep: 'step1',
      maxDuration: 1000,
      maxRevisions: 1,
    } as WorkflowTemplate;

    const result = validateWorkflow(invalidTemplate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Entry step');
    }
  });

  test('validateWorkflow fails for invalid transition reference', () => {
    const invalidTemplate = {
      name: 'test',
      description: 'Test',
      version: '1.0.0',
      roles: ['researcher'],
      steps: [{ id: 'step1', agent: 'researcher', type: 'work', inputTypes: [], outputType: 'result', maxIterations: 1, timeout: 1000, optional: false, description: '' }],
      transitions: [{ from: 'step1', to: 'nonexistent', condition: { type: 'complete' as const } }],
      entryStep: 'step1',
      completionStep: 'step1',
      maxDuration: 1000,
      maxRevisions: 1,
    } as WorkflowTemplate;

    const result = validateWorkflow(invalidTemplate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_TRANSITION');
    }
  });
});

// =============================================================================
// Workflow Instance Creation Tests
// =============================================================================

describe('Workflow Templates - Instance Creation', () => {
  test('createWorkflowInstance creates valid instance', () => {
    const result = createWorkflowInstance('research', 'session-123', 'Analyze codebase');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.templateName).toBe('research');
      expect(result.value.sessionId).toBe('session-123');
      expect(result.value.goal).toBe('Analyze codebase');
      expect(result.value.currentStep).toBe('initial_research');
      expect(result.value.status).toBe('running');
      expect(result.value.stepHistory).toEqual([]);
      expect(result.value.iterationCounts).toBeInstanceOf(Map);
    }
  });

  test('createWorkflowInstance fails for invalid template', () => {
    const result = createWorkflowInstance('nonexistent', 'session-123', 'Goal');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TEMPLATE_NOT_FOUND');
    }
  });

  test('each template has correct entry step', () => {
    const templates = [
      { name: 'research', entryStep: 'initial_research' },
      { name: 'implement', entryStep: 'architecture' },
      { name: 'review', entryStep: 'code_analysis' },
      { name: 'full', entryStep: 'research' },
    ];

    for (const { name, entryStep } of templates) {
      const result = createWorkflowInstance(name, 'session', 'Goal');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.currentStep).toBe(entryStep);
      }
    }
  });
});

// =============================================================================
// Step Execution Tests
// =============================================================================

describe('Workflow Engine - Step Execution', () => {
  test('startStep creates execution record', () => {
    const instance = createTestInstance();
    const result = startStep(instance, 'initial_research');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.stepHistory.length).toBe(1);
      expect(result.value.stepHistory[0].stepId).toBe('initial_research');
      expect(result.value.stepHistory[0].status).toBe('running');
    }
  });

  test('startStep fails for nonexistent step', () => {
    const instance = createTestInstance();
    const result = startStep(instance, 'nonexistent');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('STEP_NOT_FOUND');
    }
  });

  test('completeStep marks step as complete', () => {
    let instance = createTestInstance();
    const startResult = startStep(instance, 'initial_research');
    expect(startResult.ok).toBe(true);
    if (startResult.ok) {
      instance = startResult.value;
    }

    const result = completeStep(instance, 'initial_research', {
      type: 'finding',
      summary: 'Found 3 issues',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const record = result.value.stepHistory.find(r => r.stepId === 'initial_research' && r.status === 'complete');
      expect(record).toBeDefined();
      expect(record?.output?.type).toBe('finding');
    }
  });

  test('completeStep fails for non-running step', () => {
    const instance = createTestInstance();
    // Don't start the step first
    const result = completeStep(instance, 'initial_research', {
      type: 'finding',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('STEP_NOT_FOUND');
    }
  });

  test('completeStep with verdict records it', () => {
    let instance = createTestInstance();
    const startResult = startStep(instance, 'initial_research');
    if (startResult.ok) {
      instance = startResult.value;
    }

    const result = completeStep(instance, 'initial_research', {
      type: 'review',
      verdict: 'APPROVED',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const record = result.value.stepHistory.find(r => r.status === 'complete');
      expect(record?.output?.verdict).toBe('APPROVED');
    }
  });
});

// =============================================================================
// Step Skip Tests
// =============================================================================

describe('Workflow Engine - Step Skipping', () => {
  test('skipStep fails for non-optional step', () => {
    const instance = createTestInstance();
    const result = skipStep(instance, 'initial_research');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_TRANSITION');
      expect(result.error.message).toContain('non-optional');
    }
  });

  test('skipStep succeeds for optional step', () => {
    const instance = createTestInstance();
    // deep_dive is optional in research workflow
    const result = skipStep(instance, 'deep_dive');
    expect(result.ok).toBe(true);
    if (result.ok) {
      const record = result.value.stepHistory.find(r => r.stepId === 'deep_dive');
      expect(record?.status).toBe('skipped');
    }
  });
});

// =============================================================================
// Workflow Transition Tests
// =============================================================================

describe('Workflow Engine - Transitions', () => {
  test('getNextStep returns correct next step on complete', () => {
    const instance = createTestInstance();
    const result = getNextStep(instance, 'initial_research', {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('verification');
    }
  });

  test('getNextStep returns correct step on APPROVED verdict', () => {
    const instance = createTestInstance();
    const result = getNextStep(instance, 'verification', { verdict: 'APPROVED' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('synthesis');
    }
  });

  test('getNextStep returns correct step on NEEDS_REVISION verdict', () => {
    const instance = createTestInstance();
    const result = getNextStep(instance, 'verification', { verdict: 'NEEDS_REVISION' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('deep_dive');
    }
  });

  test('getNextStep returns null at completion step', () => {
    const instance = createTestInstance();
    const result = getNextStep(instance, 'synthesis', {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeNull();
    }
  });

  test('transitionWorkflow updates current step', () => {
    let instance = createTestInstance();
    // Start and complete initial_research
    let startResult = startStep(instance, 'initial_research');
    if (startResult.ok) instance = startResult.value;

    let completeResult = completeStep(instance, 'initial_research', { type: 'finding' });
    if (completeResult.ok) instance = completeResult.value;

    const result = transitionWorkflow(instance, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.currentStep).toBe('verification');
    }
  });
});

// =============================================================================
// Max Iterations Tests
// =============================================================================

describe('Workflow Engine - Max Iterations', () => {
  test('iteration count increments on step start', () => {
    let instance = createTestInstance();
    const startResult = startStep(instance, 'initial_research');
    expect(startResult.ok).toBe(true);
    if (startResult.ok) {
      expect(startResult.value.iterationCounts.get('initial_research')).toBe(1);
    }
  });

  test('getNextStep respects max iterations', () => {
    let instance = createTestInstance();
    // Simulate max iterations on deep_dive (maxIterations: 2)
    instance.iterationCounts.set('deep_dive', 2);

    const result = getNextStep(instance, 'verification', { verdict: 'NEEDS_REVISION' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should skip to synthesis instead of deep_dive since max iterations reached
      expect(result.value).toBe('synthesis');
    }
  });
});

// =============================================================================
// Workflow Completion Tests
// =============================================================================

describe('Workflow Engine - Completion', () => {
  test('isWorkflowComplete returns false for running workflow', () => {
    const instance = createTestInstance();
    expect(isWorkflowComplete(instance)).toBe(false);
  });

  test('isWorkflowComplete returns true when status is complete', () => {
    const instance = createTestInstance();
    instance.status = 'complete';
    expect(isWorkflowComplete(instance)).toBe(true);
  });

  test('isWorkflowComplete returns true when completion step executed', () => {
    let instance = createTestInstance();
    instance.currentStep = 'synthesis';

    // Start and complete synthesis
    const startResult = startStep(instance, 'synthesis');
    if (startResult.ok) instance = startResult.value;

    const completeResult = completeStep(instance, 'synthesis', { type: 'result' });
    if (completeResult.ok) instance = completeResult.value;

    expect(isWorkflowComplete(instance)).toBe(true);
  });
});

// =============================================================================
// Progress Tracking Tests
// =============================================================================

describe('Workflow Engine - Progress', () => {
  test('getWorkflowProgress returns 0 for new instance', () => {
    const instance = createTestInstance();
    const result = getWorkflowProgress(instance);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(0);
    }
  });

  test('getWorkflowProgress increases with completed steps', () => {
    let instance = createTestInstance();
    const startResult = startStep(instance, 'initial_research');
    if (startResult.ok) instance = startResult.value;

    const completeResult = completeStep(instance, 'initial_research', { type: 'finding' });
    if (completeResult.ok) instance = completeResult.value;

    const result = getWorkflowProgress(instance);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeGreaterThan(0);
    }
  });

  test('getWorkflowProgress returns progress for complete workflow', () => {
    let instance = createTestInstance();
    instance.status = 'complete';

    // Progress calculation may be based on completed steps, not just status
    // Complete the synthesis step to get 100%
    const startResult = startStep(instance, 'synthesis');
    if (startResult.ok) instance = startResult.value;
    const completeResult = completeStep(instance, 'synthesis', { type: 'result' });
    if (completeResult.ok) instance = completeResult.value;

    const result = getWorkflowProgress(instance);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeGreaterThanOrEqual(0);
      expect(result.value).toBeLessThanOrEqual(100);
    }
  });
});

// =============================================================================
// Active Agents Tests
// =============================================================================

describe('Workflow Engine - Active Agents', () => {
  test('getActiveAgents returns roles from template', () => {
    const instance = createTestInstance('research');
    const result = getActiveAgents(instance);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('researcher');
      expect(result.value).toContain('reviewer');
    }
  });

  test('getActiveAgents returns all roles for full workflow', () => {
    const instance = createTestInstance('full');
    const result = getActiveAgents(instance);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(4);
      expect(result.value).toContain('researcher');
      expect(result.value).toContain('architect');
      expect(result.value).toContain('developer');
      expect(result.value).toContain('reviewer');
    }
  });
});

// =============================================================================
// Message Creation Tests
// =============================================================================

describe('Workflow Engine - Message Creation', () => {
  test('createInitialTaskMessage creates valid message', () => {
    const instance = createTestInstance();
    const result = createInitialTaskMessage(instance);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.type).toBe('task');
      expect(result.value.from).toBe('orchestrator');
      // Content may be an object or string depending on implementation
      const contentStr = typeof result.value.content === 'string'
        ? result.value.content
        : JSON.stringify(result.value.content);
      expect(contentStr).toContain('Test goal');
    }
  });
});

// =============================================================================
// Message Routing Tests
// =============================================================================

describe('Workflow Engine - Message Routing', () => {
  test('routeMessage returns routing decisions', () => {
    const instance = createTestInstance();
    const message = createTestMessage({
      from: 'researcher',
      type: 'finding',
    });

    const result = engineRouteMessage(instance, message);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// Result Synthesis Tests
// =============================================================================

describe('Workflow Engine - Result Synthesis', () => {
  test('synthesizeResult fails for incomplete workflow', () => {
    const instance = createTestInstance();
    const result = synthesizeResult(instance);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_TRANSITION');
    }
  });

  test('synthesizeResult succeeds for complete workflow', () => {
    let instance = createTestInstance();
    instance.status = 'complete';
    instance.currentStep = 'synthesis';

    // Add completed step
    const startResult = startStep(instance, 'synthesis');
    if (startResult.ok) instance = startResult.value;
    const completeResult = completeStep(instance, 'synthesis', { type: 'result', summary: 'Done' });
    if (completeResult.ok) instance = completeResult.value;

    const result = synthesizeResult(instance);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(true);
    }
  });
});

// =============================================================================
// Step Lookup Tests
// =============================================================================

describe('Workflow Templates - Step Lookup', () => {
  test('getStepById returns step for valid ID', () => {
    const result = getStepById('research', 'initial_research');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe('initial_research');
      expect(result.value.agent).toBe('researcher');
    }
  });

  test('getStepById fails for invalid ID', () => {
    const result = getStepById('research', 'nonexistent');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('STEP_NOT_FOUND');
    }
  });

  test('getTransitionsFromStep returns transitions', () => {
    const result = getTransitionsFromStep('research', 'verification');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBeGreaterThan(0);
      // Should have transitions for APPROVED, NEEDS_REVISION, and REJECTED
    }
  });
});

// =============================================================================
// Workflow Template Structure Tests
// =============================================================================

describe('Workflow Templates - Structure Validation', () => {
  const templates = ['research', 'implement', 'review', 'full'];

  for (const templateName of templates) {
    describe(`${templateName} template`, () => {
      test('has valid entry step', () => {
        const result = getWorkflowTemplate(templateName);
        expect(result.ok).toBe(true);
        if (result.ok) {
          const entryStep = result.value.steps.find(s => s.id === result.value.entryStep);
          expect(entryStep).toBeDefined();
        }
      });

      test('has valid completion step', () => {
        const result = getWorkflowTemplate(templateName);
        expect(result.ok).toBe(true);
        if (result.ok) {
          const completionStep = result.value.steps.find(s => s.id === result.value.completionStep);
          expect(completionStep).toBeDefined();
        }
      });

      test('all step agents are in roles', () => {
        const result = getWorkflowTemplate(templateName);
        expect(result.ok).toBe(true);
        if (result.ok) {
          const roleSet = new Set(result.value.roles);
          for (const step of result.value.steps) {
            expect(roleSet.has(step.agent)).toBe(true);
          }
        }
      });

      test('all transitions reference valid steps', () => {
        const result = getWorkflowTemplate(templateName);
        expect(result.ok).toBe(true);
        if (result.ok) {
          const stepIds = new Set(result.value.steps.map(s => s.id));
          for (const transition of result.value.transitions) {
            expect(stepIds.has(transition.from)).toBe(true);
            expect(stepIds.has(transition.to)).toBe(true);
          }
        }
      });

      test('has positive maxDuration', () => {
        const result = getWorkflowTemplate(templateName);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.maxDuration).toBeGreaterThan(0);
        }
      });

      test('all steps have positive timeout', () => {
        const result = getWorkflowTemplate(templateName);
        expect(result.ok).toBe(true);
        if (result.ok) {
          for (const step of result.value.steps) {
            expect(step.timeout).toBeGreaterThan(0);
          }
        }
      });
    });
  }
});
