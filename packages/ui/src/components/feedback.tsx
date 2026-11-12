import { createContext, useContext, useId, useRef, useState, type ComponentPropsWithRef, type ReactNode } from 'react';
import { Check, CheckCircle2, CircleHelp, CircleX, Info, PackageOpen, RefreshCw, TriangleAlert, X } from 'lucide-react';
import { Button, cx, IconButton } from './primitives';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';
const toneIcons = { neutral: CircleHelp, success: CheckCircle2, warning: TriangleAlert, danger: CircleX, info: Info };
export function StatusBadge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  const Icon = toneIcons[tone];
  return <span className={cx('oh-badge', `oh-tone--${tone}`)}><Icon size={14} aria-hidden="true" />{children}</span>;
}
export function Alert({ title, children, tone = 'info', action }: { title: string; children?: ReactNode; tone?: Tone; action?: ReactNode }) {
  const Icon = toneIcons[tone];
  return <div className={cx('oh-alert', `oh-tone--${tone}`)} role={tone === 'danger' ? 'alert' : undefined}><Icon size={19} aria-hidden="true" /><div><p className="oh-label">{title}</p>{children && <div className="oh-alert-copy">{children}</div>}{action && <div className="oh-alert-action">{action}</div>}</div></div>;
}
export function Skeleton({ className, ...props }: ComponentPropsWithRef<'div'>) { return <div {...props} aria-hidden="true" className={cx('oh-skeleton', className)} />; }
export function EmptyState({ title = 'Nada por aqui ainda', description, action, icon }: { title?: string; description: string; action?: ReactNode; icon?: ReactNode }) {
  return <div className="oh-empty"><div className="oh-empty-icon" aria-hidden="true">{icon ?? <PackageOpen size={24} />}</div><h3>{title}</h3><p>{description}</p>{action}</div>;
}
export function ErrorState({ title = 'Não foi possível carregar', description = 'Verifique sua conexão e tente novamente.', onRetry }: { title?: string; description?: string; onRetry?: () => void }) {
  return <div className="oh-empty" role="alert"><div className="oh-empty-icon oh-error-icon"><TriangleAlert size={24} aria-hidden="true" /></div><h3>{title}</h3><p>{description}</p>{onRetry && <Button variant="secondary" onClick={onRetry}><RefreshCw size={16} aria-hidden="true" />Tentar novamente</Button>}</div>;
}
interface ToastMessage { title: string; description?: string; tone?: Tone }
const ToastContext = createContext<(message: ToastMessage) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<(ToastMessage & { id: number })[]>([]);
  const counter = useRef(0); const region = useId();
  const notify = (message: ToastMessage) => { counter.current++; setMessages(previous => [...previous.slice(-2), { ...message, id: counter.current }]); };
  return <ToastContext.Provider value={notify}>{children}<section className="oh-toasts" aria-label="Notificações" id={region}>{messages.map(message => <div className="oh-toast" key={message.id}>
    <div role={message.tone === 'danger' ? 'alert' : 'status'} className="oh-toast-copy"><p className="oh-label">{message.title}</p>{message.description && <p className="oh-hint">{message.description}</p>}</div>
    <IconButton variant="ghost" size="sm" label={`Dispensar: ${message.title}`} onClick={() => setMessages(previous => previous.filter(item => item.id !== message.id))}><X size={16} aria-hidden="true" /></IconButton>
  </div>)}</section></ToastContext.Provider>;
}
export const useToast = () => useContext(ToastContext);
export function CopyButton({ text, label = 'Copiar' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false); const notify = useToast();
  return <Button size="sm" variant="ghost" onClick={async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); notify({ title: 'Copiado', description: 'O conteúdo exibido foi copiado.' }); }
    catch { notify({ title: 'Não foi possível copiar', description: 'Selecione o conteúdo e copie pelo teclado.', tone: 'danger' }); }
  }}>{copied && <Check size={14} aria-hidden="true" />}{copied ? 'Copiado' : label}</Button>;
}
