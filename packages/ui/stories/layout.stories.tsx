import type { Meta, StoryObj } from '@storybook/react-vite';
import { Card, Separator } from '../src';
import { DocPage, Usage } from './docs';
const meta = { title: 'Layout/Espaço e superfícies', id: 'layout' } satisfies Meta;
export default meta;
export const Fundamentos: StoryObj<typeof meta> = { name: 'Espaço, raio e superfícies', render: () => <DocPage category="Layout" title="Espaço para o que importa." lead="Uma escala de quatro pixels organiza a leitura. Superfícies discretas agrupam informação; a densidade nunca depende de diminuir a tipografia.">
  <div className="catalog-grid"><Card title="Ritmo de espaçamento">{[1,2,3,4,5,6,8,10,12].map(step => <div className="catalog-space-row" key={step}><code>--oh-space-{step}</code><div className="catalog-space-bar" style={{ width: `var(--oh-space-${step})` }} /></div>)}</Card><Card title="Raios por função"><div className="catalog-stack">{[['Controles','--oh-radius-control'],['Superfícies','--oh-radius-panel'],['Status','--oh-radius-pill']].map(([label, token]) => <div className="catalog-radius-example" key={token} style={{ borderRadius: `var(${token})` }}>{label}<p className="oh-hint">{token}</p></div>)}</div></Card></div>
  <Card title="Cartão e separador" description="Use uma superfície para agrupar conteúdo relacionado, com título e ação quando necessário."><p>O conteúdo define o tamanho do cartão.</p><Separator /><p className="oh-hint">O separador organiza assuntos sem disputar atenção.</p><Usage>{`<Card title="Movimentações" description="Atividade recente">\n  <Timeline items={events} />\n</Card>`}</Usage></Card>
</DocPage> };
