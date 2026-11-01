/**
 * The learner's concept bridges (PLAN.md Phase 5): concept matching, the
 * trusted N-hop path search, proposals from traces and resolved stack
 * levels (suggestions only), confirm / reject / edit-keeps-history /
 * delete, objective-graph links, the my_bridges answer, and the routes —
 * under an isolated LH_DATA_DIR.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-bridges-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const { matchConcept, bridgePaths } = await import("../src/core/learner-bridges.ts");
const { stores, workspaceStores } = await import("../src/server/stores.ts");
const bridges = await import("../src/server/learner-bridges.ts");
const bridgesRoute = await import("../app/api/learner/bridges/route.ts");
const bridgeRoute = await import("../app/api/learner/bridges/[id]/route.ts");
const { myBridgesTool } = await import("../src/agent/tools/learner.ts");
import type { LearnerConcept, LearnerEdge, ReasoningTrace, StackResolution } from "../src/core/contracts/learner.ts";

const concept = (id: string, label: string, aliases: string[] = []): LearnerConcept => ({ id, rev: 1, label, aliases, workspaces: [], objectiveLinks: [], createdAt: "", updatedAt: "" });
const edge = (id: string, from: string, to: string, type: LearnerEdge["type"], source: LearnerEdge["source"] = "mine", extra: Partial<LearnerEdge> = {}): LearnerEdge => ({ id, rev: 1, from, to, type, source, confidence: 1, evidence: [], createdAt: "", updatedAt: "", ...extra });

describe("pure queries", () => {
	it("matches concepts by name, alias, plural and strong word overlap — not loosely", () => {
		const cs = [concept("c1", "Eigenvector"), concept("c2", "Markov chain steady state", ["stationary distribution"])];
		assert.equal(matchConcept(cs, "eigenvectors")?.id, "c1");
		assert.equal(matchConcept(cs, "Stationary distribution")?.id, "c2");
		assert.equal(matchConcept(cs, "steady state of a Markov chain")?.id, "c2");
		assert.equal(matchConcept(cs, "matrix determinant"), null);
	});

	it("finds trusted paths of up to N hops leading to the target; symmetric links both ways; no cycles", () => {
		const edges = [
			edge("e1", "markov", "eigen", "understood-through"),
			edge("e2", "springs", "markov", "analogy"),
			edge("e3", "eigen", "pca", "prerequisite-for-me"),
			edge("e4", "guess", "eigen", "understood-through", "extracted-unconfirmed"),
			edge("e5", "old", "eigen", "understood-through", "mine", { validUntil: "x" }),
			edge("e6", "eigen", "markov", "analogy"),
		];
		const one = bridgePaths(edges, "eigen", 1);
		assert.deepEqual(one.map((p) => p.start).sort(), ["markov", "markov"], "direct + the symmetric analogy, never the suggestion or the replaced edge");
		const two = bridgePaths(edges, "eigen", 2);
		assert.ok(two.some((p) => p.start === "springs" && p.steps.length === 2), "two hops through the analogy");
		assert.ok(!bridgePaths(edges, "eigen", 4).some((p) => p.start === "pca"), "a directional edge is not followed backwards");
	});
});

describe("bridge service", () => {
	const trace = (bridgesIn: ReasoningTrace["bridges"]): ReasoningTrace => ({
		id: "tr_1", rev: 1, key: "k", type: "trace", evidence: { workspaceId: "general", chatId: "chat_x", messageId: "m1", kind: "thinking", at: "2026-11-01T00:00:00.000Z" },
		steps: [], assumptionsUsed: [], assumptionsMissing: [], references: [], entryPoint: "analogy", signals: { notation: [], formatting: [] }, bridges: bridgesIn, confidence: 0.8, model: "faux", createdAt: "",
	});

	it("traces propose suggestions; only confirmed links reach the agent; rejection sticks", () => {
		bridges.proposeFromTraces([trace([{ from: "Markov chain steady state", to: "eigenvectors", type: "understood-through", wording: "it's the steady state again" }])]);
		let view = bridges.listBridges();
		assert.equal(view.edges.length, 1);
		assert.equal(view.edges[0]!.source, "extracted-unconfirmed");
		assert.match(bridges.bridgeAnswer("eigenvector"), /no trusted link/, "a suggestion is not used yet");
		bridges.changeBridge(view.edges[0]!.id, { action: "confirm" });
		const answer = bridges.bridgeAnswer("eigenvectors");
		assert.match(answer, /From Markov chain steady state[\s\S]*helps me understand[\s\S]*it's the steady state again/);
		// The same link proposed again folds into it (no duplicate).
		bridges.proposeFromTraces([trace([{ from: "markov chain steady state", to: "Eigenvector", type: "understood-through" }])]);
		view = bridges.listBridges();
		assert.equal(view.edges.length, 1);
		assert.equal(view.edges[0]!.evidence.length, 2);
		// A rejected suggestion is never re-suggested.
		bridges.proposeFromTraces([trace([{ from: "cooking", to: "eigenvectors", type: "analogy" }])]);
		const cooking = bridges.listBridges().edges.find((e) => e.source === "extracted-unconfirmed")!;
		bridges.changeBridge(cooking.id, { action: "reject" });
		bridges.proposeFromTraces([trace([{ from: "cooking", to: "eigenvectors", type: "analogy" }])]);
		assert.ok(!bridges.listBridges().edges.some((e) => e.source === "extracted-unconfirmed"));
	});

	it("an edit replaces the link but keeps the old one, marked replaced", () => {
		const added = bridges.addBridge({ from: "recursion", to: "induction", type: "same-structure", wording: "same shape" });
		const edited = bridges.changeBridge(added.id, { action: "edit", wording: "base case plus step" });
		const all = bridges.listBridges({ history: true }).edges;
		const old = all.find((e) => e.id === added.id)!;
		assert.equal(old.replacedBy, edited.id);
		assert.ok(old.validUntil);
		assert.ok(!bridges.listBridges().edges.some((e) => e.id === added.id), "the current view hides the replaced link");
		assert.throws(() => bridges.changeBridge(added.id, { action: "confirm" }), /replaced/);
		bridges.deleteBridge(edited.id);
		assert.ok(!bridges.listBridges().edges.some((e) => e.id === edited.id));
	});

	it("a resolved stack level links the assumption to what needed it; closed levels do not", () => {
		const chat = stores.chatStore.createChat("Eigen lesson");
		const r = (outcome: StackResolution["outcome"], neededBy: string): StackResolution => ({ id: `st_${outcome}`, rev: 1, key: outcome, type: "stack-resolution", evidence: { workspaceId: "general", chatId: chat.id, messageId: "m", kind: "stack", at: "" }, assumption: "basis", neededBy, outcome, createdAt: "" });
		assert.equal(bridges.proposeFromResolutions([r("understood", "Original problem"), r("closed", "span")]), 1);
		const names = new Map(bridges.listBridges().concepts.map((c) => [c.id, c.label]));
		const link = bridges.listBridges().edges.find((e) => e.type === "prerequisite-for-me")!;
		assert.equal(names.get(link.from), "basis");
		assert.equal(names.get(link.to), "Eigen lesson", "the root resolves to the chat title");
	});

	it("concepts link to a same-named node of the course's objective graph (read-only)", () => {
		const { graphStore } = workspaceStores("general");
		graphStore.appendNode({ id: "n_det", name: "Determinant", statement: "…", aliases: [], createdAt: "", provenance: [] });
		const before = fs.readFileSync(path.join(TMP, "workspaces", "general", "graph", "nodes.jsonl"), "utf8");
		const c = bridges.ensureConcept("determinant", "general");
		assert.deepEqual(c.objectiveLinks, [{ workspaceId: "general", nodeId: "n_det" }]);
		assert.equal(fs.readFileSync(path.join(TMP, "workspaces", "general", "graph", "nodes.jsonl"), "utf8"), before, "the objective graph is untouched");
	});
});

describe("routes and tool", () => {
	it("POST/PATCH/DELETE round-trip; my_bridges answers through the query seam", async () => {
		const res = await bridgesRoute.POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ from: "vectors as arrows", to: "linear maps", type: "understood-through" }) }));
		assert.equal(res.status, 201);
		const { edge: created } = (await res.json()) as { edge: { id: string } };
		assert.equal((await bridgesRoute.POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ from: "x", to: "x", type: "analogy" }) }))).status, 400);
		assert.equal((await bridgesRoute.POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ from: "a", to: "b", type: "nope" }) }))).status, 400);
		const listed = (await (await bridgesRoute.GET(new Request("http://localhost/api/learner/bridges"))).json()) as { edges: { id: string }[] };
		assert.ok(listed.edges.some((e) => e.id === created.id));
		assert.equal((await bridgeRoute.PATCH(new Request("http://localhost", { method: "PATCH", body: JSON.stringify({ action: "confirm" }) }), { params: Promise.resolve({ id: created.id }) })).status, 400, "only suggestions confirm");
		assert.equal((await bridgeRoute.DELETE(new Request("http://localhost"), { params: Promise.resolve({ id: created.id }) })).status, 200);
		assert.equal((await bridgeRoute.DELETE(new Request("http://localhost"), { params: Promise.resolve({ id: created.id }) })).status, 404);
		const tool = myBridgesTool((c) => `answer for ${c}`);
		const out = await tool.execute("t", { concept: "eigen" }, undefined as never);
		assert.match(JSON.stringify(out.content), /answer for eigen/);
		assert.ok(fs.existsSync(path.join(TMP, "learner", "edges.jsonl")) && fs.existsSync(path.join(TMP, "learner", "concepts.jsonl")));
	});
});
