/**
 * Claude Swarm - Workflow Templates
 *
 * Defines workflow templates for different task types. Each template specifies
 * which agents participate, in what order, and how to transition between steps.
 */

import {
  type AgentRole,
  type MessageType,
  type Result,
  ok,
  err,
} from '../types.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Verdict from a review step, determines next transition.
 */
export type ReviewVerdict = 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED';

/**
 * Step types define what kind of action happens at each step.
 */
export type StepType =
  | 'task'      // Initial task assignment
  | 'work'      // Agent performs work
  | 'review'    // Agent reviews work
  | 'synthesis' // Combine results
  | 'decision'; // Make a choice based on input

/**
 * A single step in a workflow.
 */
export interface WorkflowStep {
  /** Unique identifier for this step */
  id: string;
  /** Human-readable description */
  description: string;
  /** Agent role that executes this step */
  agent: AgentRole;
  /** Type of step */
  type: StepType;
  /** Expected input message types */
  inputTypes: MessageType[];
  /** Output message type produced */
  outputType: MessageType;
  /** Maximum times this step can execute in revision cycles */
  maxIterations: number;
  /** Timeout in milliseconds for this step */
  timeout: number;
  /** Whether this step is optional */
  optional: boolean;
}

/**
 * Defines how to transition from one step to another based on results.
 */
export interface StepTransition {
  /** Step this transition comes from */
  from: string;
  /** Step to transition to */
  to: string;
  /** Condition for this transition */
  condition: TransitionCondition;
}

/**
 * Conditions that trigger a transition.
 */
export interface TransitionCondition {
  /** Type of condition */
  type: 'complete' | 'verdict' | 'default';
  /** For verdict conditions, which verdict triggers this */
  verdict?: ReviewVerdict;
  /** Custom condition description */
  description?: string;
}

/**
 * Complete workflow template definition.
 */
export interface WorkflowTemplate {
  /** Unique workflow identifier */
  name: string;
  /** Human-readable description */
  description: string;
  /** Semantic version */
  version: string;
  /** Agent roles involved */
  roles: AgentRole[];
  /** Ordered steps in the workflow */
  steps: WorkflowStep[];
  /** Transitions between steps */
  transitions: StepTransition[];
  /** ID of the entry step */
  entryStep: string;
  /** ID of the completion step */
  completionStep: string;
  /** Maximum workflow duration in ms */
  maxDuration: number;
  /** Maximum revision cycles globally */
  maxRevisions: number;
}

/**
 * Runtime instance of a workflow being executed.
 */
export interface WorkflowInstance {
  /** Template name this instance is based on */
  templateName: string;
  /** Session this instance belongs to */
  sessionId: string;
  /** User-provided goal */
  goal: string;
  /** Current step ID */
  currentStep: string;
  /** Step execution history */
  stepHistory: StepExecutionRecord[];
  /** Iteration count per step */
  iterationCounts: Map<string, number>;
  /** ISO8601 timestamp of creation */
  createdAt: string;
  /** Current status */
  status: WorkflowInstanceStatus;
}

export type WorkflowInstanceStatus =
  | 'running'
  | 'complete'
  | 'failed'
  | 'timeout';

/**
 * Record of a step execution.
 */
export interface StepExecutionRecord {
  /** Step ID */
  stepId: string;
  /** When the step started */
  startedAt: string;
  /** When the step completed (if complete) */
  completedAt?: string;
  /** Result status */
  status: 'running' | 'complete' | 'skipped' | 'failed';
  /** Iteration number for this step */
  iteration: number;
  /** Output produced (if any) */
  output?: StepOutput;
}

/**
 * Output from a step execution.
 */
export interface StepOutput {
  /** Message type produced */
  type: MessageType;
  /** Review verdict (if review step) */
  verdict?: ReviewVerdict;
  /** Summary of output */
  summary?: string;
}

// =============================================================================
// Error Types
// =============================================================================

export interface WorkflowError extends Error {
  code: WorkflowErrorCode;
  templateName?: string;
  stepId?: string;
  details?: string;
}

export type WorkflowErrorCode =
  | 'TEMPLATE_NOT_FOUND'
  | 'INVALID_TEMPLATE'
  | 'STEP_NOT_FOUND'
  | 'INVALID_TRANSITION'
  | 'MAX_ITERATIONS_EXCEEDED'
  | 'WORKFLOW_TIMEOUT';

function createWorkflowError(
  code: WorkflowErrorCode,
  message: string,
  templateName?: string,
  stepId?: string,
  details?: string
): WorkflowError {
  const error = new Error(message) as WorkflowError;
  error.code = code;
  error.templateName = templateName;
  error.stepId = stepId;
  error.details = details;
  error.name = 'WorkflowError';
  return error;
}

// =============================================================================
// Workflow Templates
// =============================================================================

/**
 * Research workflow: researcher -> reviewer verification cycle.
 */
const researchTemplate: WorkflowTemplate = {
  name: 'research',
  description: 'Research-focused workflow with verification. Researcher gathers findings, reviewer verifies accuracy.',
  version: '1.0.0',
  roles: ['researcher', 'reviewer'],
  steps: [
    {
      id: 'initial_research',
      description: 'Researcher gathers initial findings',
      agent: 'researcher',
      type: 'work',
      inputTypes: ['task'],
      outputType: 'finding',
      maxIterations: 1,
      timeout: 600000, // 10 minutes
      optional: false,
    },
    {
      id: 'verification',
      description: 'Reviewer verifies research findings',
      agent: 'reviewer',
      type: 'review',
      inputTypes: ['finding'],
      outputType: 'review',
      maxIterations: 1,
      timeout: 300000, // 5 minutes
      optional: false,
    },
    {
      id: 'deep_dive',
      description: 'Researcher addresses gaps identified in review',
      agent: 'researcher',
      type: 'work',
      inputTypes: ['review'],
      outputType: 'finding',
      maxIterations: 2,
      timeout: 600000,
      optional: true,
    },
    {
      id: 'synthesis',
      description: 'Final synthesis of research findings',
      agent: 'researcher',
      type: 'synthesis',
      inputTypes: ['finding', 'review'],
      outputType: 'result',
      maxIterations: 1,
      timeout: 300000,
      optional: false,
    },
  ],
  transitions: [
    {
      from: 'initial_research',
      to: 'verification',
      condition: { type: 'complete', description: 'Research findings produced' },
    },
    {
      from: 'verification',
      to: 'synthesis',
      condition: { type: 'verdict', verdict: 'APPROVED', description: 'Findings verified' },
    },
    {
      from: 'verification',
      to: 'deep_dive',
      condition: { type: 'verdict', verdict: 'NEEDS_REVISION', description: 'Gaps identified' },
    },
    {
      from: 'verification',
      to: 'synthesis',
      condition: { type: 'verdict', verdict: 'REJECTED', description: 'Max revisions reached' },
    },
    {
      from: 'deep_dive',
      to: 'verification',
      condition: { type: 'complete', description: 'Additional research complete' },
    },
    {
      from: 'synthesis',
      to: 'synthesis', // Terminal - points to self
      condition: { type: 'complete', description: 'Workflow complete' },
    },
  ],
  entryStep: 'initial_research',
  completionStep: 'synthesis',
  maxDuration: 1200000, // 20 minutes
  maxRevisions: 2,
};

/**
 * Implementation workflow: architect -> developer -> reviewer cycle.
 */
const implementTemplate: WorkflowTemplate = {
  name: 'implement',
  description: 'Implementation workflow with design and review. Architect designs, developer implements, reviewer validates.',
  version: '1.0.0',
  roles: ['architect', 'developer', 'reviewer'],
  steps: [
    {
      id: 'architecture',
      description: 'Architect creates design',
      agent: 'architect',
      type: 'work',
      inputTypes: ['task'],
      outputType: 'design',
      maxIterations: 1,
      timeout: 600000,
      optional: false,
    },
    {
      id: 'design_review',
      description: 'Reviewer evaluates design',
      agent: 'reviewer',
      type: 'review',
      inputTypes: ['design'],
      outputType: 'review',
      maxIterations: 1,
      timeout: 300000,
      optional: false,
    },
    {
      id: 'design_revision',
      description: 'Architect revises design based on feedback',
      agent: 'architect',
      type: 'work',
      inputTypes: ['review'],
      outputType: 'design',
      maxIterations: 2,
      timeout: 600000,
      optional: true,
    },
    {
      id: 'implementation',
      description: 'Developer builds the implementation',
      agent: 'developer',
      type: 'work',
      inputTypes: ['design'],
      outputType: 'artifact',
      maxIterations: 1,
      timeout: 1800000, // 30 minutes
      optional: false,
    },
    {
      id: 'code_review',
      description: 'Reviewer checks code quality',
      agent: 'reviewer',
      type: 'review',
      inputTypes: ['artifact'],
      outputType: 'review',
      maxIterations: 1,
      timeout: 300000,
      optional: false,
    },
    {
      id: 'code_revision',
      description: 'Developer fixes issues from review',
      agent: 'developer',
      type: 'work',
      inputTypes: ['review'],
      outputType: 'artifact',
      maxIterations: 3,
      timeout: 900000, // 15 minutes
      optional: true,
    },
    {
      id: 'documentation',
      description: 'Developer creates documentation',
      agent: 'developer',
      type: 'work',
      inputTypes: ['artifact'],
      outputType: 'artifact',
      maxIterations: 1,
      timeout: 600000,
      optional: false,
    },
  ],
  transitions: [
    // Design phase
    {
      from: 'architecture',
      to: 'design_review',
      condition: { type: 'complete', description: 'Design created' },
    },
    {
      from: 'design_review',
      to: 'implementation',
      condition: { type: 'verdict', verdict: 'APPROVED', description: 'Design approved' },
    },
    {
      from: 'design_review',
      to: 'design_revision',
      condition: { type: 'verdict', verdict: 'NEEDS_REVISION', description: 'Design needs work' },
    },
    {
      from: 'design_revision',
      to: 'design_review',
      condition: { type: 'complete', description: 'Design revised' },
    },
    // Implementation phase
    {
      from: 'implementation',
      to: 'code_review',
      condition: { type: 'complete', description: 'Code implemented' },
    },
    {
      from: 'code_review',
      to: 'documentation',
      condition: { type: 'verdict', verdict: 'APPROVED', description: 'Code approved' },
    },
    {
      from: 'code_review',
      to: 'code_revision',
      condition: { type: 'verdict', verdict: 'NEEDS_REVISION', description: 'Code needs fixes' },
    },
    {
      from: 'code_revision',
      to: 'code_review',
      condition: { type: 'complete', description: 'Code revised' },
    },
    // Completion
    {
      from: 'documentation',
      to: 'documentation', // Terminal
      condition: { type: 'complete', description: 'Workflow complete' },
    },
  ],
  entryStep: 'architecture',
  completionStep: 'documentation',
  maxDuration: 3600000, // 1 hour
  maxRevisions: 3,
};

/**
 * Review-only workflow: reviewer examines existing code.
 */
const reviewTemplate: WorkflowTemplate = {
  name: 'review',
  description: 'Review-only workflow for existing code. Reviewer analyzes and provides feedback.',
  version: '1.0.0',
  roles: ['reviewer'],
  steps: [
    {
      id: 'code_analysis',
      description: 'Reviewer analyzes the codebase',
      agent: 'reviewer',
      type: 'review',
      inputTypes: ['task'],
      outputType: 'review',
      maxIterations: 1,
      timeout: 600000,
      optional: false,
    },
    {
      id: 'summary',
      description: 'Reviewer creates summary report',
      agent: 'reviewer',
      type: 'synthesis',
      inputTypes: ['review'],
      outputType: 'result',
      maxIterations: 1,
      timeout: 300000,
      optional: false,
    },
  ],
  transitions: [
    {
      from: 'code_analysis',
      to: 'summary',
      condition: { type: 'complete', description: 'Analysis complete' },
    },
    {
      from: 'summary',
      to: 'summary', // Terminal
      condition: { type: 'complete', description: 'Workflow complete' },
    },
  ],
  entryStep: 'code_analysis',
  completionStep: 'summary',
  maxDuration: 900000, // 15 minutes
  maxRevisions: 1,
};

/**
 * Full workflow: all agents collaborating on complex tasks.
 */
const fullTemplate: WorkflowTemplate = {
  name: 'full',
  description: 'Full workflow with all agents. Researcher gathers context, architect designs, developer implements, reviewer validates.',
  version: '1.0.0',
  roles: ['researcher', 'architect', 'developer', 'reviewer'],
  steps: [
    {
      id: 'research',
      description: 'Researcher gathers context and prior art',
      agent: 'researcher',
      type: 'work',
      inputTypes: ['task'],
      outputType: 'finding',
      maxIterations: 1,
      timeout: 600000,
      optional: false,
    },
    {
      id: 'architecture',
      description: 'Architect creates design based on research',
      agent: 'architect',
      type: 'work',
      inputTypes: ['finding'],
      outputType: 'design',
      maxIterations: 1,
      timeout: 600000,
      optional: false,
    },
    {
      id: 'design_review',
      description: 'Reviewer evaluates design',
      agent: 'reviewer',
      type: 'review',
      inputTypes: ['design'],
      outputType: 'review',
      maxIterations: 1,
      timeout: 300000,
      optional: false,
    },
    {
      id: 'design_revision',
      description: 'Architect revises design',
      agent: 'architect',
      type: 'work',
      inputTypes: ['review'],
      outputType: 'design',
      maxIterations: 2,
      timeout: 600000,
      optional: true,
    },
    {
      id: 'implementation',
      description: 'Developer implements the design',
      agent: 'developer',
      type: 'work',
      inputTypes: ['design'],
      outputType: 'artifact',
      maxIterations: 1,
      timeout: 1800000,
      optional: false,
    },
    {
      id: 'code_review',
      description: 'Reviewer checks implementation',
      agent: 'reviewer',
      type: 'review',
      inputTypes: ['artifact'],
      outputType: 'review',
      maxIterations: 1,
      timeout: 300000,
      optional: false,
    },
    {
      id: 'code_revision',
      description: 'Developer fixes issues',
      agent: 'developer',
      type: 'work',
      inputTypes: ['review'],
      outputType: 'artifact',
      maxIterations: 3,
      timeout: 900000,
      optional: true,
    },
    {
      id: 'documentation',
      description: 'Developer creates documentation',
      agent: 'developer',
      type: 'work',
      inputTypes: ['artifact'],
      outputType: 'artifact',
      maxIterations: 1,
      timeout: 600000,
      optional: false,
    },
    {
      id: 'final_synthesis',
      description: 'Combine all outputs into final result',
      agent: 'researcher',
      type: 'synthesis',
      inputTypes: ['finding', 'design', 'artifact', 'review'],
      outputType: 'result',
      maxIterations: 1,
      timeout: 300000,
      optional: false,
    },
  ],
  transitions: [
    // Research phase
    {
      from: 'research',
      to: 'architecture',
      condition: { type: 'complete', description: 'Research complete' },
    },
    // Design phase
    {
      from: 'architecture',
      to: 'design_review',
      condition: { type: 'complete', description: 'Design created' },
    },
    {
      from: 'design_review',
      to: 'implementation',
      condition: { type: 'verdict', verdict: 'APPROVED', description: 'Design approved' },
    },
    {
      from: 'design_review',
      to: 'design_revision',
      condition: { type: 'verdict', verdict: 'NEEDS_REVISION', description: 'Design needs work' },
    },
    {
      from: 'design_revision',
      to: 'design_review',
      condition: { type: 'complete', description: 'Design revised' },
    },
    // Implementation phase
    {
      from: 'implementation',
      to: 'code_review',
      condition: { type: 'complete', description: 'Implementation complete' },
    },
    {
      from: 'code_review',
      to: 'documentation',
      condition: { type: 'verdict', verdict: 'APPROVED', description: 'Code approved' },
    },
    {
      from: 'code_review',
      to: 'code_revision',
      condition: { type: 'verdict', verdict: 'NEEDS_REVISION', description: 'Code needs fixes' },
    },
    {
      from: 'code_revision',
      to: 'code_review',
      condition: { type: 'complete', description: 'Code revised' },
    },
    // Final phase
    {
      from: 'documentation',
      to: 'final_synthesis',
      condition: { type: 'complete', description: 'Documentation complete' },
    },
    {
      from: 'final_synthesis',
      to: 'final_synthesis', // Terminal
      condition: { type: 'complete', description: 'Workflow complete' },
    },
  ],
  entryStep: 'research',
  completionStep: 'final_synthesis',
  maxDuration: 7200000, // 2 hours
  maxRevisions: 3,
};

// =============================================================================
// Template Registry
// =============================================================================

/**
 * All available workflow templates.
 */
const WORKFLOW_TEMPLATES: Map<string, WorkflowTemplate> = new Map([
  ['research', researchTemplate],
  ['implement', implementTemplate],
  ['development', implementTemplate], // Alias for spec compatibility
  ['review', reviewTemplate],
  ['full', fullTemplate],
  ['architecture', fullTemplate], // Alias - full workflow includes all agents
]);

// =============================================================================
// Public API
// =============================================================================

/**
 * Get a workflow template by name.
 *
 * @param name - The template name
 * @returns Result with the template or an error
 *
 * @example
 * const result = getWorkflowTemplate('research');
 * if (result.ok) {
 *   console.log(result.value.description);
 * }
 */
export function getWorkflowTemplate(name: string): Result<WorkflowTemplate, WorkflowError> {
  const template = WORKFLOW_TEMPLATES.get(name);

  if (!template) {
    return err(
      createWorkflowError(
        'TEMPLATE_NOT_FOUND',
        `Workflow template not found: ${name}. Available: ${Array.from(WORKFLOW_TEMPLATES.keys()).join(', ')}`,
        name
      )
    );
  }

  return ok(template);
}

/**
 * List all available workflow templates.
 *
 * @returns Array of template info objects
 */
export function listWorkflowTemplates(): Array<{ name: string; description: string; roles: AgentRole[] }> {
  return Array.from(WORKFLOW_TEMPLATES.values()).map(t => ({
    name: t.name,
    description: t.description,
    roles: t.roles,
  }));
}

/**
 * Validate a workflow template structure.
 *
 * @param template - The template to validate
 * @returns Result with void on success, error on failure
 */
export function validateWorkflow(template: WorkflowTemplate): Result<void, WorkflowError> {
  // Check required fields
  if (!template.name || typeof template.name !== 'string') {
    return err(createWorkflowError('INVALID_TEMPLATE', 'Template must have a name'));
  }

  if (!template.description || typeof template.description !== 'string') {
    return err(createWorkflowError('INVALID_TEMPLATE', 'Template must have a description', template.name));
  }

  if (!Array.isArray(template.roles) || template.roles.length === 0) {
    return err(createWorkflowError('INVALID_TEMPLATE', 'Template must have at least one role', template.name));
  }

  if (!Array.isArray(template.steps) || template.steps.length === 0) {
    return err(createWorkflowError('INVALID_TEMPLATE', 'Template must have at least one step', template.name));
  }

  if (!Array.isArray(template.transitions) || template.transitions.length === 0) {
    return err(createWorkflowError('INVALID_TEMPLATE', 'Template must have at least one transition', template.name));
  }

  // Validate entry step exists
  const stepIds = new Set(template.steps.map(s => s.id));
  if (!stepIds.has(template.entryStep)) {
    return err(
      createWorkflowError(
        'INVALID_TEMPLATE',
        `Entry step '${template.entryStep}' not found in steps`,
        template.name
      )
    );
  }

  // Validate completion step exists
  if (!stepIds.has(template.completionStep)) {
    return err(
      createWorkflowError(
        'INVALID_TEMPLATE',
        `Completion step '${template.completionStep}' not found in steps`,
        template.name
      )
    );
  }

  // Validate all step agents are in roles
  const roleSet = new Set(template.roles);
  for (const step of template.steps) {
    if (!roleSet.has(step.agent)) {
      return err(
        createWorkflowError(
          'INVALID_TEMPLATE',
          `Step '${step.id}' uses agent '${step.agent}' which is not in roles`,
          template.name,
          step.id
        )
      );
    }
  }

  // Validate transitions reference valid steps
  for (const transition of template.transitions) {
    if (!stepIds.has(transition.from)) {
      return err(
        createWorkflowError(
          'INVALID_TRANSITION',
          `Transition 'from' step '${transition.from}' not found`,
          template.name
        )
      );
    }
    if (!stepIds.has(transition.to)) {
      return err(
        createWorkflowError(
          'INVALID_TRANSITION',
          `Transition 'to' step '${transition.to}' not found`,
          template.name
        )
      );
    }
  }

  return ok(undefined);
}

/**
 * Create a new workflow instance from a template.
 *
 * @param templateName - Name of the template to instantiate
 * @param sessionId - Session ID for this instance
 * @param goal - User-provided goal
 * @returns Result with the new instance or an error
 */
export function createWorkflowInstance(
  templateName: string,
  sessionId: string,
  goal: string
): Result<WorkflowInstance, WorkflowError> {
  const templateResult = getWorkflowTemplate(templateName);
  if (!templateResult.ok) {
    return templateResult;
  }

  const template = templateResult.value;

  const instance: WorkflowInstance = {
    templateName: template.name,
    sessionId,
    goal,
    currentStep: template.entryStep,
    stepHistory: [],
    iterationCounts: new Map(),
    createdAt: new Date().toISOString(),
    status: 'running',
  };

  return ok(instance);
}

/**
 * Get the next step based on current step and result.
 *
 * @param instance - The workflow instance
 * @param currentStep - Current step ID
 * @param result - Result from the current step (verdict if review)
 * @returns Result with next step ID or null if complete, or an error
 */
export function getNextStep(
  instance: WorkflowInstance,
  currentStep: string,
  result: { verdict?: ReviewVerdict }
): Result<string | null, WorkflowError> {
  const templateResult = getWorkflowTemplate(instance.templateName);
  if (!templateResult.ok) {
    return templateResult;
  }

  const template = templateResult.value;

  // If we're at the completion step, workflow is done
  if (currentStep === template.completionStep) {
    return ok(null);
  }

  // Find matching transition
  const transitions = template.transitions.filter(t => t.from === currentStep);

  if (transitions.length === 0) {
    return err(
      createWorkflowError(
        'INVALID_TRANSITION',
        `No transitions defined from step '${currentStep}'`,
        instance.templateName,
        currentStep
      )
    );
  }

  // Check for verdict-based transitions first
  if (result.verdict) {
    const verdictTransition = transitions.find(
      t => t.condition.type === 'verdict' && t.condition.verdict === result.verdict
    );
    if (verdictTransition) {
      // Check iteration limits for revision steps
      const targetStep = template.steps.find(s => s.id === verdictTransition.to);
      if (targetStep) {
        const iterCount = instance.iterationCounts.get(verdictTransition.to) || 0;
        if (iterCount >= targetStep.maxIterations) {
          // Max iterations reached, find an alternative (usually completion or forced approval)
          const completeTransition = transitions.find(
            t => t.condition.type === 'complete' ||
                 (t.condition.type === 'verdict' && t.condition.verdict === 'REJECTED')
          );
          if (completeTransition) {
            return ok(completeTransition.to);
          }
        }
      }
      return ok(verdictTransition.to);
    }
  }

  // Fall back to complete transition
  const completeTransition = transitions.find(t => t.condition.type === 'complete');
  if (completeTransition) {
    return ok(completeTransition.to);
  }

  // Default transition
  const defaultTransition = transitions.find(t => t.condition.type === 'default');
  if (defaultTransition) {
    return ok(defaultTransition.to);
  }

  // Use first available transition as fallback
  return ok(transitions[0].to);
}

/**
 * Check if a workflow instance is complete.
 *
 * @param instance - The workflow instance to check
 * @returns true if the workflow is complete
 */
export function isWorkflowComplete(instance: WorkflowInstance): boolean {
  if (instance.status === 'complete' || instance.status === 'failed' || instance.status === 'timeout') {
    return true;
  }

  const templateResult = getWorkflowTemplate(instance.templateName);
  if (!templateResult.ok) {
    return false;
  }

  const template = templateResult.value;

  // Check if completion step has been executed
  const completionExecuted = instance.stepHistory.some(
    record => record.stepId === template.completionStep && record.status === 'complete'
  );

  return completionExecuted;
}

/**
 * Get a step definition by ID from a template.
 *
 * @param templateName - Template name
 * @param stepId - Step ID to find
 * @returns Result with the step or an error
 */
export function getStepById(
  templateName: string,
  stepId: string
): Result<WorkflowStep, WorkflowError> {
  const templateResult = getWorkflowTemplate(templateName);
  if (!templateResult.ok) {
    return templateResult;
  }

  const step = templateResult.value.steps.find(s => s.id === stepId);
  if (!step) {
    return err(
      createWorkflowError(
        'STEP_NOT_FOUND',
        `Step '${stepId}' not found in template '${templateName}'`,
        templateName,
        stepId
      )
    );
  }

  return ok(step);
}

/**
 * Get all transitions from a specific step.
 *
 * @param templateName - Template name
 * @param stepId - Step ID
 * @returns Result with array of transitions or an error
 */
export function getTransitionsFromStep(
  templateName: string,
  stepId: string
): Result<StepTransition[], WorkflowError> {
  const templateResult = getWorkflowTemplate(templateName);
  if (!templateResult.ok) {
    return templateResult;
  }

  const transitions = templateResult.value.transitions.filter(t => t.from === stepId);
  return ok(transitions);
}
