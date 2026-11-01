"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckIcon, PencilIcon, Trash2Icon, XIcon } from "lucide-react";
import { useServerEvent } from "@/components/server-events";
import { cn } from "@/lib/utils";
import {
	BRIDGE_TYPE_LABELS,
	BRIDGE_TYPES,
	EDGE_SOURCE_LABELS,
	type BridgeType,
	type LearnerConcept,
	type LearnerEdge,
	type WorkspaceSummary,
} from "@/src/core";

/**
 * MY CONCEPT LINKS (PLAN.md Phase 5): how the learner's own mind links
 * concepts, across courses. Suggestions (found in their reasoning or in a
 * resolved learning-stack level) wait for Confirm / Reject; only their own
 * and confirmed links reach the agents. A list first, plus a simple graph.
 * Editing a link keeps the old one, marked replaced.
 */

const button = "rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";
const input = "lh-input rounded-md border border-border bg-background px-2 py-1 text-sm";

export function LearnerBridges({ workspaces }: { workspaces: WorkspaceSummary[]; titles: Map<string, string> }) {
	const [course, setCourse] = useState("");
	const [view, setView] = useState<"list" | "graph">("list");
	const [data, setData] = useState<{ concepts: LearnerConcept[]; edges: LearnerEdge[] } | null>(null);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(() => {
		void fetch(`/api/learner/bridges${course ? `?workspaceId=${encodeURIComponent(course)}` : ""}`, { cache: "no-store" })
			.then((r) => r.json())
			.then(setData)
			.catch(() => setError("Could not load your concept links."));
	}, [course]);
	useEffect(() => refresh(), [refresh]);
	useServerEvent("learner-changed", () => refresh());

	const names = useMemo(() => new Map((data?.concepts ?? []).map((c) => [c.id, c.label])), [data]);
	const suggestions = (data?.edges ?? []).filter((e) => e.source === "extracted-unconfirmed");
	const trusted = (data?.edges ?? []).filter((e) => e.source !== "extracted-unconfirmed");

	const call = async (url: string, method: string, body?: unknown) => {
		setError(null);
		const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Request failed (${res.status})`);
		refresh();
		return res.ok;
	};

	return (
		<div className="flex flex-col gap-4">
			<p className="text-sm text-muted-foreground">
				Links between concepts the way <em>you</em> connect them — across all your courses. Agents look these up before explaining something new and
				explain through the links you trust. Suggestions come from your own reasoning; they are used only after you confirm them.
			</p>
			<div className="flex flex-wrap items-center gap-2 text-xs">
				<label className="flex items-center gap-1.5 text-muted-foreground">
					Course
					<select value={course} onChange={(e) => setCourse(e.target.value)} className="rounded-md border border-border bg-background px-1.5 py-1">
						<option value="">All courses</option>
						{workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
					</select>
				</label>
				<span className="flex-1" />
				{(["list", "graph"] as const).map((v) => (
					<button key={v} type="button" onClick={() => setView(v)} className={cn(button, view === v && "bg-accent text-foreground")}>
						{v === "list" ? "List" : "Graph"}
					</button>
				))}
			</div>
			{error && <div role="alert" className="rounded-md border border-border px-3 py-2 text-sm">{error}</div>}
			{!data ? (
				<p className="text-sm text-muted-foreground">Loading…</p>
			) : (
				<>
					{suggestions.length > 0 && (
						<section className="flex flex-col gap-2">
							<h2 className="font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">Suggestions · {suggestions.length}</h2>
							{suggestions.map((edge) => (
								<EdgeRow key={edge.id} edge={edge} names={names} onAction={(body) => call(`/api/learner/bridges/${edge.id}`, "PATCH", body)} onDelete={() => call(`/api/learner/bridges/${edge.id}`, "DELETE")} />
							))}
						</section>
					)}
					{view === "graph" ? (
						<BridgeGraph concepts={data.concepts} edges={trusted} />
					) : (
						<section className="flex flex-col gap-2">
							<h2 className="font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">Your links · {trusted.length}</h2>
							{trusted.length === 0 && <p className="text-sm text-muted-foreground">No links yet — add one below, or confirm a suggestion.</p>}
							{trusted.map((edge) => (
								<EdgeRow key={edge.id} edge={edge} names={names} onAction={(body) => call(`/api/learner/bridges/${edge.id}`, "PATCH", body)} onDelete={() => call(`/api/learner/bridges/${edge.id}`, "DELETE")} />
							))}
						</section>
					)}
					<AddLink concepts={data.concepts} defaultCourse={course} onAdd={(body) => call("/api/learner/bridges", "POST", body)} />
				</>
			)}
		</div>
	);
}

function EdgeRow({ edge, names, onAction, onDelete }: { edge: LearnerEdge; names: Map<string, string>; onAction: (body: unknown) => Promise<boolean>; onDelete: () => void }) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState({ from: names.get(edge.from) ?? "", to: names.get(edge.to) ?? "", type: edge.type, wording: edge.wording ?? "" });
	const suggestion = edge.source === "extracted-unconfirmed";
	return (
		<div data-testid={suggestion ? "bridge-suggestion" : "bridge-edge"} className={cn("rounded-lg border px-3 py-2 text-sm", suggestion ? "border-dashed border-border" : "border-border")}>
			<div className="flex flex-wrap items-center gap-2">
				<span className="min-w-0 flex-1">
					<span className="text-foreground">{names.get(edge.from) ?? edge.from}</span>{" "}
					<span className="text-muted-foreground">{BRIDGE_TYPE_LABELS[edge.type]}</span>{" "}
					<span className="text-foreground">{names.get(edge.to) ?? edge.to}</span>
				</span>
				{suggestion && (
					<>
						<button type="button" data-testid="bridge-confirm" onClick={() => void onAction({ action: "confirm" })} className={button} aria-label="Confirm"><CheckIcon className="size-3.5" /></button>
						<button type="button" data-testid="bridge-reject" onClick={() => void onAction({ action: "reject" })} className={button} aria-label="Reject"><XIcon className="size-3.5" /></button>
					</>
				)}
				<button type="button" onClick={() => setEditing((v) => !v)} className={button} aria-label="Edit"><PencilIcon className="size-3.5" /></button>
				<button type="button" onClick={onDelete} className={button} aria-label="Delete"><Trash2Icon className="size-3.5" /></button>
			</div>
			<div className="mt-1 font-ui text-[11px] text-muted-foreground">
				{EDGE_SOURCE_LABELS[edge.source]} · confidence {Math.round(edge.confidence * 100)}% · {edge.evidence.length} evidence · {edge.updatedAt.slice(0, 10)}
				{edge.wording && <span className="block font-prose text-sm italic">“{edge.wording}”</span>}
			</div>
			{editing && (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						void onAction({ action: "edit", ...draft }).then((ok) => ok && setEditing(false));
					}}
					className="mt-2 flex flex-wrap gap-1.5"
				>
					<input value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} className={cn(input, "w-40")} aria-label="From concept" />
					<select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as BridgeType })} className={input} aria-label="Link type">
						{BRIDGE_TYPES.map((t) => <option key={t} value={t}>{BRIDGE_TYPE_LABELS[t]}</option>)}
					</select>
					<input value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} className={cn(input, "w-40")} aria-label="To concept" />
					<input value={draft.wording} onChange={(e) => setDraft({ ...draft, wording: e.target.value })} placeholder="In your words (optional)" className={cn(input, "min-w-48 flex-1")} />
					<button type="submit" className={button}>Save (keeps the old link as replaced)</button>
				</form>
			)}
		</div>
	);
}

function AddLink({ concepts, defaultCourse, onAdd }: { concepts: LearnerConcept[]; defaultCourse: string; onAdd: (body: unknown) => Promise<boolean> }) {
	const [draft, setDraft] = useState({ from: "", to: "", type: "understood-through" as BridgeType, wording: "" });
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				if (!draft.from.trim() || !draft.to.trim()) return;
				void onAdd({ ...draft, ...(defaultCourse ? { workspaceId: defaultCourse } : {}) }).then((ok) => ok && setDraft({ from: "", to: "", type: draft.type, wording: "" }));
			}}
			className="flex flex-col gap-1.5 rounded-lg border border-border p-3"
		>
			<h2 className="font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">Add a link</h2>
			<datalist id="learner-concepts">{concepts.map((c) => <option key={c.id} value={c.label} />)}</datalist>
			<div className="flex flex-wrap gap-1.5">
				<input list="learner-concepts" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} placeholder="A concept you know (e.g. Markov chain steady state)" className={cn(input, "min-w-56 flex-1")} />
				<select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as BridgeType })} className={input}>
					{BRIDGE_TYPES.map((t) => <option key={t} value={t}>{BRIDGE_TYPE_LABELS[t]}</option>)}
				</select>
				<input list="learner-concepts" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} placeholder="A concept it explains (e.g. eigenvectors)" className={cn(input, "min-w-56 flex-1")} />
			</div>
			<input value={draft.wording} onChange={(e) => setDraft({ ...draft, wording: e.target.value })} placeholder="How you would put the link in your own words (optional)" className={input} />
			<button type="submit" className={cn(button, "w-fit")}>Add link</button>
		</form>
	);
}

/** A simple circular graph of the trusted links (no physics — readable at a glance). */
export function BridgeGraph({ concepts, edges }: { concepts: LearnerConcept[]; edges: LearnerEdge[] }) {
	const used = concepts.filter((c) => edges.some((e) => e.from === c.id || e.to === c.id));
	if (used.length === 0) return <p className="text-sm text-muted-foreground">No trusted links to draw yet.</p>;
	const size = 520;
	const r = size / 2 - 90;
	const pos = new Map(used.map((c, i) => {
		const a = (2 * Math.PI * i) / used.length - Math.PI / 2;
		return [c.id, { x: size / 2 + r * Math.cos(a), y: size / 2 + r * Math.sin(a) }];
	}));
	return (
		<svg data-testid="bridge-graph" viewBox={`0 0 ${size} ${size}`} className="mx-auto w-full max-w-[520px] text-foreground" role="img" aria-label="Concept links graph">
			<defs>
				<marker id="lh-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
					<path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" opacity="0.5" />
				</marker>
			</defs>
			{edges.map((e) => {
				const a = pos.get(e.from);
				const b = pos.get(e.to);
				if (!a || !b) return null;
				return (
					<g key={e.id}>
						<line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="currentColor" strokeOpacity={0.35} strokeWidth={1.5} markerEnd="url(#lh-arrow)" />
						<text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 4} textAnchor="middle" fontSize={10} fill="currentColor" opacity={0.6}>{e.type}</text>
					</g>
				);
			})}
			{used.map((c) => {
				const p = pos.get(c.id)!;
				return (
					<g key={c.id}>
						<circle cx={p.x} cy={p.y} r={5} fill="currentColor" />
						<text x={p.x} y={p.y + 18} textAnchor="middle" fontSize={12} fill="currentColor">{c.label.length > 28 ? `${c.label.slice(0, 27)}…` : c.label}</text>
					</g>
				);
			})}
		</svg>
	);
}
