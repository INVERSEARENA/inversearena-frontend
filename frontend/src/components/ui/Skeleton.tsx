import { HTMLAttributes } from "react";

export function Skeleton({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={`animate-pulse bg-white/5 rounded ${className}`}
            {...props}
        />
    );
}
