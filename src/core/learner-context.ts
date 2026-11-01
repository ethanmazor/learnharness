/**
 * THE LEARNER-CONTEXT SUMMARY (PLAN.md Phase 3, owner decision D2): a short,
 * token-budgeted block of the ACTIVE traits (course overrides applied) and
 * the learner's most recent relevant feedback, handed to the Teacher,
 * Prober and Practitioner as a `learner-context` transcript marker. The
 * marker is appended at the session's first turn and again only when the
 * FINGERPRINT (the active values — not their confidences, not new
 * feedback) changes, so the transcript only grows and prompt caching holds.
 * Pure.
 */

import {
	FEEDBACK_TAG_LABELS,
	FEEDBACK_TYPE_LABELS,
	LIST_TRAITS,
	SCALAR_TRAITS,
	TRAIT_LABELS,
	type FeedbackItem,
	type LearnerProfile,
} from "./contracts/learner.ts";
import { effectiveScalar } from "./learner-profile.ts";

const LIST_ITEM_CAP = 6;
const FEEDBACK_CHARS = 220;

export interface LearnerContext {
	text: string;
	fingerprint: string;
}

/** FNV-1a (32-bit) — a stable, dependency-free fingerprint. */
export function fingerprintOf(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function clip(text: string, max: number): string {
	const t = text.replace(/\s+/g, " ").trim();
	return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** The active-trait lines plus their fingerprint (null when nothing is
 *  active yet). */
function traitLines(profile: LearnerProfile, workspaceId: string): { lines: string[]; identity: string[] } {
	const lines: string[] = [];
	const identity: string[] = [];
	for (const key of SCALAR_TRAITS) {
		const v = effectiveScalar(profile, key, workspaceId);
		if (!v) continue;
		lines.push(`- ${TRAIT_LABELS[key]}: ${v.value}${v.override ? " (for this course)" : ""}`);
		identity.push(`${key}=${v.value}`);
	}
	for (const key of LIST_TRAITS) {
		const items = profile.lists[key].items.filter((i) => i.status === "active").slice(0, LIST_ITEM_CAP);
		if (items.length === 0) continue;
		lines.push(`- ${TRAIT_LABELS[key]}: ${items.map((i) => i.value).join("; ")}`);
		identity.push(`${key}=${items.map((i) => i.value.toLowerCase()).join("|")}`);
	}
	return { lines, identity };
}

function feedbackLine(item: FeedbackItem): string {
	const parts: string[] = [];
	if (item.tags.length > 0) parts.push(item.tags.map((t) => FEEDBACK_TAG_LABELS[t]).join(", "));
	if (item.quote) parts.push(`lost at “${clip(item.quote.text, 80)}”`);
	if (item.text) parts.push(`${FEEDBACK_TYPE_LABELS[item.type]}: “${clip(item.text, FEEDBACK_CHARS)}”`);
	return `- ${parts.join(" — ")}`;
}

/**
 * Render the summary for one chat. `recentFeedback` is newest-first and
 * already filtered to the relevant scope (same chat first, then same
 * course). Lines are dropped from the end (oldest feedback first, then the
 * list traits) until the text fits `budgetTokens` (≈ 4 chars per token).
 */
export function renderLearnerContext(
	profile: LearnerProfile | null,
	workspaceId: string,
	recentFeedback: readonly FeedbackItem[],
	opts: { budgetTokens: number; feedbackItems: number },
): LearnerContext | null {
	const { lines, identity } = profile ? traitLines(profile, workspaceId) : { lines: [], identity: [] };
	const feedback = recentFeedback.slice(0, opts.feedbackItems).map(feedbackLine);
	if (lines.length === 0 && feedback.length === 0) return null;
	const header = "[How this learner learns — inferred from their own reasoning and feedback; use it to choose the structure, order, step size and format of your explanations]";
	const body = [...lines];
	const fb = feedback.length > 0 ? ["", "Their recent feedback on explanations:", ...feedback] : [];
	const budget = opts.budgetTokens * 4;
	let all = [header, ...body, ...fb];
	while (all.join("\n").length > budget && all.length > 1) all = all.slice(0, -1);
	if (all.at(-1) === "Their recent feedback on explanations:" || all.at(-1) === "") all = all.slice(0, all.at(-1) === "" ? -1 : -2);
	const text = all.join("\n");
	// The fingerprint follows the ACTIVE VALUES only (decision D2): new
	// feedback reaches the chat through its own markers, not a refresh.
	return { text, fingerprint: fingerprintOf(identity.join("\n") || "feedback-only") };
}
