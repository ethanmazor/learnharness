"use client";

import { useState } from "react";
import { ChevronRightIcon, MessageSquareQuoteIcon, PencilIcon, Trash2Icon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
	FEEDBACK_TAG_LABELS,
	FEEDBACK_TAGS,
	FEEDBACK_TYPE_LABELS,
	type FeedbackItem,
	type FeedbackQuote,
	type FeedbackTag,
	type FeedbackType,
} from "@/src/core";

/**
 * PER-RESPONSE FEEDBACK (PLAN.md Phase 2): a collapsed "Feedback" disclosure
 * under every agent response. Inside: quick tags, "How I would say it",
 * "How I read this", and "This part lost me" (capture a selected span of
 * the response, plus an optional note). Plain textareas, so system
 * dictation (Wispr Flow and the like) types straight into them. One submit
 * saves one item per filled field (tags ride the first item, or stand alone).
 *
 * Feedback is stored in learner/feedback.jsonl and handed to the agent on
 * the learner's next turn. Submitted items list below with edit/delete.
 */

/** The text selection inside one response, as a quote — or null when the
 *  selection is empty or outside the response (pure over the DOM nodes). */
export function quoteFromSelection(selection: Selection | null, response: HTMLElement | null): FeedbackQuote | null {
	if (!selection || selection.isCollapsed || !response) return null;
	const text = selection.toString().replace(/\s+/g, " ").trim();
	const anchor = selection.anchorNode;
	if (!text || !anchor || !response.contains(anchor)) return null;
	const element = anchor instanceof Element ? anchor : anchor.parentElement;
	const source = element?.closest("[data-source-message-id]")?.getAttribute("data-source-message-id");
	const fallback = response.getAttribute("data-response-id");
	const sourceMessageId = source ?? fallback;
	return sourceMessageId ? { text: text.slice(0, 2000), sourceMessageId } : null;
}

/** The submit payloads for one filled form (pure — tests pin it). */
export function feedbackPayloads(form: {
	tags: FeedbackTag[];
	rewrite: string;
	reading: string;
	lostQuote: FeedbackQuote | null;
	lostNote: string;
}): Array<{ type: FeedbackType; text?: string; quote?: FeedbackQuote; tags: FeedbackTag[] }> {
	const out: Array<{ type: FeedbackType; text?: string; quote?: FeedbackQuote; tags: FeedbackTag[] }> = [];
	if (form.rewrite.trim()) out.push({ type: "rewrite", text: form.rewrite.trim(), tags: [] });
	if (form.reading.trim()) out.push({ type: "reading", text: form.reading.trim(), tags: [] });
	if (form.lostQuote || form.lostNote.trim()) {
		out.push({ type: "lost", ...(form.lostNote.trim() ? { text: form.lostNote.trim() } : {}), ...(form.lostQuote ? { quote: form.lostQuote } : {}), tags: [] });
	}
	if (form.tags.length > 0) {
		if (out.length > 0) out[0]!.tags = form.tags;
		else out.push({ type: "tags", tags: form.tags });
	}
	return out;
}

const label = "font-ui text-[11px] font-medium uppercase tracking-wide text-muted-foreground";
const field = "lh-input w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 font-prose text-sm text-foreground outline-none";

export function FeedbackBox({
	chatId,
	messageId,
	messageIds,
	items,
	onChanged,
	onPushToStack,
}: {
	chatId: string;
	/** The response group's id (its first native assistant message). */
	messageId: string;
	messageIds: string[];
	/** This response's live feedback items. */
	items: FeedbackItem[];
	/** Refetch after a write (the learner-changed event also arrives). */
	onChanged: () => void;
	/** Phase 4: push a "lost me" item onto the learning stack. */
	onPushToStack?: (item: FeedbackItem) => void;
}) {
	const [open, setOpen] = useState(false);
	const [tags, setTags] = useState<FeedbackTag[]>([]);
	const [rewrite, setRewrite] = useState("");
	const [reading, setReading] = useState("");
	const [lostQuote, setLostQuote] = useState<FeedbackQuote | null>(null);
	const [lostNote, setLostNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [hint, setHint] = useState<string | null>(null);
	const [boxEl, setBoxEl] = useState<HTMLDivElement | null>(null);

	const payloads = feedbackPayloads({ tags, rewrite, reading, lostQuote, lostNote });

	const reset = () => {
		setTags([]);
		setRewrite("");
		setReading("");
		setLostQuote(null);
		setLostNote("");
		setHint(null);
	};

	const submit = async () => {
		if (busy || payloads.length === 0) return;
		setBusy(true);
		setError(null);
		try {
			for (const payload of payloads) {
				const res = await fetch("/api/learner/feedback", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ chatId, messageId, messageIds, ...payload }),
				});
				if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Could not save (${res.status})`);
			}
			reset();
			setOpen(false);
			onChanged();
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(false);
		}
	};

	const captureSelection = () => {
		const response = boxEl?.closest<HTMLElement>("[data-response-id]") ?? null;
		const quote = quoteFromSelection(window.getSelection(), response);
		if (quote) {
			setLostQuote(quote);
			setHint(null);
		} else {
			setHint("Select the confusing part of this response first, then click again.");
		}
	};

	return (
		<div ref={setBoxEl} data-testid="feedback-box" className="mt-1 font-ui text-xs">
			<div className="flex flex-wrap items-center gap-2">
				<button
					type="button"
					data-testid="feedback-toggle"
					onClick={() => setOpen((v) => !v)}
					aria-expanded={open}
					className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
				>
					<ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
					Feedback
					{items.length > 0 && <span className="text-muted-foreground">· {items.length}</span>}
				</button>
			</div>
			{open && (
				<div className="mt-2 flex flex-col gap-3 rounded-lg border border-border/60 bg-card/50 p-3">
					<div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick tags">
						{FEEDBACK_TAGS.map((tag) => {
							const on = tags.includes(tag);
							return (
								<button
									key={tag}
									type="button"
									data-testid={`feedback-tag-${tag}`}
									aria-pressed={on}
									onClick={() => setTags((prev) => (on ? prev.filter((t) => t !== tag) : [...prev, tag]))}
									className={cn(
										"rounded-full border px-2 py-0.5 transition-colors",
										on ? "border-foreground/60 bg-accent text-foreground" : "border-border text-muted-foreground hover:text-foreground",
									)}
								>
									{FEEDBACK_TAG_LABELS[tag]}
								</button>
							);
						})}
					</div>
					<label className="flex flex-col gap-1">
						<span className={label}>{FEEDBACK_TYPE_LABELS.rewrite}</span>
						<textarea data-testid="feedback-rewrite" rows={3} value={rewrite} onChange={(e) => setRewrite(e.target.value)} placeholder="Explain it the way you would — your order, your steps." className={field} />
					</label>
					<label className="flex flex-col gap-1">
						<span className={label}>{FEEDBACK_TYPE_LABELS.reading}</span>
						<textarea data-testid="feedback-reading" rows={2} value={reading} onChange={(e) => setReading(e.target.value)} placeholder="What you took this to mean." className={field} />
					</label>
					<div className="flex flex-col gap-1">
						<span className={label}>{FEEDBACK_TYPE_LABELS.lost}</span>
						{lostQuote ? (
							<div className="flex items-start gap-2 rounded-md border-l-2 border-muted-foreground/40 bg-background px-2 py-1">
								<span data-testid="feedback-quote" className="min-w-0 flex-1 font-prose text-sm italic text-foreground">“{lostQuote.text}”</span>
								<button type="button" aria-label="Remove quote" onClick={() => setLostQuote(null)} className="text-muted-foreground hover:text-foreground">
									<XIcon className="size-3.5" />
								</button>
							</div>
						) : (
							<button
								type="button"
								data-testid="feedback-capture"
								// mousedown + preventDefault: the click must not clear the
								// learner's text selection before it is read.
								onMouseDown={(e) => {
									e.preventDefault();
									captureSelection();
								}}
								className="flex w-fit items-center gap-1 rounded-md border border-dashed border-border px-2 py-1 text-muted-foreground hover:text-foreground"
							>
								<MessageSquareQuoteIcon className="size-3.5" />
								Use selected text from this response
							</button>
						)}
						{hint && <span className="text-muted-foreground">{hint}</span>}
						<textarea data-testid="feedback-lost-note" rows={2} value={lostNote} onChange={(e) => setLostNote(e.target.value)} placeholder="Optional: what about it lost you?" className={field} />
					</div>
					{error && <div role="alert" className="text-foreground">{error}</div>}
					<div className="flex justify-end gap-2">
						<button type="button" onClick={() => { reset(); setOpen(false); }} className="rounded-sm px-3 py-1.5 text-muted-foreground hover:text-foreground">
							Cancel
						</button>
						<button
							type="button"
							data-testid="feedback-submit"
							disabled={busy || payloads.length === 0}
							onClick={() => void submit()}
							className="rounded-sm border border-border px-3 py-1.5 text-foreground hover:bg-accent disabled:opacity-40"
						>
							{busy ? "Saving…" : "Save feedback"}
						</button>
					</div>
				</div>
			)}
			{items.length > 0 && (
				<ul className="mt-1.5 flex flex-col gap-1" data-testid="feedback-items">
					{items.map((item) => (
						<FeedbackItemRow key={item.id} item={item} onChanged={onChanged} onPushToStack={onPushToStack} />
					))}
				</ul>
			)}
		</div>
	);
}

/** One saved item: summary line, inline edit of its text, delete. */
export function FeedbackItemRow({ item, onChanged, onPushToStack }: { item: FeedbackItem; onChanged: () => void; onPushToStack?: (item: FeedbackItem) => void }) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(item.text ?? "");
	const [error, setError] = useState<string | null>(null);
	const save = async () => {
		const res = await fetch(`/api/learner/feedback/${encodeURIComponent(item.id)}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: draft }),
		});
		if (!res.ok) return setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not save");
		setEditing(false);
		setError(null);
		onChanged();
	};
	const remove = async () => {
		const res = await fetch(`/api/learner/feedback/${encodeURIComponent(item.id)}`, { method: "DELETE" });
		if (res.ok) onChanged();
	};
	return (
		<li data-testid="feedback-item" className="rounded-md border border-border/50 px-2 py-1.5">
			<div className="flex items-start gap-2">
				<span className="min-w-0 flex-1 text-muted-foreground">
					<span className="text-foreground">{FEEDBACK_TYPE_LABELS[item.type]}</span>
					{item.tags.length > 0 && <> · {item.tags.map((t) => FEEDBACK_TAG_LABELS[t]).join(", ")}</>}
					{item.quote && <span className="block font-prose italic">“{item.quote.text}”</span>}
					{item.text && !editing && <span className="block whitespace-pre-wrap font-prose text-sm text-foreground">{item.text}</span>}
				</span>
				{item.type === "lost" && onPushToStack && (
					<button type="button" data-testid="feedback-push-stack" onClick={() => onPushToStack(item)} className="shrink-0 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
						Learn this first
					</button>
				)}
				{item.type !== "tags" && (
					<button type="button" aria-label="Edit feedback" onClick={() => { setDraft(item.text ?? ""); setEditing((v) => !v); }} className="shrink-0 text-muted-foreground hover:text-foreground">
						<PencilIcon className="size-3.5" />
					</button>
				)}
				<button type="button" aria-label="Delete feedback" data-testid="feedback-delete" onClick={() => void remove()} className="shrink-0 text-muted-foreground hover:text-foreground">
					<Trash2Icon className="size-3.5" />
				</button>
			</div>
			{editing && (
				<div className="mt-1.5 flex flex-col gap-1.5">
					<textarea rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} className={field} />
					{error && <span role="alert" className="text-foreground">{error}</span>}
					<div className="flex justify-end gap-2">
						<button type="button" onClick={() => setEditing(false)} className="px-2 py-1 text-muted-foreground hover:text-foreground">Cancel</button>
						<button type="button" onClick={() => void save()} className="rounded-sm border border-border px-2 py-1 text-foreground hover:bg-accent">Save</button>
					</div>
				</div>
			)}
		</li>
	);
}
