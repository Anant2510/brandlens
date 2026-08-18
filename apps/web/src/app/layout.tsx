import type { Metadata, Viewport } from 'next';
import './globals.css';
import { QueryProvider } from '@/providers/query-provider';
import { ThemeProvider, themeInitScript } from '@/providers/theme-provider';
import { ToastProvider } from '@/components/ui/toast';

export const metadata: Metadata = {
  title: {
    default: 'BrandLens',
    template: '%s · BrandLens',
  },
  description:
    'The brand-compliance verification layer. Structured findings, measured values and auditable decision traces.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8fafc' },
    { media: '(prefers-color-scheme: dark)', color: '#0f172a' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Applied before first paint so the console never flashes light-on-dark. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="antialiased">
        <ThemeProvider>
          <QueryProvider>
            <ToastProvider>{children}</ToastProvider>
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
