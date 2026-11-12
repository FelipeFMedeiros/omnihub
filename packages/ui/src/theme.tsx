import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
const ThemeContext = createContext<{ preference: ThemePreference; setPreference: (theme: ThemePreference) => void }>({ preference: 'system', setPreference: () => {} });
export function storedTheme(): ThemePreference {
  try { const value = localStorage.getItem('omnihub.theme'); if (value === 'light' || value === 'dark') return value; } catch {}
  return 'system';
}
export function applyTheme(preference: ThemePreference) {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = preference === 'system'
    ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : preference;
}
export function ThemeProvider({ children, theme, onThemeChange }: { children: ReactNode; theme?: ThemePreference; onThemeChange?: (value: ThemePreference) => void }) {
  const [local, setLocal] = useState<ThemePreference>(storedTheme);
  const preference = theme ?? local;
  const setPreference = (next: ThemePreference) => {
    setLocal(next); applyTheme(next);
    try { localStorage.setItem('omnihub.theme', next); } catch {}
    onThemeChange?.(next);
  };
  useEffect(() => {
    applyTheme(preference);
    try { localStorage.setItem('omnihub.theme', preference); } catch {}
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => applyTheme(preference);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [preference]);
  return <ThemeContext.Provider value={{ preference, setPreference }}>{children}</ThemeContext.Provider>;
}
export const useTheme = () => useContext(ThemeContext);
