/**
 * THE LEARNER'S CONCEPT BRIDGES — server service (PLAN.md Phase 5): how the
 * learner's own mind links concepts, across all courses.
 *
 *  - Proposals: the trace extractor's `bridges` and resolved learning-stack
 *    levels become `extracted-unconfirmed` edges — SUGGESTIONS the learner
 *    confirms or rejects. Only the learner's own edges and confirmed ones
 *    count with full weight (agents only ever see those).
 *  - Edits never delete history: the old edge is marked replaced
 *    (validUntil + replacedBy) and the new one gets a fresh id.
 *  - Concepts link to the matching node of a course's objective graph when
 *    a node's name matches (read-only — the objective graph is never written).
 *  - bridgeAnswer: the my_bridges tool's text (N-hop trusted paths).
 */

import {
	BRIDGE_TYPES,
	EDGE_SOURCES,
	isCurrentEdge,
	itemKey,
	LearnerInputError,
	type BridgeType,
	type EdgeSource,
	type EvidenceRef,
	type LearnerConcept,
	type LearnerEdge,
	type ReasoningTrace,
	type StackResolution,
} from "../core/contracts/learner.ts";
import { emit } from "../core/events.ts";
import { bridgePaths, formatBridges, matchConcept } from "../core/learner-bridges.ts";
import { ROOT_LABEL } from "../core/learning-stack.ts";
import { onStackResolved, onTracesAdded } from "./learner-model.ts";
import { effectiveSettings, stores, workspaceStores } from "./stores.ts";

const graph = () => stores.learnerGraphStore;

function newId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

/** Link a concept to a same-named proposition of a course's objective graph
 *  (exact normalized name or alias match). Read-only on that graph. */
function objectiveNodeFor(workspaceId: string, label: string): string | null {
	try {
		const key = itemKey(label);
		const node = workspaceStores(workspaceId).graphStore.readNodes().find((n) => itemKey(n.name) === key || n.aliases.some((a) => itemKey(a) === key));
		return node?.id ?? null;
	} catch {
		return null;
	}
}

/** The learner's concept for a label — created when new; the course is
 *  recorded on it, and an objective-graph link added when one matches. */
export function ensureConcept(label: string, workspaceId?: string): LearnerConcept {
	const clean = label.replace(/\s+/g, " ").trim().slice(0, 200);
	if (!clean) throw new LearnerInputError("A concept needs a name");
	const now = new Date().toISOString();
	const existing = matchConcept(graph().concepts(), clean);
	if (existing) {
		const needsCourse = workspaceId && !existing.workspaces.includes(workspaceId);
		const nodeId = needsCourse ? objectiveNodeFor(workspaceId!, existing.label) : null;
		const alias = itemKey(existing.label) !== itemKey(clean) && !existing.aliases.some((a) => itemKey(a) === itemKey(clean));
		if (!needsCourse && !alias) return existing;
		const next: LearnerConcept = {
			...existing,
			rev: existing.rev + 1,
			aliases: alias ? [...existing.aliases, clean] : existing.aliases,
			workspaces: needsCourse ? [...existing.workspaces, workspaceId!] : existing.workspaces,
			objectiveLinks: nodeId ? [...existing.objectiveLinks, { workspaceId: workspaceId!, nodeId }] : existing.objectiveLinks,
			updatedAt: now,
		};
		graph().upsertConcept(next);
		return next;
	}
	const nodeId = workspaceId ? objectiveNodeFor(workspaceId, clean) : null;
	const concept: LearnerConcept = {
		id: newId("cn"),
		rev: 1,
		label: clean,
		aliases: [],
		workspaces: workspaceId ? [workspaceId] : [],
		objectiveLinks: nodeId ? [{ workspaceId: workspaceId!, nodeId }] : [],
		createdAt: now,
		updatedAt: now,
	};
	graph().upsertConcept(concept);
	return concept;
}

/** Add a proposed link, or fold new evidence into the same current edge. */
function propose(fromLabel: string, toLabel: string, type: BridgeType, wording: string | undefined, evidence: EvidenceRef, confidence: number): void {
	const from = ensureConcept(fromLabel, evidence.workspaceId);
	const to = ensureConcept(toLabel, evidence.workspaceId);
	if (from.id === to.id) return;
	const now = new Date().toISOString();
	const same = graph().edges().find((e) => isCurrentEdge(e) && e.from === from.id && e.to === to.id && e.type === type);
	if (same) {
		graph().putEdge({ ...same, rev: same.rev + 1, evidence: [evidence, ...same.evidence].slice(0, 25), confidence: Math.min(1, Math.max(same.confidence, confidence)), updatedAt: now });
		return;
	}
	// A link the learner REJECTED stays rejected: no re-suggestion.
	if (graph().edges().some((e) => e.rejectedAt && e.from === from.id && e.to === to.id && e.type === type)) return;
	graph().putEdge({ id: newId("ed"), rev: 1, from: from.id, to: to.id, type, ...(wording ? { wording } : {}), source: "extracted-unconfirmed", confidence, evidence: [evidence], createdAt: now, updatedAt: now });
}

export function proposeFromTraces(traces: readonly ReasoningTrace[]): number {
	let n = 0;
	for (const trace of traces) {
		for (const bridge of trace.bridges) {
			propose(bridge.from, bridge.to, bridge.type, bridge.wording, { ...trace.evidence, traceId: trace.id }, trace.confidence);
			n++;
		}
	}
	return n;
}

/** A resolved stack level links the assumption to the concept that needed
 *  it (prerequisite-for-me). The root ("Original problem") resolves to the
 *  chat's title; a closed (unfinished) level proposes nothing. */
export function proposeFromResolutions(resolutions: readonly StackResolution[]): number {
	let n = 0;
	for (const r of resolutions) {
		if (r.outcome !== "understood") continue;
		const neededBy = r.neededBy === ROOT_LABEL ? (stores.chatStore.getChat(r.evidence.chatId)?.title ?? ROOT_LABEL) : r.neededBy;
		propose(r.assumption, neededBy, "prerequisite-for-me", undefined, r.evidence, 0.8);
		n++;
	}
	return n;
}

onTracesAdded((traces) => {
	if (proposeFromTraces(traces) > 0) emit("learner-changed", {});
});
onStackResolved((resolutions) => {
	if (proposeFromResolutions(resolutions) > 0) emit("learner-changed", {});
});

// ─── the learner's own edits ─────────────────────────────────────────────────

export interface BridgeView {
	concepts: LearnerConcept[];
	edges: LearnerEdge[];
}

/** Current concepts and edges (suggestions included; replaced/rejected only
 *  with `history`). `workspaceId` narrows to links touching that course. */
export function listBridges(filter: { workspaceId?: string; history?: boolean } = {}): BridgeView {
	const concepts = graph().concepts();
	const inCourse = new Set(concepts.filter((c) => !filter.workspaceId || c.workspaces.includes(filter.workspaceId)).map((c) => c.id));
	const edges = graph()
		.edges()
		.filter((e) => (filter.history || isCurrentEdge(e)) && (!filter.workspaceId || inCourse.has(e.from) || inCourse.has(e.to)))
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	const used = new Set(edges.flatMap((e) => [e.from, e.to]));
	return { concepts: concepts.filter((c) => inCourse.has(c.id) || used.has(c.id)), edges };
}

function parseType(raw: unknown): BridgeType {
	if (!(BRIDGE_TYPES as readonly unknown[]).includes(raw)) throw new LearnerInputError(`type must be one of: ${BRIDGE_TYPES.join(", ")}`);
	return raw as BridgeType;
}

function cleanWording(raw: unknown): string | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== "string") throw new LearnerInputError("wording must be a string");
	return raw.trim().slice(0, 500) || undefined;
}

export function addBridge(raw: unknown): LearnerEdge {
	const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
	if (typeof r.from !== "string" || typeof r.to !== "string") throw new LearnerInputError("from and to are required");
	const workspaceId = typeof r.workspaceId === "string" && stores.workspaceStore.get(r.workspaceId) ? r.workspaceId : undefined;
	const from = ensureConcept(r.from, workspaceId);
	const to = ensureConcept(r.to, workspaceId);
	if (from.id === to.id) throw new LearnerInputError("A link needs two different concepts");
	const now = new Date().toISOString();
	const wording = cleanWording(r.wording);
	const edge: LearnerEdge = { id: newId("ed"), rev: 1, from: from.id, to: to.id, type: parseType(r.type), ...(wording ? { wording } : {}), source: "mine", confidence: 1, evidence: [], createdAt: now, updatedAt: now };
	graph().putEdge(edge);
	emit("learner-changed", {});
	return edge;
}

function current(id: string): LearnerEdge {
	const edge = graph().edges().find((e) => e.id === id);
	if (!edge) throw new LearnerInputError("No such link");
	return edge;
}

/** confirm | reject a suggestion; edit (→ a replacement edge, the old one
 *  kept as replaced). */
export function changeBridge(id: string, raw: unknown): LearnerEdge {
	const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
	const edge = current(id);
	const now = new Date().toISOString();
	if (edge.validUntil) throw new LearnerInputError("This link was replaced — change the newer one");
	let result: LearnerEdge;
	switch (r.action) {
		case "confirm":
			if (edge.source !== "extracted-unconfirmed") throw new LearnerInputError("Only suggestions can be confirmed");
			result = { ...edge, rev: edge.rev + 1, source: "extracted-confirmed", confidence: Math.max(edge.confidence, 0.9), updatedAt: now };
			graph().putEdge(result);
			break;
		case "reject":
			result = { ...edge, rev: edge.rev + 1, rejectedAt: now, updatedAt: now };
			graph().putEdge(result);
			break;
		case "edit": {
			const from = typeof r.from === "string" ? ensureConcept(r.from).id : edge.from;
			const to = typeof r.to === "string" ? ensureConcept(r.to).id : edge.to;
			if (from === to) throw new LearnerInputError("A link needs two different concepts");
			const wording = "wording" in r ? cleanWording(r.wording) : edge.wording;
			const source: EdgeSource = edge.source === "extracted-unconfirmed" ? "extracted-confirmed" : edge.source;
			result = {
				id: newId("ed"), rev: 1, from, to, type: r.type === undefined ? edge.type : parseType(r.type),
				...(wording ? { wording } : {}), source, confidence: Math.max(edge.confidence, 0.9), evidence: edge.evidence, createdAt: now, updatedAt: now,
			};
			graph().replaceEdge(edge.id, result);
			break;
		}
		default:
			throw new LearnerInputError("action must be confirm | reject | edit");
	}
	emit("learner-changed", {});
	return result;
}

export function deleteBridge(id: string): void {
	current(id);
	graph().deleteEdge(id);
	emit("learner-changed", {});
}

export const BRIDGE_SOURCES = EDGE_SOURCES;

// ─── the agent query ─────────────────────────────────────────────────────────

/** The my_bridges tool's answer: trusted paths (≤ bridgeHops) leading to
 *  the concept, in the learner's own wording. */
export function bridgeAnswer(concept: string): string {
	const concepts = graph().concepts();
	const target = matchConcept(concepts, concept);
	const names = new Map(concepts.map((c) => [c.id, c.label]));
	const paths = target ? bridgePaths(graph().edges(), target.id, effectiveSettings().learner.bridgeHops) : [];
	return formatBridges(target, concept, paths, names);
}
