"use client";

import { useState } from "react";
import { BrainIcon, ChevronRightIcon, LayersIcon, MessageSquareQuoteIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The learner layer's transcript lines (PLAN.md Phases 2–4): compact,
 * collapsible system lines for the markers the agent reads — feedback the
 * learner gave, the learner-profile summary applied to the session, and
 * learning-stack changes. Expanding shows exactly the text the agent got.
 */

export interface LearnerMarkerData {
	content: string;
	[key: string]: unknown;
}

const TITLES = {
	"data-learner-feedback": { icon: MessageSquareQuoteIcon, title: "Your feedback — the agent reads this next turn" },
	"data-learner-context": { icon: BrainIcon, title: "How you learn — applied to this session" },
	"data-learning-stack": { icon: LayersIcon, title: "Learning stack" },
} as const;

export type LearnerMarkerPart = keyof typeof TITLES;

export function isLearnerMarkerPart(type: string): type is LearnerMarkerPart {
	return type in TITLES;
}

export function LearnerMarkerLine({ type, data }: { type: LearnerMarkerPart; data: LearnerMarkerData }) {
	const [open, setOpen] = useState(false);
	const { icon: Icon, title } = TITLES[type];
	const summary = type === "data-learning-stack" && typeof data.summary === "string" ? data.summary : title;
	return (
		<div data-testid={`marker-${type.slice(5)}`} className="my-1 font-ui text-xs text-muted-foreground">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
				className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-foreground"
			>
				<ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
				<Icon className="size-3.5" />
				<span className="uppercase tracking-wide">{summary}</span>
			</button>
			{open && (
				<pre className="mt-1 whitespace-pre-wrap rounded-md border border-border/50 bg-card/50 px-3 py-2 font-prose text-sm text-foreground">
					{data.content}
				</pre>
			)}
		</div>
	);
}
