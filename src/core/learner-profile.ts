/**
 * THE LEARNER PROFILE FOLD (PLAN.md Phase 3) — deterministic, no model call:
 * reasoning traces + feedback (+ learning-stack pushes, Phase 4) → traits.
 *
 * Evidence weights: explicit feedback weighs `feedbackWeight` (settings,
 * default 3), inferred evidence 1 — each scaled by the extractor's own
 * confidence (floored at 0.25). Quick tags map without a model:
 * too abstract → abstraction "concrete", steps skipped → step size
 * "small", too many steps → "large", wrong starting point → evidence
 * AGAINST the current entry point, good → support for the active values.
 *
 * Rules:
 *  - confidence = support(value) / (all support + conflicts + 1) — a
 *    conflicting value LOWERS confidence; it never silently replaces.
 *  - an inferred value is ACTIVE once it appears in `activationSessions`
 *    separate sessions; a value with feedback evidence, or the learner's
 *    own edit, is active at once.
 *  - a competing value replaces the current one only when it is itself
 *    activatable AND has more support; the switch is written to history.
 *    A PINNED trait never switches; an EDITED one keeps the learner's value.
 *  - a deletion ignores all evidence observed before it.
 * Pure and browser-safe.
 */

import {
	itemKey,
	LIST_TRAITS,
	SCALAR_TRAITS,
	TRAIT_EVIDENCE_CAP,
	type EvidenceRef,
	type FeedbackItem,
	type LearnerProfile,
	type ListTrait,
	type ListTraitKey,
	type ProfileUserState,
	type ReasoningTrace,
	type ScalarTrait,
	type ScalarTraitKey,
	type StackPushEvidence,
	type TraitKey,
	type TraitValue,
} from "./contracts/learner.ts";

export interface ProfileOptions {
	activationSessions: number;
	feedbackWeight: number;
	now: string;
}

interface Unit {
	key: TraitKey;
	value: string;
	weight: number;
	ref: EvidenceRef;
	fromFeedback: boolean;
}

const HISTORY_CAP = 50;
const AGAINST = "\u0000against";

function feedbackRef(item: FeedbackItem): EvidenceRef {
	return { workspaceId: item.workspaceId, chatId: item.chatId, messageId: item.messageId, kind: "feedback", feedbackId: item.id, at: item.createdAt };
}

/** Every evidence unit the inputs carry (good-tag support is resolved in
 *  a second pass, once the current values are known). */
function evidenceUnits(traces: readonly ReasoningTrace[], feedback: readonly FeedbackItem[], pushes: readonly StackPushEvidence[], feedbackWeight: number): Unit[] {
	const units: Unit[] = [];
	for (const trace of traces) {
		const fromFeedback = trace.evidence.kind === "feedback";
		const weight = (fromFeedback ? feedbackWeight : 1) * Math.min(1, Math.max(0.25, trace.confidence));
		const ref: EvidenceRef = { ...trace.evidence, traceId: trace.id };
		const add = (key: TraitKey, value: string | undefined) => {
			const v = value?.trim();
			if (v) units.push({ key, value: v, weight, ref, fromFeedback });
		};
		if (trace.entryPoint !== "unclear") add("entryPoint", trace.entryPoint);
		add("abstraction", trace.signals.abstraction);
		add("stepSize", trace.signals.stepSize);
		for (const n of trace.signals.notation) add("notation", n);
		for (const f of trace.signals.formatting) add("formatting", f);
		for (const r of trace.references) add("analogyDomains", r.domain ?? (r.kind === "analogy" ? r.text : undefined));
		for (const a of trace.assumptionsMissing) add("missingAssumptions", a);
	}
	for (const item of feedback) {
		const ref = feedbackRef(item);
		const add = (key: TraitKey, value: string) => units.push({ key, value, weight: feedbackWeight, ref, fromFeedback: true });
		for (const tag of item.tags) {
			if (tag === "too-abstract") add("abstraction", "concrete");
			else if (tag === "steps-skipped") add("stepSize", "small");
			else if (tag === "too-many-steps") add("stepSize", "large");
			else if (tag === "wrong-start") add("entryPoint", AGAINST);
		}
	}
	for (const push of pushes) {
		units.push({ key: "missingAssumptions", value: push.assumption, weight: 2, ref: push.evidence, fromFeedback: false });
	}
	return units;
}

interface Group {
	display: string;
	support: number;
	sessions: Set<string>;
	fromFeedback: boolean;
	refs: EvidenceRef[];
}

function groupUnits(units: readonly Unit[]): Map<string, Group> {
	const groups = new Map<string, Group>();
	for (const unit of units) {
		const k = itemKey(unit.value);
		let g = groups.get(k);
		if (!g) groups.set(k, (g = { display: unit.value, support: 0, sessions: new Set(), fromFeedback: false, refs: [] }));
		g.support += unit.weight;
		g.sessions.add(unit.ref.chatId);
		g.fromFeedback ||= unit.fromFeedback;
		g.refs.push(unit.ref);
		g.display = unit.value; // newest phrasing wins
	}
	return groups;
}

function newestFirst(refs: readonly EvidenceRef[]): EvidenceRef[] {
	return [...refs].sort((a, b) => b.at.localeCompare(a.at));
}

function round(n: number): number {
	return Math.round(n * 100) / 100;
}

function traitValue(group: Group | undefined, value: string, opts: ProfileOptions, conf: number, source: TraitValue["source"], pinned: boolean, editAt?: string): TraitValue {
	const refs = group ? newestFirst(group.refs) : [];
	const sessions = group?.sessions.size ?? 0;
	const times = [...refs.map((r) => r.at), ...(editAt ? [editAt] : [])].sort();
	return {
		value,
		confidence: round(conf),
		evidenceCount: refs.length,
		evidence: refs.slice(0, TRAIT_EVIDENCE_CAP),
		sessions,
		firstSeen: times[0] ?? opts.now,
		lastUpdated: times.at(-1) ?? opts.now,
		source,
		status: source !== "inferred" || sessions >= opts.activationSessions ? "active" : "candidate",
		pinned,
	};
}

function activatable(group: Group, opts: ProfileOptions): boolean {
	return group.fromFeedback || group.sessions.size >= opts.activationSessions;
}

function foldScalar(key: ScalarTraitKey, units: readonly Unit[], user: ProfileUserState, prev: ScalarTrait | undefined, opts: ProfileOptions, goodRefs: readonly EvidenceRef[]): ScalarTrait | undefined {
	const deletedAt = user.deleted[key];
	const live = units.filter((u) => u.key === key && (!deletedAt || u.ref.at > deletedAt));
	const against = live.filter((u) => u.value === AGAINST);
	const groups = groupUnits(live.filter((u) => u.value !== AGAINST));
	const edit = user.edits[key];
	const pinned = user.pins[key] === true;
	const history = [...(prev?.history ?? [])];
	if (groups.size === 0 && !edit) return undefined;

	const byValue = (v: string) => groups.get(itemKey(v));
	let current: string;
	if (edit) current = edit.value;
	else if (prev && byValue(prev.value) && (pinned || byValue(prev.value)!.support > 0)) current = prev.value;
	else current = [...groups.values()].sort((a, b) => b.support - a.support)[0]!.display;

	if (!edit && !pinned) {
		const cur = byValue(current);
		const best = [...groups.values()].filter((g) => itemKey(g.display) !== itemKey(current)).sort((a, b) => b.support - a.support)[0];
		if (best && activatable(best, opts) && best.support > (cur?.support ?? 0)) {
			history.push({ at: opts.now, value: best.display, confidence: 0, reason: `replaced “${current}”: stronger evidence across ${best.sessions.size} session(s)` });
			current = best.display;
		}
	}

	const curGroup = byValue(current);
	// Good tags support whatever the value was when the response was praised.
	const good = goodRefs.length;
	const total = [...groups.values()].reduce((n, g) => n + g.support, 0) + against.reduce((n, u) => n + u.weight, 0);
	const editWeight = edit ? opts.feedbackWeight : 0;
	const support = (curGroup?.support ?? 0) + editWeight + good * 0.5 * opts.feedbackWeight;
	const confidence = support / (total + editWeight + good * 0.5 * opts.feedbackWeight + 1);
	const source: TraitValue["source"] = edit ? "edited" : curGroup?.fromFeedback ? "feedback" : "inferred";
	const value = traitValue(curGroup, current, opts, confidence, source, pinned, edit?.at);
	if (good > 0 && curGroup) value.evidence = newestFirst([...value.evidence, ...goodRefs]).slice(0, TRAIT_EVIDENCE_CAP);

	const last = history.at(-1);
	if (!prev || prev.value !== current || Math.abs(prev.confidence - value.confidence) >= 0.1) {
		const reason = !prev
			? "first observed"
			: prev.value !== current
				? edit ? "edited by you" : (last?.at === opts.now ? last.reason : "value changed")
				: value.confidence < prev.confidence
					? "conflicting evidence lowered confidence"
					: "new supporting evidence";
		if (last?.at === opts.now && last.value === current) history.pop();
		history.push({ at: opts.now, value: current, confidence: value.confidence, reason });
	}

	return {
		key,
		...value,
		alternatives: [...groups.values()]
			.filter((g) => itemKey(g.display) !== itemKey(current))
			.map((g) => ({ value: g.display, support: round(g.support), sessions: g.sessions.size }))
			.sort((a, b) => b.support - a.support),
		history: history.slice(-HISTORY_CAP),
	};
}

function foldList(key: ListTraitKey, units: readonly Unit[], user: ProfileUserState, opts: ProfileOptions): ListTrait {
	const traitDeleted = user.deleted[key];
	const live = units.filter((u) => u.key === key && (!traitDeleted || u.ref.at > traitDeleted));
	const groups = groupUnits(live);
	const items: TraitValue[] = [];
	const added = new Map((user.addedItems[key] ?? []).map((a) => [itemKey(a.value), a]));
	const keys = new Set([...groups.keys(), ...added.keys()]);
	for (const k of keys) {
		const deletedAt = user.deleted[`${key}:${k}`];
		const group = groups.get(k);
		const kept = group ? { ...group, refs: group.refs.filter((r) => !deletedAt || r.at > deletedAt) } : undefined;
		const g = kept && kept.refs.length > 0
			? { ...kept, support: kept.refs.length === group!.refs.length ? kept.support : kept.refs.length, sessions: new Set(kept.refs.map((r) => r.chatId)) }
			: undefined;
		const edit = added.get(k);
		if (!g && !edit) continue;
		const support = (g?.support ?? 0) + (edit ? opts.feedbackWeight : 0);
		const source: TraitValue["source"] = edit ? "edited" : g?.fromFeedback ? "feedback" : "inferred";
		items.push(traitValue(g, edit?.value ?? g!.display, opts, support / (support + 1), source, user.pins[`${key}:${k}`] === true, edit?.at));
	}
	items.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.evidenceCount - a.evidenceCount || b.confidence - a.confidence);
	return { key, items };
}

/** Recompute the profile from the evidence and the learner's own decisions. */
export function foldProfile(
	inputs: { traces: readonly ReasoningTrace[]; feedback: readonly FeedbackItem[]; pushes: readonly StackPushEvidence[] },
	user: ProfileUserState,
	prev: LearnerProfile | null,
	opts: ProfileOptions,
): LearnerProfile {
	const units = evidenceUnits(inputs.traces, inputs.feedback, inputs.pushes, opts.feedbackWeight);
	const goodRefs = inputs.feedback.filter((f) => f.tags.includes("good")).map(feedbackRef);
	const scalars: LearnerProfile["scalars"] = {};
	for (const key of SCALAR_TRAITS) {
		const goods = goodRefs.filter((r) => !user.deleted[key] || r.at > user.deleted[key]!);
		const trait = foldScalar(key, units, user, prev?.scalars[key], opts, goods);
		if (trait) scalars[key] = trait;
	}
	const lists = Object.fromEntries(LIST_TRAITS.map((key) => [key, foldList(key, units, user, opts)])) as Record<ListTraitKey, ListTrait>;
	return { version: 1, user, scalars, lists, updatedAt: opts.now };
}

/** The value an agent should use for a scalar trait in one course:
 *  the course override, else the active global value, else null. */
export function effectiveScalar(profile: LearnerProfile, key: ScalarTraitKey, workspaceId?: string): { value: string; confidence: number; override: boolean } | null {
	const override = workspaceId ? profile.user.overrides[workspaceId]?.[key] : undefined;
	if (override) return { value: override.value, confidence: 1, override: true };
	const trait = profile.scalars[key];
	return trait && trait.status === "active" ? { value: trait.value, confidence: trait.confidence, override: false } : null;
}
