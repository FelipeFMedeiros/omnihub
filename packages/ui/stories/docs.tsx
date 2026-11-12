import { useEffect, useState, type ReactNode } from 'react';
import { CodePanel, CopyButton, ThemeSelect } from '../src';

export function DocPage({ category, title, lead, children }: { category: string; title: string; lead: string; children: ReactNode }) {
  return <main className="catalog"><header className="catalog-header"><div><p className="catalog-kicker">Omnihub / {category}</p><h1>{title}</h1><p className="catalog-lead">{lead}</p></div><ThemeSelect /></header><div className="catalog-stack">{children}</div></main>;
}
export function Usage({ children }: { children: string }) { return <details className="catalog-usage"><summary>Ver código de uso</summary><CodePanel title="Exemplo React" code={children} /></details>; }
export function ColorSwatch({ label, token }: { label: string; token: string }) {
  const [value, setValue] = useState('');
  useEffect(() => {
    const update = () => setValue(getComputedStyle(document.documentElement).getPropertyValue(token).trim());
    update(); const observer = new MutationObserver(update); observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }); return () => observer.disconnect();
  }, [token]);
  return <div className="catalog-swatch"><div className="catalog-swatch-color" style={{ background: `var(${token})` }} /><strong>{label}</strong><code>{token}</code><div className="oh-row oh-wrap"><code>{value}</code><CopyButton label="Copiar token" text={`var(${token})`} /></div></div>;
}
