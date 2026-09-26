export type SiteId = 'hub' | 'kanban' | 'marketplace' | 'cost' | 'memory';

export const family: { id: SiteId; name: string; href: string; blurb: string }[] = [
  { id: 'hub', name: 'Hub', href: 'https://nikiforovall.blog/claude-code-hub/', blurb: 'All four apps in one window' },
  { id: 'kanban', name: 'Kanban', href: 'https://nikiforovall.blog/claude-code-kanban/', blurb: 'Watch and drive sessions' },
  { id: 'marketplace', name: 'Marketplace', href: 'https://nikiforovall.blog/claude-code-marketplace/', blurb: 'Plugins and skills' },
  { id: 'cost', name: 'Cost', href: 'https://nikiforovall.blog/claude-code-cost/', blurb: 'Spend by session and project' },
  { id: 'memory', name: 'Memory', href: 'https://nikiforovall.blog/claude-code-memory/', blurb: 'What Claude Code loads' },
];

export const url = (path = '') => `${import.meta.env.BASE_URL.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
