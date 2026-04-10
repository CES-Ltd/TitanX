/**
 * Agent Loader — discover and parse agent definitions from the filesystem.
 *
 * Scans `.claude/agents/` and `.deepagents/agents/` for agent definition files:
 * - JSON format: `*.json` with agent properties
 * - Markdown format: `*.md` with YAML frontmatter
 *
 * Inspired by open-claude-code's custom agent loading pattern.
 */

import fs from 'fs';
import path from 'path';

export type AgentDefinition = {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  prompt: string;
  source: string; // file path
};

/**
 * Scan standard directories for agent definition files.
 */
export function loadAgentDefinitions(workspacePath?: string): AgentDefinition[] {
  const dirs: string[] = [];

  // Home directory agents (global)
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (homeDir) {
    dirs.push(path.join(homeDir, '.claude', 'agents'));
    dirs.push(path.join(homeDir, '.deepagents', 'agents'));
  }

  // Workspace-local agents
  if (workspacePath) {
    dirs.push(path.join(workspacePath, '.claude', 'agents'));
    dirs.push(path.join(workspacePath, '.deepagents', 'agents'));
  }

  const agents: AgentDefinition[] = [];
  const seenNames = new Set<string>();

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const filePath = path.join(dir, entry.name);

        try {
          let agent: AgentDefinition | null = null;

          if (entry.name.endsWith('.json')) {
            agent = parseJsonAgent(filePath);
          } else if (entry.name.endsWith('.md')) {
            agent = parseMarkdownAgent(filePath);
          }

          if (agent && !seenNames.has(agent.name)) {
            agents.push(agent);
            seenNames.add(agent.name);
            console.log(`[AgentLoader] Loaded: ${agent.name} from ${filePath}`);
          }
        } catch (err) {
          console.warn(`[AgentLoader] Failed to parse ${filePath}:`, err);
        }
      }
    } catch {
      // Directory not readable — skip
    }
  }

  console.log(`[AgentLoader] Discovered ${String(agents.length)} custom agent definitions`);
  return agents;
}

/** Parse a JSON agent definition file. */
function parseJsonAgent(filePath: string): AgentDefinition | null {
  const content = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(content) as Record<string, unknown>;

  if (!data.name || typeof data.name !== 'string') return null;

  return {
    name: data.name as string,
    description: (data.description as string) ?? '',
    model: data.model as string | undefined,
    tools: Array.isArray(data.tools) ? (data.tools as string[]) : undefined,
    prompt: (data.prompt as string) ?? (data.systemPrompt as string) ?? '',
    source: filePath,
  };
}

/** Parse a Markdown agent definition with YAML frontmatter. */
function parseMarkdownAgent(filePath: string): AgentDefinition | null {
  const content = fs.readFileSync(filePath, 'utf-8');

  // Extract YAML frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) {
    // No frontmatter — use filename as name, content as prompt
    const name = path.basename(filePath, '.md');
    return { name, description: '', prompt: content.trim(), source: filePath };
  }

  const frontmatter = fmMatch[1]!;
  const body = fmMatch[2]!.trim();

  // Simple YAML parsing (no external dependency)
  const nameMatch = frontmatter.match(/name:\s*(.+)/);
  const descMatch = frontmatter.match(/description:\s*(.+)/);
  const modelMatch = frontmatter.match(/model:\s*(.+)/);
  const toolsMatch = frontmatter.match(/tools:\s*\[([^\]]*)\]/);

  const name = nameMatch?.[1]?.trim() ?? path.basename(filePath, '.md');
  const tools = toolsMatch?.[1]
    ?.split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  return {
    name,
    description: descMatch?.[1]?.trim() ?? '',
    model: modelMatch?.[1]?.trim(),
    tools,
    prompt: body,
    source: filePath,
  };
}
