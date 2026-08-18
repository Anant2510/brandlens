import type { Metadata } from 'next';
import Link from 'next/link';
import { RegisterForm } from './register-form';

export const metadata: Metadata = { title: 'Create an organization' };

export default function RegisterPage() {
  return (
    <>
      <h1 className="text-lg font-semibold tracking-tight text-fg">Create an organization</h1>
      <p className="mt-1 text-xs text-fg-muted">
        You become the owner. Brands, rules and assets all live inside this organization.
      </p>
      <RegisterForm />
      <p className="mt-6 text-xs text-fg-muted">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}
