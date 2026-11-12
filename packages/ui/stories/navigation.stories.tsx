import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Boxes, ChartNoAxesCombined, Workflow } from 'lucide-react';
import { AppShell, Breadcrumb, Card, Pagination, Tabs } from '../src';
import { DocPage, Usage } from './docs';

function NavigationDemo() {
  const [area, setArea] = useState('overview'); const [page, setPage] = useState(0);
  return <DocPage category="Navegação" title="Sempre saiba onde você está." lead="A estrutura acompanha o tamanho da tela. A mesma navegação lateral se torna um menu recolhível no celular."><AppShell activeItem={area} onNavigate={setArea} items={[{ id:'overview',label:'Visão geral',icon:<ChartNoAxesCombined size={18} aria-hidden="true" /> },{ id:'inventory',label:'Estoque',icon:<Boxes size={18} aria-hidden="true" /> },{ id:'pipeline',label:'Fluxo de pedidos',icon:<Workflow size={18} aria-hidden="true" /> }]}>
    <div className="catalog-stack"><Breadcrumb items={[{ label:'Operação',href:'#oh-main-content' },{ label:area === 'inventory' ? 'Estoque' : area === 'pipeline' ? 'Fluxo de pedidos' : 'Visão geral' }]} /><Card title="Uma estrutura compartilhada" description="Selecione uma área no menu para atualizar a localização."><Tabs label="Detalhes de navegação" items={[{ id:'summary',label:'Resumo',content:<p>A localização atual é indicada no menu e no breadcrumb.</p> },{ id:'history',label:'Histórico',content:<p>Abas podem ser percorridas com as setas do teclado.</p> },{ id:'future',label:'Indisponível',disabled:true,content:null }]} /><Pagination hasPrevious={page>0} hasNext={page<2} label={`Conjunto ilustrativo ${page+1}`} onPrevious={() => setPage(value => value-1)} onNext={() => setPage(value => value+1)} /></Card></div>
  </AppShell><Usage>{`<Pagination hasPrevious={offset > 0} hasNext={hasMore}\n  onPrevious={previous} onNext={next} label="Produtos" />`}</Usage></DocPage>;
}
const meta = { title: 'Navegação/Shell, abas e paginação', id: 'navegacao' } satisfies Meta;
export default meta;
export const Estrutura: StoryObj<typeof meta> = { name: 'Estrutura interativa', render: () => <NavigationDemo /> };
