/**
 * JobStore — the fs JSON adapter: one file per background sub-agent job in
 * workspaces/<id>/jobs/ — the owning chat's workspace (PLAN.md Phase 1;
 * the job routes by its chatId, lookups by id scan the workspaces) (contracts.ts "THE ASYNC PROTOCOL"). Keyed by toolCallId for
 * dedup: the chat-handler spawn hook never creates two jobs for the same
 * tool part. Implements core/ports.ts JobStore. Idioms: sync fs, id-guarded
 * filenames, JSON with tab indentation. Writes are small and rare (activity
 * line updates); the read-modify-write sections in the runner contain no
 * awaits, so they are atomic within the single-threaded event loop.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { workspacePaths } from "../../config.ts";
import { workspaceStore } from "./workspaces.ts";
import { emit } from "../core/events.ts";
import type { JobStore } from "../core/ports.ts";
import type { CreateJobInit, JobPatch } from "../core/ports.ts";
import type { JobRecord } from "../core/contracts.ts";

/** A chat's jobs directories: its own workspace's, or — for a chat no
 *  workspace holds (deleted, or never persisted) — every workspace's, so a
 *  job record never becomes unreachable. The store has never required the
 *  chat to exist; routing must not add that requirement. */
function jobsDirsForChat(chatId: string): string[] {
	const workspaceId = workspaceStore.workspaceOfChat(chatId);
	if (workspaceId) return [workspacePaths(workspaceId).jobs];
	return workspaceStore.list().map((w) => workspacePaths(w.id).jobs);
}

function checkJobId(id: string): void {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid job id: ${id}`);
}

/** Job ids are globally unique: the existing file in whichever workspace
 *  holds it (cached), or null. */
const jobLocations = new Map<string, string>();
function existingJobFile(id: string): string | null {
	checkJobId(id);
	const cached = jobLocations.get(id);
	if (cached && fs.existsSync(cached)) return cached;
	jobLocations.delete(id);
	for (const workspace of workspaceStore.list()) {
		const file = path.join(workspacePaths(workspace.id).jobs, `${id}.json`);
		if (fs.existsSync(file)) {
			jobLocations.set(id, file);
			return file;
		}
	}
	return null;
}

/** Writes announce on the events channel AFTER the write lands (the
 *  notify-after-write law, beginTurn precedent) — jobs-changed is what
 *  retires the view's interval poll (push S4, 2026-10-02): dispatch cards,
 *  progress lines, settles, and aborts all surface as one fetch. */
function createJob(init: CreateJobInit): JobRecord {
	const now = new Date().toISOString();
	const record: JobRecord = {
		id: `job_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		kind: init.kind,
		chatId: init.chatId,
		toolCallId: init.toolCallId,
		...(init.input !== undefined ? { input: init.input } : {}),
		status: "running",
		activity: init.activity ?? "starting",
		createdAt: now,
		updatedAt: now,
	};
	// The chat's own workspace; an unknown chat's job lands in the active one.
	const dir = workspacePaths(workspaceStore.workspaceOfChat(init.chatId) ?? workspaceStore.active()).jobs;
	fs.mkdirSync(dir, { recursive: true });
	checkJobId(record.id);
	const file = path.join(dir, `${record.id}.json`);
	fs.writeFileSync(file, JSON.stringify(record, null, "\t"), "utf-8");
	jobLocations.set(record.id, file);
	emit("jobs-changed", { chatId: init.chatId });
	return record;
}

function getJob(id: string): JobRecord | null {
	const file = existingJobFile(id);
	if (!file) return null;
	return readJobFile(file);
}

function readJobFile(file: string): JobRecord | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as JobRecord;
	} catch {
		return null;
	}
}

/** Merge a partial patch into the record (identity fields are immutable).
 *  An explicit patch.updatedAt is honored (tests pin deterministic order);
 *  otherwise the merge bumps it to now. */
function updateJob(id: string, patch: JobPatch): JobRecord | null {
	const record = getJob(id);
	if (!record) return null;
	const next: JobRecord = { ...record, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
	const file = existingJobFile(id);
	if (!file) return null;
	fs.writeFileSync(file, JSON.stringify(next, null, "\t"), "utf-8");
	// EVERY write, not just status flips: progress-line updates must reach
	// the dispatch cards (the view debounces the fetch bursts). A missing id
	// wrote nothing and stays silent.
	emit("jobs-changed", { chatId: next.chatId });
	return next;
}

/** All jobs for a chat, newest activity first. */
function listJobs(chatId: string): JobRecord[] {
	try {
		return jobsDirsForChat(chatId)
			.filter((dir) => fs.existsSync(dir))
			.flatMap((dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => readJobFile(path.join(dir, f))))
			.filter((j): j is JobRecord => j !== null && j.chatId === chatId)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	} catch {
		return [];
	}
}

/** The job fulfilling a given tool part, if any (spawn-hook dedup). */
function findJobByToolCallId(chatId: string, toolCallId: string): JobRecord | null {
	return listJobs(chatId).find((j) => j.toolCallId === toolCallId) ?? null;
}

/** Delete every job record file for a chat (session-deletion wave 6) —
 *  running or finished, they are the chat's records and die with it.
 *  Returns how many files were removed. The deletion route refuses while
 *  jobs are still running, so every record here is terminal. */
function deleteJobsForChat(chatId: string): number {
	let removed = 0;
	for (const job of listJobs(chatId)) {
		try {
			const file = existingJobFile(job.id);
			if (!file) continue;
			fs.unlinkSync(file);
			jobLocations.delete(job.id);
			removed++;
		} catch {
			/* already gone — the count is best-effort truth */
		}
	}
	// Only when something actually died — a zero-file delete wrote nothing
	// (the endTurn present-entry law).
	if (removed > 0) emit("jobs-changed", { chatId });
	return removed;
}

export const jobStore: JobStore = {
	createJob,
	getJob,
	updateJob,
	listJobs,
	findJobByToolCallId,
	deleteJobsForChat,
};
