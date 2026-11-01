/**
 * THE LEARNER'S CONCEPT BRIDGES — pure queries (PLAN.md Phase 5) over the
 * LearnerGraphStore's concepts and edges.
 *
 *  - matchConcept: find the learner's concept for a label (normalized
 *    equality or alias, else strong word overlap).
 *  - bridgePaths: trusted paths of up to N hops that LEAD TO a target
 *    concept — the concepts the learner already understands, chained
 *    through their own links. Directional link types (understood-through,
 *    prerequisite-for-me) are followed from → to; symmetric ones (analogy,
 *    same-structure, contrast) both ways.
 */

import {
	BRIDGE_TYPE_LABELS,
	isTrustedEdge,
	itemKey,
	type BridgeType,
	type LearnerConcept,
	type LearnerEdge,
} from "./contracts/learner.ts";

const SYMMETRIC: ReadonlySet<BridgeType> = new Set(["analogy", "same-structure", "contrast"]);

function words(label: string): Set<string> {
	return new Set(itemKey(label).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
}

/** The concept for a label, or null. Exact/alias first, then a word
 *  overlap (Jaccard ≥ 0.6) — loose enough for "eigenvectors" vs
 *  "eigenvector", strict enough not to merge different ideas. */
export function matchConcept(concepts: readonly LearnerConcept[], label: string): LearnerConcept | null {
	const key = itemKey(label);
	if (!key) return null;
	const singular = (s: string) => s.replace(/(es|s)$/, "");
	for (const c of concepts) {
		const keys = [c.label, ...c.aliases].map(itemKey);
		if (keys.includes(key) || keys.map(singular).includes(singular(key))) return c;
	}
	const target = new Set([...words(label)].map(singular));
	if (target.size === 0) return null;
	let best: { concept: LearnerConcept; score: number } | null = null;
	for (const c of concepts) {
		const own = new Set([...words(c.label)].map(singular));
		const inter = [...target].filter((w) => own.has(w)).length;
		const score = inter / new Set([...target, ...own]).size;
		if (score >= 0.6 && (!best || score > best.score)) best = { concept: c, score };
	}
	return best?.concept ?? null;
}

export interface BridgeStep {
	edge: LearnerEdge;
	/** The concept this step starts from (for a reversed symmetric edge,
	 *  the edge's `to`). */
	from: string;
	to: string;
}

export interface BridgePath {
	/** The familiar concept the path starts from. */
	start: string;
	steps: BridgeStep[];
	confidence: number;
}

/** Trusted paths of ≤ `hops` edges ending at `targetId`, shortest and most
 *  confident first; at most `limit`. Cycles are never revisited. */
export function bridgePaths(edges: readonly LearnerEdge[], targetId: string, hops: number, limit = 5): BridgePath[] {
	const trusted = edges.filter(isTrustedEdge);
	// incoming[x] = steps that ARRIVE at x
	const incoming = new Map<string, BridgeStep[]>();
	const add = (step: BridgeStep) => incoming.set(step.to, [...(incoming.get(step.to) ?? []), step]);
	for (const edge of trusted) {
		add({ edge, from: edge.from, to: edge.to });
		if (SYMMETRIC.has(edge.type)) add({ edge, from: edge.to, to: edge.from });
	}
	const out: BridgePath[] = [];
	const walk = (node: string, tail: BridgeStep[], seen: Set<string>) => {
		if (tail.length >= hops) return;
		for (const step of incoming.get(node) ?? []) {
			if (seen.has(step.from)) continue;
			const steps = [step, ...tail];
			out.push({ start: step.from, steps, confidence: steps.reduce((p, s) => p * s.edge.confidence, 1) });
			walk(step.from, steps, new Set([...seen, step.from]));
		}
	};
	walk(targetId, [], new Set([targetId]));
	return out.sort((a, b) => a.steps.length - b.steps.length || b.confidence - a.confidence).slice(0, limit);
}

/** The tool's text answer for one concept. */
export function formatBridges(concept: LearnerConcept | null, label: string, paths: readonly BridgePath[], names: ReadonlyMap<string, string>): string {
	if (!concept) return `The learner has no recorded concept matching "${label}" yet — no personal bridges to use.`;
	if (paths.length === 0) return `"${concept.label}" is in the learner's concept graph, but no trusted link leads to it yet.`;
	const name = (id: string) => names.get(id) ?? id;
	const lines = [`Trusted bridges the learner already uses that lead to "${concept.label}" (explain through these):`];
	for (const path of paths) {
		const chain = path.steps
			.map((s) => `${name(s.from)} —${BRIDGE_TYPE_LABELS[s.edge.type]}→ ${name(s.to)}${s.edge.wording ? ` (in their words: "${s.edge.wording}")` : ""}`)
			.join("; then ");
		lines.push(`- From ${name(path.start)}: ${chain}`);
	}
	return lines.join("\n");
}
