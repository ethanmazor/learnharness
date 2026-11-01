/**
 * The reasoning-trace extractor's INPUTS (PLAN.md Phase 3, owner decision
 * D4): every learner channel in a chat record — answers, the question
 * thinking field, the reading-thinking field, practice thinking
 * submissions, and composer messages (typed or dictated) — each paired with
 * the assistant prose it reacted to. Pure; the server diffs these against
 * the traces ledger by `key` (an input is traced at most once, and a
 * deleted trace's tombstone keeps its key so it is never re-traced).
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { EvidenceKind, FeedbackItem, LearnerInput } from "./contracts/learner.ts";
import { FEEDBACK_TAG_LABELS, FEEDBACK_TYPE_LABELS } from "./contracts/learner.ts";
import { userFacingTextOf, type LhMarkerMessage, type LhMessage } from "./native-messages.ts";
import { QUESTION_TOOLS } from "./pending.ts";
import type { QuestionAnswerData } from "./question-core.ts";

/** Context window of the reacted-to explanation handed to the extractor. */
const CONTEXT_CHARS = 1500;

function wordCount(text: string): number {
	return text.trim().split(/\s+/).filter(Boolean).length;
}

/** The skip rule: thinking channels need a few words; answers and
 *  composer messages need enough to show a path (a bare "B" or "ok" holds
 *  no reasoning). */
export function worthTracing(kind: EvidenceKind, text: string): boolean {
	const words = wordCount(text);
	if (kind === "thinking" || kind === "readingThinking" || kind === "practiceThinking" || kind === "feedback") return words >= 4;
	return words >= 15;
}

function clip(text: string, max = CONTEXT_CHARS): string {
	return text.length <= max ? text : `…${text.slice(text.length - max)}`;
}

function answerText(answer: QuestionAnswerData): string {
	if (answer.dontKnow) return "";
	const parts: string[] = [];
	if (answer.text) parts.push(answer.text);
	if (answer.other) parts.push(answer.other);
	const chosen = answer.answers?.map((a) => (a as { label?: string }).label).filter((l): l is string => typeof l === "string") ?? [];
	if (chosen.length > 0) parts.push(`Chose: ${chosen.join("; ")}`);
	return parts.join("\n");
}

/** Every learner input in the record, oldest first (unfiltered by the
 *  skip rule — callers apply worthTracing). */
export function learnerInputsOf(messages: readonly LhMessage[]): LearnerInput[] {
	const out: LearnerInput[] = [];
	let lastAssistant: { id: string; prose: string } | null = null;
	const push = (messageId: string, kind: EvidenceKind, text: string | undefined) => {
		const t = text?.trim();
		if (!t) return;
		out.push({
			key: `${messageId}:${kind}`,
			messageId,
			kind,
			text: t,
			...(lastAssistant ? { respondingTo: lastAssistant.id, context: clip(lastAssistant.prose) } : {}),
		});
	};
	for (const m of messages) {
		if (m.role === "assistant") {
			const prose = userFacingTextOf((m as AssistantMessage).content).join("\n\n");
			if (prose.trim()) lastAssistant = { id: m.id, prose };
			continue;
		}
		if (m.role === "user") {
			const content = m.content;
			const text = typeof content === "string" ? content : content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
			push(m.id, "composer", text);
			continue;
		}
		if (m.role === "toolResult") {
			const result = m as ToolResultMessage & { id: string };
			if (!(QUESTION_TOOLS as readonly string[]).includes(result.toolName) || result.isError) continue;
			const answer = result.details as QuestionAnswerData | null | undefined;
			if (!answer || typeof answer !== "object" || answer.dismissed) continue;
			// The question the learner answered is the context they reacted to.
			const question = typeof answer.questionText === "string" ? answer.questionText : "";
			const saved = lastAssistant;
			if (question) lastAssistant = { id: saved?.id ?? result.id, prose: `${saved?.prose ? `${saved.prose}\n\n` : ""}Question: ${question}` };
			push(result.id, "answer", answerText(answer));
			push(result.id, "thinking", answer.thinking ?? answer.note);
			push(result.id, "readingThinking", answer.readingThinking);
			lastAssistant = saved;
			continue;
		}
		if (m.role === "custom") {
			const marker = m as LhMarkerMessage;
			if (marker.customType === "practice-thinking") push(m.id, "practiceThinking", (marker.details as { text?: string } | null)?.text);
		}
	}
	return out;
}

/** A feedback item as an extractor input (the strongest evidence). */
export function feedbackInput(item: FeedbackItem, context?: string): LearnerInput {
	const lines: string[] = [];
	if (item.tags.length > 0) lines.push(`Tags: ${item.tags.map((t) => FEEDBACK_TAG_LABELS[t]).join(", ")}`);
	if (item.quote) lines.push(`Quoted part: "${item.quote.text}"`);
	if (item.text) lines.push(`${FEEDBACK_TYPE_LABELS[item.type]}: ${item.text}`);
	return {
		key: `fb:${item.id}`,
		messageId: item.messageId,
		kind: "feedback",
		feedbackId: item.id,
		text: lines.join("\n"),
		respondingTo: item.messageId,
		...(context ? { context: clip(context) } : {}),
	};
}

/** The prose of one assistant message (feedback context). */
export function assistantProse(messages: readonly LhMessage[], messageIds: readonly string[]): string {
	const wanted = new Set(messageIds);
	return messages
		.filter((m) => m.role === "assistant" && wanted.has(m.id))
		.map((m) => userFacingTextOf((m as AssistantMessage).content).join("\n\n"))
		.join("\n\n");
}
