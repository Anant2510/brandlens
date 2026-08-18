import { HttpException, HttpStatus } from '@nestjs/common';

/** 402 — the tenant tripped its daily spend ceiling. Distinct from 429. */
export class BudgetExceededException extends HttpException {
  constructor(message = 'Tenant budget exceeded') {
    super({ error: 'BudgetExceeded', message }, HttpStatus.PAYMENT_REQUIRED);
  }
}

/** 503 — the analysis engine is unreachable or the breaker is open. */
export class EngineUnavailableException extends HttpException {
  constructor(message = 'Analysis engine unavailable') {
    super({ error: 'EngineUnavailable', message }, HttpStatus.SERVICE_UNAVAILABLE);
  }
}

/** 409 — a brand has no published ruleset, so nothing can be checked yet. */
export class NoActiveRulesetException extends HttpException {
  constructor(brandId: string) {
    super(
      {
        error: 'NoActiveRuleset',
        message: `Brand ${brandId} has no published ruleset. Publish one via POST /v1/brands/${brandId}/rulesets.`,
      },
      HttpStatus.CONFLICT,
    );
  }
}
