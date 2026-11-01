/**
 * THE LEARNER LAYER (PLAN.md Phases 2–5): what the app learns about how the
 * learner reasons — per-response feedback, reasoning traces, the style
 * profile, and the learner's own concept bridges. It lives GLOBALLY in
 * data/learner/, above every course workspace, and is NEVER written into a
 * workspace's knowledge graph (graph nodes stay objective, world-facing
 * propositions).
 *
 * Every inferred fact links to its evidence (EvidenceRef: workspace, chat,
 * message) and carries a confidence; the learner can see, edit and delete
 * all of it. JSONL ledgers are append-only REVISION logs: an edit appends a
 * full new revision with the same id, a delete appends a tombstone; readers
 * fold by id (latest line wins). Pure — no IO; browser-safe.
 */

// ─── evidence ────────────────────────────────────────────────────────────────

/** Which learner channel (or learner action) a fact came from. */
export type EvidenceKind =
	| "answer"
	| "thinking"
	| "readingThinking"
	| "practiceThinking"
	| "composer"
	| "feedback"
	| "stack"
	| "edit";

export interface EvidenceRef {
	workspaceId: string;
	chatId: string;
	/** The source record message (the learner's message, or for feedback the
	 *  assistant message the feedback is about). */
	messageId: string;
	kind: EvidenceKind;
	feedbackId?: string;
	traceId?: string;
	/** ISO time the evidence was observed. */
	at: string;
}

// ─── Phase 2: per-response feedback ──────────────────────────────────────────

export const FEEDBACK_TYPES = ["rewrite", "reading", "lost", "tags"] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

export const FEEDBACK_TAGS = ["too-abstract", "steps-skipped", "too-many-steps", "wrong-start", "good"] as const;
export type FeedbackTag = (typeof FEEDBACK_TAGS)[number];

export const FEEDBACK_TAG_LABELS: Record<FeedbackTag, string> = {
	"too-abstract": "Too abstract",
	"steps-skipped": "Too many steps skipped",
	"too-many-steps": "Too many steps",
	"wrong-start": "Wrong starting point",
	good: "Good",
};

export const FEEDBACK_TYPE_LABELS: Record<FeedbackType, string> = {
	rewrite: "How I would say it",
	reading: "How I read this",
	lost: "This part lost me",
	tags: "Quick tags",
};

/** A quoted span of the response ("This part lost me"). */
export interface FeedbackQuote {
	text: string;
	/** The native assistant message the span was selected in. */
	sourceMessageId: string;
}

/** One feedback item (the folded, current revision). */
export interface FeedbackItem {
	id: string;
	rev: number;
	workspaceId: string;
	chatId: string;
	/** The response's first native assistant message id (the view group id). */
	messageId: string;
	/** Every native assistant message in the response group. */
	messageIds: string[];
	type: FeedbackType;
	/** The learner's own words: rewrite / interpretation / note on "lost". */
	text?: string;
	quote?: FeedbackQuote;
	tags: FeedbackTag[];
	createdAt: string;
	updatedAt: string;
}

/** A deletion tombstone line (any learner ledger). `key` keeps a deleted
 *  trace's source key so the extractor never re-traces that input. */
export interface Tombstone {
	id: string;
	rev: number;
	op: "delete";
	at: string;
	key?: string;
}

/** One ledger line: a full revision, or a tombstone. */
export type FeedbackLine = FeedbackItem | Tombstone;

/** Fold revision lines by id (latest rev wins; a tombstone removes).
 *  Returns live items, oldest first. */
export function foldRevisions<T extends { id: string; rev: number }>(
	lines: readonly (T | { id: string; rev: number; op: "delete" })[],
): T[] {
	const latest = new Map<string, T | { id: string; rev: number; op: "delete" }>();
	for (const line of lines) {
		const prev = latest.get(line.id);
		if (!prev || line.rev >= prev.rev) latest.set(line.id, line);
	}
	return [...latest.values()].filter((l): l is T => !("op" in l && l.op === "delete"));
}

/** What the client submits for a new feedback item. */
export interface FeedbackInput {
	chatId: string;
	messageId: string;
	messageIds: string[];
	type: FeedbackType;
	text?: string;
	quote?: FeedbackQuote;
	tags: FeedbackTag[];
}

export class LearnerInputError extends Error {}

const MAX_FEEDBACK_TEXT = 8000;

function cleanText(raw: unknown, field: string): string | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== "string") throw new LearnerInputError(`${field} must be a string`);
	const text = raw.trim();
	if (text.length > MAX_FEEDBACK_TEXT) throw new LearnerInputError(`${field} is too long`);
	return text.length > 0 ? text : undefined;
}

function cleanTags(raw: unknown): FeedbackTag[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw) || !raw.every((t) => (FEEDBACK_TAGS as readonly string[]).includes(t))) {
		throw new LearnerInputError(`tags must be a subset of: ${FEEDBACK_TAGS.join(", ")}`);
	}
	return [...new Set(raw as FeedbackTag[])];
}

function cleanQuote(raw: unknown): FeedbackQuote | undefined {
	if (raw === undefined || raw === null) return undefined;
	const q = raw as { text?: unknown; sourceMessageId?: unknown };
	const text = cleanText(q.text, "quote.text");
	if (!text || typeof q.sourceMessageId !== "string" || q.sourceMessageId === "") {
		throw new LearnerInputError("quote needs text and sourceMessageId");
	}
	return { text, sourceMessageId: q.sourceMessageId };
}

/** Shape the body content of a feedback item (text, quote, tags) for its
 *  type: rewrite/reading need text, lost needs a quote or a note, tags need
 *  at least one tag. */
function checkContent(type: FeedbackType, text: string | undefined, quote: FeedbackQuote | undefined, tags: FeedbackTag[]): void {
	if ((type === "rewrite" || type === "reading") && !text) throw new LearnerInputError(`${FEEDBACK_TYPE_LABELS[type]} needs text`);
	if (type === "lost" && !text && !quote) throw new LearnerInputError("This part lost me needs a quoted span or a note");
	if (type === "tags" && tags.length === 0) throw new LearnerInputError("Pick at least one tag");
	if (type !== "lost" && quote) throw new LearnerInputError("Only “This part lost me” carries a quoted span");
}

export function parseFeedbackInput(raw: unknown): FeedbackInput {
	if (typeof raw !== "object" || raw === null) throw new LearnerInputError("Body must be an object");
	const r = raw as Record<string, unknown>;
	if (typeof r.chatId !== "string" || !r.chatId) throw new LearnerInputError("chatId is required");
	if (typeof r.messageId !== "string" || !r.messageId) throw new LearnerInputError("messageId is required");
	if (!(FEEDBACK_TYPES as readonly unknown[]).includes(r.type)) throw new LearnerInputError(`type must be one of: ${FEEDBACK_TYPES.join(", ")}`);
	const type = r.type as FeedbackType;
	const messageIds = Array.isArray(r.messageIds) && r.messageIds.every((m) => typeof m === "string") ? [...new Set([r.messageId, ...(r.messageIds as string[])])] : [r.messageId];
	const text = cleanText(r.text, "text");
	const quote = cleanQuote(r.quote);
	const tags = cleanTags(r.tags);
	checkContent(type, text, quote, tags);
	return { chatId: r.chatId, messageId: r.messageId, messageIds, type, ...(text ? { text } : {}), ...(quote ? { quote } : {}), tags };
}

/** An edit: the content fields only (identity and target are immutable). */
export function parseFeedbackPatch(raw: unknown, current: FeedbackItem): Pick<FeedbackItem, "text" | "quote" | "tags"> {
	if (typeof raw !== "object" || raw === null) throw new LearnerInputError("Body must be an object");
	const r = raw as Record<string, unknown>;
	const text = "text" in r ? cleanText(r.text, "text") : current.text;
	const quote = "quote" in r ? cleanQuote(r.quote) : current.quote;
	const tags = "tags" in r ? cleanTags(r.tags) : current.tags;
	checkContent(current.type, text, quote, tags);
	return { text, quote, tags };
}

/** The model-facing marker text for one feedback item — bracketed as
 *  injected context (the PREAMBLE LAW: markers arrive in the learner's
 *  voice channel, so they must read as context, never fake speech). */
export function feedbackMarkerText(item: Pick<FeedbackItem, "type" | "text" | "quote" | "tags">): string {
	const lines = ["[Learner feedback on one of your earlier responses — the learner's own words; use it to adjust how you explain from here on]"];
	if (item.tags.length > 0) lines.push(`Tags: ${item.tags.map((t) => FEEDBACK_TAG_LABELS[t]).join(", ")}`);
	if (item.quote) lines.push(`The part that lost them: "${item.quote.text}"`);
	if (item.text) lines.push(`${FEEDBACK_TYPE_LABELS[item.type === "tags" ? "rewrite" : item.type]}: ${item.text}`);
	return lines.join("\n");
}

// ─── Phase 3: reasoning traces ───────────────────────────────────────────────

export const ENTRY_POINTS = ["example-first", "definition-first", "visual", "procedure", "intuition", "analogy", "question", "unclear"] as const;
export type EntryPoint = (typeof ENTRY_POINTS)[number];
export const ABSTRACTION_LEVELS = ["concrete", "mixed", "abstract"] as const;
export type AbstractionLevel = (typeof ABSTRACTION_LEVELS)[number];
export const STEP_SIZES = ["small", "medium", "large"] as const;
export type StepSize = (typeof STEP_SIZES)[number];
export const BRIDGE_TYPES = ["analogy", "understood-through", "same-structure", "prerequisite-for-me", "contrast"] as const;
export type BridgeType = (typeof BRIDGE_TYPES)[number];

export interface TraceReference {
	kind: "analogy" | "topic" | "example";
	text: string;
	domain?: string;
}

/** A link the learner drew between two concepts (Phase 5 proposals). */
export interface ProposedBridge {
	from: string;
	to: string;
	type: BridgeType;
	wording?: string;
}

/** One learner input as the extractor sees it (core/learner-traces.ts). */
export interface LearnerInput {
	/** Stable per input: `${messageId}:${kind}` or `fb:${feedbackId}`. */
	key: string;
	messageId: string;
	kind: EvidenceKind;
	text: string;
	/** The assistant message the learner was reacting to, and its prose. */
	respondingTo?: string;
	context?: string;
	feedbackId?: string;
}

/** One reasoning trace (learner/traces.jsonl) — linked to its source. */
export interface ReasoningTrace {
	id: string;
	rev: number;
	/** The input's key (see LearnerInput.key). */
	key: string;
	type: "trace";
	evidence: EvidenceRef;
	respondingTo?: string;
	steps: string[];
	assumptionsUsed: string[];
	assumptionsMissing: string[];
	references: TraceReference[];
	entryPoint: EntryPoint;
	signals: { abstraction?: AbstractionLevel; stepSize?: StepSize; notation: string[]; formatting: string[] };
	bridges: ProposedBridge[];
	confidence: number;
	model: string;
	createdAt: string;
}

/** A learning-stack resolution (Phase 4 → Phase 5 bridges), traces.jsonl. */
export interface StackResolution {
	id: string;
	rev: number;
	key: string;
	type: "stack-resolution";
	evidence: EvidenceRef;
	/** The assumption that was missing, and the item that needed it. */
	assumption: string;
	neededBy: string;
	outcome: "understood" | "closed";
	createdAt: string;
}

/** A learning-stack push recorded as missing-assumption evidence. */
export interface StackPushEvidence {
	id: string;
	rev: number;
	key: string;
	type: "stack-push";
	evidence: EvidenceRef;
	assumption: string;
	createdAt: string;
}

export type TraceLedgerEntry = ReasoningTrace | StackResolution | StackPushEvidence;

// ─── Phase 3: the learner profile (learner/profile.json) ─────────────────────

export const SCALAR_TRAITS = ["entryPoint", "abstraction", "stepSize"] as const;
export type ScalarTraitKey = (typeof SCALAR_TRAITS)[number];
export const LIST_TRAITS = ["notation", "analogyDomains", "formatting", "missingAssumptions"] as const;
export type ListTraitKey = (typeof LIST_TRAITS)[number];
export type TraitKey = ScalarTraitKey | ListTraitKey;

export const TRAIT_LABELS: Record<TraitKey, string> = {
	entryPoint: "Preferred entry point",
	abstraction: "Abstraction level",
	stepSize: "Step size",
	notation: "Notation preferences",
	analogyDomains: "Analogy domains",
	formatting: "Formatting preferences",
	missingAssumptions: "Commonly missing assumptions",
};

/** Allowed values of the scalar traits (edits validate against these). */
export const SCALAR_TRAIT_VALUES: Record<ScalarTraitKey, readonly string[]> = {
	entryPoint: ENTRY_POINTS.filter((e) => e !== "unclear"),
	abstraction: ABSTRACTION_LEVELS,
	stepSize: STEP_SIZES,
};

export type TraitSource = "inferred" | "feedback" | "edited";

export interface TraitHistoryEntry {
	at: string;
	value: string;
	confidence: number;
	reason: string;
}

/** One trait value with its evidence (a scalar trait, or one list item). */
export interface TraitValue {
	value: string;
	confidence: number;
	evidenceCount: number;
	/** Newest first, capped (TRAIT_EVIDENCE_CAP); evidenceCount is the total. */
	evidence: EvidenceRef[];
	/** Distinct sessions (chats) supporting the value. */
	sessions: number;
	firstSeen: string;
	lastUpdated: string;
	source: TraitSource;
	status: "candidate" | "active";
	pinned: boolean;
}

export interface ScalarTrait extends TraitValue {
	key: ScalarTraitKey;
	/** Competing values seen in the evidence (the conflict view). */
	alternatives: Array<{ value: string; support: number; sessions: number }>;
	history: TraitHistoryEntry[];
}

export interface ListTrait {
	key: ListTraitKey;
	items: TraitValue[];
}

/** The learner's own decisions — never recomputed away. */
export interface ProfileUserState {
	/** Edited scalar values / added list items (source "edited"). */
	edits: Partial<Record<ScalarTraitKey, { value: string; at: string }>>;
	addedItems: Partial<Record<ListTraitKey, Array<{ value: string; at: string }>>>;
	pins: Partial<Record<string, boolean>>;
	/** Deletions: trait key or `${listKey}:${item}` → ISO; evidence observed
	 *  before it is ignored (later evidence can bring it back). */
	deleted: Record<string, string>;
	/** Per-course overrides of scalar traits (workspace id → key → value). */
	overrides: Record<string, Partial<Record<ScalarTraitKey, { value: string; at: string }>>>;
}

export interface LearnerProfile {
	version: 1;
	user: ProfileUserState;
	scalars: Partial<Record<ScalarTraitKey, ScalarTrait>>;
	lists: Record<ListTraitKey, ListTrait>;
	updatedAt: string;
}

export const TRAIT_EVIDENCE_CAP = 25;

export function emptyProfileUserState(): ProfileUserState {
	return { edits: {}, addedItems: {}, pins: {}, deleted: {}, overrides: {} };
}

/** The normalized identity of a list item (case/space-insensitive). */
export function itemKey(value: string): string {
	return value.toLowerCase().replace(/\s+/g, " ").trim();
}

// ─── Phase 5: the learner's own concept graph (bridges) ──────────────────────

/** A concept in the learner's head (learner/concepts.jsonl), across courses. */
export interface LearnerConcept {
	id: string;
	rev: number;
	label: string;
	aliases: string[];
	/** Courses the concept has appeared in. */
	workspaces: string[];
	/** Optional links to the matching node of a course's objective graph. */
	objectiveLinks: Array<{ workspaceId: string; nodeId: string }>;
	createdAt: string;
	updatedAt: string;
}

export const EDGE_SOURCES = ["mine", "extracted-confirmed", "extracted-unconfirmed"] as const;
export type EdgeSource = (typeof EDGE_SOURCES)[number];

export const EDGE_SOURCE_LABELS: Record<EdgeSource, string> = {
	mine: "Made by you",
	"extracted-confirmed": "Found, confirmed by you",
	"extracted-unconfirmed": "Suggestion",
};

export const BRIDGE_TYPE_LABELS: Record<BridgeType, string> = {
	analogy: "is an analogy for",
	"understood-through": "helps me understand",
	"same-structure": "has the same structure as",
	"prerequisite-for-me": "is what I need before",
	contrast: "contrasts with",
};

/** A link between two concepts (learner/edges.jsonl). Edits never delete:
 *  the old edge gets validUntil + replacedBy, the new one is a new id. */
export interface LearnerEdge {
	id: string;
	rev: number;
	/** The familiar concept the learner reasons FROM. */
	from: string;
	/** The concept being understood through it. */
	to: string;
	type: BridgeType;
	wording?: string;
	source: EdgeSource;
	confidence: number;
	evidence: EvidenceRef[];
	createdAt: string;
	updatedAt: string;
	validUntil?: string;
	replacedBy?: string;
	rejectedAt?: string;
}

/** Trusted edges count with full weight: the learner's own and confirmed
 *  ones, still valid, never rejected. */
export function isTrustedEdge(edge: LearnerEdge): boolean {
	return (edge.source === "mine" || edge.source === "extracted-confirmed") && !edge.validUntil && !edge.rejectedAt;
}

/** Edges currently shown (suggestions included): valid and not rejected. */
export function isCurrentEdge(edge: LearnerEdge): boolean {
	return !edge.validUntil && !edge.rejectedAt;
}
