/**
 * The learner layer's server service (PLAN.md Phases 2–5). Phase 2:
 * per-response feedback — stored globally in learner/feedback.jsonl and,
 * by owner decision D3, ALSO handed to the chat's agent as a quiet
 * `learner-feedback` marker that the agent reads on the learner's next turn
 * (feedback never starts a turn by itself).
 *
 * Marker placement law: a marker may enter the record directly only while
 * the chat is idle and its record ends cleanly (a successful assistant
 * message or a marker) — never between a question call and its answer,
 * never over an owed continuation or a failed tail awaiting Retry.
 * Otherwise it waits (delivery is DERIVED: a feedback item is delivered once
 * the chat holds a marker naming it) and rides the learner's next input.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	feedbackMarkerText,
	foldRevisions,
	LearnerInputError,
	parseFeedbackInput,
	parseFeedbackPatch,
	type FeedbackItem,
	type FeedbackLine,
} from "../core/contracts/learner.ts";
import { deliveredFeedbackIds, hasUnresolvedQuestion, newLearnerFeedbackMessage, type LhMarkerMessage, type LhMessage } from "../core/native-messages.ts";
import { emit } from "../core/events.ts";
import { compactionInFlight } from "./compaction.ts";
import { stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";

export { LearnerInputError };

/** Hooks later phases register (the profile and the trace extractor
 *  react to feedback). */
type FeedbackChange = "created" | "updated" | "deleted";
const feedbackListeners: Array<(item: FeedbackItem | null, change: FeedbackChange) => void> = [];
export function onFeedbackChanged(listener: (item: FeedbackItem | null, change: FeedbackChange) => void): void {
	feedbackListeners.push(listener);
}
function notifyFeedback(item: FeedbackItem | null, change: FeedbackChange): void {
	for (const listener of feedbackListeners) {
		try {
			listener(item, change);
		} catch (err) {
			console.error(`[learner] feedback listener failed (${change}):`, err);
		}
	}
}

export function listFeedback(filter: { chatId?: string; workspaceId?: string } = {}): FeedbackItem[] {
	return foldRevisions<FeedbackItem>(stores.learnerStore.readLines("feedback") as unknown as FeedbackLine[]).filter(
		(item) => (!filter.chatId || item.chatId === filter.chatId) && (!filter.workspaceId || item.workspaceId === filter.workspaceId),
	);
}

function getFeedback(id: string): FeedbackItem | null {
	return listFeedback().find((item) => item.id === id) ?? null;
}

function assistantIds(messages: readonly LhMessage[]): Set<string> {
	return new Set(messages.filter((m) => m.role === "assistant").map((m) => m.id));
}

export function submitFeedback(raw: unknown): FeedbackItem {
	const input = parseFeedbackInput(raw);
	const record = stores.chatStore.getChat(input.chatId);
	const workspaceId = stores.workspaceStore.workspaceOfChat(input.chatId);
	if (!record || !workspaceId) throw new LearnerInputError("Unknown chat");
	const ids = assistantIds(record.messages);
	if (!ids.has(input.messageId)) throw new LearnerInputError("Feedback must target an agent response in this chat");
	const now = new Date().toISOString();
	const item: FeedbackItem = {
		id: `fb_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		rev: 1,
		workspaceId,
		chatId: input.chatId,
		messageId: input.messageId,
		messageIds: input.messageIds.filter((id) => ids.has(id)),
		type: input.type,
		...(input.text ? { text: input.text } : {}),
		...(input.quote ? { quote: input.quote } : {}),
		tags: input.tags,
		createdAt: now,
		updatedAt: now,
	};
	stores.learnerStore.appendLine("feedback", item);
	deliverFeedbackIfIdle(input.chatId);
	notifyFeedback(item, "created");
	emit("learner-changed", { chatId: input.chatId });
	return item;
}

export function updateFeedback(id: string, raw: unknown): FeedbackItem {
	const current = getFeedback(id);
	if (!current) throw new LearnerInputError("No such feedback");
	const patch = parseFeedbackPatch(raw, current);
	const next: FeedbackItem = { ...current, ...patch, rev: current.rev + 1, updatedAt: new Date().toISOString() };
	if (!next.text) delete next.text;
	if (!next.quote) delete next.quote;
	stores.learnerStore.appendLine("feedback", next);
	notifyFeedback(next, "updated");
	emit("learner-changed", { chatId: current.chatId });
	return next;
}

export function deleteFeedback(id: string): void {
	const current = getFeedback(id);
	if (!current) throw new LearnerInputError("No such feedback");
	stores.learnerStore.appendLine("feedback", { id, rev: current.rev + 1, op: "delete", at: new Date().toISOString() });
	notifyFeedback(null, "deleted");
	emit("learner-changed", { chatId: current.chatId });
}

/** Markers for this chat's feedback not yet in `messages` (oldest first). */
export function pendingFeedbackMarkers(chatId: string, messages: readonly LhMessage[]): LhMarkerMessage[] {
	const delivered = deliveredFeedbackIds(messages);
	return listFeedback({ chatId })
		.filter((item) => !delivered.has(item.id))
		.map((item) => newLearnerFeedbackMessage(item.id, item.messageId, feedbackMarkerText(item)));
}

/** Does the record end where a marker may be appended without changing
 *  what the next turn owes? (See the module's placement law.) */
export function endsCleanly(messages: readonly LhMessage[]): boolean {
	const last = messages[messages.length - 1];
	if (!last) return false;
	if (last.role === "custom") return !hasUnresolvedQuestion(messages);
	if (last.role !== "assistant") return false;
	const stop = (last as AssistantMessage).stopReason;
	return stop !== "error" && stop !== "aborted" && !hasUnresolvedQuestion(messages);
}

/** Append pending feedback markers now when the chat is idle and clean. */
export function deliverFeedbackIfIdle(chatId: string): boolean {
	if (isTurnRunning(chatId) || compactionInFlight(chatId)) return false;
	const record = stores.chatStore.getChat(chatId);
	if (!record || !endsCleanly(record.messages)) return false;
	const markers = pendingFeedbackMarkers(chatId, record.messages);
	if (markers.length === 0) return false;
	stores.chatStore.saveMessages(chatId, [...record.messages, ...markers]);
	emit("record-changed", { chatId });
	return true;
}
