/**
 * The reasoning-style model (PLAN.md Phase 3): input collection over every
 * learner channel, the deterministic profile fold (activation threshold,
 * feedback activates at once, conflicts lower confidence without silently
 * replacing, switches with history, pins, edits, deletions, tag mapping),
 * the token-budgeted learner-context summary, and the tracer end to end on
 * a scripted faux engine under an isolated LH_DATA_DIR.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-learner-model-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const { learnerInputsOf, worthTracing, feedbackInput } = await import("../src/core/learner-traces.ts");
const { foldProfile, effectiveScalar } = await import("../src/core/learner-profile.ts");
const { renderLearnerContext } = await import("../src/core/learner-context.ts");
const { emptyProfileUserState } = await import("../src/core/contracts/learner.ts");
const { stores } = await import("../src/server/stores.ts");
const model = await import("../src/server/learner-model.ts");
const { tracerInstructions } = await import("../src/agent/subagents/tracer.ts");
import type { FeedbackItem, ReasoningTrace } from "../src/core/contracts/learner.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const NOW = "2026-11-01T12:00:00.000Z";
const opts = { activationSessions: 3, feedbackWeight: 3, now: NOW };

function trace(chatId: string, overrides: Partial<ReasoningTrace> = {}, at = "2026-10-01T00:00:00.000Z"): ReasoningTrace {
	return {
		id: `tr_${chatId}_${Math.random().toString(36).slice(2, 8)}`, rev: 1, key: `${chatId}:k`, type: "trace",
		evidence: { workspaceId: "general", chatId, messageId: "m", kind: "thinking", at },
		steps: [], assumptionsUsed: [], assumptionsMissing: [], references: [], entryPoint: "example-first",
		signals: { notation: [], formatting: [] }, bridges: [], confidence: 1, model: "faux", createdAt: at, ...overrides,
	};
}

function feedback(overrides: Partial<FeedbackItem>): FeedbackItem {
	return { id: "fb_1", rev: 1, workspaceId: "general", chatId: "c9", messageId: "a1", messageIds: ["a1"], type: "tags", tags: [], createdAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z", ...overrides };
}

const assistant = (id: string, text: string): LhMessage => ({ id, role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 1 } as unknown as LhMessage);

describe("learner inputs", () => {
	it("collects composer, answer, thinking, reading-thinking and practice thinking, each with its context", () => {
		const messages: LhMessage[] = [
			{ id: "u1", role: "user", content: "I want to understand eigenvectors because the steady state of a Markov chain looked like one", timestamp: 1 } as LhMessage,
			assistant("a1", "An eigenvector keeps its direction."),
			{ id: "r1", role: "toolResult", toolCallId: "q1", toolName: "quiz", isError: false, timestamp: 2, content: [],
				details: { kind: "quiz", questionText: "Which vector stays on its line?", dontKnow: false, answers: [{ label: "v1", value: "a", index: 1 }], thinking: "I pictured the matrix stretching the plane", readingThinking: "this sounds like the steady state idea", answeredAt: NOW } } as unknown as LhMessage,
			{ id: "p1", role: "custom", customType: "practice-thinking", content: "", display: true, timestamp: 3, details: { problemCallId: "x", text: "first I would normalize the vector then compare" } } as unknown as LhMessage,
		];
		const inputs = learnerInputsOf(messages);
		assert.deepEqual(inputs.map((i) => i.key), ["u1:composer", "r1:answer", "r1:thinking", "r1:readingThinking", "p1:practiceThinking"]);
		const thinking = inputs.find((i) => i.kind === "thinking")!;
		assert.equal(thinking.respondingTo, "a1");
		assert.match(thinking.context!, /keeps its direction[\s\S]*Question: Which vector/);
		assert.equal(inputs.find((i) => i.kind === "answer")!.text, "Chose: v1");
		assert.equal(worthTracing("answer", "Chose: v1"), false, "a bare choice holds no reasoning");
		assert.equal(worthTracing("thinking", "I pictured the matrix stretching"), true);
		assert.equal(worthTracing("composer", "ok continue"), false);
	});

	it("feedback becomes an input keyed by its id", () => {
		const input = feedbackInput(feedback({ id: "fb_9", type: "rewrite", text: "start with a 2x2 example", tags: ["too-abstract"] }), "prose");
		assert.equal(input.key, "fb:fb_9");
		assert.match(input.text, /Too abstract[\s\S]*How I would say it: start with a 2x2 example/);
	});
});

describe("profile fold", () => {
	it("an inferred trait turns active only after the configured number of separate sessions", () => {
		const two = foldProfile({ traces: [trace("c1"), trace("c2"), trace("c2")], feedback: [], pushes: [] }, emptyProfileUserState(), null, opts);
		assert.equal(two.scalars.entryPoint?.status, "candidate");
		assert.equal(two.scalars.entryPoint?.sessions, 2);
		const three = foldProfile({ traces: [trace("c1"), trace("c2"), trace("c3")], feedback: [], pushes: [] }, emptyProfileUserState(), two, opts);
		assert.equal(three.scalars.entryPoint?.status, "active");
		assert.equal(three.scalars.entryPoint?.evidence[0]?.chatId !== undefined, true, "evidence links to its source");
		const lower = foldProfile({ traces: [trace("c1"), trace("c2")], feedback: [], pushes: [] }, emptyProfileUserState(), null, { ...opts, activationSessions: 2 });
		assert.equal(lower.scalars.entryPoint?.status, "active", "the threshold is configurable");
	});

	it("feedback activates at once and maps quick tags without a model", () => {
		const p = foldProfile({ traces: [], feedback: [feedback({ tags: ["too-abstract", "steps-skipped"] })], pushes: [] }, emptyProfileUserState(), null, opts);
		assert.equal(p.scalars.abstraction?.value, "concrete");
		assert.equal(p.scalars.abstraction?.status, "active");
		assert.equal(p.scalars.abstraction?.source, "feedback");
		assert.equal(p.scalars.stepSize?.value, "small");
	});

	it("conflicting evidence lowers confidence but never silently replaces; a stronger activatable value switches with history", () => {
		const base = [trace("c1"), trace("c2"), trace("c3")];
		const p1 = foldProfile({ traces: base, feedback: [], pushes: [] }, emptyProfileUserState(), null, opts);
		const conflict = [...base, trace("c4", { entryPoint: "definition-first" })];
		const p2 = foldProfile({ traces: conflict, feedback: [], pushes: [] }, emptyProfileUserState(), p1, opts);
		assert.equal(p2.scalars.entryPoint?.value, "example-first", "one conflicting session does not replace it");
		assert.ok(p2.scalars.entryPoint!.confidence < p1.scalars.entryPoint!.confidence, "confidence drops");
		assert.equal(p2.scalars.entryPoint?.alternatives[0]?.value, "definition-first");
		const many = [...conflict, ...["c5", "c6", "c7", "c8"].map((c) => trace(c, { entryPoint: "definition-first" }))];
		const p3 = foldProfile({ traces: many, feedback: [], pushes: [] }, emptyProfileUserState(), p2, opts);
		assert.equal(p3.scalars.entryPoint?.value, "definition-first");
		assert.ok(p3.scalars.entryPoint!.history.some((h) => /replaced “example-first”/.test(h.reason)), "the switch is in the history");
		const pinned = { ...emptyProfileUserState(), pins: { entryPoint: true } };
		const p4 = foldProfile({ traces: many, feedback: [], pushes: [] }, pinned, p2, opts);
		assert.equal(p4.scalars.entryPoint?.value, "example-first", "a pinned trait never switches");
	});

	it("an edit is active at once and wins; a deletion ignores earlier evidence; wrong-start counts against", () => {
		const user = { ...emptyProfileUserState(), edits: { stepSize: { value: "small", at: NOW } } };
		const p = foldProfile({ traces: [trace("c1", { signals: { stepSize: "large", notation: [], formatting: [] } })], feedback: [], pushes: [] }, user, null, opts);
		assert.equal(p.scalars.stepSize?.value, "small");
		assert.equal(p.scalars.stepSize?.source, "edited");
		assert.equal(p.scalars.stepSize?.status, "active");
		const deleted = { ...emptyProfileUserState(), deleted: { entryPoint: "2026-10-15T00:00:00.000Z" } };
		const d = foldProfile({ traces: [trace("c1"), trace("c2"), trace("c3")], feedback: [], pushes: [] }, deleted, null, opts);
		assert.equal(d.scalars.entryPoint, undefined);
		const later = foldProfile({ traces: [trace("c1", {}, "2026-10-20T00:00:00.000Z")], feedback: [], pushes: [] }, deleted, null, opts);
		assert.equal(later.scalars.entryPoint?.status, "candidate", "later evidence can bring it back");
		const against = foldProfile({ traces: [trace("c1"), trace("c2"), trace("c3")], feedback: [feedback({ tags: ["wrong-start"] })], pushes: [] }, emptyProfileUserState(), null, opts);
		const plain = foldProfile({ traces: [trace("c1"), trace("c2"), trace("c3")], feedback: [], pushes: [] }, emptyProfileUserState(), null, opts);
		assert.ok(against.scalars.entryPoint!.confidence < plain.scalars.entryPoint!.confidence);
	});

	it("list traits collect items with their own evidence; added items are active; per-course overrides apply", () => {
		const traces = ["c1", "c2", "c3"].map((c) => trace(c, { references: [{ kind: "analogy", text: "steady state", domain: "Markov chains" }], assumptionsMissing: ["what a basis is"] }));
		const user = { ...emptyProfileUserState(), addedItems: { notation: [{ value: "column vectors", at: NOW }] }, overrides: { ws_la: { entryPoint: { value: "visual", at: NOW } } } };
		const p = foldProfile({ traces, feedback: [], pushes: [] }, user, null, opts);
		assert.equal(p.lists.analogyDomains.items[0]?.value, "Markov chains");
		assert.equal(p.lists.analogyDomains.items[0]?.status, "active");
		assert.equal(p.lists.missingAssumptions.items[0]?.sessions, 3);
		assert.equal(p.lists.notation.items[0]?.source, "edited");
		assert.deepEqual(effectiveScalar(p, "entryPoint", "ws_la"), { value: "visual", confidence: 1, override: true });
		assert.equal(effectiveScalar(p, "entryPoint", "general")?.value, "example-first");
	});
});

describe("learner context", () => {
	it("renders active traits within the budget; the fingerprint follows active values only", () => {
		const traces = ["c1", "c2", "c3"].map((c) => trace(c));
		const p = foldProfile({ traces, feedback: [], pushes: [] }, emptyProfileUserState(), null, opts);
		const ctx = renderLearnerContext(p, "general", [feedback({ type: "rewrite", text: "Start from a picture.", tags: [] })], { budgetTokens: 600, feedbackItems: 5 })!;
		assert.match(ctx.text, /^\[How this learner learns/);
		assert.match(ctx.text, /Preferred entry point: example-first/);
		assert.match(ctx.text, /Start from a picture/);
		const again = renderLearnerContext(p, "general", [], { budgetTokens: 600, feedbackItems: 5 })!;
		assert.equal(again.fingerprint, ctx.fingerprint, "feedback does not change the fingerprint");
		const tiny = renderLearnerContext(p, "general", Array.from({ length: 5 }, (_, i) => feedback({ id: `f${i}`, type: "rewrite", text: "x".repeat(200), tags: [] })), { budgetTokens: 100, feedbackItems: 5 })!;
		assert.ok(tiny.text.length <= 400, "the budget holds");
		assert.equal(renderLearnerContext(null, "general", [], { budgetTokens: 600, feedbackItems: 5 }), null);
	});
});

describe("tracer end to end (faux engine)", () => {
	it("traces untraced inputs once, links them to their source, updates the profile and injects context", async () => {
		assert.match(tracerInstructions({}), /record HOW they reasoned/);
		const chat = stores.chatStore.createChat("Eigen");
		stores.chatStore.saveMessages(chat.id, [
			assistant("a1", "An eigenvector keeps its direction under the map."),
			{ id: "u1", role: "user", content: "So it is like the steady state of a Markov chain, the distribution that does not change when you apply the matrix again", timestamp: 2 } as LhMessage,
		]);
		let calls = 0;
		const faux = createFauxCore({});
		faux.setResponses([() => {
			calls++;
			return fauxAssistantMessage([fauxToolCall("submit_traces", { traces: [{
				inputId: "1", steps: ["recalls the steady state", "maps it onto eigenvectors"], assumptionsUsed: ["matrix powers"], assumptionsMissing: [],
				references: [{ kind: "analogy", text: "steady state", domain: "Markov chains" }], entryPoint: "analogy",
				signals: { abstraction: "concrete" }, bridges: [{ from: "steady state", to: "eigenvector", type: "understood-through", wording: "it is like the steady state" }], confidence: 0.9,
			}] })], { stopReason: "toolUse" });
		}]);
		const engine = { model: faux.getModel(), streamFn: faux.streamSimple } as never;
		assert.equal(await model.runTracingFor(chat.id, engine), 1);
		assert.equal(await model.runTracingFor(chat.id, engine), 0, "an input is traced once");
		assert.equal(calls, 1);
		const [t] = model.listTraces({ chatId: chat.id });
		assert.equal(t!.evidence.messageId, "u1");
		assert.equal(t!.evidence.kind, "composer");
		assert.equal(t!.evidence.workspaceId, "general");
		assert.equal(model.readProfile()?.scalars.entryPoint?.value, "analogy");

		model.applyTraitAction("entryPoint", { action: "edit", value: "example-first" });
		const marker = model.learnerContextMarkerFor(chat.id, stores.chatStore.getChat(chat.id)!.messages);
		assert.ok(marker, "an edited (active) trait produces a context marker");
		assert.match(marker!.content, /example-first/);
		assert.equal(model.learnerContextMarkerFor(chat.id, [marker! as LhMessage]), null, "same fingerprint → no refresh");

		model.deleteTrace(t!.id);
		assert.equal(model.listTraces({ chatId: chat.id }).length, 0);
		assert.equal(await model.runTracingFor(chat.id, engine), 0, "a deleted trace is never re-extracted");
		assert.throws(() => model.applyTraitAction("entryPoint", { action: "edit", value: "nonsense" }), /must be one of/);
		assert.throws(() => model.applyTraitAction("bogus", { action: "delete" }), /Unknown trait/);
	});
});
