import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Activity } from 'lucide-react';
import { getSessionUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (user) redirect('/dashboard');

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="flex flex-col justify-center px-6 py-12 sm:px-12">
        <div className="mx-auto w-full max-w-sm">
          <Link href="/" className="mb-8 inline-flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded bg-accent text-accent-fg">
              <Activity className="size-4" aria-hidden="true" />
            </span>
            <span className="text-sm font-semibold tracking-tight">BrandLens</span>
          </Link>
          {children}
        </div>
      </div>

      {/* The pitch, stated plainly. No hero image: this is an inspection tool. */}
      <aside className="hidden border-l border-border bg-surface lg:flex lg:flex-col lg:justify-center lg:px-12">
        <div className="max-w-md">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-accent">The verification layer</p>
          <h2 className="mt-3 text-xl font-semibold leading-7 tracking-tight text-fg">
            Every verdict carries a measurement, a threshold, a citation and an immutable trace.
          </h2>
          <dl className="mt-8 space-y-5">
            {[
              {
                term: 'Deterministic scoring',
                detail:
                  'The headline number is aggregation over atomic criteria — never a raw model score. Judges rank well and score badly.',
              },
              {
                term: 'Generator-agnostic',
                detail:
                  'Verify assets from any tool or model. The judge is deliberately a different family than your generator, to avoid self-preference bias.',
              },
              {
                term: 'Auditable by construction',
                detail:
                  'traceKey, ruleKey@version, tier, verdict, confidence, cache state, cost and latency for every criterion evaluated.',
              },
            ].map((item) => (
              <div key={item.term}>
                <dt className="text-[13px] font-medium text-fg">{item.term}</dt>
                <dd className="mt-1 text-xs leading-5 text-fg-muted">{item.detail}</dd>
              </div>
            ))}
          </dl>
        </div>
      </aside>
    </div>
  );
}
