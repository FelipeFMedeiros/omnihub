---
project: ominihub
type: design-system-plan
status: active
version: "0.1.0"
created_at: "2026-11-02"
updated_at: "2026-11-03"
---

# Omnihub — plano do design system

Diretrizes da fundação visual implementada na TASK-009, antes da integração
do painel na TASK-006. Tokens e componentes reais estão em `packages/ui`;
a [API pública e o guia de uso](../../packages/ui/README.md) documentam o consumo.
Abra o catálogo com `bun run dev:ui` em http://localhost:6006. As histórias usam
fixtures identificadas e não acessam a API. O arquivo `omnihub-preview.html`
permanece como estudo exploratório anterior; o Storybook é a referência visual atual.

Decisões do usuário: **claro e escuro desde a primeira versão**; referência
mantida **no projeto, com documentação, tokens e vitrine de componentes**.

## 1. Direção e princípios

Uma central de operação clara, confiável e fácil de investigar. A identidade
preserva o O do Omnihub e os três segmentos que convergem para o núcleo comum:
fontes diferentes entram, informação consistente sai. Essa relação orienta a
hierarquia e a visualização do fluxo, sem transformar toda a interface em círculos.
O número de segmentos da marca não limita o número de integrações do produto.

- Clareza operacional: destacar o que exige ação, quando foi atualizado e qual
  é o próximo passo. Saldo zero e erro de sistema são situações diferentes.
- Divulgação progressiva: operação diária primeiro; detalhes técnicos, JSON e
  auditoria ficam a um clique. O modo técnico apoia também a demonstração do TCC.
- Consistência: a mesma ação, estado ou medida usa o mesmo nome e componente.
- Resposta visível: toda interação tem feedback de foco, processamento,
  conclusão, erro e recuperação quando aplicável.
- Acessibilidade e responsividade fazem parte do contrato do componente.
- Os mesmos componentes atendem aos dois temas, sem duplicar telas.

## 2. Identidade, cores e tokens

Os PNGs fornecidos são as referências da marca. A amostragem indica valores
próximos de **navy #11365F** e **turquesa #19C1B9**; existem variações no raster,
portanto esses valores são candidatos, não uma especificação oficial da logo.
Não redesenhar nem modificar os arquivos originais durante a implementação.

O turquesa da marca serve para destaque, seleção e detalhes. Para botões claros
com texto branco, usar uma variação mais escura: branco sobre #19C1B9 tem
contraste aproximado de 2,24:1; branco sobre #0F766E tem 5,47:1.

| Papel semântico | Claro | Escuro |
| --- | --- | --- |
| Fundo da aplicação | #F5F7FA | #0B1422 |
| Superfície de conteúdo | #FFFFFF | #142235 |
| Texto principal | #172B4D | #E6EDF5 |
| Texto secundário | #526174 | #A2B3C7 |
| Ação primária | #0F766E | #2DD4BF |
| Texto da ação primária | #FFFFFF | #082F2C |
| Hover da ação primária | #115E59 | #5EEAD4 |
| Borda estrutural decorativa | #DFE6EE | #2A3B50 |
| Borda essencial de campo/controle | #8293A6 | #5A718C |
| Indicador de foco | #0F766E | #5EEAD4 |
| Sucesso: texto / fundo | #166534 / #F0FDF4 | #86EFAC / #132D23 |
| Atenção: texto / fundo | #92400E / #FFFBEB | #FCD34D / #33270E |
| Erro: texto / fundo | #B42318 / #FEF3F2 | #FDA29B / #3F1718 |

Amostras calculadas: texto principal na superfície 14,10:1 / 13,59:1;
secundário 6,32:1 / 7,49:1; ação primária 5,47:1 / 7,76:1; bordas essenciais
3,15:1 / 3,19:1. A tabela não certifica toda a interface: hover, foco, seleção,
gráficos e combinações entre superfícies serão verificados na vitrine.

Tokens têm três camadas: primitivos (paleta, escala), semânticos (função) e
aliases de componente quando necessários. Componentes consomem funções, como
`--color-action-primary`, `--color-text-muted` e `--color-warning-bg`,
sem valores de cor locais. `packages/ui/src/styles/tokens.css` é a fonte dos valores; o tema altera
os aliases semânticos. Não manter um segundo JSON manual com valores divergentes.

Turquesa de marca não significa sucesso. Status usam texto e ícone além de cor.
Canal de origem recebe rótulo próprio; suas cores não substituem as de estado.
O tema começa em Sistema e permite Claro/Escuro, com preferência persistida.
A aplicação deve aplicar o tema no primeiro desenho, evitando flash do tema errado.

Enquanto não houver variantes transparentes oficiais, o símbolo PNG pode usar
uma pequena base branca intencional no tema escuro. Não remover fundo com CSS,
inverter cores nem comprimir a assinatura completa em áreas pequenas. Planejar
símbolo, assinatura, favicon e variante monocromática a partir de um master aprovado.

## 3. Tipografia, forma e movimento

Inter para interface, com fallback `system-ui`; pesos 400, 500 e 600.
Não tentar reconstruir o lettering da marca com a fonte da interface. JSON e
identificadores técnicos usam `ui-monospace`; valores numéricos usam tabular figures.
Arquivos latin hospedados localmente via `@fontsource/inter`, com licença OFL
preservada em `packages/ui/licenses/Inter-OFL.txt`.

| Elemento | Regra inicial |
| --- | --- |
| Texto de leitura e campos | 16 px, entrelinha 1,5 |
| Tabelas e rótulos | 14 px; não reduzir para acomodar mais colunas |
| Metadados complementares | 12 px; informações essenciais permanecem maiores |
| Títulos | 24–32 px na página; 18–20 px nas seções |
| Espaçamento | Base 4 px: 4, 8, 12, 16, 24, 32, 40, 48 |
| Raios | 8 px em controles; 12 px em superfícies; pill em status |
| Bordas e sombras | Bordas discretas; sombras principalmente em sobreposições |
| Altura de controles | 40 px em desktop; alvo confortável de 44 px em toque |
| Densidade | Confortável como padrão; compacta opcional em desktop, sem reduzir fonte |
| Movimento | 120–160 ms em controles; 200–240 ms em painéis |

Respeitar `prefers-reduced-motion`: remover deslocamentos e animações
desnecessárias. Não usar pulsos contínuos, animação decorativa de métricas ou
mudanças de layout que tirem o foco do trabalho. A inspiração na convergência
aparece no indicador de etapas e nas transições, não como animação permanente.

## 4. Componentes e estados

| Camada | Conteúdo inicial | Contrato mínimo |
| --- | --- | --- |
| Primitivos | Button, IconButton, Link, Input, Textarea, Select, Checkbox, Radio, Switch, Label | Variantes, tamanho, foco, disabled, loading, erro e ajuda quando aplicáveis |
| Feedback | StatusBadge, Alert, Toast, Skeleton, EmptyState, ErrorState | Mensagem com ação, ícone e contexto; não depender apenas de cor |
| Navegação | AppShell, Sidebar, Header, Breadcrumb, Tabs, Pagination | Localização atual, teclado, adaptação a toque e foco preservado |
| Sobreposições | Dialog, AlertDialog, Drawer, Popover, Dropdown, Tooltip | Escape, foco inicial e retorno ao acionador; tooltip nunca contém a única instrução |
| Dados | Table, DataToolbar, MetricCard, ChartFrame, CodePanel, Timeline | Ordenação e unidades claras; fallback tabular/textual para gráficos |
| Padrões do produto | Estoque, conectividade, etapa de pedido, fluxo de payloads | Composição dos primitivos com contratos do domínio no dashboard |

Para cada componente, documentar propósito, situações de uso, variantes,
estados aplicáveis, responsividade, teclado, rótulos, exemplos e limites.
O catálogo inclui conteúdo longo, erro, vazio, carregamento e os dois temas.

Formulários têm rótulo persistente, erro junto ao campo e preservação dos valores
ao falhar. Envio em andamento bloqueia repetição da ação e mantém o rótulo.
Toast confirma ações simples; erros que exigem correção permanecem no contexto.
Diálogos de ações sensíveis descrevem impacto e entidade afetada, sem pedir
confirmação para consultas ou operações sem consequência relevante.

## 5. Navegação e telas que validam o sistema

Navegação principal do MVP: **Visão geral**, **Estoque** e **Fluxo de pedidos**.
Integrações e configurações entram conforme suas funções existirem. Evitar menus
vazios e gráficos usados apenas como decoração. Usuários operacionais veem
vocabulário de negócio; o inspetor disponibiliza o modo técnico.

### Visão geral

KPIs de pedidos, latência, entregas e conflitos de estoque bloqueados; período
e unidade sempre explícitos. Conectividade diferencia conectado, degradado,
desconectado e desconhecido. Uma rejeição por estoque insuficiente não representa
falha técnica. Não apresentar número inventado quando a API ainda não fornece a métrica.

Atualizações em segundo plano mantêm foco, rolagem e seleção. Indicar horário
da última atualização e dados possivelmente desatualizados. Se a atualização
alterar a ordem da tabela durante leitura, oferecer aviso de novidades em vez
de mover linhas sob o ponteiro. `aria-live` anuncia resultados agrupados.

### Estoque

SKU e nome, físico, reservado, segurança, **disponível**, canais e acesso ao
histórico. O disponível é dado fornecido pela API, não recalculado no cliente.
Mostrar físico 5 e reservado 5 como disponível zero, sem sugerir desaparecimento
de estoque físico. Previsão ARIMA sem histórico mostra mensagem própria, não zero.

Tabela em desktop e lista de produtos em celular. A lista prioriza nome/SKU,
disponível e estado; a expansão/detalhe mantém acesso aos outros saldos, canais e
movimentações. Não eliminar informação para caber na tela. Ações ficam acessíveis
por teclado e toque, sem depender de hover. Números alinhados à direita.

Busca, filtros, ordenação e totais precisam de suporte da API para operar sobre
o conjunto completo. O contrato atual tem `limit`/`offset`, sem total de páginas:
usar Anterior/Próxima sem inventar contagem total. A vitrine pode demonstrar
outros estados com fixtures explicitamente identificadas.

### Fluxo de pedidos / inspetor

Uma origem, um modelo canônico, um destino. Em telas amplas, mostrar Raw JSON →
IR Canônica → Payload ERP em três painéis com ordem estável. A etapa atual,
validação e falhas têm rótulos e ícones; os conectores não são a única indicação.
Selecionar uma transformação destaca os campos correspondentes, como valor em
centavos, documento, CEP, UF e SKU. Falha no ERP pode coexistir com reserva ativa.

Em espaços menores, manter a trilha de etapas e apresentar um painel por vez.
Preservar pedido e posição lógica ao trocar de etapa. Quebra de linhas é opção
de apresentação, sem alterar o JSON copiado. Payloads longos têm limite inicial
visível e expansão explícita. Copiar dados dá feedback e respeita o mascaramento
de informações pessoais e as permissões fornecidas pelo backend.

Simulação será identificada como ambiente de teste, protegida pela autenticação
e Turnstile definidos na TASK-005. A interface chama o endpoint administrativo
autorizado; não fabrica assinaturas nem expõe chaves de marketplaces no navegador.

## 6. Responsividade e acessibilidade

Quebras por conteúdo, usando como referência 640, 768, 1024 e 1280 px do
[Tailwind](https://tailwindcss.com/docs/responsive-design). O objetivo não é
encolher o desktop: navegação, densidade e composição se reorganizam.

| Espaço disponível | Comportamento |
| --- | --- |
| 320–767 px | Navegação recolhível, formulários em uma coluna, KPIs empilhados, estoque em lista, etapas do inspetor selecionáveis |
| 768–1279 px | Navegação compacta/recolhível, KPIs em duas colunas quando couberem, filtros em painel, detalhes em drawer ou seção |
| 1280 px ou mais | Navegação lateral persistente, tabela e conteúdo mais denso, painéis conforme largura útil |
| Área do inspetor com cerca de 1056 px ou mais | Três painéis simultâneos; em um shell com sidebar, costuma exigir viewport próximo de 1440 px |

Referências de validação: 320, 390, 768, 1024 e 1440 px, zoom e orientações
diferentes. Sem rolagem horizontal da página; rolagem localizada só quando a
estrutura bidimensional for indispensável, com alternativa de leitura em detalhe.

Meta de engenharia: **WCAG 2.2 AA**, validada por componentes e fluxos. Texto
normal com 4,5:1 e texto grande com 3:1, conforme o
[critério de contraste](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).
Controles e indicadores essenciais precisam de contraste adequado ao fundo.
Adotar alvos de 44 × 44 px em toque como padrão de conforto; o critério AA de
[alvo mínimo](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
define 24 × 24 px ou as exceções de espaçamento/equivalência descritas pela W3C.
Considerar também [reflow a 320 CSS px](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html).

Teclado completo, foco visível e não encoberto, skip link, títulos semânticos,
rótulos acessíveis, erros associados ao campo e retorno de foco em sobreposições.
Português brasileiro, datas e moedas localizadas, milissegundos identificados,
sem depender de vermelho/verde para diferenciar resultados. Testes automáticos
complementam a verificação manual; a prévia não constitui certificação AA.

## 7. Implementação e fonte de verdade

Organização implementada; a pasta do dashboard continua prevista para TASK-006:

```text
docs/design-system/              Diretrizes, decisões e critérios de aceitação
packages/ui/
  src/styles/tokens.css          Valores primitivos e aliases claro/escuro
  src/components/                Componentes reutilizáveis sem regras de negócio
  src/index.ts                   API pública de @omnihub/ui
  stories/                       Estados e composições da vitrine
  .storybook/                    Catálogo em desenvolvimento e build estático
apps/web-dashboard/src/
  features/                      Estoque, overview e pipeline com contratos reais
  api/client.ts                  HTTP centralizado e erros padronizados
```

React 19, Vite 7, Tailwind 4 e Lucide compõem a base. A biblioteca possui
componentes próprios com controles HTML nativos e primitivas do pacote `radix-ui`
para abas e sobreposições. O catálogo usa Storybook 10.6.5 com addons de
documentação e acessibilidade; versões resolvidas ficam no único `bun.lock`.
O CSS usa tokens e aliases Tailwind; foco, semântica e interação são verificados
por Playwright/axe e revisão no navegador.

Um único pacote UI reúne tokens e componentes; não criar bibliotecas paralelas
de tokens com cópias dos mesmos valores. Padrões específicos de estoque e pedido
ficam nas features, evitando acoplar `@omnihub/ui` ao banco ou aos serviços HTTP.
O Storybook serve como vitrine, não como dependência de runtime do dashboard.

### Catálogo navegável para validação manual

Requisito explicitado pelo usuário a partir da referência visual: entregar uma
área própria de documentação no navegador, com navegação lateral, busca e página
de visão geral. A organização da referência inspira a estrutura; a identidade
visual permanece a do Omnihub, nos temas claro e escuro.

Comandos disponíveis na raiz:

| Comando | Uso |
| --- | --- |
| `bun run dev:ui` | Abrir a vitrine em desenvolvimento em `http://localhost:6006` |
| `bun run build:ui` | Gerar a versão estática do catálogo |
| `bun run preview:ui` | Servir localmente o catálogo compilado para revisão |
| `bun run test:ui` | Verificar interações, teclado, contraste, reflow e axe no Chrome |

A vitrine funciona com fixtures sem iniciar API, banco, Mock ERP ou dashboard.
O build estático fica em `packages/ui/storybook-static/`. Dev e preview usam
a porta 6006: execute um por vez. A publicação pode ser tratada quando solicitada.

Menu implementado:

```text
Visão geral
Marca             Logo e aplicações
Cores             Paleta, temas, cores semânticas e contraste
Tipografia        Fontes, escala e números
Layout            Espaçamento, raios, superfícies e responsividade
Ações             Botões e links
Formulários       Campos, seleções, validação e ajuda
Navegação         Shell, menu, abas e paginação
Feedback          Status, alertas, carregamento, vazio e erro
Sobreposições     Diálogos, drawers e menus
Dados             Tabelas, métricas, timeline e painéis de código
Padrões Omnihub   Visão geral, estoque e fluxo de pedidos com fixtures
```

Cada entrada deve apresentar o componente React real usado pela aplicação,
regras de uso, variantes, estados aplicáveis e exemplo de código. As amostras
devem permitir clicar, digitar, abrir, fechar e validar. Disponibilizar controles
para ajustar propriedades, alternar tema e testar larguras de tela; oferecer
links diretos para compartilhar a página e o exemplo exatos em revisão.

A página inicial reúne aplicações da marca, cores e exemplos dos padrões
operacionais. O conteúdo da documentação está em português; alguns controles
da ferramenta Storybook mantêm seus rótulos em inglês. No celular, o menu é
recolhível. A validação manual inclui teclado, foco, estados de erro e retorno
de diálogos, além da aparência nos dois temas.

## 8. Ordem de entrega e aceite

| Etapa | Entrega revisável | Critério para avançar |
| --- | --- | --- |
| Fundação | Assets, tokens, tipografia, espaçamento, dois temas | Contrastes essenciais medidos; preferência de tema sem flash |
| Componentes | Primitivos, feedback e sobreposições na vitrine | Estados aplicáveis, teclado e foco funcionando nos dois temas |
| Padrões | Shell, tabela/lista, filtros, métricas e painéis JSON com fixtures | Desktop e celular preservam acesso às mesmas informações e ações |
| Validação | Exemplos das três visões, documentação e QA | Fluxos e estados revisados antes de iniciar a integração da TASK-006 |

Definição de pronto: sem cores soltas nos componentes; estados documentados;
claro/escuro completos; sem overflow de página em 320 px; teclado e toque;
loading/vazio/erro/desatualizado; números e unidade coerentes; nenhuma regra de
saldo no UI; typecheck, build da vitrine e testes de interação relevantes;
catálogo navegável com busca e exemplos reais, comandos de abertura/build/preview
documentados; verificação visual e de acessibilidade. A revisão considera também dados longos,
SKU extenso, falha de rede, ausência de histórico e integração indisponível.

A TASK-009 entrega o design system com fixtures. A TASK-006 continua responsável
pelas telas conectadas, dependendo também de TASK-004 e TASK-005. Filtros locais,
contadores e métricas das histórias não constituem contratos novos da API.

Validação executada em 2026-11-03: typecheck dos workspaces, suíte Bun,
build estático, interações de interface, cinco larguras de referência, texto
ampliado a 200%, contraste dos papéis essenciais nos dois temas, axe e revisão
no Navegador do Orca. Resultados e evidências detalhados no log da TASK-009 no cofre.

Mudanças posteriores de componente exigem atualizar a história da vitrine e
documentar a decisão. Interfaces novas reutilizam os componentes existentes;
exceções visuais precisam de motivo e, se recorrentes, viram uma variante comum.
