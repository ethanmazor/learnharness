/**
 * THE REASONING-STYLE MODEL — server orchestration (PLAN.md Phase 3):
 *
 *  - TRACING: after a turn settles (and after feedback with words), the
 *    chat's untraced learner inputs go to the trace extractor (cheap slot,
 *    batched, single-flight per chat). Each trace lands in
 *    learner/traces.jsonl linked to its source message.
 *  - THE PROFILE: learner/profile.json is recomputed from the ledgers by the
 *    pure fold (core/learner-profile.ts) after every change — traces,
 *    feedback, the learner's own edits/pins/deletions.
 *  - CONTEXT: learnerContextMarkerFor builds the session's learner-context
 *    marker when the active-trait fingerprint changed (decision D2).
 */

import type { PiEngine } from "../agent/models.ts";
import { runTracer, type ExtractedTrace } from "../agent/subagents/tracer.ts";
import {
	emptyProfileUserState,
	foldRevisions,
	itemKey,
	LearnerInputError,
	LIST_TRAITS,
	SCALAR_TRAIT_VALUES,
	SCALAR_TRAITS,
	type FeedbackItem,
	type LearnerInput,
	type LearnerProfile,
	type ListTraitKey,
	type ReasoningTrace,
	type ScalarTraitKey,
	type StackPushEvidence,
	type StackResolution,
	type Tombstone,
	type TraceLedgerEntry,
	type TraitKey,
} from "../core/contracts/learner.ts";
import { emit } from "../core/events.ts";
import { renderLearnerContext } from "../core/learner-context.ts";
import { foldProfile } from "../core/learner-profile.ts";
import { assistantProse, feedbackInput, learnerInputsOf, worthTracing } from "../core/learner-traces.ts";
import { foldLearningStack } from "../core/learning-stack.ts";
import { lastLearnerContextFingerprint, newLearnerContextMessage, type LhMarkerMessage, type LhMessage } from "../core/native-messages.ts";
import { listFeedback, onFeedbackChanged } from "./learner.ts";
import { effectiveSettings, stores } from "./stores.ts";

const BATCH = 6;

// ─── the ledger reads ────────────────────────────────────────────────────────

function traceLines(): Array<TraceLedgerEntry | Tombstone> {
	return stores.learnerStore.readLines("traces") as unknown as Array<TraceLedgerEntry | Tombstone>;
}

/** Live trace-ledger entries (traces, stack pushes, stack resolutions). */
export function listTraceEntries(filter: { chatId?: string; workspaceId?: string } = {}): TraceLedgerEntry[] {
	return foldRevisions<TraceLedgerEntry>(traceLines()).filter(
		(e) => (!filter.chatId || e.evidence.chatId === filter.chatId) && (!filter.workspaceId || e.evidence.workspaceId === filter.workspaceId),
	);
}

export function listTraces(filter: { chatId?: string; workspaceId?: string } = {}): ReasoningTrace[] {
	return listTraceEntries(filter).filter((e): e is ReasoningTrace => e.type === "trace");
}

/** Every input key ever traced — tombstones included (a deleted trace is
 *  never re-extracted). */
function tracedKeys(): Set<string> {
	const keys = new Set<string>();
	for (const line of traceLines()) if (typeof line.key === "string") keys.add(line.key);
	return keys;
}

export function deleteTrace(id: string): void {
	const current = listTraceEntries().find((e) => e.id === id);
	if (!current) throw new LearnerInputError("No such trace");
	stores.learnerStore.appendLine("traces", { id, rev: current.rev + 1, op: "delete", at: new Date().toISOString(), key: current.key } satisfies Tombstone);
	recomputeProfile();
	emit("learner-changed", { chatId: current.evidence.chatId });
}

// ─── the profile ─────────────────────────────────────────────────────────────

export function readProfile(): LearnerProfile | null {
	const raw = stores.learnerStore.readProfile() as LearnerProfile | null;
	if (!raw || typeof raw !== "object" || raw.version !== 1 || !raw.user || !raw.lists) return null;
	return raw;
}

/** Recompute and persist the profile from the ledgers + the learner's own
 *  decisions. Cheap (a few small files); called after every change. */
export function recomputeProfile(): LearnerProfile {
	const prev = readProfile();
	const learner = effectiveSettings().learner;
	const entries = listTraceEntries();
	const profile = foldProfile(
		{
			traces: entries.filter((e): e is ReasoningTrace => e.type === "trace"),
			feedback: listFeedback(),
			pushes: entries.filter((e): e is StackPushEvidence => e.type === "stack-push"),
		},
		prev?.user ?? emptyProfileUserState(),
		prev,
		{ activationSessions: learner.activationSessions, feedbackWeight: learner.feedbackWeight, now: new Date().toISOString() },
	);
	stores.learnerStore.writeProfile(profile);
	return profile;
}

const isScalar = (key: string): key is ScalarTraitKey => (SCALAR_TRAITS as readonly string[]).includes(key);
const isList = (key: string): key is ListTraitKey => (LIST_TRAITS as readonly string[]).includes(key);

/** The learner's own decisions on a trait (the "How I learn" panel). */
export type TraitAction =
	| { action: "edit"; value: string }
	| { action: "pin"; pinned: boolean; item?: string }
	| { action: "delete"; item?: string }
	| { action: "add-item"; value: string }
	| { action: "override"; workspaceId: string; value: string | null };

export function parseTraitAction(raw: unknown): TraitAction {
	const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : null);
	switch (r.action) {
		case "edit": {
			const value = str(r.value);
			if (!value) throw new LearnerInputError("edit needs a value");
			return { action: "edit", value };
		}
		case "pin":
			if (typeof r.pinned !== "boolean") throw new LearnerInputError("pin needs pinned: boolean");
			return { action: "pin", pinned: r.pinned, ...(str(r.item) ? { item: str(r.item)! } : {}) };
		case "delete":
			return { action: "delete", ...(str(r.item) ? { item: str(r.item)! } : {}) };
		case "add-item": {
			const value = str(r.value);
			if (!value) throw new LearnerInputError("add-item needs a value");
			return { action: "add-item", value };
		}
		case "override": {
			if (typeof r.workspaceId !== "string" || !r.workspaceId) throw new LearnerInputError("override needs a workspaceId");
			return { action: "override", workspaceId: r.workspaceId, value: r.value === null ? null : str(r.value) };
		}
		default:
			throw new LearnerInputError("action must be edit | pin | delete | add-item | override");
	}
}

export function applyTraitAction(key: string, raw: unknown): LearnerProfile {
	if (!isScalar(key) && !isList(key)) throw new LearnerInputError(`Unknown trait ${key}`);
	const action = parseTraitAction(raw);
	const prev = readProfile();
	const user = structuredClone(prev?.user ?? emptyProfileUserState());
	const now = new Date().toISOString();
	const checkScalarValue = (value: string) => {
		if (!isScalar(key)) throw new LearnerInputError(`${key} is a list — add items instead`);
		if (!SCALAR_TRAIT_VALUES[key].includes(value)) throw new LearnerInputError(`${key} must be one of: ${SCALAR_TRAIT_VALUES[key].join(", ")}`);
	};
	switch (action.action) {
		case "edit":
			checkScalarValue(action.value);
			user.edits[key as ScalarTraitKey] = { value: action.value, at: now };
			break;
		case "pin":
			user.pins[action.item ? `${key}:${itemKey(action.item)}` : key] = action.pinned;
			break;
		case "delete":
			if (action.item) {
				const k = itemKey(action.item);
				user.deleted[`${key}:${k}`] = now;
				if (isList(key)) user.addedItems[key] = (user.addedItems[key] ?? []).filter((a) => itemKey(a.value) !== k);
				delete user.pins[`${key}:${k}`];
			} else {
				user.deleted[key] = now;
				if (isScalar(key)) delete user.edits[key];
				if (isList(key)) user.addedItems[key] = [];
				delete user.pins[key];
			}
			break;
		case "add-item":
			if (!isList(key)) throw new LearnerInputError(`${key} is a single value — edit it instead`);
			user.addedItems[key] = [...(user.addedItems[key] ?? []).filter((a) => itemKey(a.value) !== itemKey(action.value)), { value: action.value, at: now }];
			break;
		case "override": {
			if (!stores.workspaceStore.get(action.workspaceId)) throw new LearnerInputError("No such course");
			const course = { ...(user.overrides[action.workspaceId] ?? {}) };
			if (action.value === null) delete course[key as ScalarTraitKey];
			else {
				checkScalarValue(action.value);
				course[key as ScalarTraitKey] = { value: action.value, at: now };
			}
			user.overrides[action.workspaceId] = course;
			break;
		}
	}
	stores.learnerStore.writeProfile({ ...(prev ?? { version: 1, scalars: {}, lists: {} }), user });
	const profile = recomputeProfile();
	emit("learner-changed", {});
	return profile;
}

// ─── tracing ─────────────────────────────────────────────────────────────────

export interface TracingDeps {
	/** The tracer engine (role override → cheap slot), or undefined when
	 *  unconfigured / keyless / background use is off. Read fresh per run. */
	engineFor: () => PiEngine | undefined;
}

let deps: TracingDeps | null = null;
export function configureLearnerTracing(next: TracingDeps): void {
	deps = next;
}

const running = new Set<string>();
const again = new Set<string>();

/** The chat's learner inputs not yet traced (skip rule applied). */
export function untracedInputs(chatId: string): LearnerInput[] {
	const record = stores.chatStore.getChat(chatId);
	if (!record) return [];
	const traced = tracedKeys();
	const inputs = learnerInputsOf(record.messages).filter((i) => !traced.has(i.key) && worthTracing(i.kind, i.text));
	// Feedback with words is traced too (tags-only feedback is folded
	// deterministically — no model call needed).
	for (const item of listFeedback({ chatId })) {
		const input = feedbackInput(item, assistantProse(record.messages, item.messageIds));
		if ((item.text || item.quote) && !traced.has(input.key) && worthTracing("feedback", input.text)) inputs.push(input);
	}
	return inputs;
}

function traceRecord(input: LearnerInput, extracted: ExtractedTrace, chatId: string, workspaceId: string, model: string): ReasoningTrace {
	const now = new Date().toISOString();
	return {
		id: `tr_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		rev: 1,
		key: input.key,
		type: "trace",
		evidence: { workspaceId, chatId, messageId: input.messageId, kind: input.kind, ...(input.feedbackId ? { feedbackId: input.feedbackId } : {}), at: now },
		...(input.respondingTo ? { respondingTo: input.respondingTo } : {}),
		steps: extracted.steps,
		assumptionsUsed: extracted.assumptionsUsed,
		assumptionsMissing: extracted.assumptionsMissing,
		references: extracted.references,
		entryPoint: extracted.entryPoint,
		signals: extracted.signals,
		bridges: extracted.bridges,
		confidence: extracted.confidence,
		model,
		createdAt: now,
	};
}

/** Listeners for new traces (Phase 5 turns their bridges into suggestions). */
const traceListeners: Array<(traces: ReasoningTrace[]) => void> = [];
export function onTracesAdded(listener: (traces: ReasoningTrace[]) => void): void {
	traceListeners.push(listener);
}

/** Trace one chat's pending inputs now. Returns how many traces landed.
 *  `engine` overrides the configured resolver (tests). */
export async function runTracingFor(chatId: string, engine?: PiEngine): Promise<number> {
	const learner = effectiveSettings().learner;
	if (!learner.enabled || !learner.traceExtraction) return 0;
	if (running.has(chatId)) {
		again.add(chatId);
		return 0;
	}
	const workspaceId = stores.workspaceStore.workspaceOfChat(chatId);
	if (!workspaceId) return 0;
	const inputs = untracedInputs(chatId);
	if (inputs.length === 0) return 0;
	const resolved = engine ?? deps?.engineFor();
	if (!resolved) {
		console.info(`[learner] tracing skipped for ${chatId}: no tracer model available (cheap slot unset, key missing or background use off)`);
		return 0;
	}
	running.add(chatId);
	let landed = 0;
	try {
		for (let i = 0; i < inputs.length; i += BATCH) {
			const batch = inputs.slice(i, i + BATCH);
			let model = `${resolved.model.provider}:${resolved.model.id}`;
			const extracted = await runTracer({
				engine: resolved,
				inputs: batch,
				promptSwitches: effectiveSettings().agent.prompts,
				onStep: (_usage, stamped) => {
					model = stamped;
				},
			});
			const byKey = new Map(batch.map((input) => [input.key, input]));
			const records = extracted.flatMap((t) => (byKey.has(t.inputKey) ? [traceRecord(byKey.get(t.inputKey)!, t, chatId, workspaceId, model)] : []));
			for (const record of records) stores.learnerStore.appendLine("traces", record);
			landed += records.length;
			for (const listener of traceListeners) {
				try {
					listener(records);
				} catch (err) {
					console.error("[learner] trace listener failed:", err);
				}
			}
		}
	} catch (err) {
		console.error(`[learner] tracing failed for ${chatId}:`, err);
	} finally {
		running.delete(chatId);
		if (landed > 0) {
			recomputeProfile();
			emit("learner-changed", { chatId });
		}
		if (again.delete(chatId)) void runTracingFor(chatId, engine);
	}
	return landed;
}

/** Fire-and-forget tracing after a turn / feedback (off under tests — the
 *  extraction precedent; tests call runTracingFor with a faux engine). */
export function triggerTracing(chatId: string): void {
	if (process.env.NODE_ENV === "test") return;
	void runTracingFor(chatId);
}

// Feedback changes the profile at once (tags fold without a model) and
// feedback with words is traced.
onFeedbackChanged((item, change) => {
	try {
		recomputeProfile();
	} catch (err) {
		console.error("[learner] profile recompute failed:", err);
	}
	if (change === "created" && item) triggerTracing(item.chatId);
});

// ─── learning-stack evidence (PLAN.md Phase 4 §4) ─────────────────────────────

/** Listeners for new stack resolutions (Phase 5 links the assumption to the
 *  concept that needed it). */
const resolutionListeners: Array<(resolutions: StackResolution[]) => void> = [];
export function onStackResolved(listener: (resolutions: StackResolution[]) => void): void {
	resolutionListeners.push(listener);
}

/** Record the chat's stack pushes (missing-assumption evidence) and
 *  resolutions (understood / closed) not yet in the ledger. Idempotent —
 *  keyed by the stack event's id. */
export function recordStackEvidence(chatId: string): number {
	const record = stores.chatStore.getChat(chatId);
	const workspaceId = stores.workspaceStore.workspaceOfChat(chatId);
	if (!record || !workspaceId) return 0;
	const known = tracedKeys();
	const now = new Date().toISOString();
	const added: TraceLedgerEntry[] = [];
	for (const event of foldLearningStack(record.messages).events) {
		const key = `stack:${event.id}`;
		if (known.has(key)) continue;
		const evidence = { workspaceId, chatId, messageId: event.messageId, kind: "stack" as const, at: now };
		const id = `st_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
		added.push(
			event.type === "push"
				? { id, rev: 1, key, type: "stack-push", evidence, assumption: event.frame.label, createdAt: now }
				: { id, rev: 1, key, type: "stack-resolution", evidence, assumption: event.frame.label, neededBy: event.neededBy, outcome: event.outcome, createdAt: now },
		);
	}
	for (const entry of added) stores.learnerStore.appendLine("traces", entry);
	if (added.length > 0) {
		recomputeProfile();
		const resolutions = added.filter((e): e is StackResolution => e.type === "stack-resolution");
		for (const listener of resolutionListeners) {
			try {
				if (resolutions.length > 0) listener(resolutions);
			} catch (err) {
				console.error("[learner] stack listener failed:", err);
			}
		}
		emit("learner-changed", { chatId });
	}
	return added.length;
}

// ─── context injection ───────────────────────────────────────────────────────

/** The session's learner-context marker when the active-trait fingerprint
 *  differs from the chat's latest one (decision D2), else null. */
export function learnerContextMarkerFor(chatId: string, messages: readonly LhMessage[]): LhMarkerMessage | null {
	const learner = effectiveSettings().learner;
	if (!learner.enabled) return null;
	const workspaceId = stores.workspaceStore.workspaceOfChat(chatId);
	if (!workspaceId) return null;
	const profile = readProfile();
	// Relevant feedback: this course's, newest first — this chat's own items
	// already reach it as feedback markers, so other chats come first.
	const feedback = listFeedback({ workspaceId })
		.filter((f: FeedbackItem) => f.chatId !== chatId)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	const context = renderLearnerContext(profile, workspaceId, feedback, { budgetTokens: learner.contextTokenBudget, feedbackItems: learner.recentFeedbackItems });
	if (!context || lastLearnerContextFingerprint(messages) === context.fingerprint) return null;
	return newLearnerContextMessage(context.text, context.fingerprint);
}

/** Trait keys the panel renders, in order. */
export const TRAIT_ORDER: readonly TraitKey[] = [...SCALAR_TRAITS, ...LIST_TRAITS];
