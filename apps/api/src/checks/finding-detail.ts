/**
 * Framework-free so both the API (synchronous checks) and the worker
 * (queued checks) import the SAME function.
 *
 * This was duplicated once, and the two copies had already drifted — the
 * worker's signature rejected the nulls the engine actually emits, so a
 * queued check failed to build where an inline one succeeded. Identical
 * inputs producing different output depending on `async: true` reads to a
 * customer as non-determinism in the product, which is precisely the thing a
 * verification tool cannot afford to look like.
 */
export interface FindingEvidence {
  measured?: Record<string, unknown> | null;
  threshold?: Record<string, unknown> | null;
  observation?: string | null;
}

/**
 * Renders the human-readable body of a finding, in the order a reviewer
 * needs it: what we saw, what we measured, what the rule required, how to
 * fix it.
 */
export function buildFindingDetail(
  evidence: FindingEvidence,
  suggestedFix: string | null,
): string | null {
  const parts: string[] = [];

  if (evidence.observation) parts.push(evidence.observation);
  if (evidence.measured && Object.keys(evidence.measured).length) {
    parts.push(`Measured: ${JSON.stringify(evidence.measured)}`);
  }
  if (evidence.threshold && Object.keys(evidence.threshold).length) {
    parts.push(`Threshold: ${JSON.stringify(evidence.threshold)}`);
  }
  if (suggestedFix) parts.push(`Fix: ${suggestedFix}`);

  return parts.length ? parts.join('\n') : null;
}
