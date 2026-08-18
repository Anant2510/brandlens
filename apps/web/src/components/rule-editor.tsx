'use client';

import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import type { Rule } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Field, Input, Label } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { SEVERITIES, SEVERITY_LABEL } from '@/lib/domain';
import { humanizeKey } from '@/lib/format';

export interface RuleEditorValues {
  statement: string;
  severity: string;
  weight: number;
  params: Record<string, unknown>;
}

/**
 * Inline parameter editing for a proposed rule.
 *
 * Parameters are typed from their current values rather than a schema: the
 * analyzer owns the schema, and guessing one here would drift. Numbers stay
 * numbers, booleans stay booleans, everything else round-trips as JSON.
 */
export function RuleEditor({
  rule,
  onCancel,
  onSave,
  saving = false,
}: {
  rule: Rule;
  onCancel: () => void;
  onSave: (values: RuleEditorValues) => void | Promise<void>;
  saving?: boolean;
}) {
  const initialParams = React.useMemo(() => rule.check?.params ?? {}, [rule.check]);

  const [statement, setStatement] = React.useState(rule.statement);
  const [severity, setSeverity] = React.useState<string>(rule.severity);
  const [weight, setWeight] = React.useState(String(rule.weight ?? 1));
  const [params, setParams] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(initialParams).map(([key, value]) => [
        key,
        typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value),
      ]),
    ),
  );
  const [jsonError, setJsonError] = React.useState<string | null>(null);

  const submit = () => {
    const parsed: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(params)) {
      const original = initialParams[key];
      if (typeof original === 'number') {
        const value = Number(raw);
        if (Number.isNaN(value)) {
          setJsonError(`${humanizeKey(key)} must be a number.`);
          return;
        }
        parsed[key] = value;
      } else if (typeof original === 'boolean') {
        parsed[key] = raw === 'true';
      } else if (typeof original === 'object' && original !== null) {
        try {
          parsed[key] = JSON.parse(raw);
        } catch {
          setJsonError(`${humanizeKey(key)} is not valid JSON.`);
          return;
        }
      } else {
        parsed[key] = raw;
      }
    }
    setJsonError(null);
    void onSave({ statement, severity, weight: Number(weight) || 1, params: parsed });
  };

  const paramKeys = Object.keys(params);

  return (
    <div className="space-y-3 rounded-md border border-accent/40 bg-surface-2 p-3">
      <Field label="Rule statement" htmlFor={`statement-${rule.id}`} required>
        <Textarea
          id={`statement-${rule.id}`}
          rows={2}
          value={statement}
          onChange={(event) => setStatement(event.target.value)}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Severity" htmlFor={`severity-${rule.id}`}>
          <Select
            id={`severity-${rule.id}`}
            value={severity}
            onChange={(event) => setSeverity(event.target.value)}
            options={SEVERITIES.map((s) => ({ value: s, label: SEVERITY_LABEL[s] }))}
          />
        </Field>
        <Field label="Weight" htmlFor={`weight-${rule.id}`} hint="Contribution to the dimension score.">
          <Input
            id={`weight-${rule.id}`}
            type="number"
            step="0.1"
            min="0"
            mono
            value={weight}
            onChange={(event) => setWeight(event.target.value)}
          />
        </Field>
      </div>

      <div>
        <Label>
          Check parameters <span className="font-mono font-normal text-fg-subtle">{rule.check?.fn}</span>
        </Label>
        {paramKeys.length === 0 ? (
          <p className="text-[11px] text-fg-subtle">This analyzer takes no parameters.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {paramKeys.map((key) => {
              const original = initialParams[key];
              const id = `param-${rule.id}-${key}`;
              return (
                <div key={key}>
                  <Label htmlFor={id} className="font-mono text-[11px]">
                    {key}
                  </Label>
                  {typeof original === 'boolean' ? (
                    <Select
                      id={id}
                      value={params[key]}
                      onChange={(event) => setParams((p) => ({ ...p, [key]: event.target.value }))}
                      options={[
                        { value: 'true', label: 'true' },
                        { value: 'false', label: 'false' },
                      ]}
                    />
                  ) : (
                    <Input
                      id={id}
                      mono
                      type={typeof original === 'number' ? 'number' : 'text'}
                      step="any"
                      value={params[key]}
                      onChange={(event) => setParams((p) => ({ ...p, [key]: event.target.value }))}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {jsonError ? (
        <p role="alert" className="flex items-center gap-1 text-[11px] text-[var(--danger)]">
          <AlertTriangle className="size-3" aria-hidden="true" />
          {jsonError}
        </p>
      ) : null}

      <p className="text-[11px] text-fg-subtle">
        Editing an active rule creates version {rule.version + 1}; the previous version stays in history so past traces
        remain reproducible.
      </p>

      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="primary" loading={saving} onClick={submit}>
          Save changes
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
