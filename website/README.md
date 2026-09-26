# Claude Code Kanban website

The landing page and docs for Claude Code Kanban, published at https://nikiforovall.blog/claude-code-kanban/. Built with Astro and Starlight.

## Commands

Run from this folder. Node 22.12 or later.

| Command | Action |
| --- | --- |
| `npm install` | Install dependencies |
| `npm run dev` | Start the dev server with hot reload. It prints the local URL. |
| `npm run build` | Build the site to `dist/` |
| `npm run preview` | Serve the built site |

## Layout

- `src/pages/index.astro` is the landing page.
- `src/content/docs/` holds the docs pages. Add each new page to the `sidebar` in `astro.config.mjs`.
- `src/kit/` and `src/components/` are the design kit: layout, themes, `Shot`, `Lightbox`, `Keys`. The same kit is in the Marketplace, Cost and Memory sites. Keep the copies the same.
- `public/shots/` holds the screenshots. Theme shots are named `themes/<palette>-<view>-<mode>.webp`, and pages find them by that name. To update a shot, replace the file and keep its name.
- `public/og.png` is the 1200×630 image for link previews.

## Deploy

`.github/workflows/pages.yml` builds and deploys the site to GitHub Pages on each push to `main` that changes `website/`.
