'use client';

import * as React from 'react';
import { CheckCircle2, FileUp, Loader2, Upload, X, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { formatBytes } from '@/lib/format';
import { PROXY_PREFIX } from '@/lib/env';

export type UploadState = 'queued' | 'uploading' | 'done' | 'error';

export interface UploadItem {
  id: string;
  file: File;
  progress: number;
  state: UploadState;
  error?: string;
  responseId?: string;
  deduped?: boolean;
}

export interface AssetUploaderProps {
  /** Extra multipart fields sent alongside each file. */
  fields: Record<string, string | undefined>;
  endpoint?: string;
  accept?: string;
  maxFiles?: number;
  disabled?: boolean;
  disabledReason?: string;
  onUploaded?: (item: UploadItem, response: unknown) => void;
  onAllComplete?: () => void;
  className?: string;
  label?: string;
  description?: string;
}

/**
 * Drag-and-drop uploader with real per-file progress.
 *
 * XMLHttpRequest rather than fetch: `upload.onprogress` is the only reliable
 * way to show a 40 MB brand book actually moving, and a stalled bar with no
 * feedback is how an onboarding session gets abandoned.
 */
export function AssetUploader({
  fields,
  endpoint = '/v1/assets',
  accept,
  maxFiles = 20,
  disabled = false,
  disabledReason,
  onUploaded,
  onAllComplete,
  className,
  label = 'Drop files here',
  description = 'or click to browse. Multiple files are uploaded in parallel.',
}: AssetUploaderProps) {
  const [items, setItems] = React.useState<UploadItem[]>([]);
  const [dragging, setDragging] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const inputId = React.useId();

  const update = React.useCallback((id: string, patch: Partial<UploadItem>) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const upload = React.useCallback(
    (item: UploadItem) => {
      const form = new FormData();
      form.append('file', item.file);
      form.append('name', item.file.name);
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined && value !== '') form.append(key, value);
      }

      const request = new XMLHttpRequest();
      request.open('POST', `${PROXY_PREFIX}${endpoint}`);
      request.withCredentials = true;

      request.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          update(item.id, { state: 'uploading', progress: Math.round((event.loaded / event.total) * 100) });
        }
      };

      request.onload = () => {
        if (request.status >= 200 && request.status < 300) {
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(request.responseText);
          } catch {
            /* a 2xx with a non-JSON body still counts as delivered */
          }
          const record = parsed as { asset?: { id?: string }; id?: string; deduped?: boolean } | null;
          update(item.id, {
            state: 'done',
            progress: 100,
            responseId: record?.asset?.id ?? record?.id,
            deduped: record?.deduped,
          });
          onUploaded?.(item, parsed);
        } else {
          update(item.id, { state: 'error', error: extractError(request.responseText, request.status) });
        }
      };

      request.onerror = () => update(item.id, { state: 'error', error: 'Network error — the API is unreachable.' });
      request.onabort = () => update(item.id, { state: 'error', error: 'Upload cancelled.' });

      request.send(form);
    },
    [endpoint, fields, onUploaded, update],
  );

  const add = React.useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files).slice(0, maxFiles);
      const next: UploadItem[] = list.map((file) => ({
        id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        progress: 0,
        state: 'queued',
      }));
      setItems((current) => [...current, ...next]);
      next.forEach(upload);
    },
    [maxFiles, upload],
  );

  React.useEffect(() => {
    if (items.length > 0 && items.every((item) => item.state === 'done' || item.state === 'error')) {
      onAllComplete?.();
    }
    // Fires once per settle, not per render of the same settled set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.map((i) => i.state).join(',')]);

  return (
    <div className={className}>
      <div
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (!disabled && event.dataTransfer.files.length > 0) add(event.dataTransfer.files);
        }}
        className={cn(
          'rounded-lg border-2 border-dashed p-6 text-center transition-colors',
          disabled
            ? 'cursor-not-allowed border-border bg-surface-2 opacity-60'
            : dragging
              ? 'border-accent bg-accent-soft/40'
              : 'border-border bg-surface hover:border-border-strong',
        )}
      >
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          multiple
          accept={accept}
          disabled={disabled}
          className="sr-only"
          onChange={(event) => {
            if (event.target.files) add(event.target.files);
            event.target.value = '';
          }}
        />
        <FileUp className="mx-auto size-5 text-fg-subtle" aria-hidden="true" />
        <label htmlFor={inputId} className={cn('mt-2 block text-[13px] font-medium', disabled ? 'text-fg-subtle' : 'cursor-pointer text-fg')}>
          {label}
        </label>
        <p className="mt-0.5 text-xs text-fg-muted">{disabled ? (disabledReason ?? 'Uploading is unavailable.') : description}</p>
        {!disabled ? (
          <Button variant="outline" size="sm" className="mt-3" onClick={() => inputRef.current?.click()}>
            <Upload className="size-3.5" aria-hidden="true" />
            Choose files
          </Button>
        ) : null}
      </div>

      {items.length > 0 ? (
        <ul className="mt-3 space-y-1.5" aria-label="Upload queue">
          {items.map((item) => (
            <li key={item.id} className="rounded-md border border-border bg-surface p-2.5">
              <div className="flex items-center gap-2">
                <StateIcon state={item.state} />
                <span className="min-w-0 flex-1 truncate text-xs text-fg">{item.file.name}</span>
                <span className="num shrink-0 text-fg-subtle">{formatBytes(item.file.size)}</span>
                {item.state !== 'uploading' ? (
                  <button
                    type="button"
                    aria-label={`Remove ${item.file.name} from the list`}
                    onClick={() => setItems((current) => current.filter((i) => i.id !== item.id))}
                    className="shrink-0 rounded p-0.5 text-fg-subtle hover:bg-surface-2 hover:text-fg"
                  >
                    <X className="size-3.5" aria-hidden="true" />
                  </button>
                ) : null}
              </div>

              {item.state === 'uploading' || item.state === 'queued' ? (
                <Progress className="mt-1.5" value={item.progress} label={`Uploading ${item.file.name}`} size="xs" />
              ) : null}

              {item.state === 'error' ? (
                <p role="alert" className="mt-1 text-[11px] text-[var(--danger)]">
                  {item.error}
                </p>
              ) : null}

              {item.state === 'done' && item.deduped ? (
                <p className="mt-1 text-[11px] text-fg-subtle">
                  Content hash already known — reused the existing asset instead of storing a duplicate.
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function StateIcon({ state }: { state: UploadState }) {
  if (state === 'done') return <CheckCircle2 className="size-3.5 shrink-0 text-[var(--ok)]" aria-label="Uploaded" />;
  if (state === 'error') return <XCircle className="size-3.5 shrink-0 text-[var(--danger)]" aria-label="Failed" />;
  return <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" aria-label="Uploading" />;
}

function extractError(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { message?: string | string[] };
    if (Array.isArray(parsed.message)) return parsed.message.join(' · ');
    if (parsed.message) return parsed.message;
  } catch {
    /* fall through to the status line */
  }
  return `Upload failed with status ${status}.`;
}
