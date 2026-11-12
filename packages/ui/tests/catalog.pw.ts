import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function story(page: Page, id: string, theme = 'light') {
  await page.goto(`/iframe.html?id=${id}&viewMode=story&globals=appearance:${theme}`);
  await expect(page.locator('#storybook-root')).not.toBeEmpty();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await page.evaluate(() => document.fonts.ready);
}

test('menu, busca e links do catálogo', async ({ page }) => {
  await page.goto('/?path=/story/visao-geral--inicio');
  const frame = page.frameLocator('#storybook-preview-iframe');
  await expect(frame.getByRole('heading', { name:'Conectar é só o começo.' })).toBeVisible();
  await frame.getByRole('link', { name:'Explorar os padrões' }).click();
  await expect(page).toHaveURL(/padroes-estoque--interativo/);
  await expect(frame.getByRole('heading', { name:'Estoque canônico' })).toBeVisible();
  const search = page.getByRole('searchbox', { name:'Search for components' });
  await search.fill('Botão');
  await expect(page.getByText('Botão', { exact:true }).filter({ visible:true }).first()).toBeVisible();
  await page.keyboard.press('Escape');
});

test('tema persiste e acompanha a preferência do sistema', async ({ page }) => {
  // Persistence is tested without a URL override: shared links may pin a theme.
  await page.goto('/iframe.html?id=visao-geral--inicio&viewMode=story');
  await expect(page.getByRole('combobox', { name:'Tema da interface' })).toBeVisible();
  await page.getByRole('combobox', { name:'Tema da interface' }).selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await page.getByRole('combobox', { name:'Tema da interface' }).selectOption('system');
  await page.emulateMedia({ colorScheme:'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme','light');
  await page.emulateMedia({ colorScheme:'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
});

test('menu do catálogo no celular e controles alteram o componente real', async ({ page }) => {
  await page.setViewportSize({ width:390,height:844 });
  await page.goto('/?path=/story/visao-geral--inicio');
  const frame = page.frameLocator('#storybook-preview-iframe');
  await expect(frame.getByRole('heading', { name:'Conectar é só o começo.' })).toBeVisible();
  await page.getByRole('button', { name:'Open navigation menu' }).click();
  await page.getByRole('button', { name:'Botão',exact:true }).click();
  await page.getByRole('link', { name:'Primário',exact:true }).click();
  await expect(page).toHaveURL(/acoes-botao--primario/);
  await frame.getByRole('textbox', { name:'Texto do botão' }).fill('Aplicar ajustes');
  const button = frame.getByRole('button', { name:'Aplicar ajustes',exact:true });
  await expect(button).toBeEnabled();
  await frame.getByRole('combobox', { name:'Variação' }).selectOption('danger');
  await expect(button).toHaveClass(/oh-button--danger/);
  await frame.getByRole('checkbox', { name:'Carregando',exact:true }).check();
  await expect(button).toBeDisabled(); await expect(button).toHaveAttribute('aria-busy','true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('formulário valida, mantém valores, anuncia conclusão e usa seleções independentes', async ({ page }) => {
  await story(page,'formularios-campos--validacao');
  await page.getByRole('button', { name:'Salvar preferências' }).click();
  const sku = page.getByRole('textbox', { name:'SKU canônico' });
  await expect(sku).toBeFocused(); await expect(sku).toHaveAttribute('aria-invalid','true');
  await expect(page.getByRole('alert')).toHaveText('Informe o SKU canônico para continuar.');
  await sku.fill('SKU-FONTE-600W');
  await page.getByRole('radio', { name:'Compacta em desktop' }).check();
  await expect(page.getByRole('combobox', { name:'Canal' })).toHaveValue('all');
  await page.getByRole('button', { name:'Salvar preferências' }).click();
  await expect(page.getByText('Preferências salvas nesta demonstração')).toBeVisible();
  await expect(sku).toHaveValue('SKU-FONTE-600W');
  await page.getByRole('button', { name:'Dispensar: Preferências salvas' }).click();
  await expect(page.getByRole('button', { name:'Dispensar: Preferências salvas' })).toHaveCount(0);
});

test('diálogo contém foco, fecha por Escape e devolve o foco ao botão', async ({ page }) => {
  await story(page,'sobreposicoes--interativas');
  const trigger = page.getByRole('button', { name:'Editar identificação' });
  await trigger.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name:'Editar identificação' });
  await expect(dialog).toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
  for (let i=0;i<6;i++) await page.keyboard.press('Tab');
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
  await page.getByRole('button', { name:'Remover vínculo',exact:true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await expect(page.getByRole('button', { name:'Cancelar',exact:true })).toBeFocused();
  await page.getByRole('button', { name:'Cancelar',exact:true }).click();
});

test('menu, popover e abas funcionam por teclado', async ({ page }) => {
  await story(page,'sobreposicoes--interativas');
  await page.getByRole('button', { name:'Mais ações do produto' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name:'Consultar histórico' })).toBeFocused();
  await page.keyboard.press('ArrowDown'); await expect(page.getByRole('menuitem', { name:'Exportar seleção' })).toBeFocused();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name:'Filtros',exact:true }).click();
  await expect(page.getByRole('checkbox', { name:'Com disponibilidade' })).toBeVisible();
  await page.keyboard.press('Escape');
  await story(page,'navegacao--estrutura');
  await page.getByRole('tab', { name:'Resumo',exact:true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name:'Histórico' })).toHaveAttribute('aria-selected','true');
});

test('estoque filtra fixtures, pagina e mostra saldo sem confundir físico com disponível', async ({ page }) => {
  await story(page,'padroes-estoque--interativo');
  await page.getByRole('combobox', { name:'Filtrar disponibilidade' }).selectOption('unavailable');
  await expect(page.getByText('SSD NVMe 1 TB', { exact:true }).filter({ visible:true })).toBeVisible();
  await page.getByRole('button', { name:'Detalhes de SSD NVMe 1 TB' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Há saldo físico, mas não há disponibilidade')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('combobox', { name:'Filtrar disponibilidade' }).selectOption('all');
  await page.getByRole('button', { name:'Próxima' }).click();
  await expect(page.getByText('Memória DDR5 16 GB', { exact:true }).filter({ visible:true })).toBeVisible();
  await page.getByRole('searchbox', { name:'Buscar produto por nome ou SKU' }).fill('inexistente');
  await expect(page.getByRole('heading', { name:'Nenhum produto encontrado' })).toBeVisible();
  await page.getByRole('button', { name:'Limpar filtros' }).click();
  await expect(page.getByText('Fonte ATX 600W', { exact:true }).filter({ visible:true })).toBeVisible();
});

test('pipeline alterna campos e etapas, preserva reserva em falha de entrega', async ({ page }) => {
  await page.setViewportSize({ width:390,height:900 });
  await story(page,'padroes-pipeline--interativo');
  await expect(page.getByLabel('Código: Canônico')).toBeVisible();
  await page.getByRole('button', { name:'Origem',exact:true }).click();
  await expect(page.getByLabel('Código: Origem')).toBeVisible();
  await page.getByRole('combobox', { name:'Investigar campo' }).selectOption('postal');
  await expect(page.locator('.oh-code-highlight:visible')).toContainText('59.600-000');
  await page.getByRole('button', { name:'Simular falha no exemplo' }).click();
  await expect(page.getByText('A reserva permanece ativa', { exact:true })).toBeVisible();
  await page.getByRole('button', { name:'Abrir navegação' }).click();
  await page.getByRole('dialog').getByRole('button', { name:'Estoque',exact:true }).click();
  await expect(page.getByRole('heading', { name:'Estoque canônico' })).toBeVisible();
});

test('conteúdo longo expande e gráficos oferecem tabela', async ({ page }) => {
  await story(page,'dados--codigo');
  await page.getByRole('button', { name:/Exibir conteúdo completo/ }).click();
  await expect(page.getByLabel('Código: Pedido canônico ilustrativo')).toContainText('metadata');
  await page.getByRole('checkbox', { name:'Quebrar linhas' }).uncheck();
  await expect(page.getByLabel('Código: Pedido canônico ilustrativo')).toHaveClass(/oh-code--nowrap/);
  await story(page,'dados--apresentacao');
  await page.getByText('Ver dados em tabela', { exact:true }).click();
  await expect(page.getByRole('table', { name:'Pedidos por intervalo' })).toBeVisible();
});

for (const width of [320,390,768,1024,1440]) {
  for (const id of ['visao-geral--inicio','padroes-estoque--interativo','padroes-pipeline--interativo']) {
    test(`reflow ${width}px · ${id}`, async ({ page }) => {
      await page.setViewportSize({ width,height:1000 }); await story(page,id);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      if (width === 320 && id === 'padroes-estoque--interativo') {
        await page.getByRole('button', { name:'Próxima' }).click();
        await expect(page.getByText('Memória DDR5 16 GB', { exact:true }).filter({ visible:true })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      }
    });
  }
}

for (const theme of ['light','dark']) {
  for (const id of ['visao-geral--inicio','formularios-campos--validacao','sobreposicoes--interativas','padroes-estoque--interativo','padroes-pipeline--interativo']) {
    test(`acessibilidade ${theme} · ${id}`, async ({ page }) => {
      await story(page,id,theme);
      if (id === 'sobreposicoes--interativas') await page.getByRole('button', { name:'Editar identificação' }).click();
      const result = await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();
      expect(result.violations).toEqual([]);
    });
  }
}

test('todas as páginas registradas renderizam sem exceção nem acesso ao backend', async ({ page, request }) => {
  const errors: string[] = []; const backend: string[] = [];
  page.on('pageerror',error => errors.push(error.message));
  page.on('request',request => { if (/:(3000|3002)\//.test(request.url())) backend.push(request.url()); });
  const index = await request.get('/index.json'); const { entries } = await index.json() as { entries: Record<string,{ id:string;type:string }> };
  const stories = Object.values(entries).filter(entry => entry.type === 'story');
  expect(stories.length).toBeGreaterThanOrEqual(30);
  for (const entry of stories) {
    await story(page,entry.id);
    await expect(page.locator('.sb-errordisplay')).not.toBeVisible();
  }
  expect(errors).toEqual([]); expect(backend).toEqual([]);
});

for (const theme of ['light','dark']) {
  test(`contraste de texto, estados e controles · ${theme}`, async ({ page }) => {
    await story(page,'cores-paleta--semantica',theme);
    const ratios = await page.evaluate(() => {
      const probe = document.createElement('span'); document.body.append(probe);
      const rgb = (token: string) => {
        probe.style.color = `var(${token})`;
        return getComputedStyle(probe).color.match(/[\d.]+/g)!.slice(0,3).map(value => Number(value)/255);
      };
      const luminance = (token: string) => rgb(token).map(value => value <= .04045 ? value/12.92 : ((value+.055)/1.055)**2.4).reduce((sum,value,index) => sum + value * [0.2126,0.7152,0.0722][index]!,0);
      const pairs: [string,string,number][] = [
        ['--color-text','--color-surface',4.5],['--color-text-muted','--color-surface',4.5],
        ['--color-action-text','--color-action-primary',4.5],['--color-action-text','--color-action-hover',4.5],
        ['--color-success','--color-success-bg',4.5],['--color-warning','--color-warning-bg',4.5],['--color-danger','--color-danger-bg',4.5],['--color-info','--color-info-bg',4.5],
        ['--color-control-border','--color-surface',3],['--color-focus','--color-surface',3],
      ];
      const result = pairs.map(([foreground,background,minimum]) => {
        const first=luminance(foreground),second=luminance(background);
        return { foreground,background,minimum,ratio:(Math.max(first,second)+.05)/(Math.min(first,second)+.05) };
      });
      probe.remove(); return result;
    });
    for (const pair of ratios) expect(pair.ratio,`${pair.foreground} / ${pair.background}`).toBeGreaterThanOrEqual(pair.minimum);
    await test.info().attach('contrastes',{ body:JSON.stringify(ratios,null,2),contentType:'application/json' });
  });
}

test('texto ampliado a 200% preserva a largura da página', async ({ page }) => {
  await page.setViewportSize({ width:1280,height:1000 });
  for (const id of ['visao-geral--inicio','padroes-estoque--interativo','padroes-pipeline--interativo']) {
    await story(page,id); await page.addStyleTag({ content:'html { font-size: 200%; }' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),id).toBe(true);
  }
});
