// themes.json is a copy of claude-code-hub/scripts/themes.json, the palettes every app ships with.
import themes from './themes.json';

type Tokens = (typeof themes)[number]['dark'];
export type Mode = 'light' | 'dark';

export const DEFAULT_PALETTE = 'ember';
export const DEFAULT_MODE: Mode = 'light';
// The family sites share one origin, so these keys carry the reader's choice from site to site.
export const PALETTE_KEY = 'hub-palette';
export const MODE_KEY = 'starlight-theme';

export const palettes = themes.map(({ id, label, light, dark }) => ({ id, label, light, dark }));

function vars(t: Tokens): string {
  return [
    `--c-field:${t.field}`,
    `--c-surface:${t.surface}`,
    `--c-elevated:${t.elevated}`,
    `--c-hover:${t.hover}`,
    `--c-border:${t.border}`,
    `--c-ink1:${t.ink1}`,
    `--c-ink2:${t.ink2}`,
    `--c-ink3:${t.ink3}`,
    `--c-muted:${t.inkMuted}`,
    `--c-accent:${t.ember}`,
    `--c-accent-ink:${t.emberGlow}`,
    `--c-accent-dim:${t.emberDim}`,
    // Starlight's scale runs from --sl-color-white (text) to --sl-color-black (page) in both modes.
    `--sl-color-white:${t.ink1}`,
    `--sl-color-gray-1:${t.ink1}`,
    `--sl-color-gray-2:${t.ink2}`,
    `--sl-color-gray-3:${t.ink3}`,
    `--sl-color-gray-4:${t.inkMuted}`,
    `--sl-color-gray-5:${t.border}`,
    `--sl-color-gray-6:${t.surface}`,
    `--sl-color-gray-7:${t.elevated}`,
    `--sl-color-black:${t.field}`,
    `--sl-color-accent-low:${t.emberDim}`,
    `--sl-color-accent:${t.ember}`,
    `--sl-color-accent-high:${t.emberGlow}`,
    // Dark Starlight sets text-invert to accent-low, which is translucent here, so text on accent vanishes.
    `--sl-color-text-invert:${t.field}`,
  ].join(';');
}

export function paletteCss(): string {
  return palettes
    .flatMap((p) =>
      (['light', 'dark'] as const).map(
        (mode) => `:root[data-palette="${p.id}"][data-theme="${mode}"]{${vars(p[mode])}}`,
      ),
    )
    .join('\n');
}
