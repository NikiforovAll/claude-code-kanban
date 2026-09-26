// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
	site: 'https://nikiforovall.blog',
	base: '/claude-code-kanban',
	devToolbar: { enabled: false },
	integrations: [
		starlight({
			title: 'Claude Code Kanban',
			description: 'A live board for every Claude Code session on your machine, with a terminal built in.',
			favicon: '/favicon.svg',
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/NikiforovAll/claude-code-kanban' }],
			editLink: { baseUrl: 'https://github.com/NikiforovAll/claude-code-kanban/edit/main/website/' },
			customCss: ['./src/kit/kit.css'],
			components: {
				ThemeProvider: './src/components/ThemeProvider.astro',
				ThemeSelect: './src/components/ThemeSelect.astro',
			},
			sidebar: [
				{ label: 'Start here', items: [{ label: 'Getting started', slug: 'getting-started' }] },
				{
					label: 'Guides',
					items: [
						{ label: 'Sessions and the board', slug: 'guides/sessions-and-board' },
						{ label: 'Session log and details', slug: 'guides/session-details' },
						{ label: 'Subagents', slug: 'guides/subagents' },
						{ label: 'Answer prompts from the board', slug: 'guides/waiting-prompts' },
						{ label: 'Embedded terminal', slug: 'guides/embedded-terminal' },
						{ label: 'Session groups', slug: 'guides/session-groups' },
						{ label: 'Dispatch tasks to other sessions', slug: 'guides/dispatch' },
						{ label: 'Claude Code plugin skills', slug: 'guides/plugin-skills' },
						{ label: 'Run inside Claude Code Hub', slug: 'guides/claude-code-hub' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'Keyboard shortcuts', slug: 'reference/keyboard-shortcuts' },
						{ label: 'CLI reference', slug: 'reference/cli' },
						{ label: 'Configuration', slug: 'reference/configuration' },
						{ label: 'Troubleshooting', slug: 'troubleshooting' },
					],
				},
			],
		}),
	],
});
