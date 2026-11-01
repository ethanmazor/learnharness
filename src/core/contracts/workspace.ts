/**
 * COURSE WORKSPACES (PLAN.md Phase 1): one directory per course holding its
 * own chats, jobs and knowledge graph (config.workspacePaths). A chat
 * belongs to exactly one workspace for its whole life — every turn and
 * worker it starts reads and writes that workspace only. The ACTIVE
 * workspace is a UI choice (home graph, New chat), never a write scope.
 */

/** The record at workspaces/<id>/workspace.json. */
export interface WorkspaceRecord {
	/** Private schema counter (breaking shape changes only). */
	version: 1;
	/** Opaque and stable: a rename changes `name`, never the directory. */
	id: string;
	name: string;
	createdAt: string;
	/** ISO when archived; absent/null = active course. */
	archivedAt?: string | null;
}

export const CURRENT_WORKSPACE_VERSION = 1;

/** The record at workspaces/index.json. */
export interface WorkspaceIndex {
	version: 1;
	activeWorkspaceId: string;
}

/** What the workspace routes return to the UI. */
export interface WorkspaceSummary {
	id: string;
	name: string;
	createdAt: string;
	archived: boolean;
	active: boolean;
	chatCount: number;
}

/** Workspace names: trimmed, non-empty, bounded. Returns null when invalid. */
export function normalizeWorkspaceName(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const name = raw.replace(/\s+/g, " ").trim();
	return name.length > 0 && name.length <= 80 ? name : null;
}

/** Ids are opaque path segments — the same guard chat ids use. */
export function isWorkspaceId(raw: unknown): raw is string {
	return typeof raw === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(raw);
}
