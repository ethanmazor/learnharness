/**
 * Assumptions and recursive descent (PLAN.md Phase 4): the record-derived
 * learning stack (learner push/jump/close markers + the Teacher's clean
 * stack_push/stack_pop calls), the stack input event, the tools' validation
 * and depth limit, and stack evidence → missing assumptions + resolutions.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-stack-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const { foldLearningStack, newStackMarker, ROOT_LABEL } = await import("../src/core/learning-stack.ts");
const { parseChatInput, inputAppends, ChatInputError } = await import("../src/core/input-events.ts");
const { toLlmMessages } = await import("../src/core/native-messages.ts");
const { stackTools, assumptionsTool } = await import("../src/agent/tools/learner.ts");
const { stores } = await import("../src/server/stores.ts");
const model = await import("../src/server/learner-model.ts");
import type { LhMessage } from "../src/core/native-messages.ts";

const assistantCall = (id: string, name: string, args: unknown): LhMessage => ({ id, role: "assistant", content: [{ type: "toolCall", id: `call_${id}`, name, arguments: args }], stopReason: "toolUse", timestamp: 1 } as unknown as LhMessage);
const result = (id: string, name: string, isError = false): LhMessage => ({ id: `r_${id}`, role: "toolResult", toolCallId: `call_${id}`, toolName: name, content: [{ type: "text", text: "ok" }], isError, timestamp: 1 } as unknown as LhMessage);
const assistant = (id: string): LhMessage => ({ id, role: "assistant", content: [{ type: "text", text: "Teaching." }], stopReason: "stop", timestamp: 1 } as unknown as LhMessage);

describe("learning stack fold", () => {
	it("learner pushes and agent pushes stack up; pops, closes and jumps unwind with resolution events", () => {
		let messages: LhMessage[] = [assistant("a0")];
		const pushA = newStackMarker(messages, { action: "push", label: "What a basis is", origin: { kind: "chip", ref: "x" } }, 4);
		messages = [...messages, pushA, assistantCall("p1", "stack_push", { label: "Linear independence", statement: "…" }), result("p1", "stack_push")];
		let state = foldLearningStack(messages);
		assert.deepEqual(state.frames.map((f) => f.label), ["What a basis is", "Linear independence"]);
		assert.equal(state.events[1]!.type === "push" && state.events[1]!.neededBy, "What a basis is");

		messages = [...messages, assistantCall("p2", "stack_pop", { evidence: "they explained it" }), result("p2", "stack_pop")];
		state = foldLearningStack(messages);
		assert.deepEqual(state.frames.map((f) => f.label), ["What a basis is"]);
		const resolved = state.events.at(-1)!;
		assert.equal(resolved.type, "resolve");
		assert.equal(resolved.type === "resolve" && resolved.outcome, "understood");
		assert.equal(resolved.type === "resolve" && resolved.neededBy, "What a basis is");

		const failed = foldLearningStack([...messages, assistantCall("p3", "stack_pop", {}), result("p3", "stack_pop", true)]);
		assert.equal(failed.frames.length, 1, "an errored pop never happened");

		const close = newStackMarker(messages, { action: "close", frameId: state.frames[0]!.id }, 4);
		assert.equal(foldLearningStack([...messages, close]).frames.length, 0);
		const jump = newStackMarker(messages, { action: "jump", frameId: "root" }, 4);
		const jumped = foldLearningStack([...messages, jump]);
		assert.equal(jumped.frames.length, 0);
		assert.equal(jumped.events.at(-1)!.type === "resolve" && jumped.events.at(-1)!.type, "resolve");
	});

	it("refuses pushes past the depth limit and invalid jumps/closes; the model reads the bracketed text", () => {
		const one = newStackMarker([], { action: "push", label: "A" }, 1);
		assert.throws(() => newStackMarker([one], { action: "push", label: "B" }, 1), /maximum depth \(1\)/);
		assert.throws(() => newStackMarker([one], { action: "close", frameId: "nope" }, 4), /top level/);
		assert.throws(() => newStackMarker([one], { action: "jump", frameId: "nope" }, 4), /no longer/);
		assert.match(JSON.stringify(toLlmMessages([one])), /\[Learning stack — level 1\][\s\S]*needed for: Original problem/);
		assert.equal(ROOT_LABEL, "Original problem");
	});
});

describe("stack input event", () => {
	it("parses, appends a marker, and never lands after a dangling question", () => {
		const input = parseChatInput({ type: "stack", action: "push", label: "eigenvalues", origin: { kind: "chip", ref: "c:a1" } });
		const appends = inputAppends({ messages: [assistant("a1")], stackMaxDepth: 4 }, input);
		assert.equal(appends.at(-1)!.role, "custom");
		assert.throws(() => parseChatInput({ type: "stack", action: "push" }), ChatInputError);
		assert.throws(() => parseChatInput({ type: "stack", action: "jump" }), /frameId/);
		const dangling = assistantCall("q", "ask_user_question", { question: "Next topic?", options: [{ label: "Chemistry" }, { label: "History" }] });
		assert.throws(() => inputAppends({ messages: [dangling] }, input), /open question/);
		const deep = inputAppends({ messages: [], stackMaxDepth: 1 }, input);
		assert.throws(() => inputAppends({ messages: deep, stackMaxDepth: 1 }, input), /maximum depth/);
	});
});

describe("learner tools", () => {
	const ctx = (messages: LhMessage[], maxDepth = 2) => ({ chatId: "c", chatStore: { getChat: () => ({ messages }) } as never, maxDepth: () => maxDepth });

	it("stack_push respects the depth limit including pushes earlier in the same run; stack_pop needs a frame", async () => {
		const tools = stackTools(ctx([]));
		const push = (label: string) => tools.stack_push!.execute(`c_${label}`, { label, statement: "s" }, undefined as never);
		assert.equal((await push("A")).isError, undefined);
		assert.equal((await push("B")).isError, undefined);
		const third = await push("C");
		assert.equal(third.isError, true, "the run's own pushes count toward the limit");
		const popped = await tools.stack_pop!.execute("c_pop", { evidence: "explained" }, undefined as never);
		assert.match(JSON.stringify(popped.content), /Popped \\"B\\"[\s\S]*Return to \\"A\\"/);
		const empty = stackTools(ctx([]));
		assert.equal((await empty.stack_pop!.execute("x", { evidence: "e" }, undefined as never)).isError, true);
	});

	it("assumptions validates unique ids and diff references", async () => {
		const tool = assumptionsTool();
		const ok = await tool.execute("a", { items: [{ id: "a1", label: "linearity", statement: "T(x+y)=T(x)+T(y)", kind: "assumption" }] }, undefined as never);
		assert.equal(ok.isError, undefined);
		const dup = await tool.execute("b", { items: [{ id: "a1", label: "x", statement: "x", kind: "assumption" }, { id: "a1", label: "y", statement: "y", kind: "prerequisite" }] }, undefined as never);
		assert.equal(dup.isError, true);
		const badDiff = await tool.execute("c", { items: [{ id: "a1", label: "x", statement: "x", kind: "assumption" }], diff: { usedNotByLearner: ["zz"], divergence: [] } }, undefined as never);
		assert.equal(badDiff.isError, true);
	});
});

describe("stack evidence", () => {
	it("pushes become missing-assumption evidence and resolutions are recorded once", () => {
		const chat = stores.chatStore.createChat("Stack lesson");
		const push = newStackMarker([assistant("a1")], { action: "push", label: "What a basis is" }, 4);
		const frameId = foldLearningStack([push]).frames[0]!.id;
		const close = newStackMarker([assistant("a1"), push], { action: "close", frameId }, 4);
		stores.chatStore.saveMessages(chat.id, [assistant("a1"), push, close]);
		let resolved: string[] = [];
		model.onStackResolved((rs) => { resolved = rs.map((r) => `${r.assumption}→${r.neededBy}:${r.outcome}`); });
		assert.equal(model.recordStackEvidence(chat.id), 2);
		assert.equal(model.recordStackEvidence(chat.id), 0, "idempotent");
		assert.deepEqual(resolved, ["What a basis is→Original problem:closed"]);
		const profile = model.recomputeProfile();
		assert.equal(profile.lists.missingAssumptions.items[0]?.value, "What a basis is");
		assert.equal(profile.lists.missingAssumptions.items[0]?.evidence[0]?.kind, "stack");
	});
});
