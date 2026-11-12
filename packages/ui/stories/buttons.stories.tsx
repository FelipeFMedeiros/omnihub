import type { Meta, StoryObj } from '@storybook/react-vite';
import { useArgs } from 'storybook/preview-api';
import { Download, Plus, Settings } from 'lucide-react';
import { Button, Checkbox, Field, IconButton, Input, Link, Select, type ButtonProps } from '../src';
import { DocPage, Usage } from './docs';

const meta = {
  title: 'Ações/Botão', id: 'acoes-botao', component: Button,
  args: { children: 'Confirmar', variant: 'primary', size: 'md', loading: false, disabled: false },
  argTypes: { variant: { control: 'select', options: ['primary','secondary','ghost','danger'] }, size: { control: 'select', options: ['sm','md','lg'] }, children: { control: 'text' }, loading: { control: 'boolean' }, disabled: { control: 'boolean' } },
  render: function Playground() {
    const [args, update] = useArgs<ButtonProps>();
    return <DocPage category="Ações" title="Uma ação, uma intenção." lead="A ação primária conduz o próximo passo. Ações secundárias apoiam; ações destrutivas explicam o impacto antes de acontecer.">
      <section className="oh-card"><div className="oh-card-body"><div className="catalog-demo"><Button {...args} /><IconButton label="Preferências" variant="secondary"><Settings size={18} aria-hidden="true" /></IconButton><Link href="./?path=/story/formularios-campos--validacao" target="_top">Ver formulários</Link></div></div></section>
      <div className="catalog-grid"><Field label="Variação"><Select value={args.variant} onChange={event => update({ variant: event.target.value as ButtonProps['variant'] })}><option value="primary">Primária</option><option value="secondary">Secundária</option><option value="ghost">Discreta</option><option value="danger">Destrutiva</option></Select></Field><Field label="Texto do botão"><Input value={String(args.children)} onChange={event => update({ children: event.target.value })} /></Field></div>
      <div className="catalog-demo"><Checkbox label="Carregando" checked={args.loading} onChange={event => update({ loading: event.target.checked })} /><Checkbox label="Desabilitado" checked={args.disabled} onChange={event => update({ disabled: event.target.checked })} /></div>
      <p className="catalog-note">Durante o envio, o botão preserva o texto, informa que está ocupado e bloqueia novos acionamentos. Ícones de ação sempre têm nome acessível.</p>
      <Usage>{`import { Button, IconButton } from '@omnihub/ui';\n<Button variant="${args.variant}" loading={${args.loading}}>Confirmar</Button>\n<IconButton label="Preferências" variant="secondary"><Settings /></IconButton>`}</Usage>
    </DocPage>;
  },
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Primario: Story = { name: 'Primário' };
export const Secundario: Story = { name: 'Secundário', args: { variant: 'secondary' } };
export const Carregando: Story = { name: 'Carregando', args: { loading: true, children: 'Salvando' } };
export const Desabilitado: Story = { name: 'Desabilitado', args: { disabled: true } };
export const ComIcones: Story = { name: 'Ícones e links', render: () => <DocPage category="Ações" title="Um apoio visual, sem ambiguidade." lead="O ícone ajuda a reconhecer a ação; o nome continua acessível."><div className="catalog-demo"><Button><Plus size={17} aria-hidden="true" />Novo vínculo</Button><Button variant="secondary"><Download size={17} aria-hidden="true" />Exportar</Button><IconButton label="Abrir preferências" variant="ghost"><Settings size={18} aria-hidden="true" /></IconButton></div><Usage>{`<Button><Plus aria-hidden="true" />Novo vínculo</Button>\n<IconButton label="Abrir preferências"><Settings /></IconButton>`}</Usage></DocPage> };
