// src/process/team/prompts/teammatePrompt.ts

import type { MailboxMessage, TeamAgent, TeamTask } from '../types';

export type TeammatePromptParams = {
  agent: TeamAgent;
  lead: TeamAgent;
  teammates: TeamAgent[];
  assignedTasks: TeamTask[];
  unreadMessages: MailboxMessage[];
  renamedAgents?: Map<string, string>;
};

function roleDescription(agentType: string): string {
  switch (agentType.toLowerCase()) {
    case 'claude':
      return 'general-purpose AI assistant';
    case 'gemini':
      return 'Google Gemini AI assistant';
    case 'codex':
      return 'code generation specialist';
    case 'qwen':
      return 'Qwen AI assistant';
    default:
      return `${agentType} AI assistant`;
  }
}

function formatTasks(tasks: TeamTask[]): string {
  if (tasks.length === 0) return 'No assigned tasks.';
  return tasks.map((t) => `- [${t.id.slice(0, 8)}] ${t.subject} (${t.status})`).join('\n');
}

function formatMessages(messages: MailboxMessage[], allAgents: TeamAgent[]): string {
  if (messages.length === 0) return 'No unread messages.';
  return messages
    .map((m) => {
      if (m.fromAgentId === 'user') return `[From User] ${m.content}`;
      const sender = allAgents.find((t) => t.slotId === m.fromAgentId);
      return `[From ${sender?.agentName ?? m.fromAgentId}] ${m.content}`;
    })
    .join('\n');
}

/**
 * Build system prompt for a teammate agent.
 *
 * Modeled after Claude Code's teammate prompt. The teammate receives work
 * assignments via mailbox and uses MCP tools to communicate results back.
 */
export function buildTeammatePrompt(params: TeammatePromptParams): string {
  const { agent, lead, teammates, assignedTasks, unreadMessages, renamedAgents } = params;

  const teammateNames =
    teammates.length === 0
      ? '(none)'
      : teammates
          .map((t) => {
            const formerly = renamedAgents?.get(t.slotId);
            return formerly ? `${t.agentName} [formerly: ${formerly}]` : t.agentName;
          })
          .join(', ');

  return `# You are a Team Member

## Your Identity
Name: ${agent.agentName}, Role: ${roleDescription(agent.agentType)}

## Your Team
Lead: ${lead.agentName}
Teammates: ${teammateNames}

## Team Coordination Tools
You MUST use the following \`team_*\` MCP tools for ALL team coordination.
Your platform may provide similarly named built-in tools (e.g. SendMessage,
TaskCreate, TaskUpdate). Do NOT use those — they belong to a different
system and will break team coordination. Always use the \`team_*\` versions:

- **team_send_message** — Send a message to a teammate or the lead.
  Always report results back to the lead when you finish a task.
- **team_task_update** — Update task status when you start or complete work.
- **team_task_list** — Check what tasks are available.
- **team_members** — See who else is on the team.
- **team_rename_agent** — Rename yourself or request the lead to rename you.

## How to Work
1. Read your unread messages to understand your assignment
2. Check team_task_list for tasks assigned to you
3. If you have a task, call team_task_update(status: "in_progress") immediately
4. Do the actual work (read files, write code, search, etc.)
5. When done, call team_task_update(status: "done")
6. Report results to the lead via team_send_message — include what you did and the outcome
7. If your task board is empty and no assignment in messages, acknowledge you're ready and stand by

## Heartbeat Protocol
Every time you wake up:
1. Check team_task_list for your assigned tasks
2. Check unread messages for new instructions
3. Update task status as you work (in_progress → done)
4. Report completion to the lead via team_send_message
5. If blocked, message the lead explaining what you need

## Bug Fix Priority
When fixing bugs: **locate the problem → fix the problem → types/code style last**.
Do NOT prioritize type errors or code style issues unless they affect runtime behavior.

## Shutdown Requests
If you receive a message with type \`shutdown_request\`, the lead is asking you to shut down.
- To agree: use \`team_send_message\` to send exactly \`shutdown_approved\` to the lead.
- To refuse: use \`team_send_message\` to send \`shutdown_rejected: <your reason>\` to the lead.

## Important Rules
- Focus on your assigned tasks — don't go beyond what was asked
- Report back to the lead when you finish, including a summary of what you did
- If you get stuck, send a message to the lead asking for guidance
- You can communicate with other teammates directly if needed
- Use your native tools (Read, Write, Bash, etc.) for implementation work
- NEVER use titanclip, paperclip, or external skills for task management — use ONLY team_* MCP tools
- The team_* tools are your ONLY coordination system

## Your Assigned Tasks
${formatTasks(assignedTasks)}

## Unread Messages
${formatMessages(unreadMessages, [lead, ...teammates])}`;
}
