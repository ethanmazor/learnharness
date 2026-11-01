"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRightIcon, PinIcon, PinOffIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { useServerEvent } from "@/components/server-events";
import { FeedbackItemRow } from "@/components/feedback-box";
import { LearnerBridges } from "@/components/learner-bridges";
import { cn } from "@/lib/utils";
import {
	FEEDBACK_TAG_LABELS,
	LEARNER_LIMITS,
	LIST_TRAITS,
	SCALAR_TRAIT_VALUES,
	SCALAR_TRAITS,
	TRAIT_LABELS,
	type ChatListItem,
	type EvidenceRef,
	type FeedbackItem,
	type LearnerProfile,
	type LearnerSettings,
	type ListTraitKey,
	type ScalarTrait,
	type ScalarTraitKey,
	type TraceLedgerEntry,
	type TraitValue,
	type WorkspaceSummary,
} from "@/src/core";

/**
 * "HOW I LEARN" (PLAN.md Phases 3–5): everything the app has inferred about
 * how the learner reasons, with its confidence and evidence — and the
 * learner's controls over it: edit, pin, delete, per-course overrides. Plus
 * the raw material (feedback, traces), the learner's concept bridges, and
 * the learner-model settings.
 */

type Tab = "traits" | "feedback" | "traces" | "bridges" | "settings";
const TABS: Array<{ id: Tab; label: string }> = [
	{ id: "traits", label: "Traits" },
	{ id: "feedback", label: "Feedback" },
	{ id: "traces", label: "Reasoning traces" },
	{ id: "bridges", label: "My concept links" },
	{ id: "settings", label: "Settings" },
];

interface ProfileResponse {
	profile: LearnerProfile;
	workspaces: WorkspaceSummary[];
	settings: Required<LearnerSettings>;
}

const chip = "rounded-full border px-2 py-0.5 text-[11px] uppercase tracking-wide";
const button = "rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

export function LearnerPanel() {
	const [tab, setTab] = useState<Tab>("traits");
	const [data, setData] = useState<ProfileResponse | null>(null);
	const [chats, setChats] = useState<ChatListItem[]>([]);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(() => {
		void fetch("/api/learner/profile", { cache: "no-store" })
			.then((r) => r.json())
			.then((body: ProfileResponse) => setData(body))
			.catch(() => setError("Could not load your learner profile."));
		void fetch("/api/chats", { cache: "no-store" })
			.then((r) => r.json())
			.then((body: { chats: ChatListItem[] }) => setChats(body.chats))
			.catch(() => {});
	}, []);
	useEffect(() => refresh(), [refresh]);
	useServerEvent("learner-changed", () => refresh());
	useServerEvent("workspaces-changed", () => refresh());

	const titles = useMemo(() => new Map(chats.map((c) => [c.id, c.title])), [chats]);
	const courseNames = useMemo(() => new Map((data?.workspaces ?? []).map((w) => [w.id, w.name])), [data]);

	const act = useCallback(async (key: string, body: unknown) => {
		setError(null);
		const res = await fetch(`/api/learner/traits/${encodeURIComponent(key)}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const payload = (await res.json().catch(() => ({}))) as { profile?: LearnerProfile; error?: string };
		if (!res.ok) return setError(payload.error ?? `Could not save (${res.status})`);
		if (payload.profile) setData((prev) => (prev ? { ...prev, profile: payload.profile! } : prev));
	}, []);

	return (
		<div className="flex h-dvh flex-col">
			<TopBar>
				<h1 className="font-title text-3xl tracking-tight">How I learn</h1>
			</TopBar>
			<div className="flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-4">
					<nav className="flex flex-wrap gap-1 border-b border-border pb-2" aria-label="How I learn sections">
						{TABS.map((t) => (
							<button
								key={t.id}
								type="button"
								data-testid={`learner-tab-${t.id}`}
								onClick={() => setTab(t.id)}
								className={cn(
									"rounded-md px-3 py-1.5 font-ui text-xs uppercase tracking-wide transition-colors",
									tab === t.id ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
								)}
							>
								{t.label}
							</button>
						))}
					</nav>
					{error && <div role="alert" className="rounded-md border border-border px-3 py-2 text-sm">{error}</div>}
					{!data ? (
						<p className="text-sm text-muted-foreground">Loading…</p>
					) : tab === "traits" ? (
						<TraitsView data={data} titles={titles} courseNames={courseNames} act={act} />
					) : tab === "feedback" ? (
						<FeedbackView titles={titles} courseNames={courseNames} />
					) : tab === "traces" ? (
						<TracesView titles={titles} courseNames={courseNames} />
					) : tab === "bridges" ? (
						<LearnerBridges workspaces={data.workspaces} titles={titles} />
					) : (
						<SettingsView settings={data.settings} onSaved={refresh} />
					)}
				</div>
			</div>
		</div>
	);
}

// ─── traits ──────────────────────────────────────────────────────────────────

function percent(n: number): string {
	return `${Math.round(n * 100)}%`;
}

function ConfidenceBar({ value }: { value: number }) {
	return (
		<span className="flex items-center gap-1.5" title={`Confidence ${percent(value)}`}>
			<span className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
				<span className="block h-full bg-foreground/60" style={{ width: percent(value) }} />
			</span>
			<span className="font-ui text-[11px] text-muted-foreground">{percent(value)}</span>
		</span>
	);
}

function StatusChips({ t }: { t: TraitValue }) {
	return (
		<span className="flex flex-wrap items-center gap-1.5">
			<span className={cn(chip, t.status === "active" ? "border-foreground/40 text-foreground" : "border-border text-muted-foreground")}>
				{t.status === "active" ? "Active" : "Candidate"}
			</span>
			<span className={cn(chip, "border-border text-muted-foreground")}>
				{t.source === "edited" ? "Edited by you" : t.source === "feedback" ? "From your feedback" : "Inferred"}
			</span>
			{t.pinned && <span className={cn(chip, "border-border text-muted-foreground")}>Pinned</span>}
		</span>
	);
}

export function EvidenceList({ evidence, total, titles, courseNames }: { evidence: EvidenceRef[]; total: number; titles: Map<string, string>; courseNames: Map<string, string> }) {
	const [open, setOpen] = useState(false);
	if (total === 0) return <span className="text-xs text-muted-foreground">No evidence — set by you.</span>;
	return (
		<div className="text-xs">
			<button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
				<ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
				Evidence · {total} item{total === 1 ? "" : "s"}
			</button>
			{open && (
				<ul className="mt-1 flex flex-col gap-0.5 pl-4">
					{evidence.map((e, i) => (
						<li key={`${e.messageId}-${e.kind}-${i}`} className="text-muted-foreground">
							<Link href={`/chat/${e.chatId}#message-${e.messageId}`} className="text-foreground underline-offset-2 hover:underline">
								{titles.get(e.chatId) ?? e.chatId}
							</Link>
							{" · "}
							{courseNames.get(e.workspaceId) ?? "deleted course"} · {e.kind} · {e.at.slice(0, 10)}
						</li>
					))}
					{total > evidence.length && <li className="text-muted-foreground">… and {total - evidence.length} older</li>}
				</ul>
			)}
		</div>
	);
}

function TraitsView({
	data,
	titles,
	courseNames,
	act,
}: {
	data: ProfileResponse;
	titles: Map<string, string>;
	courseNames: Map<string, string>;
	act: (key: string, body: unknown) => Promise<void>;
}) {
	const { profile, workspaces, settings } = data;
	const empty = SCALAR_TRAITS.every((k) => !profile.scalars[k]) && LIST_TRAITS.every((k) => profile.lists[k].items.length === 0);
	return (
		<div className="flex flex-col gap-4">
			<p className="text-sm text-muted-foreground">
				Built from your thinking, answers, messages and feedback. An inferred trait becomes active after it shows up in {settings.activationSessions} separate
				sessions; anything from your feedback or your own edit is active at once. Only active traits are given to the agents.
			</p>
			{empty && <p className="text-sm text-muted-foreground">Nothing observed yet — keep learning, think out loud, and leave feedback under responses.</p>}
			{SCALAR_TRAITS.map((key) => (
				<ScalarCard key={key} traitKey={key} trait={profile.scalars[key]} profile={profile} workspaces={workspaces} titles={titles} courseNames={courseNames} act={act} />
			))}
			{LIST_TRAITS.map((key) => (
				<ListCard key={key} traitKey={key} items={profile.lists[key].items} titles={titles} courseNames={courseNames} act={act} />
			))}
		</div>
	);
}

function ScalarCard({
	traitKey,
	trait,
	profile,
	workspaces,
	titles,
	courseNames,
	act,
}: {
	traitKey: ScalarTraitKey;
	trait: ScalarTrait | undefined;
	profile: LearnerProfile;
	workspaces: WorkspaceSummary[];
	titles: Map<string, string>;
	courseNames: Map<string, string>;
	act: (key: string, body: unknown) => Promise<void>;
}) {
	const [editing, setEditing] = useState(false);
	const [course, setCourse] = useState("");
	const [historyOpen, setHistoryOpen] = useState(false);
	const values = SCALAR_TRAIT_VALUES[traitKey];
	const overrides = Object.entries(profile.user.overrides).flatMap(([ws, o]) => (o[traitKey] ? [{ ws, value: o[traitKey]!.value }] : []));
	return (
		<section data-testid={`trait-${traitKey}`} className="rounded-lg border border-border p-3">
			<div className="flex flex-wrap items-center gap-2">
				<h2 className="font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">{TRAIT_LABELS[traitKey]}</h2>
				<span className="flex-1" />
				{trait && (
					<button type="button" aria-label={trait.pinned ? "Unpin" : "Pin"} title={trait.pinned ? "Unpin (let evidence change it)" : "Pin (never change it automatically)"} onClick={() => void act(traitKey, { action: "pin", pinned: !trait.pinned })} className={button}>
						{trait.pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
					</button>
				)}
				<button type="button" onClick={() => setEditing((v) => !v)} className={button}>Edit</button>
				{trait && (
					<button type="button" aria-label="Delete trait" onClick={() => void act(traitKey, { action: "delete" })} className={button}>
						<Trash2Icon className="size-3.5" />
					</button>
				)}
			</div>
			{trait ? (
				<div className="mt-2 flex flex-col gap-2">
					<div className="flex flex-wrap items-center gap-3">
						<span className="font-prose text-lg text-foreground">{trait.value}</span>
						<ConfidenceBar value={trait.confidence} />
						<StatusChips t={trait} />
					</div>
					<p className="text-xs text-muted-foreground">
						{trait.sessions} session{trait.sessions === 1 ? "" : "s"} · first seen {trait.firstSeen.slice(0, 10)} · updated {trait.lastUpdated.slice(0, 10)}
						{trait.alternatives.length > 0 && <> · competing: {trait.alternatives.map((a) => `${a.value} (${a.sessions} session${a.sessions === 1 ? "" : "s"})`).join(", ")}</>}
					</p>
					<EvidenceList evidence={trait.evidence} total={trait.evidenceCount} titles={titles} courseNames={courseNames} />
					{trait.history.length > 0 && (
						<div className="text-xs">
							<button type="button" onClick={() => setHistoryOpen((v) => !v)} className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
								<ChevronRightIcon className={cn("size-3 transition-transform", historyOpen && "rotate-90")} />
								History · {trait.history.length}
							</button>
							{historyOpen && (
								<ul className="mt-1 flex flex-col gap-0.5 pl-4 text-muted-foreground">
									{[...trait.history].reverse().map((h, i) => (
										<li key={i}>{h.at.slice(0, 16).replace("T", " ")} · {h.value} · {percent(h.confidence)} · {h.reason}</li>
									))}
								</ul>
							)}
						</div>
					)}
				</div>
			) : (
				<p className="mt-2 text-sm text-muted-foreground">Not observed yet.</p>
			)}
			{editing && (
				<div className="mt-2 flex flex-wrap gap-1.5">
					{values.map((v) => (
						<button key={v} type="button" onClick={() => { void act(traitKey, { action: "edit", value: v }); setEditing(false); }} className={cn(button, trait?.value === v && "text-foreground")}>
							{v}
						</button>
					))}
				</div>
			)}
			<div className="mt-3 flex flex-col gap-1.5 border-t border-border/60 pt-2 text-xs">
				{overrides.map((o) => (
					<div key={o.ws} className="flex items-center gap-2 text-muted-foreground">
						<span>In {courseNames.get(o.ws) ?? o.ws}: <span className="text-foreground">{o.value}</span></span>
						<button type="button" onClick={() => void act(traitKey, { action: "override", workspaceId: o.ws, value: null })} className="underline-offset-2 hover:underline">remove</button>
					</div>
				))}
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="text-muted-foreground">Override for a course:</span>
					<select value={course} onChange={(e) => setCourse(e.target.value)} className="rounded-md border border-border bg-background px-1.5 py-0.5">
						<option value="">course…</option>
						{workspaces.filter((w) => !w.archived).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
					</select>
					{course && values.map((v) => (
						<button key={v} type="button" onClick={() => { void act(traitKey, { action: "override", workspaceId: course, value: v }); setCourse(""); }} className={button}>{v}</button>
					))}
				</div>
			</div>
		</section>
	);
}

function ListCard({
	traitKey,
	items,
	titles,
	courseNames,
	act,
}: {
	traitKey: ListTraitKey;
	items: TraitValue[];
	titles: Map<string, string>;
	courseNames: Map<string, string>;
	act: (key: string, body: unknown) => Promise<void>;
}) {
	const [draft, setDraft] = useState("");
	return (
		<section data-testid={`trait-${traitKey}`} className="rounded-lg border border-border p-3">
			<h2 className="font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">{TRAIT_LABELS[traitKey]}</h2>
			{items.length === 0 && <p className="mt-2 text-sm text-muted-foreground">Nothing yet.</p>}
			<ul className="mt-2 flex flex-col gap-2">
				{items.map((item) => (
					<li key={item.value} className="flex flex-col gap-1 rounded-md border border-border/50 px-2 py-1.5">
						<div className="flex flex-wrap items-center gap-2">
							<span className="font-prose text-sm text-foreground">{item.value}</span>
							<ConfidenceBar value={item.confidence} />
							<StatusChips t={item} />
							<span className="flex-1" />
							<button type="button" aria-label={item.pinned ? "Unpin" : "Pin"} onClick={() => void act(traitKey, { action: "pin", pinned: !item.pinned, item: item.value })} className={button}>
								{item.pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
							</button>
							<button type="button" aria-label="Delete item" onClick={() => void act(traitKey, { action: "delete", item: item.value })} className={button}>
								<Trash2Icon className="size-3.5" />
							</button>
						</div>
						<EvidenceList evidence={item.evidence} total={item.evidenceCount} titles={titles} courseNames={courseNames} />
					</li>
				))}
			</ul>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					if (!draft.trim()) return;
					void act(traitKey, { action: "add-item", value: draft });
					setDraft("");
				}}
				className="mt-2 flex gap-1.5"
			>
				<input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add your own…" className="lh-input flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm" />
				<button type="submit" className={button} aria-label="Add"><PlusIcon className="size-3.5" /></button>
			</form>
		</section>
	);
}

// ─── feedback and traces ─────────────────────────────────────────────────────

function FeedbackView({ titles, courseNames }: { titles: Map<string, string>; courseNames: Map<string, string> }) {
	const [items, setItems] = useState<FeedbackItem[] | null>(null);
	const refresh = useCallback(() => {
		void fetch("/api/learner/feedback", { cache: "no-store" })
			.then((r) => r.json())
			.then((body: { feedback: FeedbackItem[] }) => setItems([...body.feedback].reverse()))
			.catch(() => setItems([]));
	}, []);
	useEffect(() => refresh(), [refresh]);
	useServerEvent("learner-changed", () => refresh());
	if (!items) return <p className="text-sm text-muted-foreground">Loading…</p>;
	if (items.length === 0) return <p className="text-sm text-muted-foreground">No feedback yet. Open “Feedback” under any agent response.</p>;
	return (
		<ul className="flex flex-col gap-2">
			{items.map((item) => (
				<li key={item.id} className="flex flex-col gap-1">
					<span className="text-xs text-muted-foreground">
						<Link href={`/chat/${item.chatId}#message-${item.messageId}`} className="text-foreground underline-offset-2 hover:underline">{titles.get(item.chatId) ?? item.chatId}</Link>
						{" · "}{courseNames.get(item.workspaceId) ?? "deleted course"} · {item.createdAt.slice(0, 10)}
					</span>
					<ul><FeedbackItemRow item={item} onChanged={refresh} /></ul>
				</li>
			))}
		</ul>
	);
}

function TracesView({ titles, courseNames }: { titles: Map<string, string>; courseNames: Map<string, string> }) {
	const [entries, setEntries] = useState<TraceLedgerEntry[] | null>(null);
	const refresh = useCallback(() => {
		void fetch("/api/learner/traces", { cache: "no-store" })
			.then((r) => r.json())
			.then((body: { traces: TraceLedgerEntry[] }) => setEntries(body.traces))
			.catch(() => setEntries([]));
	}, []);
	useEffect(() => refresh(), [refresh]);
	useServerEvent("learner-changed", () => refresh());
	const remove = async (id: string) => {
		const res = await fetch(`/api/learner/traces/${encodeURIComponent(id)}`, { method: "DELETE" });
		if (res.ok) refresh();
	};
	if (!entries) return <p className="text-sm text-muted-foreground">Loading…</p>;
	if (entries.length === 0) return <p className="text-sm text-muted-foreground">No reasoning traces yet. They appear after you answer, think out loud or write in a session (a cheap-model call in the background).</p>;
	return (
		<ul className="flex flex-col gap-2">
			{entries.map((e) => (
				<li key={e.id} data-testid="trace-entry" className="rounded-lg border border-border p-3 text-sm">
					<div className="flex items-start gap-2 text-xs text-muted-foreground">
						<span className="flex-1">
							<Link href={`/chat/${e.evidence.chatId}#message-${e.evidence.messageId}`} className="text-foreground underline-offset-2 hover:underline">{titles.get(e.evidence.chatId) ?? e.evidence.chatId}</Link>
							{" · "}{courseNames.get(e.evidence.workspaceId) ?? "deleted course"} · {e.evidence.kind} · {e.createdAt.slice(0, 16).replace("T", " ")}
						</span>
						<button type="button" aria-label="Delete trace" onClick={() => void remove(e.id)} className="hover:text-foreground"><Trash2Icon className="size-3.5" /></button>
					</div>
					{e.type === "trace" ? (
						<div className="mt-1.5 flex flex-col gap-1">
							<div><span className="text-muted-foreground">Entry point:</span> {e.entryPoint} · <span className="text-muted-foreground">confidence</span> {percent(e.confidence)}</div>
							{e.steps.length > 0 && <ol className="list-decimal pl-5">{e.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>}
							{e.assumptionsUsed.length > 0 && <div><span className="text-muted-foreground">Assumed:</span> {e.assumptionsUsed.join("; ")}</div>}
							{e.assumptionsMissing.length > 0 && <div><span className="text-muted-foreground">Missing:</span> {e.assumptionsMissing.join("; ")}</div>}
							{e.references.length > 0 && <div><span className="text-muted-foreground">Reached for:</span> {e.references.map((r) => r.domain ? `${r.text} (${r.domain})` : r.text).join("; ")}</div>}
							{e.bridges.length > 0 && <div><span className="text-muted-foreground">Links drawn:</span> {e.bridges.map((b) => `${b.from} → ${b.to} (${b.type})`).join("; ")}</div>}
						</div>
					) : e.type === "stack-push" ? (
						<div className="mt-1.5"><span className="text-muted-foreground">Missing assumption pushed:</span> {e.assumption}</div>
					) : (
						<div className="mt-1.5"><span className="text-muted-foreground">Resolved:</span> {e.assumption} → back to {e.neededBy} ({e.outcome})</div>
					)}
				</li>
			))}
		</ul>
	);
}

// ─── settings ────────────────────────────────────────────────────────────────

const KNOB_LABELS: Record<keyof typeof LEARNER_LIMITS, string> = {
	activationSessions: "Sessions before an inferred trait turns active",
	feedbackWeight: "Weight of your feedback vs. inferred evidence",
	contextTokenBudget: "Token budget of the summary given to agents",
	recentFeedbackItems: "Recent feedback items in that summary",
	stackMaxDepth: "Maximum learning-stack depth",
	bridgeHops: "Concept-link search depth (hops)",
};

export function SettingsView({ settings, onSaved }: { settings: Required<LearnerSettings>; onSaved: () => void }) {
	const [draft, setDraft] = useState(settings);
	const [status, setStatus] = useState<string | null>(null);
	useEffect(() => setDraft(settings), [settings]);
	const save = async () => {
		const res = await fetch("/api/settings/learner", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		setStatus(res.ok ? "Saved." : body.error ?? `Could not save (${res.status})`);
		if (res.ok) onSaved();
	};
	return (
		<div className="flex flex-col gap-3 text-sm">
			{(["enabled", "traceExtraction"] as const).map((key) => (
				<label key={key} className="flex items-center gap-2">
					<input type="checkbox" checked={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.checked })} className="size-4 accent-primary" />
					{key === "enabled" ? "Learn how I reason and adapt explanations (profile + summary for agents)" : "Extract reasoning traces in the background (cheap model slot)"}
				</label>
			))}
			{(Object.keys(LEARNER_LIMITS) as (keyof typeof LEARNER_LIMITS)[]).map((key) => (
				<label key={key} className="flex items-center gap-2">
					<input
						type="number"
						min={LEARNER_LIMITS[key][0]}
						max={LEARNER_LIMITS[key][1]}
						value={draft[key]}
						onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })}
						className="lh-input w-20 rounded-md border border-border bg-background px-2 py-1"
					/>
					<span>{KNOB_LABELS[key]} <span className="text-muted-foreground">({LEARNER_LIMITS[key][0]}–{LEARNER_LIMITS[key][1]})</span></span>
				</label>
			))}
			<p className="text-xs text-muted-foreground">
				The tracer&apos;s instructions and the agents&apos; learner-profile doctrine are editable under Settings → Agent → Prompts. Quick-tag meanings: {Object.values(FEEDBACK_TAG_LABELS).join(", ")}.
			</p>
			<div className="flex items-center gap-2">
				<button type="button" onClick={() => void save()} className={button}>Save</button>
				{status && <span className="text-xs text-muted-foreground">{status}</span>}
			</div>
		</div>
	);
}
