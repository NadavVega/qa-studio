import Link from "next/link";
import type { ReactNode } from "react";
import { useApi } from "@/lib/api";
import type { CheckResult, CheckStatus, DemoStatus, Environment, FindingStatus, LlmProviders, ModelInfo, Project, RegressionTestStatus, RequirementAuthority, Verdict } from "@qa/core";
import {
  AlertTriangle, BookOpen, Check, CircleHelp, CirclePause, Eye, FlaskConical, Folder, LayoutGrid, OctagonX, ServerCrash, Settings, ShieldCheck,
} from "lucide-react";

const icon = { size: 14, strokeWidth: 1.75, "aria-hidden": true } as const;

// Badge kinds map 1:1 to .qs-badge--* in qs.css. Icon + label, never colour alone.
type BadgeKind =
  | "correct" | "observational" | "inconclusive" | "potential" | "confirmed" | "infra" | "authoritative" | "observed"
  | "unknown" | "neutral" | "outline" | "rejected" | "promoted" | "waiting" | "running" | "simulated";
const BADGE_ICON: Partial<Record<BadgeKind, ReactNode>> = {
  correct: <Check {...icon} />,
  observational: <Eye {...icon} />,
  inconclusive: <CircleHelp {...icon} />,
  potential: <AlertTriangle {...icon} />,
  confirmed: <OctagonX {...icon} />,
  infra: <ServerCrash {...icon} />,
  authoritative: <ShieldCheck {...icon} />,
  observed: <Eye {...icon} />,
  waiting: <CirclePause {...icon} />,
  running: <span className="qs-live" aria-hidden />,
  simulated: <FlaskConical {...icon} />,
};

export function Badge({ kind, children }: { kind: BadgeKind; children: ReactNode }) {
  return <span className={`qs-badge qs-badge--${kind}`}>{BADGE_ICON[kind]}{children}</span>;
}

const VERDICT: Record<Verdict, [BadgeKind, string]> = {
  correct: ["correct", "Correct"],
  observational: ["observational", "Observational"],
  inconclusive: ["inconclusive", "Inconclusive"],
  potential_defect: ["potential", "Potential defect"],
  infra_failure: ["infra", "Infrastructure failure"],
};
export const VerdictBadge = ({ verdict }: { verdict: Verdict }) => <Badge kind={VERDICT[verdict][0]}>{VERDICT[verdict][1]}</Badge>;

const FINDING: Record<FindingStatus, [BadgeKind, string]> = {
  potential: ["potential", "Potential"],
  confirmed: ["confirmed", "Confirmed"],
  not_reproduced: ["neutral", "Not reproduced"],
  dismissed: ["outline", "Dismissed"],
};
export const FindingBadge = ({ status }: { status: FindingStatus }) => <Badge kind={FINDING[status][0]}>{FINDING[status][1]}</Badge>;

const TEST: Record<RegressionTestStatus, [BadgeKind, string]> = {
  proposed: ["outline", "Proposed"],
  validated: ["correct", "Validated"],
  rejected: ["rejected", "Rejected"],
  promoted: ["promoted", "Promoted"],
};
export const TestBadge = ({ status }: { status: RegressionTestStatus }) => <Badge kind={TEST[status][0]}>{TEST[status][1]}</Badge>;

const AUTHORITY: Record<RequirementAuthority, [BadgeKind, string]> = {
  authoritative: ["authoritative", "Authoritative"],
  observed: ["observed", "Observed (AI)"],
  unknown: ["unknown", "Unknown"],
};
export const AuthorityBadge = ({ authority }: { authority: RequirementAuthority }) => (
  <Badge kind={AUTHORITY[authority][0]}>{AUTHORITY[authority][1]}</Badge>
);

const CHECK: Record<CheckStatus, [BadgeKind, string]> = {
  ready: ["correct", "Ready"],
  needs_work: ["potential", "Needs work"],
  not_testable: ["neutral", "Not testable here"],
};
export const CheckBadge = ({ status }: { status: CheckStatus }) => <Badge kind={CHECK[status][0]}>{CHECK[status][1]}</Badge>;

// Requirement checker issues, each with its short fix.
export function CheckIssues({ check }: { check: CheckResult }) {
  if (!check.issues.length) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[12px] leading-4">
      {check.issues.map((i, n) => (
        <li key={n}><span className={i.level === "warn" ? "text-[var(--ink-muted)]" : "font-medium"}>{i.message}</span> <span className="qs-meta">{i.fix}</span></li>
      ))}
    </ul>
  );
}

export function Simulated({ on, demo }: { on: boolean; demo?: boolean }) {
  return <>{on && <Badge kind="simulated">Simulated</Badge>}{demo && <Badge kind="outline">Demo</Badge>}</>;
}

// Shown on every page while the API runs with DEMO_MODE=on.
function DemoBanner() {
  const { data } = useApi<DemoStatus>("/demo");
  if (!data?.on) return null;
  return <div role="status" className="border-b border-[var(--line)] bg-[var(--surface-sunken)] px-5 py-1 text-[12px] font-medium">Demo mode · data from {data.dir}</div>;
}

export function Button({ variant = "secondary", sm, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; sm?: boolean }) {
  return <button type="button" {...props} className={`qs-btn qs-btn--${variant} ${sm ? "qs-btn--sm" : ""} ${props.className ?? ""}`} />;
}

export function Panel({ label, meta, children, className = "", bodyClassName = "qs-panel__body flex flex-col gap-3" }: { label: ReactNode; meta?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={`qs-panel ${className}`}>
      <div className="qs-panel__head">
        <span className="qs-label">{label}</span>
        {meta && <span className="qs-meta ml-auto">{meta}</span>}
      </div>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="qs-empty">
      <p className="qs-empty__title">{title}</p>
      {children && <p>{children}</p>}
    </div>
  );
}

export function ErrorText({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="m-0 rounded-[var(--radius-md)] border border-[var(--confirmed)] bg-[var(--confirmed-soft)] px-3 py-2 text-[13px]">
      {error}
    </p>
  );
}

// Raw stage data, e.g. a full AI call. Collapsed by default.
export function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <details className="qs-code">
      <summary className="qs-code__head cursor-pointer">{label}</summary>
      <pre className="max-h-96 px-3">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

export const input =
  "h-8 rounded-[var(--radius-md)] border border-[var(--line-strong)] bg-[var(--surface-raised)] px-2 text-[13px] text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-[var(--focus)]";

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="qs-label">{label}</span>
      {children}
    </label>
  );
}

const modelLabel = (m: ModelInfo) =>
  `${m.id} · ${m.vision ? "vision" : "text only"}${m.maxInputTokens ? ` · ${m.maxInputTokens.toLocaleString()} input tokens` : ""}`;

// Models of every connected provider, grouped by provider. first is "auto" or "use the default".
export function ModelSelect({ providers, value, first, onChange, label, disabled }: {
  providers: LlmProviders | null;
  value: string;
  first: { value: string; label: string };
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
}) {
  const known = value === first.value || !!providers?.providers.some((p) => p.models.some((m) => m.id === value));
  return (
    <select className={`${input} qs-mono max-w-full`} aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value={first.value}>{first.label}</option>
      {!known && <option value={value}>{value} (provider not connected)</option>}
      {providers?.providers.filter((p) => p.models.length).map((p) => (
        <optgroup key={p.provider} label={p.provider}>
          {p.models.map((m) => <option key={m.id} value={m.id}>{modelLabel(m)}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

type Nav = "projects" | "workspace" | "knowledge" | "settings";

// AppShell: side nav, top bar with breadcrumbs, Simulated label and the page's actions.
export function Shell({ project, env, active, crumbs, actions, children }: {
  project?: Project | null;
  env?: Environment;
  active: Nav;
  crumbs: ReactNode[];
  actions?: ReactNode;
  children: ReactNode;
}) {
  const item = (nav: Nav, href: string, label: string, Icon: typeof Folder) => (
    <Link className={`qs-navitem ${active === nav ? "qs-navitem--active" : ""}`} href={href} aria-current={active === nav ? "page" : undefined}>
      <Icon size={16} strokeWidth={1.75} aria-hidden />{label}
    </Link>
  );
  return (
    <div className="flex min-h-screen flex-wrap">
      <nav className="qs-nav max-w-full flex-[1_1_232px]" aria-label="Main">
        <div className="qs-wordmark">QA Studio</div>
        {project && (
          <Link className="qs-switcher text-[var(--ink)]" href="/" aria-label="Switch project">
            {project.isSimulated && <FlaskConical {...icon} />}
            <span className="qs-switcher__name">{project.name}</span>
          </Link>
        )}
        {item("projects", "/", "Projects", Folder)}
        {project && item("workspace", `/projects/${project.id}`, "Workspace", LayoutGrid)}
        {project && item("knowledge", `/projects/${project.id}/knowledge`, "Knowledge & Config", BookOpen)}
        {item("settings", "/settings", "Settings", Settings)}
      </nav>
      <div className="flex min-w-0 flex-[999_1_640px] flex-col">
        <DemoBanner />
        <header className="qs-topbar h-auto min-h-14 flex-wrap gap-x-3 gap-y-2 py-2.5">
          <nav className="qs-crumbs" aria-label="Breadcrumb">
            {crumbs.map((c, i) => (i === crumbs.length - 1 ? <b key={i}>{c}</b> : <span key={i} className="contents"><span>{c}</span><span>/</span></span>))}
          </nav>
          <Simulated on={!!project?.isSimulated} demo={project?.isDemo} />
          {env && <span className="qs-meta qs-mono">{env.name} · {new URL(env.baseUrl).host}</span>}
          <span className="flex-auto" />
          {actions}
        </header>
        <main className="qs-main flex min-w-0 flex-col gap-4">{children}</main>
      </div>
    </div>
  );
}

// Tabs of Knowledge & Config.
export function KnowledgeTabs({ projectId, active }: { projectId: string; active: "requirements" | "integrations" }) {
  const tab = (key: typeof active, href: string, label: string) => (
    <Link className={`qs-tab ${active === key ? "qs-tab--active" : ""}`} href={href} aria-current={active === key ? "page" : undefined}>{label}</Link>
  );
  return (
    <nav className="qs-tabs flex-none border-b border-[var(--line)]" aria-label="Knowledge & Config">
      {tab("requirements", `/projects/${projectId}/knowledge`, "Requirements")}
      {tab("integrations", `/projects/${projectId}/knowledge/integrations`, "Integrations")}
    </nav>
  );
}
