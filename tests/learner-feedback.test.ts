/**
 * Per-response feedback (PLAN.md Phase 2) under an isolated LH_DATA_DIR:
 * input validation, the revision fold (edit/delete), the routes, the
 * learner-feedback marker placement law (idle + clean → appended now;
 * busy / dangling question / failed tail → waits for the next input), and
 * the form → payload mapping.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-feedback-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const { stores } = await import("../src/server/stores.ts");
const learner = await import("../src/server/learner.ts");
const { parseFeedbackInput, foldRevisions, LearnerInputError, feedbackMarkerText } = await import("../src/core/contracts/learner.ts");
const { toLlmMessages } = await import("../src/core/native-messages.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
const feedbackRoute = await import("../app/api/learner/feedback/route.ts");
const feedbackItemRoute = await import("../app/api/learner/feedback/[id]/route.ts");
const { feedbackPayloads } = await import("../components/feedback-box.tsx");
import type { LhMessage } from "../src/core/native-messages.ts";

const assistant = (id: string, extra: Record<string, unknown> = {}): LhMessage => ({
	id, role: "assistant", content: [{ type: "text", text: `Teaching ${id}.` }], api: "x", provider: "faux", model: "m",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "stop", timestamp: 1, ...extra,
} as unknown as LhMessage);

function chatWith(messages: LhMessage[]) {
	const chat = stores.chatStore.createChat("Feedback lesson");
	stores.chatStore.saveMessages(chat.id, messages);
	return chat.id;
}

describe("feedback input", () => {
	it("validates by type", () => {
		const base = { chatId: "c", messageId: "m" };
		assert.throws(() => parseFeedbackInput({ ...base, type: "rewrite" }), LearnerInputError);
		assert.throws(() => parseFeedbackInput({ ...base, type: "tags", tags: [] }), /at least one tag/);
		assert.throws(() => parseFeedbackInput({ ...base, type: "tags", tags: ["nope"] }), /subset/);
		assert.throws(() => parseFeedbackInput({ ...base, type: "rewrite", text: "x", quote: { text: "q", sourceMessageId: "m" } }), /Only/);
		const lost = parseFeedbackInput({ ...base, type: "lost", quote: { text: " the eigen part ", sourceMessageId: "m" }, tags: ["too-abstract"] });
		assert.deepEqual(lost.quote, { text: "the eigen part", sourceMessageId: "m" });
		assert.deepEqual(lost.messageIds, ["m"]);
	});

	it("folds revisions: latest wins, tombstones remove", () => {
		const items = foldRevisions([
			{ id: "a", rev: 1, v: 1 },
			{ id: "b", rev: 1, v: 1 },
			{ id: "a", rev: 2, v: 2 },
			{ id: "b", rev: 2, op: "delete" as const },
		]);
		assert.deepEqual(items, [{ id: "a", rev: 2, v: 2 }]);
	});

	it("the marker text is bracketed context with tags, quote and the learner's words", () => {
		const text = feedbackMarkerText({ type: "lost", text: "why a basis?", quote: { text: "span of v", sourceMessageId: "m" }, tags: ["steps-skipped"] });
		assert.match(text, /^\[Learner feedback/);
		assert.match(text, /Too many steps skipped/);
		assert.match(text, /"span of v"/);
		assert.match(text, /This part lost me: why a basis\?/);
	});
});

describe("feedback service and marker placement", () => {
	it("an idle, cleanly-ending chat gets the marker at once; the model sees it as user text", () => {
		const chatId = chatWith([{ id: "u1", role: "user", content: "teach me", timestamp: 1 } as LhMessage, assistant("a1")]);
		const item = learner.submitFeedback({ chatId, messageId: "a1", type: "rewrite", text: "Start from an example.", tags: ["too-abstract"] });
		assert.equal(item.workspaceId, "general");
		const record = stores.chatStore.getChat(chatId)!;
		const last = record.messages.at(-1)!;
		assert.equal(last.role, "custom");
		assert.equal((last as { customType?: string }).customType, "learner-feedback");
		const wire = toLlmMessages(record.messages);
		assert.match(JSON.stringify(wire.at(-1)), /Start from an example/);
		assert.deepEqual(learner.pendingFeedbackMarkers(chatId, record.messages), [], "delivery is derived from the record");
	});

	it("a running turn defers the marker to the next input", () => {
		const chatId = chatWith([assistant("a1")]);
		assert.ok(beginTurn(chatId));
		try {
			learner.submitFeedback({ chatId, messageId: "a1", type: "tags", tags: ["good"] });
		} finally {
			endTurn(chatId);
		}
		const record = stores.chatStore.getChat(chatId)!;
		assert.equal(record.messages.length, 1, "nothing appended mid-turn");
		assert.equal(learner.pendingFeedbackMarkers(chatId, record.messages).length, 1, "it waits for the next input");
	});

	it("never appends after a dangling question call or a failed tail", () => {
		const dangling = assistant("a1", { content: [{ type: "toolCall", id: "call_q", name: "quiz", arguments: {} }], stopReason: "toolUse" });
		assert.equal(learner.endsCleanly([dangling]), false);
		assert.equal(learner.endsCleanly([assistant("a2", { stopReason: "error" })]), false);
		assert.equal(learner.endsCleanly([{ id: "r", role: "toolResult", toolCallId: "x", toolName: "quiz", content: [], isError: false, timestamp: 1 } as unknown as LhMessage]), false);
		assert.equal(learner.endsCleanly([assistant("a3")]), true);
	});

	it("refuses feedback on a message that is not an agent response of the chat", () => {
		const chatId = chatWith([assistant("a1")]);
		assert.throws(() => learner.submitFeedback({ chatId, messageId: "nope", type: "tags", tags: ["good"] }), /agent response/);
		assert.throws(() => learner.submitFeedback({ chatId: "chat_missing", messageId: "a1", type: "tags", tags: ["good"] }), /Unknown chat/);
	});
});

describe("feedback routes", () => {
	it("POST → GET → PATCH → DELETE round-trips through the ledger", async () => {
		const chatId = chatWith([assistant("a1")]);
		const created = await feedbackRoute.POST(new Request("http://localhost/api/learner/feedback", { method: "POST", body: JSON.stringify({ chatId, messageId: "a1", type: "reading", text: "I read it as a rotation." }) }));
		assert.equal(created.status, 201);
		const { feedback } = (await created.json()) as { feedback: { id: string } };
		const listed = (await (await feedbackRoute.GET(new Request(`http://localhost/api/learner/feedback?chatId=${chatId}`))).json()) as { feedback: { id: string }[] };
		assert.deepEqual(listed.feedback.map((f) => f.id), [feedback.id]);
		const params = { params: Promise.resolve({ id: feedback.id }) };
		const patched = await feedbackItemRoute.PATCH(new Request("http://localhost", { method: "PATCH", body: JSON.stringify({ text: "A reflection, actually." }) }), params);
		assert.equal(((await patched.json()) as { feedback: { text: string; rev: number } }).feedback.rev, 2);
		assert.equal((await feedbackItemRoute.PATCH(new Request("http://localhost", { method: "PATCH", body: JSON.stringify({ text: "" }) }), params)).status, 400, "a reading needs text");
		assert.equal((await feedbackItemRoute.DELETE(new Request("http://localhost"), params)).status, 200);
		assert.deepEqual(learner.listFeedback({ chatId }), []);
		assert.equal((await feedbackRoute.POST(new Request("http://localhost", { method: "POST", body: "{}" }))).status, 400);
		assert.ok(fs.readFileSync(path.join(TMP, "learner", "feedback.jsonl"), "utf8").split("\n").filter(Boolean).length >= 3, "an append-only revision log");
		assert.ok(!fs.existsSync(path.join(TMP, "workspaces", "general", "graph", "nodes.jsonl")), "feedback never touches the workspace graph");
	});
});

describe("feedback form payloads", () => {
	it("one item per filled field; tags ride the first item or stand alone", () => {
		const quote = { text: "this", sourceMessageId: "m" };
		assert.deepEqual(feedbackPayloads({ tags: ["good"], rewrite: "", reading: "", lostQuote: null, lostNote: "" }), [{ type: "tags", tags: ["good"] }]);
		const many = feedbackPayloads({ tags: ["too-abstract"], rewrite: " mine ", reading: "", lostQuote: quote, lostNote: "" });
		assert.deepEqual(many.map((p) => [p.type, p.tags]), [["rewrite", ["too-abstract"]], ["lost", []]]);
		assert.deepEqual(many[1]!.quote, quote);
		assert.deepEqual(feedbackPayloads({ tags: [], rewrite: "", reading: "", lostQuote: null, lostNote: "" }), []);
	});
});
