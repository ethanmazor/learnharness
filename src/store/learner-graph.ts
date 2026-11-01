/**
 * LearnerGraphStore — the JSONL adapter for the learner's concept bridges
 * (PLAN.md Phase 5): learner/concepts.jsonl + learner/edges.jsonl as
 * revision logs over the LearnerStore ledgers (latest rev per id wins).
 * Swappable: everything else codes against core/ports.ts LearnerGraphStore.
 */

import { foldRevisions, type LearnerConcept, type LearnerEdge, type Tombstone } from "../core/contracts/learner.ts";
import type { LearnerGraphStore, LearnerStore } from "../core/ports.ts";
import { learnerStore } from "./learner.ts";

export function createJsonlLearnerGraph(store: LearnerStore): LearnerGraphStore {
	const edges = () => foldRevisions<LearnerEdge>(store.readLines("edges") as unknown as Array<LearnerEdge | Tombstone>);
	return {
		concepts: () => foldRevisions<LearnerConcept>(store.readLines("concepts") as unknown as Array<LearnerConcept | Tombstone>),
		upsertConcept: (concept) => store.appendLine("concepts", concept),
		edges,
		putEdge: (edge) => store.appendLine("edges", edge),
		replaceEdge(oldId, next) {
			const old = edges().find((e) => e.id === oldId);
			if (old) store.appendLine("edges", { ...old, rev: old.rev + 1, validUntil: next.createdAt, replacedBy: next.id, updatedAt: next.createdAt });
			store.appendLine("edges", next);
		},
		deleteEdge(id) {
			const old = edges().find((e) => e.id === id);
			if (old) store.appendLine("edges", { id, rev: old.rev + 1, op: "delete", at: new Date().toISOString() } satisfies Tombstone);
		},
	};
}

/** The app's learner graph (data/learner). */
export const learnerGraphStore: LearnerGraphStore = createJsonlLearnerGraph(learnerStore);
