import { cn } from "@/lib/utils";

export function MetadataCard({
  icon: Icon,
  label,
  value,
  size = "sm",
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: React.ReactNode;
  size?: "sm" | "lg";
}) {
  const valueClass = size === "lg" ? "text-lg font-semibold" : "text-sm font-semibold truncate";
  const title = typeof value === "string" ? value : undefined;
  return (
    <div className="rounded-lg border border-border/50 bg-bg-card p-3">
      <div className="flex items-center gap-2 text-xs text-text-muted mb-1">
        <Icon className="w-3.5 h-3.5" />
        {label}
      </div>
      <div className={cn(valueClass)} title={title}>
        {value}
      </div>
    </div>
  );
}
