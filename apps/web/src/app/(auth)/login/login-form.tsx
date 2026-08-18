'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { LoginInput } from '@brandlens/contracts';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';

type FormValues = z.infer<typeof LoginInput>;

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next');
  const [serverError, setServerError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ defaultValues: { email: '', password: '' } });

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);

    // Validate with the same schema the API uses. One source of truth.
    const parsed = LoginInput.safeParse(values);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'email' || field === 'password') setError(field, { message: issue.message });
      }
      return;
    }

    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parsed.data),
    }).catch(() => null);

    if (!res) {
      setServerError('Cannot reach the BrandLens API. Check that it is running and NEXT_PUBLIC_API_URL is correct.');
      return;
    }

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string | string[] } | null;
      const message = Array.isArray(body?.message) ? body.message.join(' · ') : body?.message;
      setServerError(message ?? 'Sign-in failed. Check your email and password.');
      return;
    }

    router.push(next && next.startsWith('/') ? next : '/dashboard');
    router.refresh();
  });

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-3" noValidate>
      {serverError ? (
        <p role="alert" className="rounded-md border border-blocker/40 bg-blocker-soft px-3 py-2 text-xs text-blocker-fg">
          {serverError}
        </p>
      ) : null}

      <Field label="Email" htmlFor="email" error={errors.email?.message} required>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          autoFocus
          placeholder="you@acme.com"
          invalid={Boolean(errors.email)}
          {...register('email', { required: 'Email is required' })}
        />
      </Field>

      <Field label="Password" htmlFor="password" error={errors.password?.message} required>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          placeholder="••••••••••"
          invalid={Boolean(errors.password)}
          {...register('password', { required: 'Password is required' })}
        />
      </Field>

      <Button type="submit" variant="primary" size="lg" className="w-full" loading={isSubmitting}>
        Sign in
      </Button>
    </form>
  );
}
