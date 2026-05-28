import { Skeleton } from "@/components/ui/Skeleton";

/**
 * Loading placeholder for the arena right-column stats cards (#669).
 *
 * Mirrors the layout of the yield pot, survivors, elimination feed, and player
 * status cards so the page keeps its shape while the arena stats endpoint
 * resolves (cache misses can take 200-500ms), instead of showing empty space.
 */
export function ArenaStatsSkeleton() {
    return (
        <div className="space-y-4" data-testid="arena-stats-skeleton" aria-hidden="true">
            {/* Yield pot */}
            <div className="bg-card-bg border border-white/10 p-4">
                <Skeleton className="h-3 w-24 mb-3" />
                <Skeleton className="h-8 w-40" />
            </div>
            {/* Survivors */}
            <div className="bg-card-bg border border-white/10 p-4">
                <Skeleton className="h-3 w-20 mb-2" />
                <Skeleton className="h-9 w-16" />
                <Skeleton className="mt-3 h-2 w-full" />
            </div>
            {/* Elimination feed */}
            <div className="bg-card-bg border border-white/10 p-4 space-y-3">
                <Skeleton className="h-3 w-28 mb-2" />
                {[...Array(4)].map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                ))}
            </div>
            {/* Your status */}
            <div className="bg-card-bg border border-white/10 p-4">
                <Skeleton className="h-3 w-20 mb-3" />
                <Skeleton className="h-6 w-32 mb-4" />
                <Skeleton className="h-4 w-full" />
            </div>
        </div>
    );
}
