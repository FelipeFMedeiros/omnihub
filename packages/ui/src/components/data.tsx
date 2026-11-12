import { useId, useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { Button, Card, Checkbox, cx, Input } from './primitives';
import { CopyButton, StatusBadge, type Tone } from './feedback';

export interface Column<T> { key: string; label: string; render: (row: T) => ReactNode; align?: 'left' | 'right' }
export function DataTable<T>({ data, columns, getRowKey, caption }: { data: readonly T[]; columns: readonly Column<T>[]; getRowKey: (row: T) => string; caption: string }) {
  return <div className="oh-table-region" role="region" aria-label={caption} tabIndex={0}><table className="oh-table"><caption className="oh-sr-only">{caption}</caption><thead><tr>{columns.map(column => <th scope="col" key={column.key} className={column.align === 'right' ? 'oh-numeric' : undefined}>{column.label}</th>)}</tr></thead><tbody>{data.map(row => <tr key={getRowKey(row)}>{columns.map(column => <td key={column.key} className={column.align === 'right' ? 'oh-numeric' : undefined}>{column.render(row)}</td>)}</tr>)}</tbody></table></div>;
}
export function DataToolbar({ search, onSearch, searchLabel = 'Pesquisar', placeholder = 'Buscar...', children }: { search: string; onSearch: (value: string) => void; searchLabel?: string; placeholder?: string; children?: ReactNode }) {
  const id = useId();
  return <div className="oh-data-toolbar"><label htmlFor={id} className="oh-search"><Search size={17} aria-hidden="true" /><span className="oh-sr-only">{searchLabel}</span><Input id={id} type="search" value={search} onChange={event => onSearch(event.target.value)} placeholder={placeholder} /></label><div className="oh-row oh-wrap">{children}</div></div>;
}
export function MetricCard({ label, value, unit, description, icon }: { label: string; value: string; unit?: string; description: string; icon?: ReactNode }) {
  return <section className="oh-metric" aria-label={label}><div className="oh-metric-top"><p>{label}</p><span aria-hidden="true">{icon}</span></div><p className="oh-metric-value">{value}{unit && <span>{unit}</span>}</p><p className="oh-hint">{description}</p></section>;
}
export function CodePanel({ title, subtitle, code, initialLines = 20, children, highlightLines = [] }: { title: string; subtitle?: string; code: string; initialLines?: number; children?: ReactNode; highlightLines?: readonly number[] }) {
  const [expanded, setExpanded] = useState(false); const [wrap, setWrap] = useState(true);
  const lines = code.split('\n'); const limit = Math.max(1, initialLines);
  const truncated = lines.length > limit && !expanded;
  const visible = truncated ? lines.slice(0, limit) : lines;
  return <section className="oh-code-panel"><header><div><h3>{title}</h3>{subtitle && <p className="oh-hint">{subtitle}</p>}</div><CopyButton text={code} /></header><div className="oh-code-controls"><Checkbox label="Quebrar linhas" checked={wrap} onChange={event => setWrap(event.target.checked)} />{children}</div><pre className={cx('oh-code', !wrap && 'oh-code--nowrap')} tabIndex={0} aria-label={`Código: ${title}`}><code>{visible.map((line, index) => <span key={index} className={highlightLines.includes(index + 1) ? 'oh-code-highlight' : undefined}>{line}{index < visible.length - 1 ? '\n' : ''}</span>)}</code></pre>{lines.length > limit && <div className="oh-code-expand"><Button size="sm" variant="ghost" onClick={() => setExpanded(previous => !previous)}>{expanded ? 'Recolher conteúdo' : `Exibir conteúdo completo (${lines.length} linhas)`}</Button></div>}</section>;
}
export interface TimelineItem { id: string; title: string; description: string; time: string; dateTime?: string; tone?: Tone }
export function Timeline({ items, label = 'Histórico de eventos' }: { items: readonly TimelineItem[]; label?: string }) {
  return <ol className="oh-timeline" aria-label={label}>{items.map(item => <li key={item.id}><div><StatusBadge tone={item.tone ?? 'neutral'}>{item.title}</StatusBadge><time dateTime={item.dateTime}>{item.time}</time></div><p>{item.description}</p></li>)}</ol>;
}
export function ChartFrame({ title, description, children, fallback }: { title: string; description: string; children: ReactNode; fallback: ReactNode }) {
  return <Card title={title} description={description}><div className="oh-chart-area">{children}</div><details className="oh-chart-fallback"><summary>Ver dados em tabela</summary>{fallback}</details></Card>;
}
export function LineChart({ data, unit, label }: { data: readonly { label: string; value: number }[]; unit: string; label: string }) {
  const max = Math.max(1, ...data.map(point => point.value));
  const points = data.map((point, index) => `${12 + index / Math.max(1, data.length - 1) * 616},${172 - point.value / max * 152}`).join(' ');
  return <div className="oh-line-chart"><div className="oh-chart-scale"><span>{max} {unit}</span><span>0 {unit}</span></div><svg viewBox="0 0 640 184" preserveAspectRatio="none" role="img" aria-label={label}><line x1="12" x2="628" y1="172" y2="172" className="oh-chart-baseline" /><polyline points={points} fill="none" className="oh-chart-line" vectorEffect="non-scaling-stroke" /></svg><div className="oh-chart-labels"><span>{data[0]?.label}</span><span>{data.at(-1)?.label}</span></div></div>;
}
