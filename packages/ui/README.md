# @omnihub/ui

Fundação visual do Omnihub: tokens, componentes React e catálogo Storybook.
React 19, Tailwind CSS 4, Lucide e primitivas Radix. A biblioteca é privada ao
monorepo e exporta TypeScript fonte para o bundler consumidor.

## Abrir e validar

Na raiz, com Bun 1.4+ e Node 20.19+ ou 22.12+ disponível para o Storybook/Vite:

```powershell
bun install
bun run dev:ui
# Abra http://localhost:6006
```

O menu lateral organiza fundamentos, componentes e padrões. A busca localiza
exemplos. Cada URL identifica uma história; copie-a para registrar feedback.
Use o seletor Sistema/Claro/Escuro nas páginas ou na barra superior, os controles
de viewport e zoom do Storybook e o painel Controls para propriedades expostas.
Se o painel estiver recolhido, use o botão “Show addon panel” na barra superior.
Os menus da ferramenta Storybook mantêm alguns rótulos em inglês; o conteúdo
do Omnihub está em português.

Teste os formulários, menus, diálogos e drawers com Tab, Shift+Tab, setas,
Enter/Espaço e Escape. Os padrões incluem busca, filtros, paginação, detalhes,
troca de etapa e falha ilustrativa de entrega. A seção Estoque oferece exemplos
de carregamento, vazio, erro recuperável e dados desatualizados. Tudo usa dados
ilustrativos locais; API, PostgreSQL, ERP e credenciais são dispensáveis.

```powershell
bun run build:ui
bun run preview:ui
# http://localhost:6006, sem dev:ui usando a mesma porta
bun run test:ui
```

O build fica em `packages/ui/storybook-static/` (ignorado pelo Git). Os testes
usam Playwright com Google Chrome instalado e iniciam o catálogo se necessário.
Para testar um servidor já iniciado em outra porta, defina `UI_TEST_BASE_URL`.
Relatórios ficam em `output/design-system/` e falhas em `packages/ui/test-results/`.

## Consumir no dashboard

Adicione `"@omnihub/ui": "workspace:*"` às dependências do aplicativo React 19
e configure `@tailwindcss/vite` no Vite 7. Importe os estilos uma vez na entrada:

```tsx
import '@omnihub/ui/styles.css';
import { Button, Field, Input, ThemeProvider, ToastProvider } from '@omnihub/ui';

export function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <Field label="SKU canônico" hint="Use o identificador interno do produto.">
          <Input name="sku" />
        </Field>
        <Button onClick={() => console.log('Consultar')}>Consultar</Button>
      </ToastProvider>
    </ThemeProvider>
  );
}
```

Para aplicar o tema antes do primeiro desenho, inclua o conteúdo do export
`@omnihub/ui/theme-init.js` como script clássico **inline no head, antes dos
estilos**. Em Vite, um plugin `transformIndexHtml` pode lê-lo com
`readFileSync(new URL(import.meta.resolve('@omnihub/ui/theme-init.js')), 'utf8')` e injetar
`{ tag: 'script', children: themeInit, injectTo: 'head-prepend' }`.
Ele usa `localStorage['omnihub.theme']` e a preferência do sistema. O
`ThemeProvider` mantém as mudanças posteriores e tolera armazenamento bloqueado.
O Storybook já configura essa inicialização no manager e no preview.

Exports adicionais: `tokens.css` para superfícies sem componentes e
`assets/omnihub-symbol.png` / `assets/omnihub-logo.png` para a marca. Os estilos
completos já importam os tokens e Inter local; não duplique esses imports.

## API pública

Os tipos TypeScript exportados e as assinaturas em `src/components/` são o
contrato completo. Controles nativos aceitam atributos HTML e refs do React 19;
regras de domínio, requisições e validação de negócio pertencem ao consumidor.

| Componente | Propriedades e comportamento |
| --- | --- |
| `Button`, `ButtonProps` | `variant`: primary (padrão), secondary, ghost, danger; `size`: sm/md/lg; `loading` preserva o rótulo, define busy e bloqueia repetição; `type` padrão button |
| `IconButton` | Mesmo contrato de Button; `label` acessível obrigatório; ícone em children |
| `Link` | Atributos de âncora; `href` real, texto descritivo e foco visível |
| `Logo` | `variant`: compact (símbolo + texto), symbol, signature; `className` opcional |
| `ThemeProvider`, `ThemeSelect`, `useTheme` | Preferência system/light/dark; provider opcionalmente controlado por `theme`/`onThemeChange`; hook oferece `preference`/`setPreference` |
| `storedTheme`, `applyTheme` | Leitura tolerante a falhas e aplicação de `data-theme` no documento |
| `Field` | `label`, `hint`, `error`, `id`, `required`, children; associa label/descrição/erro a um controle filho; required visual deve acompanhar o atributo `required` do controle |
| `Label`, `Input`, `Textarea`, `Select` | Atributos HTML; os três controles usam o contexto de Field para ID, descrição e invalid; Select usa options nativas |
| `Checkbox`, `Switch` | `label`, `description` opcional e atributos de input (checked, onChange, disabled); switch expõe role switch |
| `RadioGroup` | `label`, `options: {value,label}[]`, `value`, `onValueChange`, `disabled`, `name`; grupo nativo com setas e legenda |
| `Card`, `Separator` | Card: title/description/action/children/className e atributos de section; Separator é hr semântico |
| `StatusBadge`, `Tone` | `tone`: neutral/success/warning/danger/info; rótulo em children e ícone por estado |
| `Alert` | title, children, tone e action; danger anuncia alert; não usar apenas cor para informar estado |
| `Skeleton` | Placeholder visual oculto a leitores; o contêiner de carregamento deve informar busy/status |
| `EmptyState`, `ErrorState` | Empty: title/description/action/icon; Error: title/description/onRetry opcional; erro permanece no contexto |
| `ToastProvider`, `useToast` | Hook recebe `{title,description?,tone?}`; até três mensagens, dispensa explícita e anúncio status/alert |
| `CopyButton` | `text` já autorizado/mascarado e label opcional; usa clipboard e relata indisponibilidade sem simular sucesso |
| `Dialog`, `Drawer` | title/description/children, trigger opcional, footer opcional e open/onOpenChange para controle externo; foco contido, Escape e retorno ao acionador |
| `DialogClose` | Primitiva Radix; use `asChild` com Button no footer para fechar |
| `AlertDialog` | trigger/title/description/confirmLabel/onConfirm; Cancelar recebe foco inicial; use para consequências reais |
| `Popover`, `Tooltip` | Popover: trigger/label/children; Tooltip: children (acionador) e label complementar; nunca a única instrução |
| `DropdownMenu` | trigger/label/items `{label,onSelect,disabled?,danger?}[]`; navegação por setas e Escape |
| `Sidebar`, `NavigationItem` | items `{id,label,icon?}`, activeItem/onNavigate; consumidor resolve navegação e roteamento |
| `AppHeader`, `AppShell` | Header: title/children; Shell: items/activeItem/onNavigate/title/children, skip link e drawer móvel; use um shell por documento |
| `Breadcrumb` | items `{label,href?}[]`; último item indica página atual |
| `Tabs` | label/items `{id,label,content,disabled?}[]`; value/onValueChange ou defaultValue; setas trocam abas |
| `Pagination` | hasPrevious/hasNext/onPrevious/onNext/label; não exige nem inventa total de registros |
| `DataTable<T>`, `Column<T>` | data/columns `{key,label,render,align?}`/getRowKey/caption; tabela semântica com rolagem local por teclado quando necessária; ordenação e busca são externas |
| `DataToolbar` | search/onSearch/searchLabel/placeholder/children; busca controlada, filtros no slot children |
| `MetricCard` | label/value/unit/description/icon; recebe números formatados e contexto do período |
| `CodePanel` | title/subtitle/code/initialLines (20)/highlightLines (base 1)/children; expansão, quebra e cópia do conteúdo completo fornecido |
| `Timeline`, `TimelineItem` | items `{id,title,description,time,dateTime?,tone?}` e label opcional; histórico textual em ordem fornecida |
| `ChartFrame`, `LineChart` | Frame: title/description/children/fallback; Line: data `{label,value}[]`, unit/label; linha para valores não negativos, resumo acessível e tabela alternativa no Frame |
| `cx` | Composição de classes via clsx; não cria variantes nem regras visuais |

Os estados específicos estão nas histórias. Os botões têm foco e disabled;
Input/Select/Textarea têm ajuda, erro e disabled; feedback cobre sucesso, atenção,
erro, vazio, busy e desatualizado. Overlays usam Radix para gerenciamento de foco
e semântica. Toasts não substituem erros persistentes junto aos campos.

## Tokens e novas variantes

`src/styles/tokens.css` é a única fonte de valores de cor e escalas. Primitivos
`--oh-*` alimentam papéis `--color-*`; claro/escuro trocam os papéis. Componentes
usam tokens semânticos. A integração Tailwind oferece aliases como
`bg-canvas`, `bg-panel`, `text-foreground` e `bg-primary`.

1. Procure primeiro o componente e a história existente.
2. Adicione variante tipada somente se representar uso reutilizável. Regras de
   negócio e composições de estoque/pedido ficam nas features do dashboard.
3. Se precisar de um novo papel, adicione seu token nos dois temas; evite cores
   locais, valores duplicados e cópias manuais dos tokens em JSON/TypeScript.
4. Adicione histórias com estados aplicáveis, conteúdo longo, teclado e mobile,
   usando dados claramente ilustrativos. Exponha controles que alterem o exemplo.
5. Atualize esta API e as diretrizes; rode typecheck, testes afetados e build.
   Para alterações de foco, contraste ou layout, inclua a verificação relevante
   na suíte Playwright e faça revisão visual nos dois temas.

A meta é WCAG 2.2 AA. Axe, medições de contraste, reflow e teclado dão evidência
dos cenários testados; não equivalem a uma auditoria completa com tecnologias
assistivas. Verificações manuais futuras devem manter essa cobertura.

## Marca e fontes

Os PNGs fornecidos pelo autor foram copiados sem alteração para `src/assets/`;
a base branca do símbolo é intencional no tema escuro. Não há remoção de fundo,
inversão de cores ou redesenho. Navy/turquesa são aproximações do raster;
as ações usam variantes com contraste adequado.

Inter latin 400/500/600 vem de `@fontsource/inter`, servida localmente. A licença
SIL Open Font License está em [licenses/Inter-OFL.txt](licenses/Inter-OFL.txt).
As diretrizes de produto ficam em [docs/design-system/plan.md](../../docs/design-system/plan.md).
