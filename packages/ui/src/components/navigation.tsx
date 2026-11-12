import { Tabs as TabsPrimitive } from 'radix-ui';
import { ChevronLeft, ChevronRight, Menu } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Button, cx, IconButton, Logo, ThemeSelect } from './primitives';
import { Drawer } from './overlays';

export interface NavigationItem { id: string; label: string; icon?: ReactNode }
export function Sidebar({ items, activeItem, onNavigate }: { items: readonly NavigationItem[]; activeItem: string; onNavigate: (id: string) => void }) {
  return <nav className="oh-sidebar-nav" aria-label="Navegação principal">{items.map(item => <button type="button" className="oh-sidebar-link" aria-current={activeItem === item.id ? 'page' : undefined} key={item.id} onClick={() => onNavigate(item.id)}>{item.icon}{item.label}</button>)}</nav>;
}
export function AppHeader({ title, children }: { title?: string; children?: ReactNode }) {
  return <header className="oh-app-header"><Logo /><div className="oh-header-title">{title}</div><div className="oh-header-actions">{children ?? <ThemeSelect />}</div></header>;
}
export function AppShell({ children, items, activeItem, onNavigate, title = 'Central de operações' }: { children: ReactNode; items: readonly NavigationItem[]; activeItem: string; onNavigate: (id: string) => void; title?: string }) {
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    const query = matchMedia('(min-width: 1024px)');
    const close = () => { if (query.matches) setMenuOpen(false); };
    query.addEventListener('change', close); return () => query.removeEventListener('change', close);
  }, []);
  const navigate = (id: string) => { onNavigate(id); setMenuOpen(false); };
  return <div className="oh-app-shell"><a className="oh-skip-link" href="#oh-main-content">Ir para o conteúdo</a><AppHeader title={title}>
    <div className="oh-mobile-nav"><Drawer open={menuOpen} onOpenChange={setMenuOpen} title="Menu" description="Escolha uma área do Omnihub." trigger={<IconButton label="Abrir navegação" variant="ghost"><Menu size={20} aria-hidden="true" /></IconButton>}><Sidebar items={items} activeItem={activeItem} onNavigate={navigate} /></Drawer></div><ThemeSelect />
  </AppHeader><div className="oh-app-layout"><aside className="oh-app-sidebar"><p className="oh-overline">Operação</p><Sidebar items={items} activeItem={activeItem} onNavigate={navigate} /><p className="oh-sidebar-note">Diferentes fontes.<br />Uma informação consistente.</p></aside><main id="oh-main-content" className="oh-app-main" tabIndex={-1}>{children}</main></div></div>;
}
export function Breadcrumb({ items }: { items: readonly { label: string; href?: string }[] }) {
  return <nav aria-label="Localização"><ol className="oh-breadcrumb">{items.map((item, index) => <li key={`${item.label}-${index}`}>{index > 0 && <ChevronRight size={12} aria-hidden="true" />}{item.href && index !== items.length - 1 ? <a href={item.href}>{item.label}</a> : <span aria-current={index === items.length - 1 ? 'page' : undefined}>{item.label}</span>}</li>)}</ol></nav>;
}
export function Tabs({ label, items, value, defaultValue, onValueChange }: { label: string; items: readonly { id: string; label: string; content: ReactNode; disabled?: boolean }[]; value?: string; defaultValue?: string; onValueChange?: (value: string) => void }) {
  return <TabsPrimitive.Root value={value} defaultValue={defaultValue ?? items[0]?.id} onValueChange={onValueChange} className="oh-tabs"><TabsPrimitive.List className="oh-tab-list" aria-label={label}>{items.map(item => <TabsPrimitive.Trigger className="oh-tab" value={item.id} key={item.id} disabled={item.disabled}>{item.label}</TabsPrimitive.Trigger>)}</TabsPrimitive.List>{items.map(item => <TabsPrimitive.Content className="oh-tab-panel" key={item.id} value={item.id}>{item.content}</TabsPrimitive.Content>)}</TabsPrimitive.Root>;
}
export function Pagination({ hasPrevious, hasNext, onPrevious, onNext, label = 'Resultados' }: { hasPrevious: boolean; hasNext: boolean; onPrevious: () => void; onNext: () => void; label?: string }) {
  return <nav className="oh-pagination" aria-label="Paginação"><span className="oh-hint" aria-live="polite">{label}</span><div className="oh-row"><Button size="sm" variant="secondary" disabled={!hasPrevious} onClick={onPrevious}><ChevronLeft size={15} aria-hidden="true" />Anterior</Button><Button size="sm" variant="secondary" disabled={!hasNext} onClick={onNext}>Próxima<ChevronRight size={15} aria-hidden="true" /></Button></div></nav>;
}
