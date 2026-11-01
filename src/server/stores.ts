/**
 * THE COMPOSITION ROOT for storage — the single place concrete store
 * adapters are wired. Everything else (core, services, agents) codes against
 * the port types in core/ports.ts and receives instances through this
 * module. Swapping the fs adapter for SQLite later changes exactly this
 * file (and the adapter implementations in src/store/).
 */

import { chatStore, listChatsIn } from "../store/chats.ts";
import { jobStore } from "../store/jobs.ts";
import { learnerStore } from "../store/learner.ts";
import { learnerGraphStore } from "../store/learner-graph.ts";
import { ensureLayout, graphStoreFor, sourceOrganizationStoreFor, WorkspaceError, workspaceStore } from "../store/workspaces.ts";
export { WorkspaceError } from "../store/workspaces.ts";
import { settingsStore } from "../store/settings.ts";
import { resolveSettings, type EffectiveSettings } from "../core/settings-resolution.ts";
import { syncCustomProvider } from "./custom-provider.ts";
/**
 * The GLOBAL adapters (PLAN.md Phase 1). chatStore and jobStore ROUTE by
 * chat id to the chat's own course workspace, so every chat-keyed caller is
 * workspace-correct by construction. The graph family is per workspace and
 * deliberately NOT here: take it from workspaceStores(id) / storesForChat.
 */
export const stores = {
	chatStore,
	jobStore,
	settingsStore,
	workspaceStore,
	/** The global learner layer (data/learner) — above every workspace. */
	learnerStore,
	/** The learner's concept bridges (Phase 5) — behind its own port. */
	learnerGraphStore,
};

/** One workspace's full store set — satisfies core/graph.ts GraphDeps.
 *  Its chatStore is the routing store with listChats() narrowed to this
 *  workspace (cluster titles, source directory, graph costs); every
 *  id-keyed operation still routes by the chat's own workspace. */
export function workspaceStores(workspaceId: string) {
	return {
		workspaceId,
		chatStore: { ...chatStore, listChats: () => listChatsIn(workspaceId) } satisfies typeof chatStore,
		jobStore,
		settingsStore,
		graphStore: graphStoreFor(workspaceId),
		sourceOrganizationStore: sourceOrganizationStoreFor(workspaceId),
	};
}

export type WorkspaceStores = ReturnType<typeof workspaceStores>;

/** The workspace store set for the course that owns `chatId` (null when no
 *  course holds the chat). Turns, workers and chat routes resolve here —
 *  never through the UI's active workspace. */
export function storesForChat(chatId: string): WorkspaceStores | null {
	const workspaceId = workspaceStore.workspaceOfChat(chatId);
	return workspaceId ? workspaceStores(workspaceId) : null;
}

/** The workspace a request names, or the active one when it names none.
 *  An unknown id is a typed 404 (WorkspaceError) — never a silent fallback. */
export function resolveWorkspaceId(requested: string | null | undefined): string {
	if (requested === null || requested === undefined || requested === "") return workspaceStore.active();
	if (!workspaceStore.get(requested)) throw new WorkspaceError("No such course", 404);
	return requested;
}

/**
 * The resolved view of the settings record (core/settings-resolution.ts):
 * every knob concrete over its factory default — EXCEPT MODELS (BYOK all
 * the way down, owner 2026-09-22): no factory pins exist, so unset model
 * slots resolve to null and per-need refusal gates fire downstream. Read
 * fresh on every call — the record is a small file and turns are rare, so
 * no caching layer (stale toggles after a settings PUT would be worse).
 */
export function effectiveSettings(): EffectiveSettings {
	return resolveSettings(settingsStore.readSettings());
}

// Boot: bring the data root to the workspace layout (the one-time
// migration). A failed backup check THROWS here — the server refuses to
// start rather than run on a half-migrated data directory.
ensureLayout();

// Boot: register the custom endpoint (when configured) into piModels(); the
// POST /api/custom-provider route re-syncs after every connect.
syncCustomProvider();
