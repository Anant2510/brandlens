import { Skeleton } from '@/components/ui/skeleton';

export default function AppLoading() {
  return (
    <div className="p-4" role="status" aria-label="Loading">
      <Skeleton className="h-6 w-56" />
      <Skeleton className="mt-3 h-3 w-80" />
      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
      <Skeleton className="mt-4 h-64 w-full" />
      <span className="sr-only">Loading</span>
    </div>
  );
}
