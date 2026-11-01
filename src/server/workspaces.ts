/**
 * Course workspaces — the server service behind /api/workspaces and the
 * workspace scoping of graph routes (PLAN.md Phase 1).
 *
 * Scoping rule (owner decision D1): a chat's turns and workers always use
 * the chat's own workspace (storesForChat). The ACTIVE workspace only
 * decides what the UI shows — the home graph, the source directory, New
 * chat — so graph routes accept an explicit `?workspace=` and otherwise
 * fall back to the active one.
 */

import { extractionStatuses } from "../agent/subagents/extraction.ts";
import { isJobLive } from "../agent/subagents/aborts.ts";
import type { WorkspaceSummary } from "../core/contracts/workspace.ts";
import { readRenderSettings, writeRenderSettings } from "../store/render-settings.ts";
import { workspacePaths } from "../../config.ts";
import { compactionInFlight } from "./compaction.ts";
import { resolveWorkspaceId, stores, WorkspaceError, workspaceStores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";

/** The workspace a graph-family request targets: `?workspace=<id>`, else
 *  the workspace of `?chat=<id>` (a chat-surface read — practice target
 *  names — follows its chat's course), else the active workspace. Throws
 *  WorkspaceError(404) for an unknown id. */
export function workspaceFromRequest(request: Request): string {
	const params = new URL(request.url).searchParams;
	const chatId = params.get("chat");
	if (!params.get("workspace") && chatId) {
		const owner = stores.workspaceStore.workspaceOfChat(chatId);
		if (!owner) throw new WorkspaceError("Unknown chat", 404);
		return owner;
	}
	return resolveWorkspaceId(params.get("workspace"));
}

/** Map a WorkspaceError to its HTTP response; anything else rethrows. */
export function workspaceErrorResponse(error: unknown): Response {
	if (error instanceof WorkspaceError) return Response.json({ error: error.message }, { status: error.status });
	throw error;
}

export function listWorkspaceSummaries(): WorkspaceSummary[] {
	const active = stores.workspaceStore.active();
	const counts = new Map<string, number>();
	for (const chat of stores.chatStore.listChats()) counts.set(chat.workspaceId, (counts.get(chat.workspaceId) ?? 0) + 1);
	return stores.workspaceStore.list().map((w) => ({
		id: w.id,
		name: w.name,
		createdAt: w.createdAt,
		archived: Boolean(w.archivedAt),
		active: w.id === active,
		chatCount: counts.get(w.id) ?? 0,
	}));
}

/** Why a workspace cannot be deleted right now, or null. Every check is
 *  synchronous, so the caller's gate + move is one event-loop stretch. */
export function workspaceBusyReason(workspaceId: string): string | null {
	const chats = stores.chatStore.listChats().filter((c) => c.workspaceId === workspaceId);
	for (const chat of chats) {
		if (isTurnRunning(chat.id)) return `A turn is running in "${chat.title}"`;
		if (compactionInFlight(chat.id)) return `"${chat.title}" is compacting its context`;
		if (stores.jobStore.listJobs(chat.id).some((job) => job.status === "running" && (!job.result || isJobLive(job.id)))) {
			return `Background work is running in "${chat.title}"`;
		}
	}
	const chatIds = new Set(chats.map((c) => c.id));
	const sourceIds = new Set(workspaceStores(workspaceId).graphStore.readSources().map((s) => s.id));
	// Notes imports are refused wholesale: a brand-new import has no source
	// record yet, so it cannot be attributed to a workspace before it lands.
	if (extractionStatuses().some((run) => chatIds.has(run.chatId) || sourceIds.has(run.chatId) || run.kind === "notes")) {
		return "An extraction or notes import is running";
	}
	return null;
}

export function deleteWorkspace(workspaceId: string): void {
	if (!stores.workspaceStore.get(workspaceId)) throw new WorkspaceError("No such course", 404);
	const busy = workspaceBusyReason(workspaceId);
	if (busy) throw new WorkspaceError(`${busy} — try again when it finishes`, 409);
	stores.workspaceStore.remove(workspaceId);
}

/** Per-course graph render settings (each workspace's graph/ keeps its own). */
export function readWorkspaceRenderSettings(workspaceId: string) {
	return readRenderSettings(workspacePaths(workspaceId));
}

export function writeWorkspaceRenderSettings(workspaceId: string, raw: unknown) {
	return writeRenderSettings(raw, workspacePaths(workspaceId));
}
