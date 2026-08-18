/**
 * The DI token lives in its own module.
 *
 * `database.module.ts` imports `TenantRepository`, and `TenantRepository`
 * needs the token to `@Inject()` — declaring the token in the module file
 * makes that cycle load-order dependent, and under CommonJS the loser of the
 * race sees `undefined`, which Nest reports as an unresolvable dependency at
 * boot. A leaf module with no imports of its own cannot participate in a cycle.
 */
export const DB = Symbol('BRANDLENS_DB');
