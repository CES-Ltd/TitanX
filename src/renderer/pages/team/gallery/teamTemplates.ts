/**
 * Pre-built team templates for one-click team hiring.
 * Each team has a lead agent and 3-4 members, all from the agent gallery.
 */

export type TeamTemplate = {
  id: string;
  name: string;
  description: string;
  leadAgent: string;
  members: string[];
  icon: string;
};

export const TEAM_TEMPLATES: TeamTemplate[] = [
  {
    id: 'engineering',
    name: 'Engineering Squad',
    description: 'Full-stack development team with QA, frontend, backend, and DevOps coverage.',
    leadAgent: 'Senior Developer',
    members: ['QA Engineer', 'Frontend Specialist', 'Backend Engineer', 'DevOps Engineer'],
    icon: '💻',
  },
  {
    id: 'sales',
    name: 'Sales Team',
    description: 'End-to-end sales pipeline from lead generation to customer success.',
    leadAgent: 'Account Executive',
    members: ['Lead Generator', 'Sales Development Rep', 'Solutions Architect', 'Customer Success Manager'],
    icon: '📈',
  },
  {
    id: 'marketing',
    name: 'Marketing Team',
    description: 'Full marketing operations: content, SEO, social, growth, and copywriting.',
    leadAgent: 'Content Strategist',
    members: ['SEO Specialist', 'Social Media Manager', 'Growth Hacker', 'Brand Copywriter'],
    icon: '📣',
  },
  {
    id: 'research',
    name: 'Research Cell',
    description: 'Data-driven insights team for market research, analytics, and competitive intelligence.',
    leadAgent: 'Market Research Analyst',
    members: ['Data Analyst', 'Competitive Intelligence', 'Business Intelligence'],
    icon: '🔬',
  },
  {
    id: 'product',
    name: 'Product Team',
    description: 'Product lifecycle management from strategy to release.',
    leadAgent: 'Product Manager',
    members: ['Scrum Master', 'Technical Program Manager', 'Release Manager', 'Technical Writer'],
    icon: '🎯',
  },
];
