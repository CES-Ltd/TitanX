// src/process/team/adapters/xmlFallbackAdapter.ts

import type { ParsedAction, PlatformCapability } from '../types';
import type { AgentPayload, AgentResponse, BuildPayloadParams, TeamPlatformAdapter } from './PlatformAdapter';
import { buildRolePrompt } from './buildRolePrompt';

/**
 * XML fallback instructions for platforms that do NOT support MCP tool use.
 * Only describes XML tag syntax — no mention of MCP tools (those are in the role prompts).
 */
const TEAM_INSTRUCTIONS = `## Team Coordination (XML Fallback)

The team_* MCP tools are NOT available in your current session.
Use these XML tags instead to coordinate with your team:

<send_message to="AgentName">message</send_message>
<task_create subject="..." owner="..." description="..."/>
<task_update task_id="..." status="completed"/>
<spawn_agent name="AgentName" type="agent_type"/>
<idle reason="available" summary="..." completed_task_id="..."/>
<write_plan title="Plan Title"><step>Step 1</step><step>Step 2</step></write_plan>
<reflect plan_id="..." score="0.8">Reflection text</reflect>
<trigger_workflow id="workflow-uuid"/>`;

/** Remove matched XML tag spans from a string and return the remaining text */
function removeXmlSpans(text: string, spans: Array<[number, number]>): string {
  const sortedSpans = [...spans].toSorted((a, b) => a[0] - b[0]);
  let result = '';
  let cursor = 0;
  for (const [start, end] of sortedSpans) {
    result += text.slice(cursor, start);
    cursor = end;
  }
  result += text.slice(cursor);
  return result;
}

/** Extract a named attribute value from an XML tag string, order-independent */
function extractAttr(tag: string, name: string): string | undefined {
  const re = new RegExp(`${name}="([^"]*)"`, 'i');
  const m = tag.match(re);
  return m ? m[1] : undefined;
}

/** Parse XML action tags from response text using regex */
function parseXmlActions(text: string): { actions: ParsedAction[]; consumedSpans: Array<[number, number]> } {
  const actions: ParsedAction[] = [];
  const consumedSpans: Array<[number, number]> = [];

  // <send_message to="AgentName">content</send_message>
  const sendMessageRe = /<send_message\s+to="([^"]+)">([\s\S]*?)<\/send_message>/g;
  for (const match of text.matchAll(sendMessageRe)) {
    actions.push({
      type: 'send_message',
      to: match[1],
      content: match[2].trim(),
    });
    consumedSpans.push([match.index!, match.index! + match[0].length]);
  }

  // <task_create .../> - attributes in any order
  const taskCreateRe = /<task_create\s+[^>]*\/>/g;
  for (const match of text.matchAll(taskCreateRe)) {
    const tag = match[0];
    const subject = extractAttr(tag, 'subject');
    if (!subject) continue; // subject is required
    actions.push({
      type: 'task_create',
      subject,
      owner: extractAttr(tag, 'owner'),
      description: extractAttr(tag, 'description'),
    });
    consumedSpans.push([match.index!, match.index! + match[0].length]);
  }

  // <task_update .../> - attributes in any order
  const taskUpdateRe = /<task_update\s+[^>]*\/>/g;
  for (const match of text.matchAll(taskUpdateRe)) {
    const tag = match[0];
    const taskId = extractAttr(tag, 'task_id');
    if (!taskId) continue; // task_id is required
    actions.push({
      type: 'task_update',
      taskId,
      status: extractAttr(tag, 'status'),
      owner: extractAttr(tag, 'owner'),
    });
    consumedSpans.push([match.index!, match.index! + match[0].length]);
  }

  // <spawn_agent .../> - attributes in any order
  const spawnAgentRe = /<spawn_agent\s+[^>]*\/>/g;
  for (const match of text.matchAll(spawnAgentRe)) {
    const tag = match[0];
    const agentName = extractAttr(tag, 'name');
    if (!agentName) continue;
    actions.push({
      type: 'spawn_agent',
      agentName,
      agentType: extractAttr(tag, 'type'),
    });
    consumedSpans.push([match.index!, match.index! + match[0].length]);
  }

  // <idle .../> - attributes in any order
  const idleRe = /<idle\s+[^>]*\/>/g;
  for (const match of text.matchAll(idleRe)) {
    const tag = match[0];
    const reason = extractAttr(tag, 'reason');
    const summary = extractAttr(tag, 'summary');
    if (!reason || summary == null) continue; // both required
    actions.push({
      type: 'idle_notification',
      reason,
      summary,
      completedTaskId: extractAttr(tag, 'completed_task_id'),
    });
    consumedSpans.push([match.index!, match.index! + match[0].length]);
  }

  // <write_plan title="..."><step>...</step></write_plan>
  const writePlanRe = /<write_plan\s+title="([^"]+)">([\s\S]*?)<\/write_plan>/g;
  for (const match of text.matchAll(writePlanRe)) {
    const title = match[1];
    const stepMatches = match[2].matchAll(/<step>([\s\S]*?)<\/step>/g);
    const steps: string[] = [];
    for (const sm of stepMatches) {
      steps.push(sm[1].trim());
    }
    if (title && steps.length > 0) {
      actions.push({ type: 'write_plan', title, steps });
      consumedSpans.push([match.index!, match.index! + match[0].length]);
    }
  }

  // <reflect plan_id="..." score="0.8">text</reflect>
  const reflectRe = /<reflect\s+plan_id="([^"]+)"\s+score="([^"]+)">([\s\S]*?)<\/reflect>/g;
  for (const match of text.matchAll(reflectRe)) {
    actions.push({
      type: 'reflect',
      planId: match[1],
      reflection: match[3].trim(),
      score: parseFloat(match[2]) || 0,
    });
    consumedSpans.push([match.index!, match.index! + match[0].length]);
  }

  // <trigger_workflow id="..."/>
  const triggerWfRe = /<trigger_workflow\s+[^>]*\/>/g;
  for (const match of text.matchAll(triggerWfRe)) {
    const wfId = extractAttr(match[0], 'id');
    if (wfId) {
      actions.push({ type: 'trigger_workflow', workflowId: wfId, inputs: {} });
      consumedSpans.push([match.index!, match.index! + match[0].length]);
    }
  }

  return { actions, consumedSpans };
}

/**
 * Creates an adapter for platforms that do not support tool use (e.g. Gemini, Codex).
 * Agents communicate structured actions via XML tags embedded in plain text.
 */
export function createXmlFallbackAdapter(options?: { hasMcpTools?: boolean }): TeamPlatformAdapter {
  return {
    getCapability(): PlatformCapability {
      return { supportsToolUse: false, supportsStreaming: true };
    },

    buildPayload(params: BuildPayloadParams): AgentPayload {
      const { agent, mailboxMessages, tasks, teammates } = params;
      const sections: string[] = [];

      // Role prompt already includes teammates, tasks, and unread messages
      const rolePrompt = buildRolePrompt({
        agent,
        mailboxMessages,
        tasks,
        teammates,
        availableAgentTypes: params.availableAgentTypes,
        renamedAgents: params.renamedAgents,
      });
      sections.push(rolePrompt);

      // Only append XML fallback instructions when MCP tools are NOT available
      if (!options?.hasMcpTools) {
        sections.push(TEAM_INSTRUCTIONS);
      }

      return { message: sections.join('\n\n') };
    },

    parseResponse(response: AgentResponse): ParsedAction[] {
      const { actions, consumedSpans } = parseXmlActions(response.text);

      // Text outside XML tags becomes a plain_response
      const remainingText = removeXmlSpans(response.text, consumedSpans).trim();
      if (remainingText) {
        actions.push({ type: 'plain_response', content: remainingText });
      }

      return actions;
    },
  };
}
