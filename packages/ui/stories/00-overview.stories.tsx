import type { Meta, StoryObj } from '@storybook/react-vite';
import { ArrowRight, Boxes, FormInput, Layers, Palette, PanelsTopLeft, Workflow } from 'lucide-react';
import { Alert, Button, Card, Logo, MetricCard, StatusBadge } from '../src';
import { DocPage, ColorSwatch } from './docs';

const meta = { title: 'Visão geral', id: 'visao-geral' } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Inicio: Story = { name: 'Início', render: () => <DocPage category="Design system · 0.1" title="Conectar é só o começo." lead="Uma linguagem compartilhada para transformar diferentes fontes em uma operação clara. Explore, experimente e leve os mesmos componentes para cada tela.">
  <section className="catalog-hero"><div><p className="oh-overline">O essencial, em um só lugar</p><h2>Diferentes origens.<br />Uma experiência consistente.</h2><p>Uma base para decisões melhores: informação legível, interações previsíveis e clareza em cada etapa do pedido.</p><a className="oh-button" href="./?path=/story/padroes-estoque--interativo" target="_top">Explorar os padrões <ArrowRight size={16} aria-hidden="true" /></a></div><Logo variant="symbol" /></section>
  <section><h2 className="catalog-section-title">Comece pelo que você precisa</h2><div className="catalog-grid catalog-grid--three">{[
    { title: 'Marca e fundamentos', description: 'Cores, tipografia e o jeito Omnihub.', icon: Palette, story: 'cores-paleta--semantica' },
    { title: 'Componentes', description: 'Peças reais, estados e variações.', icon: Layers, story: 'acoes-botao--primario' },
    { title: 'Padrões operacionais', description: 'Estoque e fluxo de pedidos em uso.', icon: Workflow, story: 'padroes-pipeline--interativo' },
  ].map(item => <a className="catalog-link-card" key={item.title} href={`./?path=/story/${item.story}`} target="_top"><item.icon size={22} aria-hidden="true" /><div><strong>{item.title}</strong><p>{item.description}</p></div><ArrowRight size={15} aria-hidden="true" /></a>)}</div></section>
  <Card title="Uma marca, dois temas" description="A cor expressa intenção. Tokens semânticos mantêm essa intenção em claro e escuro."><div className="catalog-grid catalog-grid--three"><ColorSwatch label="Identidade" token="--oh-navy" /><ColorSwatch label="Destaque" token="--oh-turquoise" /><ColorSwatch label="Ação primária" token="--color-action-primary" /></div></Card>
  <div className="catalog-grid"><Card title="Pronta para o dia a dia" description="Controles previsíveis, linguagem direta e espaço para o conteúdo."><div className="catalog-demo"><Button>Continuar</Button><Button variant="secondary">Ver detalhes</Button><StatusBadge tone="success">Conectado</StatusBadge></div></Card><Card title="Clareza antes de densidade" description="Os números mostram unidade, período e contexto."><MetricCard label="Latência de tradução" value="128" unit="ms" description="Exemplo ilustrativo · últimos 15 minutos" icon={<PanelsTopLeft size={18} />} /></Card></div>
  <Alert title="Explore com liberdade" tone="info">Os exemplos usam dados ilustrativos. Navegue pelo menu, alterne o tema e experimente os estados sem alterar o estoque da aplicação.</Alert>
</DocPage> };
