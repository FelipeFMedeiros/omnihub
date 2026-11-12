import type { Meta, StoryObj } from '@storybook/react-vite';
import { Card, CodePanel } from '../src';
import { DocPage } from './docs';
const meta = { title: 'Tipografia/Fontes e escala', id: 'tipografia' } satisfies Meta;
export default meta;
export const Escala: StoryObj<typeof meta> = { name: 'Fontes e escala', render: () => <DocPage category="Tipografia" title="Informação que dá gosto de ler." lead="Inter, hospedada no próprio projeto, mantém uma leitura clara em títulos, tabelas e formulários. Uma única família para uma hierarquia consistente.">
  <Card><p className="catalog-font-sample">Uma operação mais clara.<br />Pedido por pedido.</p><p className="catalog-note" style={{ marginTop: 'var(--oh-space-5)' }}>Aa Bb Cc Çç 0123456789 · Inter 400 / 500 / 600</p></Card>
  <Card title="Escala de leitura">{[['Título da página','--oh-text-3xl'],['Título da seção','--oh-text-xl'],['Texto de leitura e campos','--oh-text-base'],['Tabelas e rótulos','--oh-text-sm'],['Metadados complementares','--oh-text-xs']].map(([label, token]) => <div className="catalog-type-row" key={token}><span style={{ fontSize: `var(${token})` }}>{label}</span><code className="oh-hint">{token}</code></div>)}</Card>
  <div className="catalog-grid"><Card title="Números com contexto"><p className="pattern-balance">R$ 1.249,90</p><p className="oh-hint">Moeda e datas em português brasileiro.</p><p className="pattern-balance" style={{ marginTop: 'var(--oh-space-5)' }}>128 ms</p><p className="oh-hint">Identifique a unidade ao lado da medida.</p></Card><CodePanel title="Código e identificadores" subtitle="Monoespaçada do sistema" code={'{\n  "sku": "SKU-FONTE-600W",\n  "unitPriceCents": 34990\n}'} /></div>
</DocPage> };
