import { LucideIcon } from "lucide-react";
import { Button } from "./Button";

interface EmptyStateProps {
    icon?: LucideIcon;
    title: string;
    description: string;
    actionLabel?: string;
    onAction?: () => void;
    className?: string;
}

export function EmptyState({
    icon: Icon,
    title,
    description,
    actionLabel,
    onAction,
    className = "",
}: EmptyStateProps) {
    return (
        <div className={`flex flex-col items-center justify-center p-8 text-center border border-white/5 bg-black/20 backdrop-blur-sm rounded-lg ${className}`}>
            {Icon && (
                <div className="mb-4 p-4 rounded-full bg-white/5 text-zinc-500">
                    <Icon size={32} strokeWidth={1.5} />
                </div>
            )}
            <h3 className="text-lg font-bold tracking-tight text-white mb-2 uppercase italic">
                {title}
            </h3>
            <p className="text-sm text-zinc-500 max-w-xs mb-6 font-mono">
                {description}
            </p>
            {actionLabel && onAction && (
                <Button
                    variant="secondary"
                    onClick={onAction}
                    className="border-neon-green/50 text-neon-green hover:bg-neon-green/10 text-xs tracking-widest uppercase font-bold"
                >
                    {actionLabel}
                </Button>
            )}
        </div>
    );
}
