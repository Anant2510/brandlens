import * as React from 'react';
import type { Severity } from '@brandlens/contracts';
import { Badge, Dot, type BadgeTone } from '@/components/ui/badge';
import { SEVERITY_LABEL } from '@/lib/domain';
import { cn } from '@/lib/utils';

const TONE: Record<Severity, BadgeTone> = {
  blocker: 'blocker',
  major: 'major',
  minor: 'minor',
  advisory: 'advisory',
};

export function SeverityBadge({
  severity,
  className,
  showDot = true,
}: {
  severity: Severity;
  className?: string;
  showDot?: boolean;
}) {
  return (
    <Badge tone={TONE[severity]} className={cn('uppercase tracking-wide text-[10px]', className)}>
      {showDot ? <Dot tone={TONE[severity]} /> : null}
      {SEVERITY_LABEL[severity]}
    </Badge>
  );
}

/** A colored left rail used to group findings by severity without a heading. */
export function SeverityRail({ severity, className }: { severity: Severity; className?: string }) {
  const color = {
    blocker: 'bg-blocker',
    major: 'bg-major',
    minor: 'bg-minor',
    advisory: 'bg-advisory',
  }[severity];
  return <span aria-hidden="true" className={cn('block w-0.5 shrink-0 rounded-full', color, className)} />;
}
