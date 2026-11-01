/**
 * ChatStore — the fs JSON adapter (one file per chat in
 * workspaces/<id>/chats/). ROUTING (PLAN.md Phase 1): chat ids are globally
 * unique, so every id-keyed operation finds the chat's own workspace
 * (workspaces.ts workspaceOfChat) — a chat never leaves its course, and no
 * caller has to name the workspace except at creation.
 *
 * Implements core/ports.ts ChatStore; the record shapes live in
 * core/contracts.ts (ChatRecord/ChatSummary). Idioms: sync fs, tiny
 * records, id-guarded filenames, JSON with tab indentation. Wired in the
 * composition root (src/server/stores.ts); nothing else constructs it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { workspacePaths } from "../../config.ts";
import { noteChatLocation, workspaceStore, writableWorkspace } from "./workspaces.ts";
import { emit } from "../core/events.ts";
import type { ChatStore } from "../core/ports.ts";
import type { ChatRecord, ChatSettings, ChatSummary, ExtractionRunUsage, PlanTree, TurnUsage } from "../core/contracts.ts";
import { CURRENT_CHAT_VERSION } from "../core/contracts.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { activeProblemOf, danglingQuestionOf } from "../core/native-messages.ts";
import { phaseAt3Lh } from "../core/phases.ts";

function chatFileIn(workspaceId: string, id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid chat id: ${id}`);
	return path.join(workspacePaths(workspaceId).chats, `${id}.json`);
}

/** The existing chat's file, or null when no workspace holds it. */
function chatFile(id: string): string | null {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid chat id: ${id}`);
	const workspaceId = workspaceStore.workspaceOfChat(id);
	return workspaceId ? chatFileIn(workspaceId, id) : null;
}

/** THE SILENCE LAW (push S6, 2026-10-02): chats-changed announces ONLY
 *  list-SHAPE mutations — createChat, renameChat, deleteChat (below,
 *  each emits post-write). The content writers (saveMessages,
 *  appendTurnUsage, appendExtractionUsage, saveSettings, saveTree) are
 *  DELIBERATELY SILENT: saveMessages fires per turn-persist and would
 *  spam the bus, and every list-visible change it causes (title, order,
 *  phase, busy, pendingQuestion) is already announced by turn-started /
 *  turn-settled, which the sidebar refetches on. Silence here is law,
 *  not oversight. */
function createChat(title: string, kind?: "practice", workspaceId?: string): ChatRecord {
	const workspace = writableWorkspace(workspaceId);
	const now = new Date().toISOString();
	const record: ChatRecord = {
		id: `chat_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		title: title.trim() || "Untitled session",
		createdAt: now,
		updatedAt: now,
		messages: [],
		// Practice sessions carry the marker; teach stays ABSENT (absence
		// reads as teach — pre-practice records never migrate).
		...(kind === "practice" ? { kind: "practice" as const } : {}),
	};
	fs.mkdirSync(workspacePaths(workspace).chats, { recursive: true });
	writeChatTo(chatFileIn(workspace, record.id), record);
	noteChatLocation(record.id, workspace);
	emit("chats-changed", {});
	return { ...record, version: CURRENT_CHAT_VERSION }; // the in-memory twin of what landed on disk
}

/** THE WRITE CHOKE POINT (schema-versioning wave, owner 2026-10-10): every
 *  record persist goes through here and carries the CURRENT version stamp —
 *  lazy migration means existing files only get stamped on their next write.
 *  A future-version guard lives on the read side (getChat). */
function writeChat(record: ChatRecord): void {
	const file = chatFile(record.id);
	if (!file) throw new Error(`Chat not found: ${record.id}`);
	writeChatTo(file, record);
}

function writeChatTo(file: string, record: ChatRecord): void {
	fs.writeFileSync(file, JSON.stringify({ ...record, version: CURRENT_CHAT_VERSION }, null, "\t"), "utf-8");
}

function getChat(id: string): ChatRecord | null {
	const file = chatFile(id);
	return file ? readChatFile(id, file) : null;
}

function readChatFile(id: string, file: string): ChatRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return null;
	}
	// Honest refusal (owner ruling 2026-10-10): a record stamped NEWER than
	// this build (the downgrade scenario) reads as absent, never misparsed —
	// the next read-modify-write must not rewrite what it doesn't understand.
	const v = (parsed as { version?: unknown }).version;
	if (typeof v === "number" && v > CURRENT_CHAT_VERSION) {
		console.error(`[chat ${id}] record stamped with schema version ${v} > ${CURRENT_CHAT_VERSION} — this app build is older; refusing to read it`);
		return null;
	}
	return parsed as ChatRecord;
}

function listChats(): ChatSummary[] {
	return workspaceStore
		.list()
		.flatMap((workspace) => listChatsIn(workspace.id))
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function listChatsIn(workspaceId: string): ChatSummary[] {
	const dir = workspacePaths(workspaceId).chats;
	try {
		fs.mkdirSync(dir, { recursive: true });
		return fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => readChatFile(f.slice(0, -5), path.join(dir, f)))
			.filter((r): r is ChatRecord => r !== null)
			.map(({ messages, tree, turns, extractions, ...summary }) => {
				// Per-record isolation (Wave B): a record whose messages fail the
				// projection (e.g. pre-Wave-B UIMessage-format scratch — the
				// zero-back-compat wipe makes these "corrupt") must not blank the
				// whole sidebar — same isolation getChat's per-file catch gives.
				try {
					return {
						workspaceId,
						// turns and extractions stay out of the list payload (list =
						// summaries; usage aggregates ride the full record, the picker
						// never needs them).
						...summary,
						// Normalized kind: absent record field reads as teach.
						kind: summary.kind ?? "teach",
						messageCount: messages.length,
						// Record-derived status for the session picker: phase from the
						// transcript's explicit events (probe_done concluded / verdict
						// accepted — docs/probe-teach-split.md §4), pending question
						// from the native dangling-call scan. Wave D: both folds read
						// the NATIVE record (core/phases.ts phaseAt3Lh +
						// native-messages.ts danglingQuestionOf). Liveness (busy) is
						// NOT record-derived — the API route merges it (ChatListItem).
						phase: phaseAt3Lh(messages),
						pendingQuestion: danglingQuestionOf(messages) !== null,
					};
				} catch (err) {
					console.error(`[chat ${summary.id}] summary projection failed:`, err);
					return null;
				}
			})
			.filter((s): s is ChatSummary => s !== null)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	} catch {
		return [];
	}
}

/** Persist the full native message list (the record IS the agent state —
 *  Wave B: replay is state.messages = record.messages). SILENT by the
 *  events law — see the SILENCE LAW comment at createChat. */
function saveMessages(id: string, messages: LhMessage[]): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.messages = messages;
	record.updatedAt = new Date().toISOString();
	writeChat(record);
}

/** Append one usage entry to the record's turn log — idempotent per
 * turn id: each REQUEST carries its own id, so a replay of the same turn's
 * persist appends once, while continuation turns (which share a response
 *  message id) each keep their usage. */
function appendTurnUsage(id: string, entry: TurnUsage): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.turns = record.turns?.some((t) => t.id === entry.id)
		? record.turns
		: [...(record.turns ?? []), entry];
	writeChat(record);
}

/** Append one extraction-run usage entry to the record's extractions
 * log — idempotent per startedAt: a retry that reaches the append twice
 * (abort replays) does not double-count spend. */
function appendExtractionUsage(id: string, entry: ExtractionRunUsage): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.extractions = record.extractions?.some((r) => r.startedAt === entry.startedAt)
		? record.extractions
		: [...(record.extractions ?? []), entry];
	writeChat(record);
}

/** Persist the per-chat model/thinking settings — replace-whole (the
 * picker sends the complete object; absent = config defaults). */
function saveSettings(id: string, settings: ChatSettings): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	// Like saveTree: a settings tweak is not conversation activity, so it
	// deliberately does NOT bump updatedAt (sidebar order must not churn).
	record.settings = settings;
	writeChat(record);
}

/** Rename a session (the header's click-to-edit title, 2026-09-17). Like
 * saveSettings, a rename is NOT conversation activity: updatedAt stays put
 * so sidebar order never churns. Same fallback as createChat — the empty
 * string becomes "Untitled session" (the API gate rejects it first; this
 * is the honest floor for any other caller). */
function renameChat(id: string, title: string): ChatRecord {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.title = title.trim() || "Untitled session";
	writeChat(record);
	emit("chats-changed", {});
	return record;
}

/** Delete the session record file entirely (session-deletion wave 6,
 *  owner 2026-09-22). False when the id is unknown — the route turns that
 *  into a 404. The record's graph traces and jobs are the route's
 *  choreography (core/graph-deletion.ts), not the store's. */
function deleteChat(id: string): boolean {
	try {
		const file = chatFile(id);
		if (!file) return false;
		fs.unlinkSync(file);
		emit("chats-changed", {}); // only a real removal — the present-entry law
		return true;
	} catch {
		return false; // never existed, already deleted, or unreadable — same answer
	}
}

/** Persist the session plan tree (plan tools call this in execute). */
function saveTree(id: string, tree: PlanTree): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.tree = tree;
	// Deliberately does NOT bump updatedAt: tree mutations piggyback on the
	// turn's saveMessages, and sidebar ordering shouldn't churn on tree edits.
	writeChat(record);
}

/** One workspace's chat summaries (graph cost and coverage views). */
export { listChatsIn };

export const chatStore: ChatStore = {
	createChat,
	getChat,
	listChats,
	saveMessages,
	saveTree,
	saveSettings,
	renameChat,
	deleteChat,
	appendTurnUsage,
	appendExtractionUsage,
};
