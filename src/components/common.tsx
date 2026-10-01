import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type LucideIcon } from "lucide-react";

export function DemoBadge({ full = false, className }: { full?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md bg-bps-orange-soft px-2 py-0.5 text-[11px] font-medium text-bps-orange",
        className,
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-bps-orange" />
      {full ? "Demo Data — Not Official Statistics" : "Demo Data"}
    </span>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-balance-tight text-[32px] font-semibold leading-tight tracking-tight">
          {title}
        </h1>
        {subtitle && <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function SectionTitle({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-4">
      <h2 className="text-lg font-semibold tracking-tight">{children}</h2>
      {action}
    </div>
  );
}

export function StatisticCard({
  label,
  value,
  delta,
  tone = "blue",
  demo = true,
}: {
  label: string;
  value: string;
  delta?: string;
  tone?: "blue" | "orange" | "green";
  demo?: boolean;
}) {
  const toneClass = {
    blue: "text-bps-blue bg-bps-blue-soft",
    orange: "text-bps-orange bg-bps-orange-soft",
    green: "text-bps-green bg-bps-green-soft",
  }[tone];

  return (
    <div className="panel hover-lift animate-fade-up p-5">
      <div className="flex items-start justify-between gap-3">
        <span className="text-[13px] font-medium text-muted-foreground">{label}</span>
        {delta && (
          <span className={cn("rounded-md px-1.5 py-0.5 text-[11px] font-semibold", toneClass)}>
            {delta}
          </span>
        )}
      </div>
      <div className="mt-3 text-[30px] font-semibold leading-none tracking-tight">{value}</div>
      {demo && <div className="mt-3">{<DemoBadge />}</div>}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="panel flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-bps-blue-soft text-bps-blue">
        <Icon className="h-5 w-5" />
      </div>
      <h3 className="mt-4 text-base font-semibold">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = "Unable to analyze this dataset.",
  description = "Please verify the file format and try again.",
  onRetry,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="rounded-xl border border-destructive/25 bg-destructive/5 p-5">
      <h3 className="text-sm font-semibold text-destructive">{title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
          Try Again
        </Button>
      )}
    </div>
  );
}

export function SourceCard({
  kind,
  title,
  meta,
  link,
}: {
  kind: string;
  title: string;
  meta: string;
  link?: string | undefined;
}) {
  return (
    <div className="hover-lift flex items-center justify-between gap-4 rounded-xl border bg-surface-2 px-4 py-3">
      <div className="min-w-0">
        <Badge
          variant="secondary"
          className="mb-1.5 rounded-md bg-bps-blue-soft text-[11px] font-medium text-bps-blue"
        >
          {kind}
        </Badge>
        <div className="truncate text-sm font-medium">{title}</div>
        <div className="truncate text-xs text-muted-foreground">{meta}</div>
      </div>
      {link ? (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => window.open(link, "_blank", "noopener,noreferrer")}
        >
          Buka Dokumen
        </Button>
      ) : (
        <Button variant="outline" size="sm" className="shrink-0 text-muted-foreground" disabled>
          Dokumen Internal
        </Button>
      )}
    </div>
  );
}

export function TrustNote() {
  return (
    <p className="text-xs text-muted-foreground">
      AI-generated responses should be verified against official BPS sources.
    </p>
  );
}
