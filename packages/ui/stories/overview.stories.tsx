import type { Meta, StoryObj } from '@storybook/react-vite';
import { OperationDemo } from './patterns';
const meta = { title:'Padrões Omnihub/Visão geral',id:'padroes-overview' } satisfies Meta;
export default meta;
export const Operacao: StoryObj<typeof meta> = { name:'Visão da operação',render:() => <OperationDemo initialArea="overview" /> };
