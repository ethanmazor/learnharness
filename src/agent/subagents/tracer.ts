/**
 * THE REASONING-TRACE EXTRACTOR (PLAN.md Phase 3): a background worker on
 * the cheap model slot ("tracer" role). It reads a batch of learner inputs
 * (core/learner-traces.ts) and submits one trace per input through a single
 * TypeBox-validated `submit_traces` call (the shared runSubmitAgent seam).
 * Its instructions are prompt segments (src/agent/prompts/tracer/), editable
 * like every agent prompt. Runs under the shared background-LLM semaphore.
 */

import type { Usage } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { ABSTRACTION_LEVELS, BRIDGE_TYPES, ENTRY_POINTS, STEP_SIZES, type LearnerInput, type ProposedBridge, type TraceReference } from "../../core/contracts/learner.ts";
import type { PiEngine } from "../models.ts";
import { effectivePromptSegments } from "../prompt-segments.ts";
import { withBgLlmSlot } from "./bg-llm-semaphore.ts";
import { runSubmitAgent } from "./submit-agent.ts";

const stringList = (description: string) => Type.Array(Type.String(), { description });
const literalUnion = <T extends readonly string[]>(values: T, description: string) =>
	Type.Union(values.map((v) => Type.Literal(v)), { description });

const traceSchema = Type.Object({
	inputId: Type.String({ description: "The input's id, exactly as given." }),
	steps: stringList("The learner's steps, in their order and close to their wording."),
	assumptionsUsed: stringList("Assumptions the learner took for granted."),
	assumptionsMissing: stringList("Assumptions/prerequisites their path needed but skipped or lacked."),
	references: Type.Array(
		Type.Object({
			kind: literalUnion(["analogy", "topic", "example"] as const, "analogy | topic | example"),
			text: Type.String(),
			domain: Type.Optional(Type.String({ description: "The field the reference comes from." })),
		}),
	),
	entryPoint: literalUnion(ENTRY_POINTS, "How they entered the problem."),
	signals: Type.Object({
		abstraction: Type.Optional(literalUnion(ABSTRACTION_LEVELS, "concrete | mixed | abstract")),
		stepSize: Type.Optional(literalUnion(STEP_SIZES, "small | medium | large")),
		notation: Type.Optional(stringList("Notation they used or asked for.")),
		formatting: Type.Optional(stringList("Formatting they used or asked for.")),
	}),
	bridges: Type.Optional(
		Type.Array(
			Type.Object({
				from: Type.String({ description: "The concept they reasoned FROM (the familiar one)." }),
				to: Type.String({ description: "The concept they reasoned ABOUT." }),
				type: literalUnion(BRIDGE_TYPES, "The kind of link."),
				wording: Type.Optional(Type.String({ description: "Their phrasing of the link." })),
			}),
		),
	),
	confidence: Type.Number({ minimum: 0, maximum: 1 }),
});

const submitSchema = Type.Object({ traces: Type.Array(traceSchema) });
type SubmitTraces = Static<typeof submitSchema>;

export interface ExtractedTrace {
	inputKey: string;
	steps: string[];
	assumptionsUsed: string[];
	assumptionsMissing: string[];
	references: TraceReference[];
	entryPoint: (typeof ENTRY_POINTS)[number];
	signals: { abstraction?: (typeof ABSTRACTION_LEVELS)[number]; stepSize?: (typeof STEP_SIZES)[number]; notation: string[]; formatting: string[] };
	bridges: ProposedBridge[];
	confidence: number;
}

const CHANNEL_LABELS: Record<string, string> = {
	answer: "answer to a question",
	thinking: "thinking while answering",
	readingThinking: "thinking while reading the explanation",
	practiceThinking: "practice thinking",
	composer: "message they typed or dictated",
	feedback: "feedback on an explanation",
};

/** The worker's user prompt: numbered inputs with their reacted-to text. */
export function tracerPrompt(inputs: readonly LearnerInput[]): string {
	const blocks = inputs.map((input, i) => [
		`=== INPUT ${i + 1} — id: ${i + 1} — channel: ${CHANNEL_LABELS[input.kind] ?? input.kind}`,
		...(input.context ? ["The explanation they were reacting to:", input.context, "---"] : []),
		"What the learner wrote:",
		input.text,
	].join("\n"));
	return `Trace each input below. Submit exactly one trace per input id (${inputs.map((_, i) => i + 1).join(", ")}).\n\n${blocks.join("\n\n")}`;
}

/** The tracer's instructions: its prompt segments, with any enabled user
 *  overrides (the same switch + file rule as every agent). */
export function tracerInstructions(switches: Record<string, boolean>): string {
	return effectivePromptSegments("tracer", switches)
		.map((s) => (s.enabled ? s.overrideText! : s.sourceText).trim())
		.filter(Boolean)
		.join("\n\n---\n\n");
}

export async function runTracer(opts: {
	engine: PiEngine | undefined;
	inputs: readonly LearnerInput[];
	promptSwitches: Record<string, boolean>;
	signal?: AbortSignal;
	onStep?: (usage: Usage, model: string) => void;
}): Promise<ExtractedTrace[]> {
	const ids = new Set(opts.inputs.map((_, i) => String(i + 1)));
	const submitted = await withBgLlmSlot(opts.signal, () =>
		runSubmitAgent<SubmitTraces>({
			role: "tracer",
			toolName: "submit_traces",
			toolDescription: "Submit one reasoning trace per learner input.",
			parameters: submitSchema,
			fill: (input) => input as SubmitTraces,
			validate: (value) => {
				const seen = new Set(value.traces.map((t) => t.inputId.trim()));
				const missing = [...ids].filter((id) => !seen.has(id));
				const unknown = [...seen].filter((id) => !ids.has(id));
				if (missing.length > 0) return `Missing traces for input id(s): ${missing.join(", ")}`;
				if (unknown.length > 0) return `Unknown input id(s): ${unknown.join(", ")}`;
				return null;
			},
			systemPrompt: tracerInstructions(opts.promptSwitches),
			prompt: tracerPrompt(opts.inputs),
			engine: opts.engine,
			signal: opts.signal,
			onStep: (usage, model) => opts.onStep?.(usage, model),
			neverSubmitted: "the reasoning tracer never submitted traces",
		}),
	);
	return submitted.traces.map((t) => ({
		inputKey: opts.inputs[Number(t.inputId.trim()) - 1]!.key,
		steps: t.steps,
		assumptionsUsed: t.assumptionsUsed,
		assumptionsMissing: t.assumptionsMissing,
		references: t.references,
		entryPoint: t.entryPoint,
		signals: { abstraction: t.signals.abstraction, stepSize: t.signals.stepSize, notation: t.signals.notation ?? [], formatting: t.signals.formatting ?? [] },
		bridges: t.bridges ?? [],
		confidence: Math.min(1, Math.max(0, t.confidence)),
	}));
}
