'use client';

import * as React from 'react';
import { ErrorState } from '@/components/ui/empty-state';

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  React.useEffect(() => {
    // Surfaced to the browser console rather than swallowed: on a single-VM
    // deployment there is no error tracker to send this to.
    console.error('[brandlens] route error', error);
  }, [error]);

  return (
    <div className="p-4">
      <ErrorState
        title="This screen failed to render"
        message={error.message || 'An unexpected error occurred while rendering this route.'}
        correlationId={error.digest}
        onRetry={reset}
      />
    </div>
  );
}
