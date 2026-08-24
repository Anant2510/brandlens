/* ==========================================================================
 * What state an inherited rule is in, and how the list is filtered.
 *
 * Pure, and in its own file, because these two functions decide what the
 * screen SAYS — how many rules are actually checking the brand, and how many
 * only look like they are. A rule waiting on missing ontology returns
 * `not_applicable`, which on any list that shows verdicts is indistinguishable
 * from a pass; getting this arithmetic wrong would produce a confidently
 * reassuring number, which is the one failure mode worth testing for.
 * ========================================================================== */

import type { InheritedRule } from '@/lib/types';

export interface Summary {
  total: number;
  running: number;
  waiting: number;
  overridden: number;
  drifted: number;
  missing: string[];
}

export function summarise(rules: InheritedRule[]): Summary {
  const missing = new Set<string>();
  let running = 0;
  let waiting = 0;
  let overridden = 0;
  let drifted = 0;

  for (const rule of rules) {
    if (rule.drift) drifted += 1;
    if (rule.overriddenBy) {
      overridden += 1;
      continue;
    }
    if (rule.missingOntology.length > 0) {
      waiting += 1;
      rule.missingOntology.forEach((m) => missing.add(m));
      continue;
    }
    running += 1;
  }

  return { total: rules.length, running, waiting, overridden, drifted, missing: [...missing].sort() };
}

export function filterRules(
  rules: InheritedRule[],
  filters: { search: string; dimension: string; state: string },
): InheritedRule[] {
  const needle = filters.search.trim().toLowerCase();
  return rules.filter((rule) => {
    if (filters.dimension && rule.dimension !== filters.dimension) return false;
    if (needle && !`${rule.key} ${rule.statement} ${rule.packName}`.toLowerCase().includes(needle)) return false;

    switch (filters.state) {
      case 'running':
        return !rule.overriddenBy && rule.missingOntology.length === 0;
      case 'waiting':
        return !rule.overriddenBy && rule.missingOntology.length > 0;
      case 'overridden':
        return rule.overriddenBy !== null;
      case 'drifted':
        return rule.drift !== null;
      default:
        return true;
    }
  });
}
