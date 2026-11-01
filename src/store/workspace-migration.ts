/**
 * THE WORKSPACE MIGRATION (PLAN.md Phase 1): the pre-workspace layout kept
 * chats/, graph/ and jobs/ directly under the data root. On first launch of
 * a workspace-aware build those three directories move into the General
 * workspace (workspaces/general/), after a verified backup copy.
 *
 * The sequence, each step restartable:
 *   1. COPY the legacy directories to backups/pre-workspaces-<stamp>/ and
 *      verify the copy (every relative path + byte size). A mismatch throws
 *      WorkspaceMigrationError BEFORE anything moves — the server refuses to
 *      start rather than run on a half-migrated root (owner ruling Q1.3).
 *   2. RENAME each legacy directory into workspaces/.staging-general/
 *      (same filesystem — one atomic rename per directory).
 *   3. Write the staging workspace.json, then RENAME the staging directory
 *      to its final id, then write index.json.
 * A crash leaves either the legacy layout (step 1 repeats with a fresh
 * backup) or a staging directory (resumed: remaining legacy directories
 * join it, then it is finalized).
 *
 * The downgrade case — workspaces/ already exists AND an older build wrote
 * new legacy directories beside it — imports those directories as a NEW
 * workspace ("Recovered from an older version") through the same backup +
 * rename sequence; nothing is merged into an existing workspace.
 */

import fs from "node:fs";
import path from "node:path";
import { CURRENT_WORKSPACE_VERSION, type WorkspaceIndex, type WorkspaceRecord } from "../core/contracts/workspace.ts";

export const LEGACY_DIRECTORIES = ["chats", "graph", "jobs"] as const;
const WORKSPACE_DIRECTORIES = ["chats", "jobs", "graph", "imports"] as const;

export class WorkspaceMigrationError extends Error {}

/** Atomic JSON write (temp file + rename), tab-indented like every record. */
export function writeJsonAtomic(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${crypto.randomUUID().slice(0, 8)}`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(value, null, "\t") + "\n", "utf-8");
		fs.renameSync(tmp, file);
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

/** Every file under `dir` as relative path → byte size (the copy check). */
export function fileInventory(dir: string): Map<string, number> {
	const out = new Map<string, number>();
	const walk = (current: string, rel: string) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const abs = path.join(current, entry.name);
			const relPath = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(abs, relPath);
			else if (entry.isFile()) out.set(relPath, fs.statSync(abs).size);
		}
	};
	walk(dir, "");
	return out;
}

function sameInventory(a: Map<string, number>, b: Map<string, number>): boolean {
	if (a.size !== b.size) return false;
	for (const [file, size] of a) if (b.get(file) !== size) return false;
	return true;
}

function stamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

function isDirectory(p: string): boolean {
	try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function legacyPresent(dataRoot: string): string[] {
	return LEGACY_DIRECTORIES.filter((d) => isDirectory(path.join(dataRoot, d)));
}

/** Copy + verify the legacy directories into one backup folder. */
function backupLegacy(dataRoot: string, dirs: readonly string[]): string {
	const backup = path.join(dataRoot, "backups", `pre-workspaces-${stamp()}`);
	fs.mkdirSync(backup, { recursive: true });
	for (const dir of dirs) {
		const from = path.join(dataRoot, dir);
		const to = path.join(backup, dir);
		fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
		if (!sameInventory(fileInventory(from), fileInventory(to))) {
			throw new WorkspaceMigrationError(
				`The backup copy of ${from} does not match the original (checked in ${to}). ` +
					"Nothing was moved. Free disk space or fix permissions, then restart the app.",
			);
		}
	}
	return backup;
}

function workspaceRecord(id: string, name: string): WorkspaceRecord {
	return { version: CURRENT_WORKSPACE_VERSION, id, name, createdAt: new Date().toISOString(), archivedAt: null };
}

/** Finalize a staging directory: subdirectories, workspace.json, rename. */
function finalizeStaging(staging: string, finalDir: string, record: WorkspaceRecord): void {
	for (const sub of WORKSPACE_DIRECTORIES) fs.mkdirSync(path.join(staging, sub), { recursive: true });
	const metaFile = path.join(staging, "workspace.json");
	if (!fs.existsSync(metaFile)) writeJsonAtomic(metaFile, record);
	fs.renameSync(staging, finalDir);
}

/** Move the legacy directories into a staging dir, then finalize it. */
function moveLegacyInto(dataRoot: string, staging: string, finalDir: string, record: WorkspaceRecord): void {
	fs.mkdirSync(staging, { recursive: true });
	for (const dir of legacyPresent(dataRoot)) {
		const target = path.join(staging, dir);
		if (fs.existsSync(target)) {
			throw new WorkspaceMigrationError(
				`Cannot finish the workspace migration: both ${path.join(dataRoot, dir)} and ${target} exist. ` +
					"Move one of them aside by hand (a backup is in backups/), then restart the app.",
			);
		}
		fs.renameSync(path.join(dataRoot, dir), target);
	}
	finalizeStaging(staging, finalDir, record);
}

/**
 * Bring `dataRoot` to the workspace layout. Idempotent; cheap when already
 * migrated (a few stat calls). Returns what it did, for logging and tests.
 */
export function ensureWorkspaceLayout(
	dataRoot: string,
	generalId: string,
): "ready" | "created" | "migrated" | "resumed" | "recovered" {
	const workspacesDir = path.join(dataRoot, "workspaces");
	const indexFile = path.join(workspacesDir, "index.json");
	const generalDir = path.join(workspacesDir, generalId);
	const staging = path.join(workspacesDir, `.staging-${generalId}`);
	const writeIndex = () => {
		if (!fs.existsSync(indexFile)) writeJsonAtomic(indexFile, { version: 1, activeWorkspaceId: generalId } satisfies WorkspaceIndex);
	};

	// Resume an interrupted migration first: its staging dir holds the
	// directories already moved; the rest are still legacy.
	if (isDirectory(staging) && !isDirectory(generalDir)) {
		moveLegacyInto(dataRoot, staging, generalDir, workspaceRecord(generalId, "General"));
		writeIndex();
		return "resumed";
	}

	const legacy = legacyPresent(dataRoot);
	if (isDirectory(generalDir)) {
		// A General directory whose record is missing (an adapter's mkdir
		// recreated it after a reset) is repaired, never treated as absent.
		const meta = path.join(generalDir, "workspace.json");
		if (!fs.existsSync(meta)) writeJsonAtomic(meta, workspaceRecord(generalId, "General"));
		writeIndex();
		if (legacy.length === 0) return "ready";
		// Downgrade-and-back: an older build wrote legacy dirs after the
		// migration. Import them as their own workspace — never merged.
		backupLegacy(dataRoot, legacy);
		const id = `ws_${Date.now().toString(36)}_recovered`;
		moveLegacyInto(dataRoot, path.join(workspacesDir, `.staging-${id}`), path.join(workspacesDir, id), workspaceRecord(id, "Recovered from an older version"));
		console.warn(`[workspaces] legacy data written by an older app version was imported as workspace ${id}`);
		return "recovered";
	}

	if (legacy.length === 0) {
		// Fresh install: an empty General workspace.
		fs.mkdirSync(workspacesDir, { recursive: true });
		const tmpStaging = `${staging}-${crypto.randomUUID().slice(0, 8)}`;
		fs.mkdirSync(tmpStaging, { recursive: true });
		try {
			finalizeStaging(tmpStaging, generalDir, workspaceRecord(generalId, "General"));
		} catch (err) {
			// A parallel process (tests share a data dir) finalized first.
			fs.rmSync(tmpStaging, { recursive: true, force: true });
			if (!isDirectory(generalDir)) throw err;
		}
		writeIndex();
		return "created";
	}

	const backup = backupLegacy(dataRoot, legacy);
	moveLegacyInto(dataRoot, staging, generalDir, workspaceRecord(generalId, "General"));
	writeIndex();
	console.info(`[workspaces] migrated ${legacy.join(", ")} into workspaces/${generalId} (backup: ${backup})`);
	return "migrated";
}
