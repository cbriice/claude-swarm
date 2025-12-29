/**
 * Claude Swarm - Workflow Engine
 *
 * Executes workflow steps and manages workflow state transitions.
 * Integrates with workflow templates to drive agent coordination.
 */

import {
  type AgentRole,
  type AgentMessage,
  type Result,
  ok,
  err,
  generateId,
  now,
} from '../types.js';

import {
  type WorkflowInstance,
  type WorkflowStep,
  type StepExecutionRecord,
  type StepOutput,
  type ReviewVerdict,
  type WorkflowError,
  type WorkflowErrorCode,
  getWorkflowTemplate,
  getNextStep,
  isWorkflowComplete,
  getStepById,
} from './templates.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Result of executing a workflow step.
 */
export interface StepExecutionResult {
  /** Step that was executed */
  stepId: string;
  /** Whether execution succeeded */
  success: boolean;
  /** Output from the step */
  output?: StepOutput;
  /** Error message if failed */
  error?: string;
  /** Messages produced by the step */
  messages: AgentMessage[];
}

/**
 * Routing decision for a message within a workflow.
 */
export interface RoutingDecision {
  /** Target agent for the message */
  to: AgentRole;
  /** Message to send */
  message: AgentMessage;
  /** Step transition (if any) */
  stepTransition?: {
    from: string;
    to: string;
  };
}

/**
 * Configuration for workflow execution.
 */
export interface WorkflowExecutionConfig {
  /** Whether to allow parallel step execution */
  allowParallel?: boolean;
  /** Override max duration (ms) */
  maxDuration?: number;
  /** Override max revisions */
  maxRevisions?: number;
}

/**
 * Final result of a completed workflow.
 */
export interface WorkflowResult {
  /** Whether workflow succeeded */
  success: boolean;
  /** Summary of what was accomplished */
  summary: string;
  /** Artifacts produced (file paths or message IDs) */
  artifacts: string[];
  /** Research findings (if applicable) */
  findings?: string[];
  /** Review summaries (if applicable) */
  reviews?: string[];
  /** Total execution time in ms */
  executionTime: number;
  /** Number of steps executed */
  stepsExecuted: number;
  /** Number of revision cycles */
  revisionCount: number;
}

// =============================================================================
// Error Helpers
// =============================================================================

function createEngineError(
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
// Step Execution
// =============================================================================

/**
 * Start execution of a workflow step.
 *
 * @param instance - The workflow instance
 * @param stepId - Step to start executing
 * @returns Updated instance with step recorded as started
 */
export function startStep(
  instance: WorkflowInstance,
  stepId: string
): Result<WorkflowInstance, WorkflowError> {
  const stepResult = getStepById(instance.templateName, stepId);
  if (!stepResult.ok) {
    return stepResult;
  }

  const step = stepResult.value;

  // Check iteration limit
  const currentIterations = instance.iterationCounts.get(stepId) || 0;
  if (currentIterations >= step.maxIterations) {
    return err(
      createEngineError(
        'MAX_ITERATIONS_EXCEEDED',
        `Step '${stepId}' has reached maximum iterations (${step.maxIterations})`,
        instance.templateName,
        stepId
      )
    );
  }

  // Create execution record
  const record: StepExecutionRecord = {
    stepId,
    startedAt: now(),
    status: 'running',
    iteration: currentIterations + 1,
  };

  // Update instance
  const updatedInstance: WorkflowInstance = {
    ...instance,
    currentStep: stepId,
    stepHistory: [...instance.stepHistory, record],
    iterationCounts: new Map(instance.iterationCounts).set(stepId, currentIterations + 1),
  };

  return ok(updatedInstance);
}

/**
 * Complete execution of a workflow step.
 *
 * @param instance - The workflow instance
 * @param stepId - Step that completed
 * @param output - Output from the step
 * @returns Updated instance with step marked complete
 */
export function completeStep(
  instance: WorkflowInstance,
  stepId: string,
  output?: StepOutput
): Result<WorkflowInstance, WorkflowError> {
  // Find the running execution record
  const runningIndex = instance.stepHistory.findIndex(
    r => r.stepId === stepId && r.status === 'running'
  );

  if (runningIndex === -1) {
    return err(
      createEngineError(
        'STEP_NOT_FOUND',
        `No running step '${stepId}' found in history`,
        instance.templateName,
        stepId
      )
    );
  }

  // Update the record
  const updatedHistory = [...instance.stepHistory];
  updatedHistory[runningIndex] = {
    ...updatedHistory[runningIndex],
    completedAt: now(),
    status: 'complete',
    output,
  };

  const updatedInstance: WorkflowInstance = {
    ...instance,
    stepHistory: updatedHistory,
  };

  return ok(updatedInstance);
}

/**
 * Fail a workflow step.
 *
 * @param instance - The workflow instance
 * @param stepId - Step that failed
 * @param error - Error description
 * @returns Updated instance with step marked failed
 */
export function failStep(
  instance: WorkflowInstance,
  stepId: string,
  error: string
): Result<WorkflowInstance, WorkflowError> {
  // Find the running execution record
  const runningIndex = instance.stepHistory.findIndex(
    r => r.stepId === stepId && r.status === 'running'
  );

  if (runningIndex === -1) {
    // Create a new failed record if not found
    const record: StepExecutionRecord = {
      stepId,
      startedAt: now(),
      completedAt: now(),
      status: 'failed',
      iteration: (instance.iterationCounts.get(stepId) || 0) + 1,
      output: {
        type: 'status',
        summary: error,
      },
    };

    return ok({
      ...instance,
      stepHistory: [...instance.stepHistory, record],
    });
  }

  // Update existing record
  const updatedHistory = [...instance.stepHistory];
  updatedHistory[runningIndex] = {
    ...updatedHistory[runningIndex],
    completedAt: now(),
    status: 'failed',
    output: {
      type: 'status',
      summary: error,
    },
  };

  return ok({
    ...instance,
    stepHistory: updatedHistory,
  });
}

/**
 * Skip a workflow step (for optional steps).
 *
 * @param instance - The workflow instance
 * @param stepId - Step to skip
 * @returns Updated instance with step marked skipped
 */
export function skipStep(
  instance: WorkflowInstance,
  stepId: string
): Result<WorkflowInstance, WorkflowError> {
  const stepResult = getStepById(instance.templateName, stepId);
  if (!stepResult.ok) {
    return stepResult;
  }

  const step = stepResult.value;
  if (!step.optional) {
    return err(
      createEngineError(
        'INVALID_TRANSITION',
        `Cannot skip non-optional step '${stepId}'`,
        instance.templateName,
        stepId
      )
    );
  }

  const record: StepExecutionRecord = {
    stepId,
    startedAt: now(),
    completedAt: now(),
    status: 'skipped',
    iteration: 0,
  };

  return ok({
    ...instance,
    stepHistory: [...instance.stepHistory, record],
  });
}

// =============================================================================
// Workflow State Management
// =============================================================================

/**
 * Transition workflow to the next step.
 *
 * @param instance - Current workflow instance
 * @param result - Result from current step (including verdict if review)
 * @returns Updated instance with new current step
 */
export function transitionWorkflow(
  instance: WorkflowInstance,
  result: { verdict?: ReviewVerdict }
): Result<WorkflowInstance, WorkflowError> {
  const nextStepResult = getNextStep(instance, instance.currentStep, result);
  if (!nextStepResult.ok) {
    return nextStepResult;
  }

  const nextStep = nextStepResult.value;

  // If no next step, workflow is complete
  if (nextStep === null) {
    return ok({
      ...instance,
      status: 'complete',
    });
  }

  // Update current step
  return ok({
    ...instance,
    currentStep: nextStep,
  });
}

/**
 * Mark workflow as failed.
 *
 * @param instance - The workflow instance
 * @param reason - Reason for failure
 * @returns Updated instance marked as failed
 */
export function failWorkflow(
  instance: WorkflowInstance,
  _reason: string
): WorkflowInstance {
  return {
    ...instance,
    status: 'failed',
  };
}

/**
 * Mark workflow as timed out.
 *
 * @param instance - The workflow instance
 * @returns Updated instance marked as timed out
 */
export function timeoutWorkflow(instance: WorkflowInstance): WorkflowInstance {
  return {
    ...instance,
    status: 'timeout',
  };
}

/**
 * Check if workflow has exceeded max duration.
 *
 * @param instance - The workflow instance
 * @param config - Optional execution config overrides
 * @returns true if workflow has timed out
 */
export function checkTimeout(
  instance: WorkflowInstance,
  config?: WorkflowExecutionConfig
): Result<boolean, WorkflowError> {
  const templateResult = getWorkflowTemplate(instance.templateName);
  if (!templateResult.ok) {
    return templateResult;
  }

  const maxDuration = config?.maxDuration ?? templateResult.value.maxDuration;
  const elapsed = Date.now() - new Date(instance.createdAt).getTime();

  return ok(elapsed > maxDuration);
}

// =============================================================================
// Message Creation
// =============================================================================

/**
 * Create an initial task message for a workflow.
 *
 * @param instance - The workflow instance
 * @param additionalMetadata - Extra metadata to include
 * @returns The task message
 */
export function createInitialTaskMessage(
  instance: WorkflowInstance,
  additionalMetadata?: Record<string, unknown>
): Result<AgentMessage, WorkflowError> {
  const templateResult = getWorkflowTemplate(instance.templateName);
  if (!templateResult.ok) {
    return templateResult;
  }

  const template = templateResult.value;
  const entryStep = template.steps.find(s => s.id === template.entryStep);

  if (!entryStep) {
    return err(
      createEngineError(
        'STEP_NOT_FOUND',
        `Entry step '${template.entryStep}' not found`,
        instance.templateName
      )
    );
  }

  const message: AgentMessage = {
    id: generateId(),
    timestamp: now(),
    from: 'orchestrator',
    to: entryStep.agent,
    type: 'task',
    priority: 'normal',
    content: {
      subject: `${template.name} Workflow Task`,
      body: instance.goal,
      metadata: {
        workflow: template.name,
        sessionId: instance.sessionId,
        step: entryStep.id,
        ...additionalMetadata,
      },
    },
    requiresResponse: true,
  };

  return ok(message);
}

/**
 * Create a task message for a specific step.
 *
 * @param instance - The workflow instance
 * @param stepId - Target step
 * @param body - Message body
 * @param metadata - Additional metadata
 * @returns The task message
 */
export function createStepTaskMessage(
  instance: WorkflowInstance,
  stepId: string,
  body: string,
  metadata?: Record<string, unknown>
): Result<AgentMessage, WorkflowError> {
  const stepResult = getStepById(instance.templateName, stepId);
  if (!stepResult.ok) {
    return stepResult;
  }

  const step = stepResult.value;

  const message: AgentMessage = {
    id: generateId(),
    timestamp: now(),
    from: 'orchestrator',
    to: step.agent,
    type: 'task',
    priority: 'normal',
    content: {
      subject: step.description,
      body,
      metadata: {
        workflow: instance.templateName,
        sessionId: instance.sessionId,
        step: stepId,
        iteration: instance.iterationCounts.get(stepId) || 0,
        ...metadata,
      },
    },
    requiresResponse: true,
  };

  return ok(message);
}

// =============================================================================
// Message Routing
// =============================================================================

/**
 * Determine routing for a message based on workflow state.
 *
 * @param instance - The workflow instance
 * @param message - Message to route
 * @returns Routing decision(s)
 */
export function routeMessage(
  instance: WorkflowInstance,
  message: AgentMessage
): Result<RoutingDecision[], WorkflowError> {
  const templateResult = getWorkflowTemplate(instance.templateName);
  if (!templateResult.ok) {
    return templateResult;
  }

  const template = templateResult.value;
  const currentStepDef = template.steps.find(s => s.id === instance.currentStep);

  if (!currentStepDef) {
    return err(
      createEngineError(
        'STEP_NOT_FOUND',
        `Current step '${instance.currentStep}' not found`,
        instance.templateName,
        instance.currentStep
      )
    );
  }

  // Extract verdict from message if present
  const verdict = message.content.metadata?.verdict as ReviewVerdict | undefined;

  // Determine next step
  const nextStepResult = getNextStep(instance, instance.currentStep, { verdict });
  if (!nextStepResult.ok) {
    return nextStepResult;
  }

  const nextStep = nextStepResult.value;

  // If workflow complete, no routing needed
  if (nextStep === null) {
    return ok([]);
  }

  // Get next step definition
  const nextStepDef = template.steps.find(s => s.id === nextStep);
  if (!nextStepDef) {
    return err(
      createEngineError(
        'STEP_NOT_FOUND',
        `Next step '${nextStep}' not found`,
        instance.templateName,
        nextStep
      )
    );
  }

  // Create routing decision
  const routedMessage: AgentMessage = {
    id: generateId(),
    timestamp: now(),
    from: message.from,
    to: nextStepDef.agent,
    type: message.type,
    priority: message.priority,
    content: {
      ...message.content,
      metadata: {
        ...message.content.metadata,
        routedFrom: instance.currentStep,
        routedTo: nextStep,
      },
    },
    threadId: message.threadId,
    requiresResponse: true,
  };

  const decision: RoutingDecision = {
    to: nextStepDef.agent,
    message: routedMessage,
    stepTransition: {
      from: instance.currentStep,
      to: nextStep,
    },
  };

  return ok([decision]);
}

// =============================================================================
// Result Synthesis
// =============================================================================

/**
 * Synthesize the final result from a completed workflow.
 *
 * @param instance - The completed workflow instance
 * @returns The workflow result
 */
export function synthesizeResult(instance: WorkflowInstance): Result<WorkflowResult, WorkflowError> {
  if (!isWorkflowComplete(instance)) {
    return err(
      createEngineError(
        'INVALID_TRANSITION',
        'Cannot synthesize result for incomplete workflow',
        instance.templateName
      )
    );
  }

  const executionTime = Date.now() - new Date(instance.createdAt).getTime();

  // Count completed steps
  const completedSteps = instance.stepHistory.filter(r => r.status === 'complete');

  // Count revision cycles (steps executed more than once)
  let revisionCount = 0;
  const stepCounts = new Map<string, number>();
  for (const record of instance.stepHistory) {
    if (record.status === 'complete') {
      const count = (stepCounts.get(record.stepId) || 0) + 1;
      stepCounts.set(record.stepId, count);
      if (count > 1) {
        revisionCount++;
      }
    }
  }

  // Extract findings from finding outputs
  const findings: string[] = [];
  const reviews: string[] = [];
  const artifacts: string[] = [];

  for (const record of instance.stepHistory) {
    if (record.output) {
      if (record.output.type === 'finding' && record.output.summary) {
        findings.push(record.output.summary);
      } else if (record.output.type === 'review' && record.output.summary) {
        reviews.push(record.output.summary);
      } else if (record.output.type === 'artifact' && record.output.summary) {
        artifacts.push(record.output.summary);
      }
    }
  }

  const result: WorkflowResult = {
    success: instance.status === 'complete',
    summary: `Workflow '${instance.templateName}' ${instance.status}. Goal: ${instance.goal}`,
    artifacts,
    findings: findings.length > 0 ? findings : undefined,
    reviews: reviews.length > 0 ? reviews : undefined,
    executionTime,
    stepsExecuted: completedSteps.length,
    revisionCount,
  };

  return ok(result);
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get the current step definition for a workflow instance.
 *
 * @param instance - The workflow instance
 * @returns The current step definition
 */
export function getCurrentStep(instance: WorkflowInstance): Result<WorkflowStep, WorkflowError> {
  return getStepById(instance.templateName, instance.currentStep);
}

/**
 * Get all agents currently needed for the workflow.
 *
 * @param instance - The workflow instance
 * @returns Array of agent roles needed
 */
export function getActiveAgents(instance: WorkflowInstance): Result<AgentRole[], WorkflowError> {
  const templateResult = getWorkflowTemplate(instance.templateName);
  if (!templateResult.ok) {
    return templateResult;
  }

  return ok(templateResult.value.roles);
}

/**
 * Check if a specific step has been completed.
 *
 * @param instance - The workflow instance
 * @param stepId - Step to check
 * @returns true if step has been completed
 */
export function isStepCompleted(instance: WorkflowInstance, stepId: string): boolean {
  return instance.stepHistory.some(
    r => r.stepId === stepId && r.status === 'complete'
  );
}

/**
 * Get the execution record for a step.
 *
 * @param instance - The workflow instance
 * @param stepId - Step to get record for
 * @returns Array of execution records (may have multiple for revision cycles)
 */
export function getStepExecutions(
  instance: WorkflowInstance,
  stepId: string
): StepExecutionRecord[] {
  return instance.stepHistory.filter(r => r.stepId === stepId);
}

/**
 * Get workflow progress as a percentage.
 *
 * @param instance - The workflow instance
 * @returns Progress from 0 to 100
 */
export function getWorkflowProgress(instance: WorkflowInstance): Result<number, WorkflowError> {
  const templateResult = getWorkflowTemplate(instance.templateName);
  if (!templateResult.ok) {
    return templateResult;
  }

  const totalSteps = templateResult.value.steps.filter(s => !s.optional).length;
  const completedSteps = new Set(
    instance.stepHistory
      .filter(r => r.status === 'complete')
      .map(r => r.stepId)
  );

  // Count only required steps that are complete
  const requiredCompleted = templateResult.value.steps
    .filter(s => !s.optional && completedSteps.has(s.id))
    .length;

  const progress = Math.round((requiredCompleted / totalSteps) * 100);
  return ok(Math.min(100, progress));
}

/**
 * Get a summary of the current workflow state.
 */
export function getWorkflowSummary(instance: WorkflowInstance): Result<{
  templateName: string;
  status: string;
  currentStep: string;
  progress: number;
  stepsCompleted: number;
  totalSteps: number;
  elapsedTime: number;
}, WorkflowError> {
  const templateResult = getWorkflowTemplate(instance.templateName);
  if (!templateResult.ok) {
    return templateResult;
  }

  const progressResult = getWorkflowProgress(instance);
  if (!progressResult.ok) {
    return progressResult;
  }

  const completedSteps = new Set(
    instance.stepHistory
      .filter(r => r.status === 'complete')
      .map(r => r.stepId)
  ).size;

  return ok({
    templateName: instance.templateName,
    status: instance.status,
    currentStep: instance.currentStep,
    progress: progressResult.value,
    stepsCompleted: completedSteps,
    totalSteps: templateResult.value.steps.length,
    elapsedTime: Date.now() - new Date(instance.createdAt).getTime(),
  });
}
