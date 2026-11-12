import type { StorybookConfig } from '@storybook/react-vite';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const themeInit = readFileSync(new URL('../src/theme-init.js', import.meta.url), 'utf8');
const catalogInit = `document.documentElement.lang = 'pt-BR';\n${themeInit}`;
const tokens = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');

const config: StorybookConfig = {
  framework: '@storybook/react-vite',
  stories: ['../stories/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-docs', '@storybook/addon-a11y'],
  staticDirs: [{ from: '../src/assets', to: '/brand' }],
  core: { disableTelemetry: true },
  features: { sidebarOnboardingChecklist: false, menuOnboardingChecklist: false },
  previewHead: head => `<script>${catalogInit}</script>${head}`,
  managerHead: head => `<style>${tokens}
    a[title="Omnihub · Design system"] { display:flex; align-items:center; gap:10px; }
    a[title="Omnihub · Design system"] img { width:40px; height:40px; max-height:40px; border-radius:8px; }
    a[title="Omnihub · Design system"]::after { content:'Omnihub / Design system'; font:500 14px/1.5 Inter,system-ui,sans-serif; color:var(--color-text); }
  </style><script>${catalogInit}</script>${head}`,
  viteFinal: async config => {
    // The monorepo .env belongs to the backend; do not load it into the catalog.
    config.envDir = fileURLToPath(new URL('../.storybook/empty-env', import.meta.url));
    config.plugins = [...(config.plugins ?? []), tailwindcss()];
    return config;
  },
};
export default config;
