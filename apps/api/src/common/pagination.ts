import { z } from 'zod';

export const PageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type PageQuery = z.infer<typeof PageQuery>;

export interface PageResult<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

export function offsetOf(q: { page: number; pageSize: number }): number {
  return (q.page - 1) * q.pageSize;
}

export function paginate<T>(data: T[], total: number, q: { page: number; pageSize: number }): PageResult<T> {
  return {
    data,
    page: q.page,
    pageSize: q.pageSize,
    total,
    hasMore: q.page * q.pageSize < total,
  };
}

/** Postgres `count(*)` comes back as a bigint string via node-postgres. */
export function toCount(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number.parseInt(value, 10) || 0;
  if (typeof value === 'bigint') return Number(value);
  return 0;
}
