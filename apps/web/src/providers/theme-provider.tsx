'use client';

import * as React from 'react';

export type Theme = 'light' | 'dark' | 'system';

interface ThemeContextValue {
  theme: Theme;
  resolved: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = 'brandlens.theme';

export function useTheme(): ThemeContextValue {
  const context = React.useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside <ThemeProvider>');
  return context;
}

/**
 * Applies the theme class before paint via an inline script in the document
 * head (see layout.tsx), so there is no flash of the wrong theme.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<Theme>('system');
  const [resolved, setResolved] = React.useState<'light' | 'dark'>('light');

  React.useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY) as Theme | null;
    if (stored === 'light' || stored === 'dark' || stored === 'system') setThemeState(stored);
  }, []);

  React.useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');

    const apply = () => {
      const next = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
      setResolved(next);
      document.documentElement.classList.toggle('dark', next === 'dark');
      document.documentElement.style.colorScheme = next;
    };

    apply();
    if (theme !== 'system') return;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  const setTheme = React.useCallback((next: Theme) => {
    setThemeState(next);
    window.localStorage.setItem(STORAGE_KEY, next);
  }, []);

  const value = React.useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Inlined in <head> to set the class before first paint. */
export const themeInitScript = `(function(){try{var s=localStorage.getItem('${STORAGE_KEY}');var d=window.matchMedia('(prefers-color-scheme: dark)').matches;var t=(s==='dark')||((s===null||s==='system')&&d);document.documentElement.classList.toggle('dark',t);document.documentElement.style.colorScheme=t?'dark':'light';}catch(e){}})();`;
