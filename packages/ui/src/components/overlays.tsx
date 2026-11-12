import { AlertDialog as AlertPrimitive, Dialog as DialogPrimitive, DropdownMenu as DropdownPrimitive, Popover as PopoverPrimitive, Tooltip as TooltipPrimitive } from 'radix-ui';
import { X } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { Button, IconButton } from './primitives';

interface DialogProps { trigger?: ReactElement; title: string; description: string; children: ReactNode; footer?: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }
function Modal({ trigger, title, description, children, footer, open, onOpenChange, drawer = false }: DialogProps & { drawer?: boolean }) {
  return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>{trigger && <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>}<DialogPrimitive.Portal><DialogPrimitive.Overlay className="oh-overlay" /><DialogPrimitive.Content className={drawer ? 'oh-dialog oh-drawer' : 'oh-dialog'}>
    <div className="oh-dialog-heading"><DialogPrimitive.Title className="oh-dialog-title">{title}</DialogPrimitive.Title><DialogPrimitive.Close asChild><IconButton variant="ghost" size="sm" label={drawer ? 'Fechar painel' : 'Fechar diálogo'}><X size={18} aria-hidden="true" /></IconButton></DialogPrimitive.Close></div>
    <DialogPrimitive.Description className="oh-hint">{description}</DialogPrimitive.Description><div className="oh-dialog-body">{children}</div>{footer && <footer className="oh-dialog-footer">{footer}</footer>}
  </DialogPrimitive.Content></DialogPrimitive.Portal></DialogPrimitive.Root>;
}
export function Dialog(props: DialogProps) { return <Modal {...props} />; }
export function Drawer(props: DialogProps) { return <Modal {...props} drawer />; }
export const DialogClose = DialogPrimitive.Close;
export function AlertDialog({ trigger, title, description, confirmLabel = 'Confirmar', onConfirm }: { trigger: ReactElement; title: string; description: string; confirmLabel?: string; onConfirm: () => void }) {
  return <AlertPrimitive.Root><AlertPrimitive.Trigger asChild>{trigger}</AlertPrimitive.Trigger><AlertPrimitive.Portal><AlertPrimitive.Overlay className="oh-overlay" /><AlertPrimitive.Content className="oh-dialog">
    <AlertPrimitive.Title className="oh-dialog-title">{title}</AlertPrimitive.Title><AlertPrimitive.Description className="oh-alert-description">{description}</AlertPrimitive.Description><div className="oh-dialog-footer"><AlertPrimitive.Cancel asChild><Button variant="secondary">Cancelar</Button></AlertPrimitive.Cancel><AlertPrimitive.Action asChild><Button variant="danger" onClick={onConfirm}>{confirmLabel}</Button></AlertPrimitive.Action></div>
  </AlertPrimitive.Content></AlertPrimitive.Portal></AlertPrimitive.Root>;
}
export function Popover({ trigger, label, children }: { trigger: ReactElement; label: string; children: ReactNode }) {
  return <PopoverPrimitive.Root><PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger><PopoverPrimitive.Portal><PopoverPrimitive.Content className="oh-popover" sideOffset={8} aria-label={label}>
    {children}<PopoverPrimitive.Close asChild><IconButton variant="ghost" size="sm" label="Fechar opções"><X size={16} aria-hidden="true" /></IconButton></PopoverPrimitive.Close>
  </PopoverPrimitive.Content></PopoverPrimitive.Portal></PopoverPrimitive.Root>;
}
export function Tooltip({ children, label }: { children: ReactElement; label: string }) {
  return <TooltipPrimitive.Provider delayDuration={300}><TooltipPrimitive.Root><TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger><TooltipPrimitive.Portal><TooltipPrimitive.Content className="oh-tooltip" sideOffset={8}>{label}</TooltipPrimitive.Content></TooltipPrimitive.Portal></TooltipPrimitive.Root></TooltipPrimitive.Provider>;
}
export interface MenuItem { id: string; label: string; onSelect?: () => void; disabled?: boolean; destructive?: boolean; icon?: ReactNode }
export function DropdownMenu({ trigger, items, label }: { trigger: ReactElement; items: readonly MenuItem[]; label: string }) {
  return <DropdownPrimitive.Root><DropdownPrimitive.Trigger asChild>{trigger}</DropdownPrimitive.Trigger><DropdownPrimitive.Portal><DropdownPrimitive.Content className="oh-dropdown" sideOffset={8} aria-label={label}>
    {items.map(item => <DropdownPrimitive.Item className={item.destructive ? 'oh-menu-item oh-menu-item--danger' : 'oh-menu-item'} key={item.id} disabled={item.disabled} onSelect={item.onSelect}>{item.icon}{item.label}</DropdownPrimitive.Item>)}
  </DropdownPrimitive.Content></DropdownPrimitive.Portal></DropdownPrimitive.Root>;
}
