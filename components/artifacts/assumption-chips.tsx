"use client";

import { useState } from "react";
import { ChevronRightIcon, LayersIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ArtifactPartProps } from "@/src/core";

/**
 * EXPLICIT ASSUMPTIONS (PLAN.md Phase 4): the Teacher's `assumptions` call
 * renders as chips under its message. A chip opens its statement and an
 * "I don't get this" action, which pushes it onto the learning stack (the
 * chat listens for lh:stack-push and sends the stack input). When the
 * learner reasoned first, "Your path vs. mine" shows the diff.
 */

interface AssumptionsInput {
	items?: Array<{ id: string; label: string; statement: string; kind: "assumption" | "prerequisite" }>;
	diff?: { usedNotByLearner: string[]; divergence: Array<{ learnerStep: string; myStep: string; note: string }> };
}

export function pushToStack(detail: { label: string; statement?: string; origin: { kind: "chip" | "feedback"; ref?: string } }): void {
	window.dispatchEvent(new CustomEvent("lh:stack-push", { detail }));
}

export function AssumptionChips({ part }: ArtifactPartProps) {
	const input = (part.input ?? {}) as AssumptionsInput;
	const items = Array.isArray(input.items) ? input.items : [];
	const [openId, setOpenId] = useState<string | null>(null);
	const [diffOpen, setDiffOpen] = useState(false);
	if (items.length === 0) return null;
	const unused = new Set(input.diff?.usedNotByLearner ?? []);
	const open = items.find((i) => i.id === openId);
	return (
		<div data-testid="assumption-chips" className="my-2 font-ui text-xs">
			<div className="flex flex-wrap items-center gap-1.5">
				<span className="uppercase tracking-wide text-muted-foreground">Assumes</span>
				{items.map((item) => (
					<button
						key={item.id}
						type="button"
						data-testid="assumption-chip"
						onClick={() => setOpenId(openId === item.id ? null : item.id)}
						aria-expanded={openId === item.id}
						title={item.statement}
						className={cn(
							"rounded-full border px-2 py-0.5 transition-colors hover:bg-accent",
							openId === item.id ? "border-foreground/60 text-foreground" : "border-border text-muted-foreground",
							unused.has(item.id) && "border-dashed",
						)}
					>
						{item.kind === "prerequisite" ? "◆ " : ""}
						{item.label}
					</button>
				))}
			</div>
			{open && (
				<div className="mt-1.5 flex flex-wrap items-start gap-2 rounded-md border border-border/60 bg-card/50 px-3 py-2">
					<span className="min-w-0 flex-1 font-prose text-sm text-foreground">{open.statement}</span>
					<button
						type="button"
						data-testid="assumption-dont-get"
						onClick={() => {
							pushToStack({ label: open.label, statement: open.statement, origin: { kind: "chip", ref: `${part.toolCallId}:${open.id}` } });
							setOpenId(null);
						}}
						className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-foreground hover:bg-accent"
					>
						<LayersIcon className="size-3.5" />
						I don&apos;t get this — learn it first
					</button>
				</div>
			)}
			{input.diff && (input.diff.divergence.length > 0 || unused.size > 0) && (
				<div className="mt-1.5">
					<button type="button" onClick={() => setDiffOpen((v) => !v)} aria-expanded={diffOpen} className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
						<ChevronRightIcon className={cn("size-3 transition-transform", diffOpen && "rotate-90")} />
						Your path vs. mine
					</button>
					{diffOpen && (
						<div className="mt-1 flex flex-col gap-1 rounded-md border border-border/60 bg-card/50 px-3 py-2 font-prose text-sm">
							{unused.size > 0 && (
								<p><span className="text-muted-foreground">I used, you didn&apos;t:</span> {items.filter((i) => unused.has(i.id)).map((i) => i.label).join("; ")}</p>
							)}
							{input.diff.divergence.map((d, i) => (
								<p key={i}>
									<span className="text-muted-foreground">You:</span> {d.learnerStep} · <span className="text-muted-foreground">Me:</span> {d.myStep}
									{d.note && <span className="text-muted-foreground"> — {d.note}</span>}
								</p>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

/** The Teacher's own stack moves: a quiet one-liner. */
export function StackToolLine({ part }: ArtifactPartProps) {
	const input = (part.input ?? {}) as { label?: string; evidence?: string };
	const push = part.type === "tool-stack_push";
	if (part.state === "output-error") return null;
	return (
		<div data-testid={push ? "stack-push-line" : "stack-pop-line"} className="my-1 flex items-center gap-1.5 font-ui text-xs uppercase tracking-wide text-muted-foreground">
			<LayersIcon className="size-3.5" />
			{push ? `Learning first: ${input.label ?? ""}` : "Understood — back up one level"}
		</div>
	);
}
