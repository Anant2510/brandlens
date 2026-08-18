import * as React from 'react';
import type { CheckTier } from '@brandlens/contracts';
import { Badge } from '@/components/ui/badge';
import { Tooltip } from '@/components/ui/tooltip';
import { TIER_CODE, TIER_DESCRIPTION, TIER_LABEL } from '@/lib/domain';
import { cn } from '@/lib/utils';

/**
 * T0 / T1 / T2 is the single most useful trust signal on a finding: a
 * deterministic verdict is arithmetic, a T2 verdict is a judgement.
 */
export function TierBadge({
  tier,
  className,
  withLabel = false,
}: {
  tier: CheckTier;
  className?: string;
  withLabel?: boolean;
}) {
  const code = TIER_CODE[tier] ?? tier;
  return (
    <Tooltip content={TIER_DESCRIPTION[tier] ?? TIER_LABEL[tier] ?? tier}>
      <Badge
        tone={tier === 'deterministic' ? 'ok' : tier === 'vlm' ? 'accent' : 'neutral'}
        mono
        className={cn('cursor-help', className)}
      >
        {code}
        {withLabel ? <span className="font-sans font-normal">· {TIER_LABEL[tier]}</span> : null}
      </Badge>
    </Tooltip>
  );
}
