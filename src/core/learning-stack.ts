/**
 * THE LEARNING STACK (PLAN.md Phase 4) — recursive descent into missing
 * assumptions. State is DERIVED from the chat record (it survives a restart
 * with no second copy to drift): `learning-stack` markers (the learner's
 * push / jump / close) and the Teacher's `stack_push` / `stack_pop` tool
 * calls with a clean result. The root is the original problem; frames above
 * it are assumptions the learner lacks, deepest last.
 *
 * Also the evidence feed: every push is a missing-assumption observation
 * and every pop/close/jump a resolution (PLAN.md Phase 4 §4 → Phases 3/5).
 * Pure and browser-safe.
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { newMessageId, type LhMarkerMessage, type LhMessage } from "./native-messages.ts";

export const STACK_PUSH_TOOL = "stack_push";
export const STACK_POP_TOOL = "stack_pop";
export const ASSUMPTIONS_TOOL = "assumptions";

export interface StackFrame {
	id: string;
	label: string;
	statement: string;
	origin: { kind: "chip" | "feedback" | "agent" | "manual"; ref?: string };
	/** The record message that pushed it. */
	messageId: string;
}

export type StackEvent =
	| { id: string; type: "push"; frame: StackFrame; neededBy: string; messageId: string }
	| { id: string; type: "resolve"; frame: StackFrame; neededBy: string; outcome: "understood" | "closed"; messageId: string };

export interface StackState {
	frames: StackFrame[];
	events: StackEvent[];
}

/** The learner's stack action (a marker's details). */
export type StackMarkerDetails =
	| { action: "push"; frame: Omit<StackFrame, "messageId">; summary: string }
	| { action: "jump"; frameId: string | "root"; summary: string }
	| { action: "close"; frameId: string; summary: string };

export const ROOT_LABEL = "Original problem";

function cleanResults(messages: readonly LhMessage[]): Map<string, ToolResultMessage> {
	const out = new Map<string, ToolResultMessage>();
	for (const m of messages) if (m.role === "toolResult" && !m.isError) out.set(m.toolCallId, m as ToolResultMessage);
	return out;
}

/** Fold the record into the current stack and its event log. */
export function foldLearningStack(messages: readonly LhMessage[]): StackState {
	const frames: StackFrame[] = [];
	const events: StackEvent[] = [];
	const results = cleanResults(messages);
	const top = () => frames.at(-1);
	const parentLabel = () => top()?.label ?? ROOT_LABEL;
	const push = (frame: StackFrame, eventId: string, messageId: string) => {
		events.push({ id: eventId, type: "push", frame, neededBy: parentLabel(), messageId });
		frames.push(frame);
	};
	const popTop = (outcome: "understood" | "closed", eventId: string, messageId: string) => {
		const frame = frames.pop();
		if (frame) events.push({ id: eventId, type: "resolve", frame, neededBy: parentLabel(), outcome, messageId });
	};
	for (const m of messages) {
		if (m.role === "custom" && (m as LhMarkerMessage).customType === "learning-stack") {
			const d = (m as LhMarkerMessage).details as StackMarkerDetails;
			if (d.action === "push") push({ ...d.frame, messageId: m.id }, m.id, m.id);
			else if (d.action === "close") {
				if (top()?.id === d.frameId) popTop("closed", m.id, m.id);
			} else if (d.action === "jump") {
				if (d.frameId === "root" || frames.some((f) => f.id === d.frameId)) {
					let n = 0;
					while (top() && top()!.id !== d.frameId) popTop("closed", `${m.id}#${n++}`, m.id);
				}
			}
			continue;
		}
		if (m.role !== "assistant") continue;
		for (const block of (m as AssistantMessage).content) {
			if (block.type !== "toolCall" || !results.has(block.id)) continue;
			const args = (block.arguments ?? {}) as { label?: unknown; statement?: unknown };
			if (block.name === STACK_PUSH_TOOL && typeof args.label === "string") {
				push({ id: block.id, label: args.label, statement: typeof args.statement === "string" ? args.statement : "", origin: { kind: "agent" }, messageId: m.id }, block.id, m.id);
			} else if (block.name === STACK_POP_TOOL) {
				popTop("understood", block.id, m.id);
			}
		}
	}
	return { frames, events };
}

/** The model-facing text of a learner stack action. */
export function stackActionText(details: StackMarkerDetails): string {
	return details.summary;
}

/** Build the marker for a learner stack action against the current stack.
 *  Throws a plain Error with a learner-readable message when invalid. */
export function newStackMarker(
	messages: readonly LhMessage[],
	action: { action: "push"; label: string; statement?: string; origin?: StackFrame["origin"] } | { action: "jump"; frameId: string } | { action: "close"; frameId: string },
	maxDepth: number,
): LhMarkerMessage {
	const { frames } = foldLearningStack(messages);
	const parent = frames.at(-1)?.label ?? ROOT_LABEL;
	let details: StackMarkerDetails;
	if (action.action === "push") {
		const label = action.label.replace(/\s+/g, " ").trim().slice(0, 200);
		if (!label) throw new Error("Say what you want to learn first.");
		if (frames.length >= maxDepth) throw new Error(`The learning stack is at its maximum depth (${maxDepth}). Finish or close a level first.`);
		const statement = (action.statement ?? "").trim().slice(0, 1000);
		const frame = { id: `sf_${newMessageId().slice(4)}`, label, statement, origin: action.origin ?? { kind: "manual" as const } };
		details = {
			action: "push",
			frame,
			summary: [
				`[Learning stack — level ${frames.length + 1}] The learner doesn't get this yet and wants to learn it first: "${label}"${statement && statement !== label ? ` — ${statement}` : ""}.`,
				`It is needed for: ${parent}.`,
				"Teach this prerequisite now, starting from where the learner is (use their entry point and steps). If it rests on something deeper they lack, call stack_push for that. When they show they understand it, call stack_pop, then return to the level above.",
			].join("\n"),
		};
	} else if (action.action === "jump") {
		const target = action.frameId === "root" ? null : frames.find((f) => f.id === action.frameId);
		if (action.frameId !== "root" && !target) throw new Error("That level is no longer on the stack.");
		details = {
			action: "jump",
			frameId: action.frameId,
			summary: `[Learning stack] The learner jumped back to "${target?.label ?? ROOT_LABEL}"; every level above it is closed. Continue from there.`,
		};
	} else {
		const top = frames.at(-1);
		if (!top || top.id !== action.frameId) throw new Error("Only the top level of the stack can be closed.");
		details = {
			action: "close",
			frameId: action.frameId,
			summary: `[Learning stack] The learner closed the level "${top.label}" without finishing it. Return to "${frames.at(-2)?.label ?? ROOT_LABEL}".`,
		};
	}
	return {
		id: newMessageId(),
		role: "custom",
		customType: "learning-stack",
		content: details.summary,
		display: true,
		details: { ...details, summary: shortSummary(details, frames) },
		timestamp: Date.now(),
	};
}

/** The transcript line's one-liner (the marker's full text is the content). */
function shortSummary(details: StackMarkerDetails, frames: readonly StackFrame[]): string {
	if (details.action === "push") return `Learning first: ${details.frame.label}`;
	if (details.action === "jump") return `Back to: ${details.frameId === "root" ? ROOT_LABEL : (frames.find((f) => f.id === details.frameId)?.label ?? ROOT_LABEL)}`;
	return `Closed: ${frames.at(-1)?.label ?? ""}`;
}
