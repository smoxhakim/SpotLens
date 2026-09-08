import { Skeleton } from "@/components/ui/skeleton";

/**
 * Scoped to the dashboard route group on purpose.
 *
 * A `loading.tsx` at the app root would wrap every page in a Suspense
 * boundary, and a streamed response has already sent its 200 status before a
 * page can call `notFound()` — so every unknown asset and article returned
 * "200 Page not found". Loading boundaries must stay below any route that can
 * legitimately 404.
 */
export default function Loading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-48" />
      <div className="grid gap-4 sm:grid-cols-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
      <Skeleton className="h-96 w-full" />
    </div>
  );
}
