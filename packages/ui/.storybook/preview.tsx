import type { Preview } from '@storybook/react-vite';
import { useGlobals } from 'storybook/preview-api';
import { ThemeProvider, ToastProvider, storedTheme, type ThemePreference } from '../src';
import '../src/styles/index.css';
import '../stories/catalog.css';

const preview: Preview = {
  globalTypes: {
    appearance: {
      description: 'Tema do Omnihub',
      toolbar: { title: 'Tema', icon: 'circlehollow', dynamicTitle: true, items: [{ value: 'system', title: 'Sistema' }, { value: 'light', title: 'Claro' }, { value: 'dark', title: 'Escuro' }] },
    },
  },
  initialGlobals: { appearance: storedTheme() },
  parameters: {
    layout: 'fullscreen',
    controls: { expanded: true },
    options: { storySort: { order: ['Visão geral', 'Marca', 'Cores', 'Tipografia', 'Layout', 'Ações', 'Formulários', 'Navegação', 'Feedback', 'Sobreposições', 'Dados', 'Padrões Omnihub'] } },
    a11y: { test: 'error' },
    viewport: { options: {
      mobile: { name: 'Celular 390', styles: { width: '390px', height: '844px' } },
      narrow: { name: 'Estreito 320', styles: { width: '320px', height: '800px' } },
      tablet: { name: 'Tablet 768', styles: { width: '768px', height: '1024px' } },
      desktop: { name: 'Desktop 1440', styles: { width: '1440px', height: '1000px' } },
    } },
  },
  decorators: [(Story, context) => {
    const [, updateGlobals] = useGlobals();
    return <ThemeProvider theme={(context.globals.appearance ?? 'system') as ThemePreference} onThemeChange={theme => updateGlobals({ appearance: theme })}><ToastProvider><Story /></ToastProvider></ThemeProvider>;
  }],
};
export default preview;
