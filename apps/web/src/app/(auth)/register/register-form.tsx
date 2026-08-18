'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { RegisterInput } from '@brandlens/contracts';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';

type FormValues = z.infer<typeof RegisterInput>;

export function RegisterForm() {
  const router = useRouter();
  const [serverError, setServerError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ defaultValues: { email: '', password: '', name: '', organizationName: '' } });

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);

    const parsed = RegisterInput.safeParse({ ...values, name: values.name || undefined });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'email' || field === 'password' || field === 'name' || field === 'organizationName') {
          setError(field, { message: issue.message });
        }
      }
      return;
    }

    const res = await fetch('/api/auth/register', {
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
      setServerError(message ?? 'Registration failed.');
      return;
    }

    router.push('/dashboard');
    router.refresh();
  });

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-3" noValidate>
      {serverError ? (
        <p role="alert" className="rounded-md border border-blocker/40 bg-blocker-soft px-3 py-2 text-xs text-blocker-fg">
          {serverError}
        </p>
      ) : null}

      <Field label="Organization name" htmlFor="organizationName" error={errors.organizationName?.message} required>
        <Input
          id="organizationName"
          autoFocus
          placeholder="Acme"
          invalid={Boolean(errors.organizationName)}
          {...register('organizationName', { required: 'Organization name is required' })}
        />
      </Field>

      <Field label="Your name" htmlFor="name" error={errors.name?.message} hint="Optional — shown on decisions you record.">
        <Input id="name" autoComplete="name" placeholder="Jane Okafor" {...register('name')} />
      </Field>

      <Field label="Email" htmlFor="email" error={errors.email?.message} required>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          placeholder="you@acme.com"
          invalid={Boolean(errors.email)}
          {...register('email', { required: 'Email is required' })}
        />
      </Field>

      <Field
        label="Password"
        htmlFor="password"
        error={errors.password?.message}
        hint="At least 10 characters."
        required
      >
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          invalid={Boolean(errors.password)}
          {...register('password', { required: 'Password is required' })}
        />
      </Field>

      <Button type="submit" variant="primary" size="lg" className="w-full" loading={isSubmitting}>
        Create organization
      </Button>
    </form>
  );
}
