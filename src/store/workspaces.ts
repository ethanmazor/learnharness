/**
 * WorkspaceStore — the fs adapter for course workspaces (PLAN.md Phase 1):
 * data/workspaces/<id>/workspace.json per course, data/workspaces/index.json
 * for the active one. Implements core/ports.ts WorkspaceStore.
 *
 * Also the store layer's WORKSPACE RESOLUTION: chat ids are globally unique,
 * so workspaceOfChat finds a chat's directory (cached, verified by one stat)
 * and the routing chat/job stores (chats.ts, jobs.ts) send every chat-keyed
 * call to its own workspace. Graph-family stores are per workspace and are
 * cached here (graphStoreFor / sourceOrganizationStoreFor).
 *
 * The layout migration runs lazily on first use (ensureLayout) and eagerly
 * at server boot (src/server/stores.ts) so a failed migration refuses to
 * start instead of surfacing mid-request.
 */

import fs from "node:fs";
import path from "node:path";
import { GENERAL_WORKSPACE_ID, PATHS, workspacePaths } from "../../config.ts";
import {
	CURRENT_WORKSPACE_VERSION,
	isWorkspaceId,
	normalizeWorkspaceName,
	type WorkspaceIndex,
	type WorkspaceRecord,
} from "../core/contracts/workspace.ts";
import type { GraphStore, SourceOrganizationStore, WorkspaceStore } from "../core/ports.ts";
import { emit } from "../core/events.ts";
import { ensureWorkspaceLayout, writeJsonAtomic } from "./workspace-migration.ts";
import { createGraphStore } from "./graph.ts";
import { createSourceOrganizationStore } from "./source-organization.ts";

export class WorkspaceError extends Error {
	constructor(message: string, readonly status: 400 | 404 | 409) {
		super(message);
	}
}

const INDEX_FILE = path.join(PATHS.workspaces, "index.json");

let layoutReady = false;
/** Bring the data root to the workspace layout. Runs the migration once per
 *  process; afterwards one stat confirms the index still exists (a wiped
 *  data directory — tests, a manual reset — is rebuilt, never half-read). */
export function ensureLayout(): void {
	if (layoutReady && fs.existsSync(INDEX_FILE)) return;
	ensureWorkspaceLayout(PATHS.data, GENERAL_WORKSPACE_ID);
	layoutReady = true;
}

function readMeta(id: string): WorkspaceRecord | null {
	if (!isWorkspaceId(id)) return null;
	try {
		const parsed = JSON.parse(fs.readFileSync(workspacePaths(id).meta, "utf-8")) as Partial<WorkspaceRecord>;
		if (typeof parsed.version === "number" && parsed.version > CURRENT_WORKSPACE_VERSION) {
			console.error(`[workspace ${id}] stamped with version ${parsed.version} > ${CURRENT_WORKSPACE_VERSION} — this app build is older; hiding it`);
			return null;
		}
		if (parsed.id !== id || typeof parsed.name !== "string" || typeof parsed.createdAt !== "string") return null;
		return { version: CURRENT_WORKSPACE_VERSION, id, name: parsed.name, createdAt: parsed.createdAt, archivedAt: parsed.archivedAt ?? null };
	} catch {
		return null;
	}
}

function list(): WorkspaceRecord[] {
	ensureLayout();
	let names: string[];
	try {
		names = fs.readdirSync(PATHS.workspaces, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name);
	} catch {
		names = [];
	}
	return names
		.map(readMeta)
		.filter((w): w is WorkspaceRecord => w !== null)
		.sort((a, b) => (a.id === GENERAL_WORKSPACE_ID ? -1 : b.id === GENERAL_WORKSPACE_ID ? 1 : a.createdAt.localeCompare(b.createdAt)));
}

function get(id: string): WorkspaceRecord | null {
	ensureLayout();
	return readMeta(id);
}

function requireWorkspace(id: string): WorkspaceRecord {
	const record = get(id);
	if (!record) throw new WorkspaceError("No such course", 404);
	return record;
}

function create(rawName: string): WorkspaceRecord {
	ensureLayout();
	const name = normalizeWorkspaceName(rawName);
	if (!name) throw new WorkspaceError("A course needs a name (up to 80 characters)", 400);
	const id = `ws_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
	const paths = workspacePaths(id);
	for (const dir of [paths.chats, paths.jobs, paths.graph, paths.imports]) fs.mkdirSync(dir, { recursive: true });
	const record: WorkspaceRecord = { version: CURRENT_WORKSPACE_VERSION, id, name, createdAt: new Date().toISOString(), archivedAt: null };
	writeJsonAtomic(paths.meta, record);
	emit("workspaces-changed", {});
	return record;
}

function rename(id: string, rawName: string): WorkspaceRecord {
	const record = requireWorkspace(id);
	const name = normalizeWorkspaceName(rawName);
	if (!name) throw new WorkspaceError("A course needs a name (up to 80 characters)", 400);
	const next = { ...record, name };
	writeJsonAtomic(workspacePaths(id).meta, next);
	emit("workspaces-changed", {});
	return next;
}

function setArchived(id: string, archived: boolean): WorkspaceRecord {
	const record = requireWorkspace(id);
	if (archived && !list().some((w) => w.id !== id && !w.archivedAt)) {
		throw new WorkspaceError("At least one course must stay open", 409);
	}
	const next = { ...record, archivedAt: archived ? (record.archivedAt ?? new Date().toISOString()) : null };
	writeJsonAtomic(workspacePaths(id).meta, next);
	emit("workspaces-changed", {});
	return next;
}

function remove(id: string): void {
	requireWorkspace(id);
	if (id === GENERAL_WORKSPACE_ID) throw new WorkspaceError("The General course cannot be deleted", 409);
	const trash = path.join(PATHS.backups, "deleted-workspaces");
	fs.mkdirSync(trash, { recursive: true });
	fs.renameSync(workspacePaths(id).root, path.join(trash, `${id}-${new Date().toISOString().replace(/[:.]/g, "-")}`));
	graphStores.delete(id);
	organizationStores.delete(id);
	for (const [chatId, ws] of chatLocations) if (ws === id) chatLocations.delete(chatId);
	emit("workspaces-changed", {});
	emit("chats-changed", {});
}

function readIndex(): WorkspaceIndex | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8")) as Partial<WorkspaceIndex>;
		return typeof parsed.activeWorkspaceId === "string" ? { version: 1, activeWorkspaceId: parsed.activeWorkspaceId } : null;
	} catch {
		return null;
	}
}

/** The active workspace: the index's choice while it exists and is open;
 *  otherwise the first open workspace (General first). */
function active(): string {
	ensureLayout();
	const chosen = readIndex()?.activeWorkspaceId;
	const record = chosen ? readMeta(chosen) : null;
	if (record && !record.archivedAt) return record.id;
	return list().find((w) => !w.archivedAt)?.id ?? GENERAL_WORKSPACE_ID;
}

function setActive(id: string): void {
	const record = requireWorkspace(id);
	if (record.archivedAt) throw new WorkspaceError("Unarchive the course before switching to it", 409);
	writeJsonAtomic(INDEX_FILE, { version: 1, activeWorkspaceId: id } satisfies WorkspaceIndex);
	emit("workspaces-changed", {});
}

// ─── chat → workspace resolution ─────────────────────────────────────────────

const chatLocations = new Map<string, string>();

function chatFileIn(workspaceId: string, chatId: string): string {
	return path.join(workspacePaths(workspaceId).chats, `${chatId}.json`);
}

/** The workspace owning `chatId`, or null. Cached; a stale cache entry
 *  (deleted chat or workspace) falls back to one directory scan. */
function workspaceOfChat(chatId: string): string | null {
	if (!/^[A-Za-z0-9_-]+$/.test(chatId)) return null;
	ensureLayout();
	const cached = chatLocations.get(chatId);
	if (cached && fs.existsSync(chatFileIn(cached, chatId))) return cached;
	chatLocations.delete(chatId);
	for (const workspace of list()) {
		if (fs.existsSync(chatFileIn(workspace.id, chatId))) {
			chatLocations.set(chatId, workspace.id);
			return workspace.id;
		}
	}
	return null;
}

/** Record a chat's location at creation (the next lookup skips the scan). */
export function noteChatLocation(chatId: string, workspaceId: string): void {
	chatLocations.set(chatId, workspaceId);
}

/** A workspace that can receive a new chat: exists and is not archived. */
export function writableWorkspace(id: string | undefined): string {
	const target = id ?? active();
	const record = requireWorkspace(target);
	if (record.archivedAt) throw new WorkspaceError("This course is archived — unarchive it to start a chat", 409);
	return target;
}

// ─── per-workspace graph-family stores ───────────────────────────────────────

const graphStores = new Map<string, GraphStore>();
const organizationStores = new Map<string, SourceOrganizationStore>();

/** The graph store for one workspace (cached per id). */
export function graphStoreFor(workspaceId: string): GraphStore {
	let store = graphStores.get(workspaceId);
	if (!store) {
		requireWorkspace(workspaceId);
		store = createGraphStore(workspacePaths(workspaceId));
		graphStores.set(workspaceId, store);
	}
	return store;
}

export function sourceOrganizationStoreFor(workspaceId: string): SourceOrganizationStore {
	let store = organizationStores.get(workspaceId);
	if (!store) {
		requireWorkspace(workspaceId);
		store = createSourceOrganizationStore(workspacePaths(workspaceId));
		organizationStores.set(workspaceId, store);
	}
	return store;
}

export const workspaceStore: WorkspaceStore = {
	list,
	get,
	create,
	rename,
	setArchived,
	remove,
	active,
	setActive,
	workspaceOfChat,
};
