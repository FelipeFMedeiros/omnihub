import type { Meta, StoryObj } from '@storybook/react-vite';
import { Alert, Card, Logo, Separator, StatusBadge } from '../src';
import { DocPage, Usage } from './docs';

const meta = { title: 'Marca/Logo', id: 'marca-logo' } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Aplicacoes: Story = { name: 'Aplicações', render: () => <DocPage category="Marca" title="A convergência é a nossa origem." lead="O O de Omnihub reúne três segmentos em torno de um centro: diferentes fontes, uma representação consistente. A marca continua reconhecível em cada contexto.">
  <div className="catalog-grid"><Card title="Símbolo" description="Para navegação, aplicações compactas e identificação do produto."><div className="catalog-brand-sample"><Logo variant="symbol" /></div></Card><Card title="Assinatura original" description="Preserve proporção e respiro. Ideal para apresentação e boas-vindas."><div className="catalog-brand-sample"><Logo variant="signature" /></div></Card></div>
  <Card title="No produto"><Logo /><Separator /><ul className="catalog-rule-list"><li>O símbolo acompanha o nome textual acessível no cabeçalho.</li><li>Os PNGs originais mantêm sua base branca, inclusive no tema escuro.</li><li>Não distorcer, recolorir, inverter ou remover o fundo com CSS.</li><li>Novas variantes vetoriais e monocromáticas exigem um master de marca aprovado.</li></ul><Usage>{`import { Logo } from '@omnihub/ui';\n<Logo />\n<Logo variant="symbol" />\n<Logo variant="signature" />`}</Usage></Card>
</DocPage> };
