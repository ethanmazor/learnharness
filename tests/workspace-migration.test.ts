/**
 * The one-time workspace migration (PLAN.md Phase 1), driven directly
 * against throwaway data roots: legacy chats/graph/jobs move into
 * workspaces/general after a verified backup, every byte survives in both
 * places, re-runs are no-ops, an interrupted migration resumes, a failed
 * backup moves nothing, and legacy data written by an older build after the
 * migration is imported as its own workspace.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ensureWorkspaceLayout, fileInventory } from "../src/store/workspace-migration.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function legacyRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-migrate-"));
	roots.push(root);
	fs.mkdirSync(path.join(root, "chats"));
	fs.mkdirSync(path.join(root, "graph"));
	fs.mkdirSync(path.join(root, "jobs"));
	fs.writeFileSync(path.join(root, "chats", "chat_a.json"), JSON.stringify({ id: "chat_a", title: "A", messages: [] }));
	fs.writeFileSync(path.join(root, "graph", "nodes.jsonl"), '{"id":"n1"}\n{"id":"n2"}\n');
	fs.writeFileSync(path.join(root, "jobs", "job_a.json"), JSON.stringify({ id: "job_a", chatId: "chat_a" }));
	fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ version: 1 }));
	return root;
}

const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

describe("workspace migration", () => {
	it("moves chats/graph/jobs into workspaces/general after a byte-identical backup; global files stay", () => {
		const root = legacyRoot();
		const before = fileInventory(root);
		assert.equal(ensureWorkspaceLayout(root, "general"), "migrated");
		for (const dir of ["chats", "graph", "jobs"]) assert.equal(fs.existsSync(path.join(root, dir)), false, `${dir} left the root`);
		const backups = fs.readdirSync(path.join(root, "backups"));
		assert.equal(backups.length, 1);
		assert.match(backups[0]!, /^pre-workspaces-/);
		for (const [file] of before) {
			if (file === "settings.json") continue;
			assert.equal(read(root, `workspaces/general/${file}`), read(root, `backups/${backups[0]}/${file}`), `${file} identical in both copies`);
		}
		assert.equal(read(root, "workspaces/general/graph/nodes.jsonl"), '{"id":"n1"}\n{"id":"n2"}\n');
		assert.ok(fs.existsSync(path.join(root, "settings.json")), "settings stay global");
		assert.deepEqual(JSON.parse(read(root, "workspaces/index.json")), { version: 1, activeWorkspaceId: "general" });
		const meta = JSON.parse(read(root, "workspaces/general/workspace.json"));
		assert.equal(meta.id, "general");
		assert.equal(meta.name, "General");
		assert.ok(fs.statSync(path.join(root, "workspaces", "general", "imports")).isDirectory(), "imports/ is reserved");
	});

	it("is a no-op once migrated (no second backup)", () => {
		const root = legacyRoot();
		ensureWorkspaceLayout(root, "general");
		assert.equal(ensureWorkspaceLayout(root, "general"), "ready");
		assert.equal(fs.readdirSync(path.join(root, "backups")).length, 1);
	});

	it("a fresh install gets an empty General workspace and no backup", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-migrate-"));
		roots.push(root);
		assert.equal(ensureWorkspaceLayout(root, "general"), "created");
		assert.ok(fs.existsSync(path.join(root, "workspaces", "general", "workspace.json")));
		assert.equal(fs.existsSync(path.join(root, "backups")), false);
	});

	it("resumes an interrupted migration from its staging directory", () => {
		const root = legacyRoot();
		// Simulate a crash after the first rename: chats already staged.
		fs.mkdirSync(path.join(root, "workspaces", ".staging-general"), { recursive: true });
		fs.renameSync(path.join(root, "chats"), path.join(root, "workspaces", ".staging-general", "chats"));
		assert.equal(ensureWorkspaceLayout(root, "general"), "resumed");
		assert.ok(fs.existsSync(path.join(root, "workspaces", "general", "chats", "chat_a.json")));
		assert.ok(fs.existsSync(path.join(root, "workspaces", "general", "graph", "nodes.jsonl")));
		assert.ok(fs.existsSync(path.join(root, "workspaces", "general", "jobs", "job_a.json")));
		assert.equal(fs.existsSync(path.join(root, "workspaces", ".staging-general")), false);
	});

	it("a failed backup throws and moves nothing", () => {
		const root = legacyRoot();
		fs.writeFileSync(path.join(root, "backups"), "not a directory"); // mkdir under it fails
		assert.throws(() => ensureWorkspaceLayout(root, "general"));
		for (const dir of ["chats", "graph", "jobs"]) assert.ok(fs.existsSync(path.join(root, dir)), `${dir} untouched`);
		assert.equal(fs.existsSync(path.join(root, "workspaces", "general")), false);
	});

	it("legacy data written by an older build after migration becomes its own workspace, never merged", () => {
		const root = legacyRoot();
		ensureWorkspaceLayout(root, "general");
		fs.mkdirSync(path.join(root, "chats"));
		fs.writeFileSync(path.join(root, "chats", "chat_b.json"), JSON.stringify({ id: "chat_b" }));
		assert.equal(ensureWorkspaceLayout(root, "general"), "recovered");
		const recovered = fs.readdirSync(path.join(root, "workspaces")).find((d) => d.endsWith("_recovered"));
		assert.ok(recovered, "a recovered workspace exists");
		assert.ok(fs.existsSync(path.join(root, "workspaces", recovered!, "chats", "chat_b.json")));
		assert.equal(fs.existsSync(path.join(root, "workspaces", "general", "chats", "chat_b.json")), false);
		assert.equal(JSON.parse(read(root, `workspaces/${recovered}/workspace.json`)).name, "Recovered from an older version");
	});

	it("repairs a General directory whose workspace.json is missing", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-migrate-"));
		roots.push(root);
		fs.mkdirSync(path.join(root, "workspaces", "general", "graph"), { recursive: true });
		assert.equal(ensureWorkspaceLayout(root, "general"), "ready");
		assert.equal(JSON.parse(read(root, "workspaces/general/workspace.json")).id, "general");
	});
});
