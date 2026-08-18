'use client';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif', padding: '3rem', color: '#0f172a' }}>
        <h1 style={{ fontSize: '1rem', fontWeight: 600 }}>BrandLens failed to start this page</h1>
        <p style={{ fontSize: '0.8125rem', color: '#475569', marginTop: '0.5rem' }}>
          {error.message || 'An unexpected error occurred.'}
        </p>
        {error.digest ? (
          <p style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.75rem', color: '#64748b', marginTop: '0.5rem' }}>
            digest: {error.digest}
          </p>
        ) : null}
        <button
          type="button"
          onClick={reset}
          style={{
            marginTop: '1.25rem',
            border: '1px solid #cbd5e1',
            borderRadius: '0.375rem',
            padding: '0.375rem 0.75rem',
            fontSize: '0.8125rem',
            background: '#fff',
            cursor: 'pointer',
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
