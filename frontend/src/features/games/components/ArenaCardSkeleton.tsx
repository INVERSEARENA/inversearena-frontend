import { Skeleton } from "@/components/ui/Skeleton";

export function ArenaCardSkeleton({ isFeatured = false }: { isFeatured?: boolean }) {
    if (isFeatured) {
        return (
            <div className="col-span-1 lg:col-span-2 bg-[#09101D] border border-black p-8 relative overflow-hidden h-[400px]">
                <div className="absolute top-0 right-0 p-4 space-y-2">
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-6 w-24" />
                </div>

                <div className="flex flex-col h-full justify-between">
                    <div>
                        <Skeleton className="h-3 w-32 mb-2" />
                        <Skeleton className="h-16 w-48 mb-8" />

                        <div className="flex gap-10 mb-6">
                            <div className="space-y-2">
                                <Skeleton className="h-3 w-20" />
                                <Skeleton className="h-6 w-24" />
                            </div>
                            <div className="space-y-2">
                                <Skeleton className="h-3 w-20" />
                                <Skeleton className="h-6 w-24" />
                            </div>
                        </div>

                        <Skeleton className="h-8 w-64" />
                    </div>

                    <Skeleton className="h-14 w-48 self-end" />
                </div>
            </div>
        );
    }

    return (
        <div className="bg-[#09101D] border border-black p-6 flex flex-col justify-between h-[360px]">
            <div className="flex justify-between items-start mb-8">
                <Skeleton className="h-10 w-24" />
                <Skeleton className="h-4 w-16" />
            </div>

            <div className="space-y-4 mb-8">
                <div className="pt-3 border-t border-white/5 flex justify-between items-center">
                    <Skeleton className="h-3 w-12" />
                    <Skeleton className="h-3 w-16" />
                </div>
                <div className="pt-3 border-t border-white/5 flex justify-between items-center">
                    <Skeleton className="h-3 w-12" />
                    <Skeleton className="h-3 w-16" />
                </div>
                <div className="pt-3 border-t border-white/5 flex justify-between items-center">
                    <Skeleton className="h-3 w-12" />
                    <Skeleton className="h-3 w-16" />
                </div>
            </div>

            <Skeleton className="h-11 w-full" />
        </div>
    );
}
