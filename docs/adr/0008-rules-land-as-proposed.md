# 0008 — Machine-derived rules always land as `proposed`

**Status** Accepted · **Date** 2026-02-15 · **Deciders** Platform, Product

## Context

BrandLens acquires rules from four sources, recorded in `rules.provenance`:

- `deductive` — extracted from an uploaded brand book by a vision-plus-long-context
  model, with a citation back to a page and a bounding box;
- `inductive` — induced by measuring the tenant's approved corpus, with the
  statistical support that produced them;
- `transfer` — imported from an external standard (WCAG, IAB, a platform spec);
- `manual` — hand-authored by a human.

Onboarding a brand from a 68-page PDF can plausibly propose 60-100 rules in a
few minutes. That is the demo everyone wants.

It is also the fastest way to destroy the product. Extraction is imperfect: a
model reads "the logo should generally sit in the upper left" as a hard
placement rule; it misreads a caption as a constraint; it turns an illustrative
example into a threshold. Induction is worse — it faithfully learns whatever
the corpus happens to contain, including the habits of one designer who made
most of it.

If those rules go straight to `active`, the very first check run fails a
compliant asset for a rule the customer never wrote and does not agree with.
The reviewer's conclusion is not "the extraction was imperfect", it is "this
tool does not understand our brand", and that conclusion is not recoverable.

There is a second, harder problem. In a regulated review the customer must be
able to say *who decided* each rule. "A model extracted it and the system
started enforcing it" is not an answer that survives an audit.

## Decision

**Every machine-derived rule is created with `status = 'proposed'` and can only
become `active` through an explicit human action.**

- `rule_status` is `proposed | active | deprecated | rejected`, and `proposed`
  is the column default.
- `RulesetCompilerService.compile()` selects `WHERE status = 'active'`. A
  proposed rule is structurally incapable of influencing a verdict — it is not
  in the compiled snapshot, so it is not in the hash, so it never reaches the
  engine.
- Activation records `activated_by_user_id` and `activated_at`, and writes an
  `audit_log` entry and a `rule.activated` outbox event.
- `POST /v1/brands/:id/rules/bulk-decision` exists because reviewing sixty
  proposals one at a time is the actual workflow, and making it tedious is how
  you get people to activate all of them unread.
- Every proposal must carry its justification:
  - `deductive` → `citation: { doc, page, bbox, extractedBy }`, so the UI can
    render the brand-book crop beside the proposed rule;
  - `inductive` → `support: { sampleSize, percentile, observedValue,
    exampleAssetIds }`, so the reviewer can see it is "47 of 52 approved assets
    do this" rather than an assertion.
- Editing an **active** rule creates version + 1 rather than mutating in place,
  so historical traces continue to reference the version that produced them.

## Consequences

**Good**

- The first check run a customer sees uses only rules they confirmed. The
  precision of that first impression is set by the customer, not by the
  extractor.
- The audit trail answers "who decided this rule" with a user id and a
  timestamp. That is what makes machine extraction acceptable in a regulated
  environment at all.
- Extraction can be aggressive. Proposing a rule that turns out to be wrong
  costs one click to reject, so the extractor is tuned for recall — which is
  where the value is.
- The rule-review screen is a genuinely good onboarding experience: it is where
  the customer discovers what their brand book actually says, and where
  BrandLens demonstrates it read the whole thing.
- Rejected rules are kept (`status = 'rejected'`), so a later extraction run
  can avoid re-proposing them.

**Costs**

- Onboarding has a mandatory human step. "Upload your brand book and start
  checking" becomes "upload, review sixty proposals, then check". That is real
  friction and it is the single most common request to remove.
- A brand with a hundred rules is a long review session. Bulk decisions,
  grouping by dimension and sorting by confidence help, but do not eliminate it.
- Value is delayed. A customer who uploads a brand book and never opens the
  review screen has an ontology and no active ruleset, and every check returns
  `409 NoActiveRuleset`. The error message names the endpoint to fix it, which
  is the minimum.
- Two states to represent everywhere: the console, the API and the analytics
  all have to distinguish proposed from active.

## Alternatives

**Auto-activate high-confidence extractions.** The obvious compromise: activate
anything the extractor is confident about, propose the rest. Rejected for two
reasons. Extraction confidence is poorly calibrated — the model is most
confident about the sentences that look most like rules, which is exactly where
captions and examples live. And it destroys the audit answer: "the system
decided it was confident" is not a decider.

**Auto-activate, then learn from overrides.** Ship active rules and let the
calibration loop suppress the bad ones. Rejected: the cost is paid entirely by
the first few reviewers, in trust, and trust does not recover at the rate
precision does.

**Activate `transfer` rules automatically.** Genuinely tempting — WCAG 1.4.3 is
not a matter of opinion. Rejected for consistency: a tenant may deliberately
run at AAA, or exempt a channel, and a rule that appeared without anyone
choosing it is exactly what the audit answer forbids. The seed activates them
explicitly, which is the same thing done honestly.

**A shadow mode where proposed rules run but do not affect the score.**
Considered, and it is the best rejected alternative — it would give reviewers
real data about a proposal before activating it. Rejected for now on cost: it
means paying for T2 criteria that cannot change any outcome. A plausible future
feature, gated on a per-tenant budget setting.
