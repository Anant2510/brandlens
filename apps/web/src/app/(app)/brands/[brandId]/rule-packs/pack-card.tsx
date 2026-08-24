'use client';

import * as React from 'react';
import { ExternalLink, GitFork, Info, Lock, ShieldCheck } from 'lucide-react';
import type { RulePackSummary } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const CATEGORY_TONE = { baseline: 'ok', heuristic: 'accent', regulated: 'major' } as const;

const CATEGORY_NOTE: Record<string, string> = {
  baseline: 'Every brand inherits this without asking.',
  heuristic: 'Compares against a learned model of your brand rather than a fixed threshold.',
  regulated: 'Off unless you turn it on. Failing a brand against rules that do not apply to it is worse than no rule.',
};

export function PackCard({
  pack,
  onToggle,
  busy,
  canManage,
}: {
  pack: RulePackSummary;
  onToggle: (next: boolean) => void;
  busy: boolean;
  canManage: boolean;
}) {
  const tone = CATEGORY_TONE[pack.category] ?? 'neutral';
  const off = !pack.enabled;

  return (
    <article
      className={cn(
        'rounded-lg border bg-surface p-3 transition-colors',
        off ? 'border-border opacity-70' : 'border-border hover:border-border-strong',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-[13px] font-semibold text-fg">{pack.name}</h3>
            <Badge tone={tone}>{pack.category}</Badge>
            {/*
              A pack on by default with no brand row is inherited, not chosen.
              Saying "default" rather than showing a plain toggle is what stops
              somebody assuming a previous colleague reviewed and enabled it.
            */}
            {!pack.decided ? <Badge tone="outline">{pack.enabled ? 'default on' : 'default off'}</Badge> : null}
            {pack.jurisdictions.map((code) => (
              <Badge key={code} tone="outline" mono>
                {code}
              </Badge>
            ))}
          </div>

          {pack.description ? (
            <p className="mt-1 text-xs leading-5 text-fg-muted">{pack.description}</p>
          ) : null}

          {pack.authority ? (
            <p className="mt-1 flex items-center gap-1 text-[11px] text-fg-subtle">
              <ShieldCheck className="size-3" aria-hidden="true" />
              <span className="truncate">{pack.authority}</span>
              {pack.docsUrl ? (
                <a
                  href={pack.docsUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-0.5 text-accent hover:underline"
                >
                  source
                  <ExternalLink className="size-2.5" aria-hidden="true" />
                </a>
              ) : null}
            </p>
          ) : null}
        </div>

        <div className="shrink-0">
          {canManage ? (
            <Button
              size="sm"
              variant={pack.enabled ? 'outline' : 'primary'}
              loading={busy}
              onClick={() => onToggle(!pack.enabled)}
            >
              {pack.enabled ? 'Turn off' : 'Turn on'}
            </Button>
          ) : (
            <Tooltip content="Only a brand manager can change which standards apply.">
              <span className="inline-flex items-center gap-1 text-[11px] text-fg-subtle">
                <Lock className="size-3" aria-hidden="true" />
                {pack.enabled ? 'on' : 'off'}
              </span>
            </Tooltip>
          )}
        </div>
      </div>

      <dl className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
        <Stat label="rules" value={`${pack.activeTemplateCount} of ${pack.templateCount} enforced`} />
        {pack.forkedCount > 0 ? (
          <Stat
            label="forked"
            value={String(pack.forkedCount)}
            icon={<GitFork className="size-3 text-fg-subtle" aria-hidden="true" />}
          />
        ) : null}
        {pack.overriddenCount > 0 ? <Stat label="overridden" value={String(pack.overriddenCount)} /> : null}
        {pack.activeTemplateCount < pack.templateCount ? (
          <Tooltip content="Some rules in this pack ship proposed — a threshold or a rubric your brand has to agree before it can enforce anything.">
            <span className="inline-flex items-center gap-1 text-fg-subtle">
              <Info className="size-3" aria-hidden="true" />
              {pack.templateCount - pack.activeTemplateCount} awaiting your call
            </span>
          </Tooltip>
        ) : null}
      </dl>

      {/*
        The reason somebody gave for switching a baseline off. Kept visible
        rather than tucked into an audit log: a disabled accessibility pack
        with no explanation on screen is how it stays disabled for a year.
      */}
      {off && pack.reason ? (
        <p className="mt-2 rounded border border-border bg-surface-2 px-2 py-1.5 text-[11px] leading-5 text-fg-muted">
          <span className="font-medium text-fg">Turned off:</span> {pack.reason}
        </p>
      ) : null}

      <p className="mt-2 text-[11px] leading-4 text-fg-subtle">{CATEGORY_NOTE[pack.category]}</p>
    </article>
  );
}

function Stat({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1">
      {icon}
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="num text-fg">{value}</dd>
    </div>
  );
}
