import type { Meta, StoryObj } from '@storybook/react-vite';
import { Alert, Card, StatusBadge } from '../src';
import { ColorSwatch, DocPage, Usage } from './docs';

const meta = { title: 'Cores/Paleta', id: 'cores-paleta' } satisfies Meta;
export default meta;
export const Semantica: StoryObj<typeof meta> = { name: 'Paleta semântica', render: () => <DocPage category="Cores" title="Cor com uma função clara." lead="A identidade nasce do azul e do turquesa. Na interface, cada cor recebe um papel: estruturar, orientar, chamar atenção ou informar um resultado.">
  <div className="catalog-grid catalog-grid--three"><ColorSwatch label="Navy da marca" token="--oh-navy" /><ColorSwatch label="Turquesa da marca" token="--oh-turquoise" /><ColorSwatch label="Ação primária" token="--color-action-primary" /></div>
  <Card title="Superfícies e conteúdo" description="O componente consome o papel semântico; o tema escolhe o valor."><div className="catalog-grid catalog-grid--three">{[['Fundo','--color-background'],['Superfície','--color-surface'],['Texto principal','--color-text'],['Texto secundário','--color-text-muted'],['Borda essencial','--color-control-border'],['Foco','--color-focus']].map(([label, token]) => <ColorSwatch key={token} label={label!} token={token!} />)}</div></Card>
  <Card title="Estado é mais do que cor"><div className="catalog-demo"><StatusBadge tone="success">Concluído</StatusBadge><StatusBadge tone="warning">Atenção</StatusBadge><StatusBadge tone="danger">Falha</StatusBadge><StatusBadge tone="info">Em processamento</StatusBadge><StatusBadge>Desconhecido</StatusBadge></div><Usage>{`<StatusBadge tone="warning">Sem disponibilidade</StatusBadge>`}</Usage></Card>
  <Alert title="Turquesa de marca e ação têm funções diferentes" tone="info">A versão escura da ação no tema claro permite texto branco legível. Turquesa não significa sucesso: os estados têm ícone e rótulo próprios.</Alert>
</DocPage> };
