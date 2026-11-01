/**
 * Course workspaces end to end (PLAN.md Phase 1) under an isolated
 * LH_DATA_DIR: the workspace store (create/rename/archive/active/delete),
 * chat + job ROUTING to the owning workspace, graph isolation between
 * courses, the delete gate, and the HTTP routes that create chats and read
 * graphs per course.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-workspaces-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const { stores, workspaceStores, storesForChat } = await import("../src/server/stores.ts");
const { deleteWorkspace, listWorkspaceSummaries } = await import("../src/server/workspaces.ts");
const { workspacePaths } = await import("../config.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
const chatsRoute = await import("../app/api/chats/route.ts");
const graphRoute = await import("../app/api/graph/route.ts");
const workspacesRoute = await import("../app/api/workspaces/route.ts");
const workspaceRoute = await import("../app/api/workspaces/[id]/route.ts");
const activeRoute = await import("../app/api/workspaces/active/route.ts");

const node = (id: string, chatId: string) => ({ id, name: id, statement: `${id}.`, aliases: [], createdAt: "2026-11-01", provenance: [{ chatId, messageId: "m" }] });

describe("workspace store", () => {
	it("starts with General active; creates, renames, archives and switches courses", () => {
		assert.equal(stores.workspaceStore.active(), "general");
		const la = stores.workspaceStore.create("  Linear   Algebra ");
		assert.equal(la.name, "Linear Algebra", "names are normalized");
		assert.ok(fs.existsSync(workspacePaths(la.id).chats));
		assert.ok(fs.existsSync(workspacePaths(la.id).imports));
		stores.workspaceStore.rename(la.id, "Lineare Algebra");
		assert.equal(stores.workspaceStore.get(la.id)?.name, "Lineare Algebra");
		stores.workspaceStore.setActive(la.id);
		assert.equal(stores.workspaceStore.active(), la.id);
		stores.workspaceStore.setArchived(la.id, true);
		assert.equal(stores.workspaceStore.active(), "general", "archiving the active course falls back to an open one");
		assert.throws(() => stores.workspaceStore.setActive(la.id), /Unarchive/);
		stores.workspaceStore.setArchived(la.id, false);
		assert.throws(() => stores.workspaceStore.create("   "), /needs a name/);
	});

	it("refuses to archive the last open course and to delete General", () => {
		for (const w of stores.workspaceStore.list()) if (w.id !== "general") stores.workspaceStore.setArchived(w.id, true);
		assert.throws(() => stores.workspaceStore.setArchived("general", true), /At least one course/);
		for (const w of stores.workspaceStore.list()) stores.workspaceStore.setArchived(w.id, false);
		assert.throws(() => deleteWorkspace("general"), /General course cannot be deleted/);
	});
});

describe("routing and isolation", () => {
	it("a chat, its jobs and its graph live in its own workspace; listChats names the workspace", () => {
		const bio = stores.workspaceStore.create("Biology");
		const chat = stores.chatStore.createChat("Cells", undefined, bio.id);
		assert.ok(fs.existsSync(path.join(workspacePaths(bio.id).chats, `${chat.id}.json`)));
		assert.equal(stores.workspaceStore.workspaceOfChat(chat.id), bio.id);
		assert.equal(stores.chatStore.listChats().find((c) => c.id === chat.id)?.workspaceId, bio.id);
		stores.chatStore.saveMessages(chat.id, []);
		assert.equal(stores.chatStore.getChat(chat.id)?.title, "Cells");

		const job = stores.jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call_1" });
		assert.ok(fs.existsSync(path.join(workspacePaths(bio.id).jobs, `${job.id}.json`)), "job sits in the chat's workspace");
		assert.equal(stores.jobStore.getJob(job.id)?.chatId, chat.id);
		assert.equal(stores.jobStore.listJobs(chat.id).length, 1);

		const scoped = storesForChat(chat.id)!;
		assert.equal(scoped.workspaceId, bio.id);
		scoped.graphStore.appendNode(node("n_cell", chat.id));
		assert.deepEqual(workspaceStores(bio.id).graphStore.readNodes().map((n) => n.id), ["n_cell"]);
		assert.deepEqual(workspaceStores("general").graphStore.readNodes(), [], "General's graph never sees Biology's nodes");
		assert.ok(scoped.chatStore.listChats().every((c) => c.workspaceId === bio.id), "the scoped list is the workspace's own");
	});

	it("an archived or unknown course refuses new chats", () => {
		const archived = stores.workspaceStore.create("Old course");
		stores.workspaceStore.setArchived(archived.id, true);
		assert.throws(() => stores.chatStore.createChat("x", undefined, archived.id), /archived/);
		assert.throws(() => stores.chatStore.createChat("x", undefined, "ws_missing"), /No such course/);
	});

	it("deleting a course is refused while one of its turns runs, then moves it to backups", () => {
		const doomed = stores.workspaceStore.create("Doomed");
		const chat = stores.chatStore.createChat("Busy", undefined, doomed.id);
		assert.ok(beginTurn(chat.id));
		try {
			assert.throws(() => deleteWorkspace(doomed.id), /turn is running/);
		} finally {
			endTurn(chat.id);
		}
		deleteWorkspace(doomed.id);
		assert.equal(stores.workspaceStore.get(doomed.id), null);
		assert.equal(stores.chatStore.getChat(chat.id), null, "its chats are gone from the app");
		const trash = fs.readdirSync(path.join(TMP, "backups", "deleted-workspaces"));
		assert.ok(trash.some((d) => d.startsWith(doomed.id)), "the files were moved, not erased");
	});
});

describe("routes", () => {
	it("POST /api/chats creates in the named course (else the active one); archived → 409, unknown → 404", async () => {
		const chem = stores.workspaceStore.create("Chemistry");
		const post = (body: unknown) => chatsRoute.POST(new Request("http://localhost/api/chats", { method: "POST", body: JSON.stringify(body) }));
		const named = await (await post({ title: "Acids", workspaceId: chem.id })).json();
		assert.equal(named.workspaceId, chem.id);
		assert.equal(stores.workspaceStore.workspaceOfChat(named.id), chem.id);
		const fallback = await (await post({ title: "Default" })).json();
		assert.equal(fallback.workspaceId, stores.workspaceStore.active());
		assert.equal((await post({ title: "x", workspaceId: "ws_missing" })).status, 404);
		stores.workspaceStore.setArchived(chem.id, true);
		assert.equal((await post({ title: "x", workspaceId: chem.id })).status, 409);
		stores.workspaceStore.setArchived(chem.id, false);
	});

	it("GET /api/graph reads the requested course, the chat's course, or the active course", async () => {
		const phys = stores.workspaceStore.create("Physics");
		const chat = stores.chatStore.createChat("Forces", undefined, phys.id);
		workspaceStores(phys.id).graphStore.appendNode(node("n_force", chat.id));
		const ids = async (url: string) => ((await (await graphRoute.GET(new Request(url))).json()) as { nodes: { id: string }[] }).nodes.map((n) => n.id);
		assert.ok((await ids(`http://localhost/api/graph?workspace=${phys.id}`)).includes("n_force"));
		assert.ok((await ids(`http://localhost/api/graph?chat=${chat.id}`)).includes("n_force"));
		stores.workspaceStore.setActive("general");
		assert.equal((await ids("http://localhost/api/graph")).includes("n_force"), false);
		assert.equal((await graphRoute.GET(new Request("http://localhost/api/graph?workspace=nope"))).status, 404);
	});

	it("the workspace routes create, rename, archive, switch and delete", async () => {
		const created = await workspacesRoute.POST(new Request("http://localhost/api/workspaces", { method: "POST", body: JSON.stringify({ name: "History", activate: true }) }));
		assert.equal(created.status, 201);
		const { workspace } = (await created.json()) as { workspace: { id: string } };
		assert.equal(stores.workspaceStore.active(), workspace.id);
		const patch = (body: unknown) => workspaceRoute.PATCH(new Request("http://localhost", { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id: workspace.id }) });
		assert.equal((await patch({ name: "World History" })).status, 200);
		assert.equal((await patch({})).status, 400);
		assert.equal((await patch({ archived: true })).status, 200);
		assert.equal(listWorkspaceSummaries().find((w) => w.id === workspace.id)?.archived, true);
		assert.equal((await activeRoute.PUT(new Request("http://localhost", { method: "PUT", body: JSON.stringify({ id: workspace.id }) }))).status, 409);
		assert.equal((await patch({ archived: false })).status, 200);
		const del = await workspaceRoute.DELETE(new Request("http://localhost", { method: "DELETE" }), { params: Promise.resolve({ id: workspace.id }) });
		assert.equal(del.status, 200);
		assert.equal((await workspacesRoute.GET()).status, 200);
		assert.equal(stores.workspaceStore.get(workspace.id), null);
	});
});
