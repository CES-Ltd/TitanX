/**
 * @license Apache-2.0
 * Agent Workflow Builder — per-handler parameter schema registry.
 *
 * Declarative schemas drive the typed form renderer in
 * NodeParameterForm.tsx. Each entry lists the known parameter keys
 * for a node type with label / kind / placeholder / default metadata.
 * Unknown types fall back to the JSON textarea editor, so the
 * registry can stay partial without breaking authoring.
 *
 * Kinds the form supports:
 *   - 'string'    — Arco Input (short text)
 *   - 'textarea'  — Arco Input.TextArea (for prompt templates etc.)
 *   - 'number'    — Arco InputNumber
 *   - 'boolean'   — Arco Switch
 *   - 'stringArray' — newline-separated Input.TextArea, serialized as string[]
 *   - 'enum'      — Arco Select with `options`
 *   - 'json'      — Nested JSON subtree (outputSchema etc.). Monaco-style
 *                   mini textarea with parse validation.
 *
 * If a parameter present on the node doesn't have a schema entry,
 * the form still surfaces it read-only with a "raw JSON" kind so
 * authoring-by-hand lingers forward-compatibly.
 */

export type ParameterKind = 'string' | 'textarea' | 'number' | 'boolean' | 'stringArray' | 'enum' | 'json';

export type ParameterFieldSchema = {
  key: string;
  label: string;
  kind: ParameterKind;
  placeholder?: string;
  description?: string;
  /** For kind='enum'. */
  options?: Array<{ value: string; label: string }>;
  /** When set, the form pre-fills a new node with this value. */
  defaultValue?: unknown;
};

export type HandlerSchema = {
  /** Operator-facing short description. Shown above the form. */
  description?: string;
  fields: ParameterFieldSchema[];
};

const promptTemplateField: ParameterFieldSchema = {
  key: 'promptTemplate',
  label: 'Prompt template',
  kind: 'textarea',
  placeholder: 'Write the instruction the agent sees at this step…',
  description: 'Rendered against the run state bag — supports {{var.X}} substitution.',
};
const outputSchemaField: ParameterFieldSchema = {
  key: 'outputSchema',
  label: 'Output schema (optional)',
  kind: 'json',
  placeholder: '{"approved": "boolean", "issues": "string[]"}',
  description: 'Hint the LLM about the desired response shape. Passed through as an authoring aid.',
};
const completionCriteriaField: ParameterFieldSchema = {
  key: 'completionCriteria',
  label: 'Completion criteria (optional)',
  kind: 'string',
  placeholder: 'What does "done" look like for this step?',
};

const cwdField: ParameterFieldSchema = {
  key: 'cwd',
  label: 'Working directory',
  kind: 'string',
  placeholder: 'Absolute path. Leave blank to use the process cwd.',
};
const timeoutField: ParameterFieldSchema = {
  key: 'timeoutMs',
  label: 'Timeout (ms)',
  kind: 'number',
  placeholder: '30000',
  defaultValue: 30000,
};
const argsField: ParameterFieldSchema = {
  key: 'args',
  label: 'Extra args (one per line)',
  kind: 'stringArray',
  placeholder: '--stat\n-U3',
  description: 'Appended after the required git subcommand. Supports {{var.X}}.',
};

/**
 * Typed-form registry. Keyed by `WorkflowNode.type`. Missing types
 * fall through to the JSON editor automatically.
 */
export const HANDLER_PARAMETER_SCHEMAS: Record<string, HandlerSchema> = {
  'prompt.plan': {
    description: 'Defer the next LLM turn; the agent produces a plan in response to the template below.',
    fields: [promptTemplateField, outputSchemaField, completionCriteriaField],
  },
  'prompt.create_todo': {
    description: 'Ask the agent to produce an array of todos. Schema defaults to an array of {title, ownerHint?}.',
    fields: [promptTemplateField, outputSchemaField, completionCriteriaField],
  },
  'prompt.review': {
    description: 'Gate step — the agent reviews prior output and returns {approved, issues}.',
    fields: [promptTemplateField, outputSchemaField, completionCriteriaField],
  },
  'prompt.freeform': {
    description: 'Generic prompt step with a custom template.',
    fields: [promptTemplateField, outputSchemaField, completionCriteriaField],
  },

  'tool.git.status': {
    description: 'Runs `git status --porcelain` in the resolved working directory.',
    fields: [cwdField, timeoutField],
  },
  'tool.git.diff': {
    description: 'Runs `git diff [args...]` — append flags like --stat, -U3, refs, paths.',
    fields: [argsField, cwdField, timeoutField],
  },
  'tool.git.commit': {
    description: 'Runs `git commit -m <message> [args...]`. Message supports {{var.X}} substitution.',
    fields: [
      {
        key: 'message',
        label: 'Commit message',
        kind: 'textarea',
        placeholder: 'e.g. "feat(x): short summary\\n\\nDetails..."',
        description: 'Supports {{var.X}}. Fails the step if the rendered message is empty.',
      },
      argsField,
      cwdField,
      timeoutField,
    ],
  },
  'tool.git.push': {
    description: 'Runs `git push [args...]` — append remote + branch args.',
    fields: [argsField, cwdField, timeoutField],
  },

  'sprint.create_task': {
    description: 'Creates a team task via TaskManager. `teamId` comes from the dispatcher context.',
    fields: [
      { key: 'subject', label: 'Subject', kind: 'string', placeholder: 'Short title (supports {{var.X}})' },
      { key: 'description', label: 'Description', kind: 'textarea' },
      {
        key: 'owner',
        label: 'Owner (agent name)',
        kind: 'string',
        placeholder: 'Agent name, not slotId',
      },
    ],
  },
  'sprint.update_task': {
    description: 'Updates an existing task. taskId must be present after {{var.X}} render.',
    fields: [
      { key: 'taskId', label: 'Task ID', kind: 'string', placeholder: '{{var.taskId}}' },
      {
        key: 'status',
        label: 'Status',
        kind: 'enum',
        options: [
          { value: '', label: '(unchanged)' },
          { value: 'pending', label: 'pending' },
          { value: 'in_progress', label: 'in progress' },
          { value: 'completed', label: 'completed' },
          { value: 'deleted', label: 'deleted' },
        ],
      },
      { key: 'owner', label: 'New owner', kind: 'string' },
      { key: 'progressNotes', label: 'Progress notes', kind: 'textarea' },
    ],
  },
  'sprint.list_tasks': {
    description: "No parameters — returns an array of the team's current tasks.",
    fields: [],
  },

  condition: {
    description: 'Evaluates an expression against the run state and sets __branch to "true"/"false".',
    fields: [
      {
        key: 'condition',
        label: 'Expression',
        kind: 'string',
        placeholder: '$input.approved',
        description: 'Simple field-ref or literal. Downstream edges filter by fromOutput match.',
      },
    ],
  },
  loop: {
    description: 'Iterates over an array field in the upstream output.',
    fields: [{ key: 'arrayField', label: 'Array field', kind: 'string', placeholder: 'items', defaultValue: 'items' }],
  },

  'parallel.fan_out': { description: 'No parameters — marks a fan-out branch point.', fields: [] },
  'parallel.join': { description: 'No parameters — waits for all incoming edges.', fields: [] },

  'human.approve': {
    description: 'Pauses the run with status=paused. Resume via the admin API to continue.',
    fields: [
      {
        key: 'reason',
        label: 'Approval prompt',
        kind: 'textarea',
        placeholder: 'What does the human need to confirm?',
      },
    ],
  },
  'memory.recall': {
    description: 'Read-only lookup against reasoningBank trajectories; useful before a prompt step.',
    fields: [
      {
        key: 'query',
        label: 'Task description query',
        kind: 'string',
        placeholder: 'Supports {{var.X}}',
      },
      { key: 'limit', label: 'Max results', kind: 'number', defaultValue: 5 },
    ],
  },
  'acp.slash.invoke': {
    description: 'Injects /<command> into the next agent turn. ACP runtime dispatches it.',
    fields: [
      {
        key: 'command',
        label: 'Command name',
        kind: 'string',
        placeholder: 'e.g. compact (no leading slash)',
      },
      {
        key: 'args',
        label: 'Args (one per line, supports {{var.X}})',
        kind: 'stringArray',
      },
    ],
  },

  trigger: { description: 'Entry node — no parameters.', fields: [] },
  webhook: { description: 'External-trigger entry node — no parameters.', fields: [] },
  action: { description: 'Passthrough action node (rarely used directly).', fields: [] },
};

/** Look up a schema; null when the type has no declared schema. */
export function getHandlerSchema(type: string): HandlerSchema | null {
  return HANDLER_PARAMETER_SCHEMAS[type] ?? null;
}
