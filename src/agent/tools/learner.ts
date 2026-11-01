/**
 * The learner-layer tools (PLAN.md Phases 4–5):
 *
 *  - assumptions (Teacher): the explicit list of assumptions and
 *    prerequisites an explanation or solution uses — rendered as chips under
 *    the message — plus, when the learner reasoned first, the diff between
 *    their path and the Teacher's. Non-terminating; a plain ack.
 *  - stack_push / stack_pop (Teacher): the learning stack's agent side —
 *    push a deeper prerequisite the learner lacks (depth-limited), pop when
 *    they have shown understanding. State is derived from the record
 *    (core/learning-stack.ts); pushes earlier in the same run count too.
 *  - my_bridges (Teacher, Prober, Practitioner): the learner's own trusted
 *    concept links leading to a concept (Phase 5).
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { foldLearningStack, ROOT_LABEL } from "../../core/learning-stack.ts";
import type { ChatStore } from "../../core/ports.ts";
import { invalidInputResult, serverExecute } from "../tool-execute.ts";

const assumptionItem = Type.Object({
	id: Type.String({ description: "Short stable id, e.g. a1." }),
	label: Type.String({ description: "The assumption or prerequisite in a few words (the chip text)." }),
	statement: Type.String({ description: "One sentence stating it precisely." }),
	kind: Type.Union([Type.Literal("assumption"), Type.Literal("prerequisite")], { description: "assumption = taken as given; prerequisite = knowledge needed." }),
});

export const assumptionsSchema = Type.Object({
	items: Type.Array(assumptionItem, { minItems: 1, maxItems: 12 }),
	diff: Type.Optional(
		Type.Object({
			usedNotByLearner: Type.Array(Type.String(), { description: "Ids of items YOU use that the learner's own reasoning did not." }),
			divergence: Type.Array(
				Type.Object({
					learnerStep: Type.String({ description: "Their step (their wording)." }),
					myStep: Type.String({ description: "Where your path goes instead." }),
					note: Type.String({ description: "What the difference means for the explanation." }),
				}),
			),
		}, { description: "Fill ONLY when the learner wrote their own reasoning first." }),
	),
});

export const stackPushSchema = Type.Object({
	label: Type.String({ description: "The deeper prerequisite in a few words." }),
	statement: Type.String({ description: "What exactly they lack, in one sentence." }),
});

export const stackPopSchema = Type.Object({
	evidence: Type.String({ description: "What in the learner's own words showed they understand the top level now." }),
});

export interface LearnerToolContext {
	chatId: string;
	chatStore: ChatStore;
	/** The learning-stack depth limit (settings, read fresh). */
	maxDepth: () => number;
}

export function assumptionsTool(): AgentTool<any> {
	return {
		name: "assumptions",
		label: "assumptions",
		description:
			"Declare the assumptions and prerequisites your explanation or solution relies on. The learner sees each as a chip under your message " +
			"and can say \"I don't get this\" on one. When the learner wrote their own reasoning first, also fill `diff`: the assumptions you use that " +
			"they did not, and where their path differs from yours.",
		parameters: assumptionsSchema,
		execute: async (toolCallId, input: unknown, signal) => {
			const items = (input as { items: Array<{ id: string }> }).items;
			const ids = items.map((i) => i.id.trim());
			if (new Set(ids).size !== ids.length) return invalidInputResult("assumptions", ["item ids must be unique"]);
			const diff = (input as { diff?: { usedNotByLearner: string[] } }).diff;
			const unknown = diff?.usedNotByLearner.filter((id) => !ids.includes(id.trim())) ?? [];
			if (unknown.length > 0) return invalidInputResult("assumptions", [`diff.usedNotByLearner names unknown item ids: ${unknown.join(", ")}`]);
			return serverExecute("assumptions", assumptionsSchema, () => "Assumptions shown to the learner as chips under your message.")(toolCallId, input, signal);
		},
	};
}

export function stackTools(ctx: LearnerToolContext): Record<string, AgentTool<any>> {
	// The stack as THIS run sees it: seeded once from the record (saved at
	// settlement), then kept current by the run's own pushes and pops.
	let mirror: string[] | null = null;
	const frames = () => (mirror ??= foldLearningStack(ctx.chatStore.getChat(ctx.chatId)?.messages ?? []).frames.map((f) => f.label));
	return {
		stack_push: {
			name: "stack_push",
			label: "stack_push",
			description:
				"Push a deeper prerequisite onto the learning stack: the learner lacks it, so you teach it first and come back. Use only when their " +
				"own words show the gap. Refused at the stack's depth limit — then teach it inline instead.",
			parameters: stackPushSchema,
			execute: async (toolCallId, input: unknown, signal) => {
				const max = ctx.maxDepth();
				if (frames().length >= max) return invalidInputResult("stack_push", [`the learning stack is at its maximum depth (${max}); teach this inline instead of pushing`]);
				const result = await serverExecute("stack_push", stackPushSchema, (i) => {
					frames().push(i.label);
					return `Pushed "${i.label}" (level ${frames().length}). Teach it now; call stack_pop when the learner shows they understand it.`;
				})(toolCallId, input, signal);
				return result;
			},
		},
		stack_pop: {
			name: "stack_pop",
			label: "stack_pop",
			description:
				"Pop the top of the learning stack once the learner has SHOWN they understand it (in their own words, not just \"ok\"). Then return to the level below and continue from there.",
			parameters: stackPopSchema,
			execute: async (toolCallId, input: unknown, signal) => {
				if (frames().length === 0) return invalidInputResult("stack_pop", ["the learning stack is empty — you are at the original problem"]);
				return serverExecute("stack_pop", stackPopSchema, () => {
					const popped = frames().pop();
					return `Popped "${popped}". Return to "${frames().at(-1) ?? ROOT_LABEL}" and continue from there.`;
				})(toolCallId, input, signal);
			},
		},
	};
}

export const myBridgesSchema = Type.Object({
	concept: Type.String({ description: "The concept you are about to explain, as the learner would name it." }),
});

/** my_bridges (PLAN.md Phase 5): the learner's own trusted concept links
 *  that lead to a concept — the query is the composition root's (the
 *  agent layer never touches the learner store). */
export function myBridgesTool(query: (concept: string) => string): AgentTool<any> {
	return {
		name: "my_bridges",
		label: "my_bridges",
		description:
			"Before explaining a concept, look up the bridges the learner already trusts that lead to it — links in their own head such as " +
			"\"I understand eigenvectors through the steady state of a Markov chain\". Explain THROUGH the strongest path when one exists.",
		parameters: myBridgesSchema,
		execute: serverExecute("my_bridges", myBridgesSchema, (input) => query(input.concept)),
	};
}
