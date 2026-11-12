import { useState } from 'react';
import { Activity, Boxes, ChartNoAxesCombined, PackageCheck, ShieldCheck, Workflow } from 'lucide-react';
import { Alert, AppShell, Breadcrumb, Button, Card, ChartFrame, CodePanel, DataTable, DataToolbar, Drawer, EmptyState, ErrorState, Field, LineChart, MetricCard, Pagination, Select, Skeleton, StatusBadge, Timeline, type Column } from '../src';

interface Product { id: string; name: string; sku: string; physical: number; reserved: number; safety: number; available: number; channels: readonly string[] }
const products: readonly Product[] = [
  { id:'power',name:'Fonte ATX 600W',sku:'SKU-FONTE-600W',physical:20,reserved:4,safety:2,available:14,channels:['Mercado Livre','Shopee','Amazon'] },
  { id:'ssd',name:'SSD NVMe 1 TB',sku:'SKU-SSD-NVME-1TB',physical:8,reserved:6,safety:2,available:0,channels:['Mercado Livre','Shopee'] },
  { id:'memory',name:'Memória DDR5 16 GB',sku:'SKU-MEM-DDR5-16GB-EDICAO-ESPECIAL-COM-IDENTIFICADOR-LONGO',physical:12,reserved:2,safety:2,available:8,channels:['Amazon'] },
];
const nav = [{ id:'overview',label:'Visão geral',icon:<ChartNoAxesCombined size={18} aria-hidden="true" /> },{ id:'inventory',label:'Estoque',icon:<Boxes size={18} aria-hidden="true" /> },{ id:'pipeline',label:'Fluxo de pedidos',icon:<Workflow size={18} aria-hidden="true" /> }];
export type ViewState = 'ready' | 'loading' | 'empty' | 'error' | 'stale';
function Heading({ title, description }: { title: string; description: string }) {
  return <div className="pattern-heading"><div><Breadcrumb items={[{ label:'Operação' },{ label:title }]} /><h1>{title}</h1><p>{description}</p></div><StatusBadge tone="info">Dados ilustrativos</StatusBadge></div>;
}
function ProductDetails({ product }: { product: Product }) {
  return <div className="catalog-stack"><div><p className="oh-label">{product.name}</p><p className="oh-hint" style={{ overflowWrap:'anywhere' }}>{product.sku}</p></div><MetricCard label="Saldo disponível" value={String(product.available)} unit="un." description="Valor fornecido pelo contrato ilustrativo" />
    <p className="oh-hint">Físico {product.physical} · Reservado {product.reserved} · Segurança {product.safety}</p>
    {product.available === 0 && <Alert title="Há saldo físico, mas não há disponibilidade" tone="warning">As unidades estão reservadas ou protegidas pela margem de segurança.</Alert>}
    <div><h3 className="oh-label">Canais vinculados</h3><div className="pattern-channel-list">{product.channels.map(channel => <span key={channel}>{channel}</span>)}</div></div>
    <Timeline items={[{ id:'reserve',title:'Reserva de pedido',description:'Exemplo de registro de saída no ledger. Quantidade reservada: 2 unidades.',time:'14:32',tone:'info' },{ id:'sync',title:'Reposição recebida',description:'Exemplo de entrada física confirmada pelo ERP.',time:'13:10',tone:'success' }]} />
    <Alert title="Previsão ainda indisponível" tone="neutral">Histórico insuficiente para uma projeção de demanda. Isso não significa demanda zero.</Alert>
  </div>;
}
function Inventory({ initialState = 'ready' }: { initialState?: ViewState }) {
  const [search,setSearch] = useState(''); const [filter,setFilter] = useState('all'); const [offset,setOffset] = useState(0);
  const [view,setView] = useState(initialState);
  const filtered = products.filter(product => `${product.name} ${product.sku}`.toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR')) && (filter === 'all' || (filter === 'available' ? product.available > 0 : product.available === 0)));
  const page = filtered.slice(offset, offset + 2);
  const details = (product: Product) => <Drawer trigger={<Button size="sm" variant="ghost">Detalhes<span className="oh-sr-only"> de {product.name}</span></Button>} title="Detalhes do estoque" description="Saldos e histórico ilustrativos do produto."><ProductDetails product={product} /></Drawer>;
  const columns: readonly Column<Product>[] = [
    { key:'product',label:'Produto',render:product => <div className="pattern-product-name"><strong>{product.name}</strong><code>{product.sku}</code></div> },
    { key:'physical',label:'Físico',align:'right',render:product => product.physical },{ key:'reserved',label:'Reservado',align:'right',render:product => product.reserved },{ key:'safety',label:'Segurança',align:'right',render:product => product.safety },
    { key:'available',label:'Disponível',align:'right',render:product => <strong>{product.available}</strong> },{ key:'action',label:'Consulta',render:details },
  ];
  return <><Heading title="Estoque canônico" description="A informação dos canais, reunida para uma operação consistente." />
    {view === 'stale' && <div className="pattern-example-label"><Alert title="Dados podem estar desatualizados" tone="warning" action={<Button size="sm" variant="secondary" onClick={() => setView('ready')}>Atualizar exemplo</Button>}>Última consulta ilustrativa às 14:32.</Alert></div>}
    <Card title="Catálogo de produtos" description="Saldo disponível sem confundir físico, reservado e segurança.">
      <DataToolbar search={search} searchLabel="Buscar produto por nome ou SKU" placeholder="Buscar por nome ou SKU..." onSearch={value => { setSearch(value); setOffset(0); }}><Select className="pattern-filter" aria-label="Filtrar disponibilidade" value={filter} onChange={event => { setFilter(event.target.value); setOffset(0); }}><option value="all">Todos os produtos</option><option value="available">Com disponibilidade</option><option value="unavailable">Sem disponibilidade</option></Select></DataToolbar>
      {view === 'loading' ? <div className="catalog-stack" role="status" aria-label="Carregando produtos"><Skeleton className="catalog-skeleton-title" /><Skeleton className="catalog-skeleton-line" /><Skeleton className="catalog-skeleton-line" /><span className="oh-sr-only">Carregando produtos...</span></div>
        : view === 'error' ? <ErrorState onRetry={() => setView('ready')} />
        : view === 'empty' || page.length === 0 ? <EmptyState title="Nenhum produto encontrado" description="Remova os filtros ou procure outro nome e SKU." action={<Button variant="secondary" onClick={() => { setSearch('');setFilter('all');setOffset(0);setView('ready'); }}>Limpar filtros</Button>} />
        : <><div className="pattern-product-table"><DataTable data={page} columns={columns} getRowKey={product => product.id} caption="Saldos do estoque canônico" /></div><div className="pattern-product-list">{page.map(product => <article className="pattern-product-card" key={product.id}><div><div className="pattern-product-name"><strong>{product.name}</strong><code>{product.sku}</code><span><StatusBadge tone={product.available === 0 ? 'warning' : 'success'}>{product.available === 0 ? 'Sem disponível' : 'Disponível'}</StatusBadge></span></div><div className="pattern-mobile-balance"><p className="pattern-balance">{product.available}</p><p className="pattern-balance-label">disponíveis</p></div></div><dl><div><dt>Físico</dt><dd>{product.physical}</dd></div><div><dt>Reservado</dt><dd>{product.reserved}</dd></div><div><dt>Segurança</dt><dd>{product.safety}</dd></div><div><dt>Canais</dt><dd>{product.channels.length} vinculados</dd></div></dl>{details(product)}</article>)}</div><Pagination hasPrevious={offset>0} hasNext={offset + 2 < filtered.length} onPrevious={() => setOffset(previous => Math.max(0,previous-2))} onNext={() => setOffset(previous => previous+2)} label={`${page.length} produto(s) neste conjunto ilustrativo`} /></>}
    </Card></>;
}
const intervalData = [{ label:'14:00',value:12 },{ label:'14:05',value:18 },{ label:'14:10',value:15 },{ label:'14:15',value:24 },{ label:'14:20',value:20 },{ label:'14:25',value:28 }];
function Overview() {
  return <><Heading title="Visão geral" description="O que está acontecendo, o que precisa de atenção e o próximo passo." /><div className="catalog-stack"><div className="catalog-grid catalog-grid--four"><MetricCard label="Pedidos aceitos" value="248" description="Ilustrativo · últimas 24 horas" icon={<PackageCheck size={18} />} /><MetricCard label="Latência média" value="128" unit="ms" description="Ilustrativo · tradução da IR" icon={<Activity size={18} />} /><MetricCard label="Entregas concluídas" value="98,4" unit="%" description="Ilustrativo · últimas 24 horas" icon={<Workflow size={18} />} /><MetricCard label="Conflitos bloqueados" value="12" description="Ilustrativo · reservas protegidas" icon={<ShieldCheck size={18} />} /></div>
    <div className="catalog-grid"><ChartFrame title="Vazão de pedidos" description="Ilustrativo · pedidos a cada 5 minutos" fallback={<DataTable caption="Dados de vazão" data={intervalData} getRowKey={point => point.label} columns={[{ key:'time',label:'Horário',render:point => point.label },{ key:'count',label:'Pedidos',align:'right',render:point => point.value }]} />}><LineChart data={intervalData} unit="ped." label="Exemplo de pedidos por intervalo, de 12 a 28, entre 14:00 e 14:25." /></ChartFrame>
      <Card title="Conectividade" description="Um status conhecido é diferente de uma ausência de informação."><div className="pattern-connections">{[{ name:'Mercado Livre',tone:'success' as const,label:'Conectado' },{ name:'Shopee',tone:'success' as const,label:'Conectado' },{ name:'Amazon',tone:'neutral' as const,label:'Desconhecido' },{ name:'Mock ERP',tone:'warning' as const,label:'Degradado' }].map(connection => <div className="pattern-connection" key={connection.name}><span>{connection.name}</span><StatusBadge tone={connection.tone}>{connection.label}</StatusBadge></div>)}</div></Card></div>
    <Alert title="ERP com entrega em nova tentativa" tone="warning">O pedido de exemplo continua com a reserva ativa. Falha temporária de entrega não implica desfazer a reserva.</Alert>
  </div></>;
}
function Pipeline({ initialFailure = false }: { initialFailure?: boolean }) {
  const [stage,setStage] = useState('canonical'); const [transform,setTransform] = useState('price'); const [failure,setFailure] = useState(initialFailure);
  const stages = [
    { id:'raw',name:'Origem',sub:'Raw JSON recebido',code:'{\n  "item": "sandbox-001",\n  "price": 349.9,\n  "postalCode": "59.600-000"\n}' },
    { id:'canonical',name:'Canônico',sub:'Representação intermediária',code:'{\n  "sku": "SKU-FONTE-600W",\n  "unitPriceCents": 34990,\n  "postalCode": "59600000"\n}' },
    { id:'erp',name:'ERP',sub:'Payload de destino',code:'{\n  "codigo_sku": "SKU-FONTE-600W",\n  "valor_total": 349.9,\n  "cep": "59600000"\n}' },
  ];
  return <><Heading title="Fluxo de pedidos" description="Da origem ao destino, com uma representação consistente no centro." /><div className="catalog-stack"><Card title="Pedido de demonstração" description="sandbox-001 · Mercado Livre · 14:32"><div className="catalog-demo"><StatusBadge tone="success">Reserva ativa</StatusBadge><StatusBadge tone={failure ? 'warning' : 'success'}>{failure ? 'ERP em nova tentativa' : 'Entrega concluída'}</StatusBadge><Button size="sm" variant="secondary" onClick={() => setFailure(previous => !previous)}>{failure ? 'Restaurar entrega no exemplo' : 'Simular falha no exemplo'}</Button></div></Card>
    {failure && <Alert title="A reserva permanece ativa" tone="warning">O destino está temporariamente indisponível. Uma nova tentativa não deve criar outro pedido ou reservar novamente.</Alert>}
    <div className="pattern-pipeline"><div className="pattern-stage-bar" role="group" aria-label="Selecionar etapa">{stages.map(item => <Button variant="secondary" key={item.id} aria-pressed={stage === item.id} onClick={() => setStage(item.id)}>{item.name}</Button>)}</div><div className="pattern-stage-grid">{stages.map(item => <div className="pattern-stage" data-active={stage === item.id} key={item.id}><CodePanel title={item.name} subtitle={item.sub} code={item.code} highlightLines={[transform === 'price' ? 3 : 4]} /></div>)}</div></div>
    <Card title="Transformação em destaque"><div className="catalog-demo-column"><Field label="Investigar campo"><Select value={transform} onChange={event => setTransform(event.target.value)}><option value="price">Preço em centavos</option><option value="postal">CEP normalizado</option></Select></Field><p className="oh-hint">{transform === 'price' ? 'O valor 349,90 da origem corresponde a 34990 centavos na IR. A apresentação do destino segue seu contrato.' : 'A pontuação do CEP é removida na borda. A IR e o destino recebem os mesmos oito dígitos.'}</p></div></Card>
  </div></>;
}
export function OperationDemo({ initialArea = 'inventory', initialState = 'ready', initialFailure = false }: { initialArea?: string; initialState?: ViewState; initialFailure?: boolean }) {
  const [area,setArea] = useState(initialArea);
  return <AppShell items={nav} activeItem={area} onNavigate={setArea}>{area === 'overview' ? <Overview /> : area === 'pipeline' ? <Pipeline initialFailure={initialFailure} /> : <Inventory initialState={initialState} />}</AppShell>;
}
