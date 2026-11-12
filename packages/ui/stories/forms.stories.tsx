import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, Checkbox, Field, Input, RadioGroup, Select, Switch, Textarea, useToast } from '../src';
import { DocPage, Usage } from './docs';

function FormDemo({ disabled = false, startWithError = false }: { disabled?: boolean; startWithError?: boolean }) {
  const [sku, setSku] = useState(''); const [submitted, setSubmitted] = useState(startWithError);
  const [channel, setChannel] = useState('all'); const [notifications, setNotifications] = useState(true);
  const [density, setDensity] = useState('comfortable');
  const [submitting, setSubmitting] = useState(false); const [complete, setComplete] = useState(false); const notify = useToast();
  const error = submitted && !sku.trim() ? 'Informe o SKU canônico para continuar.' : undefined;
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSubmitted(true); setComplete(false);
    if (!sku.trim()) { document.getElementById('form-demo-sku')?.focus(); return; }
    setSubmitting(true); await new Promise(resolve => setTimeout(resolve, 450)); setSubmitting(false); setComplete(true);
    notify({ title: 'Preferências salvas', description: 'Esta é uma confirmação ilustrativa.' });
  };
  return <DocPage category="Formulários" title="Preencher com confiança." lead="Rótulos visíveis, ajuda no contexto e mensagens que mostram como corrigir. Uma falha não apaga o que já foi preenchido.">
    <Card title="Preferências de consulta" description="Exemplo interativo. Nenhum dado é enviado para a API."><form className="catalog-demo-column" onSubmit={submit} noValidate>
      <Field id="form-demo-sku" label="SKU canônico" hint="Use o identificador do catálogo central." error={error} required><Input id="form-demo-sku" required value={sku} disabled={disabled} onChange={event => { setSku(event.target.value); setComplete(false); }} placeholder="Ex.: SKU-FONTE-600W" /></Field>
      <Field label="Canal"><Select value={channel} onChange={event => setChannel(event.target.value)} disabled={disabled}><option value="all">Todos os canais</option><option value="meli">Mercado Livre</option><option value="shopee">Shopee</option><option value="amazon">Amazon</option></Select></Field>
      <Field label="Observação" hint="Não inclua senhas ou informações pessoais."><Textarea placeholder="Uma anotação para a equipe..." disabled={disabled} /></Field>
      <Checkbox label="Incluir produtos sem disponibilidade" description="A consulta continua mostrando os saldos físicos e reservados." defaultChecked disabled={disabled} />
      <Switch label="Receber avisos na interface" checked={notifications} onChange={event => setNotifications(event.target.checked)} disabled={disabled} />
      <RadioGroup label="Densidade de leitura" value={density} onValueChange={setDensity} options={[{ value:'comfortable',label:'Confortável' },{ value:'compact',label:'Compacta em desktop' }]} disabled={disabled} />
      <div className="catalog-demo"><Button type="submit" loading={submitting} disabled={disabled}>Salvar preferências</Button><Button variant="secondary" disabled={disabled} onClick={() => { setSku(''); setSubmitted(false); setComplete(false); }}>Limpar</Button></div>
      {complete && <Alert title="Preferências salvas nesta demonstração" tone="success">O formulário manteve os valores preenchidos.</Alert>}
    </form></Card>
    <Usage>{`<Field label="SKU canônico" error={error} hint="Use o identificador central." required>\n  <Input required value={sku} onChange={event => setSku(event.target.value)} />\n</Field>`}</Usage>
  </DocPage>;
}
const meta = { title: 'Formulários/Campos e seleções', id: 'formularios-campos' } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Validacao: Story = { name: 'Preenchimento e validação', render: () => <FormDemo /> };
export const ComErro: Story = { name: 'Estado de erro', render: () => <FormDemo startWithError /> };
export const Desabilitados: Story = { name: 'Campos desabilitados', render: () => <FormDemo disabled /> };
