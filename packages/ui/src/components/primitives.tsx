import { createContext, useContext, useId, type ComponentPropsWithRef, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { LoaderCircle } from 'lucide-react';
import { useTheme, type ThemePreference } from '../theme';
import symbol from '../assets/omnihub-symbol.png';
import signature from '../assets/omnihub-logo.png';

export const cx = clsx;
export type ButtonProps = ComponentPropsWithRef<'button'> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
};
export function Button({ variant = 'primary', size = 'md', loading, disabled, className, children, type = 'button', ...props }: ButtonProps) {
  return <button {...props} type={type} disabled={disabled || loading} aria-busy={loading || undefined} className={cx('oh-button', `oh-button--${variant}`, `oh-button--${size}`, className)}>
    {loading && <LoaderCircle className="oh-spinner" aria-hidden="true" size={16} />}{children}
  </button>;
}
export function IconButton({ label, children, className, ...props }: Omit<ButtonProps, 'aria-label'> & { label: string }) {
  return <Button {...props} aria-label={label} className={cx('oh-icon-button', className)}>{children}</Button>;
}
export function Link({ className, ...props }: ComponentPropsWithRef<'a'>) { return <a {...props} className={cx('oh-link', className)} />; }
export function Logo({ variant = 'compact', className }: { variant?: 'compact' | 'symbol' | 'signature'; className?: string }) {
  return <span className={cx('oh-logo', `oh-logo--${variant}`, className)}>
    <img src={variant === 'signature' ? signature : symbol} alt={variant === 'compact' ? '' : 'Omnihub'} />
    {variant === 'compact' && <span>Omnihub</span>}
  </span>;
}
export function ThemeSelect() {
  const { preference, setPreference } = useTheme();
  const id = useId();
  return <label className="oh-theme-select" htmlFor={id}><span>Tema</span><select id={id} aria-label="Tema da interface" value={preference} onChange={event => setPreference(event.target.value as ThemePreference)}>
    <option value="system">Sistema</option><option value="light">Claro</option><option value="dark">Escuro</option>
  </select></label>;
}

const FieldContext = createContext<{ id: string; describedBy?: string; invalid: boolean } | null>(null);
export function Field({ label, hint, error, id: providedId, children, required }: { label: string; hint?: string; error?: string; id?: string; children: ReactNode; required?: boolean }) {
  const generated = useId(); const id = providedId ?? generated;
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
  return <FieldContext.Provider value={{ id, describedBy, invalid: Boolean(error) }}><div className="oh-field">
    <label className="oh-label" htmlFor={id}>{label}{required && <span aria-hidden="true"> *</span>}</label>
    {children}{hint && <p className="oh-hint" id={`${id}-hint`}>{hint}</p>}{error && <p className="oh-field-error" id={`${id}-error`} role="alert">{error}</p>}
  </div></FieldContext.Provider>;
}
export function Label(props: ComponentPropsWithRef<'label'>) { return <label {...props} className={cx('oh-label', props.className)} />; }
export function Input({ className, id, ...props }: ComponentPropsWithRef<'input'>) {
  const field = useContext(FieldContext);
  return <input id={id ?? field?.id} aria-describedby={field?.describedBy} aria-invalid={field?.invalid || undefined} {...props} className={cx('oh-input', className)} />;
}
export function Textarea({ className, id, ...props }: ComponentPropsWithRef<'textarea'>) {
  const field = useContext(FieldContext);
  return <textarea id={id ?? field?.id} aria-describedby={field?.describedBy} aria-invalid={field?.invalid || undefined} rows={4} {...props} className={cx('oh-input', 'oh-textarea', className)} />;
}
export function Select({ className, id, children, ...props }: ComponentPropsWithRef<'select'>) {
  const field = useContext(FieldContext);
  return <select id={id ?? field?.id} aria-describedby={field?.describedBy} aria-invalid={field?.invalid || undefined} {...props} className={cx('oh-input', 'oh-select', className)}>{children}</select>;
}
type ToggleProps = Omit<ComponentPropsWithRef<'input'>, 'type'> & { label: string; description?: string };
export function Checkbox({ label, description, id: provided, className, ...props }: ToggleProps) {
  const generated = useId(); const id = provided ?? generated;
  return <label className={cx('oh-check-label', className)} htmlFor={id}><input {...props} id={id} type="checkbox" aria-describedby={description ? `${id}-description` : undefined} className="oh-check" /><span>{label}{description && <span className="oh-hint oh-block" id={`${id}-description`}>{description}</span>}</span></label>;
}
export function Switch({ label, description, id: provided, className, ...props }: ToggleProps) {
  const generated = useId(); const id = provided ?? generated;
  return <label className={cx('oh-check-label', className)} htmlFor={id}><input {...props} id={id} type="checkbox" role="switch" className="oh-switch" aria-describedby={description ? `${id}-description` : undefined} /><span>{label}{description && <span className="oh-hint oh-block" id={`${id}-description`}>{description}</span>}</span></label>;
}
export function RadioGroup({ label, options, value, onValueChange, disabled, name: provided }: { label: string; options: readonly { value: string; label: string }[]; value: string; onValueChange: (value: string) => void; disabled?: boolean; name?: string }) {
  const generated = useId(); const name = provided ?? generated;
  return <fieldset className="oh-radio-group" disabled={disabled}><legend className="oh-label">{label}</legend>{options.map(option => <label className="oh-check-label" key={option.value}><input className="oh-check" type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onValueChange(option.value)} />{option.label}</label>)}</fieldset>;
}
export function Separator() { return <hr className="oh-separator" />; }
export function Card({ title, description, action, children, className, ...props }: ComponentPropsWithRef<'section'> & { title?: string; description?: string; action?: ReactNode }) {
  return <section {...props} className={cx('oh-card', className)}>{(title || description || action) && <header className="oh-card-header"><div>{title && <h2>{title}</h2>}{description && <p className="oh-hint">{description}</p>}</div>{action}</header>}<div className="oh-card-body">{children}</div></section>;
}
