import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Alert, Button, Card, EmptyState, ErrorState, Skeleton, StatusBadge, useToast } from '../src';
import { DocPage, Usage } from './docs';

function FeedbackDemo({ state = 'all' }: { state?: 'all' | 'loading' | 'empty' | 'error' | 'stale' }) {
  const notify = useToast(); const [retrying, setRetrying] = useState(false);
  return <DocPage category="Feedback" title="Toda resposta tem contexto." lead="Um estado informa o que aconteceu e o que pode ser feito. Sem dados não significa zero, e estoque insuficiente não significa falha no sistema.">
    {(state === 'all' || state === 'stale') && <Alert title="Dados podem estar desatualizados" tone="warning" action={<Button variant="secondary" size="sm" onClick={() => notify({ title:'Atualização solicitada', description:'Demonstração de feedback.' })}>Atualizar dados</Button>}>Última consulta ilustrativa às 14:32. O estoque pode ter mudado desde então.</Alert>}
    {state === 'all' && <><Card title="Rótulos de estado"><div className="catalog-demo"><StatusBadge tone="success">Conectado</StatusBadge><StatusBadge tone="warning">Degradado</StatusBadge><StatusBadge tone="danger">Desconectado</StatusBadge><StatusBadge>Desconhecido</StatusBadge><StatusBadge tone="info">Em processamento</StatusBadge></div></Card><div className="catalog-grid"><Alert title="Reserva confirmada" tone="success">O pedido foi aceito e o saldo está reservado.</Alert><Alert title="Estoque insuficiente" tone="warning">A reserva foi bloqueada para preservar o saldo. Nenhuma unidade foi reservada.</Alert></div><Card title="Notificação de conclusão"><Button onClick={() => notify({ title:'Alteração concluída', description:'Esta notificação pode ser dispensada manualmente.' })}>Mostrar notificação</Button></Card></>}
    {(state === 'all' || state === 'loading') && <Card title="Carregamento"><div className="catalog-stack" role="status" aria-label="Carregando produtos"><Skeleton className="catalog-skeleton-title" /><Skeleton className="catalog-skeleton-line" /><Skeleton className="catalog-skeleton-short" /><span className="oh-sr-only">Carregando produtos...</span></div></Card>}
    {(state === 'all' || state === 'empty') && <Card><EmptyState title="Nenhum produto encontrado" description="Tente outro SKU ou remova os filtros aplicados." action={<Button variant="secondary" onClick={() => notify({ title:'Filtros removidos nesta demonstração' })}>Limpar filtros</Button>} /></Card>}
    {(state === 'all' || state === 'error') && <Card>{retrying ? <Alert title="Nova consulta solicitada" tone="info">O estado de recuperação foi acionado nesta demonstração.</Alert> : <ErrorState onRetry={() => setRetrying(true)} />}</Card>}
    <Usage>{`<Alert tone="warning" title="Dados desatualizados">Última consulta às 14:32.</Alert>\n<ErrorState onRetry={refetch} />`}</Usage>
  </DocPage>;
}
const meta = { title: 'Feedback/Estados e mensagens', id: 'feedback' } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Estados: Story = { name: 'Estados e notificações', render: () => <FeedbackDemo /> };
export const Carregando: Story = { name: 'Carregando', render: () => <FeedbackDemo state="loading" /> };
export const Vazio: Story = { name: 'Vazio', render: () => <FeedbackDemo state="empty" /> };
export const Erro: Story = { name: 'Erro e recuperação', render: () => <FeedbackDemo state="error" /> };
export const Desatualizado: Story = { name: 'Dados desatualizados', render: () => <FeedbackDemo state="stale" /> };
