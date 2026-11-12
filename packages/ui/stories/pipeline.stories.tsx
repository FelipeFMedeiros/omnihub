import type { Meta, StoryObj } from '@storybook/react-vite';
import { OperationDemo } from './patterns';
const meta = { title:'Padrões Omnihub/Fluxo de pedidos',id:'padroes-pipeline' } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Interativo: Story = { name:'Origem, canônico e ERP',render:() => <OperationDemo initialArea="pipeline" /> };
export const EntregaPendente: Story = { name:'Reserva ativa e entrega pendente',render:() => <OperationDemo initialArea="pipeline" initialFailure /> };
