import { addons } from 'storybook/manager-api';
import { create } from 'storybook/theming';

function managerTheme() {
  let preference = 'system';
  try { preference = localStorage.getItem('omnihub.theme') ?? 'system'; } catch {}
  const dark = preference === 'dark' || (preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const css = getComputedStyle(document.documentElement);
  const color = (token: string) => css.getPropertyValue(token).trim();
  return create({
    base: dark ? 'dark' : 'light', brandTitle: 'Omnihub · Design system', brandImage: '/brand/omnihub-symbol.png', brandUrl: './?path=/story/visao-geral--inicio', brandTarget: '_self',
    fontBase: 'Inter, system-ui, sans-serif',
    colorPrimary: color('--color-action-primary'), colorSecondary: color('--color-action-primary'),
    appBg: color('--color-background'), appContentBg: color('--color-surface'), appPreviewBg: color('--color-background'), appBorderColor: color('--color-border'),
    textColor: color('--color-text'), textMutedColor: color('--color-text-muted'), textInverseColor: color('--color-action-text'),
    barBg: color('--color-surface'), barTextColor: color('--color-text-muted'), barSelectedColor: color('--color-action-primary'),
    inputBg: color('--color-surface'), inputBorder: color('--color-control-border'), inputTextColor: color('--color-text'),
  });
}
addons.setConfig({ theme: managerTheme(), sidebar: { showRoots: true }, layout: { showPanel: false } });
window.addEventListener('storage', (event: StorageEvent) => { if (event.key === 'omnihub.theme') addons.setConfig({ theme: managerTheme() }); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => addons.setConfig({ theme: managerTheme() }));
