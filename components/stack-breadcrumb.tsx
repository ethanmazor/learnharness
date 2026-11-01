"use client";

import { ChevronRightIcon, LayersIcon, XIcon } from "lucide-react";
import { ROOT_LABEL, type StackFrame } from "@/src/core";

/**
 * THE LEARNING-STACK BREADCRUMB (PLAN.md Phase 4): Original problem ›
 * Assumption A › Sub-assumption B, above the composer while the stack is
 * non-empty. A crumb jumps back to that level (closing everything above);
 * × closes the top level. Each action starts a turn so the agent resumes.
 */
export function StackBreadcrumb({
	frames,
	disabled,
	notice,
	onJump,
	onClose,
}: {
	frames: readonly StackFrame[];
	disabled: boolean;
	notice?: string | null;
	onJump: (frameId: string | "root") => void;
	onClose: (frameId: string) => void;
}) {
	if (frames.length === 0 && !notice) return null;
	const crumb = "max-w-[16rem] truncate rounded px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none";
	return (
		<div data-testid="stack-breadcrumb" className="pointer-events-auto mb-2 flex flex-col items-center gap-1">
			{frames.length > 0 && (
				<nav aria-label="Learning stack" className="flex max-w-full flex-wrap items-center gap-0.5 rounded-md border border-border bg-card px-2 py-1 font-ui text-xs text-muted-foreground">
					<LayersIcon className="mr-1 size-3.5 shrink-0" />
					<button type="button" disabled={disabled} onClick={() => onJump("root")} className={crumb} title="Jump back to the original problem">
						{ROOT_LABEL}
					</button>
					{frames.map((frame, i) => {
						const last = i === frames.length - 1;
						return (
							<span key={frame.id} className="flex items-center gap-0.5">
								<ChevronRightIcon className="size-3 shrink-0" />
								{last ? (
									<span className="max-w-[16rem] truncate px-1.5 py-0.5 text-foreground" title={frame.statement || frame.label}>{frame.label}</span>
								) : (
									<button type="button" disabled={disabled} onClick={() => onJump(frame.id)} className={crumb} title={`Jump back to “${frame.label}”`}>
										{frame.label}
									</button>
								)}
								{last && (
									<button type="button" data-testid="stack-close" disabled={disabled} onClick={() => onClose(frame.id)} aria-label={`Close “${frame.label}”`} title="Close this level" className="rounded p-0.5 hover:bg-accent hover:text-foreground disabled:opacity-40">
										<XIcon className="size-3" />
									</button>
								)}
							</span>
						);
					})}
				</nav>
			)}
			{notice && <span role="status" className="font-ui text-xs text-muted-foreground">{notice}</span>}
		</div>
	);
}
