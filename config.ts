import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (this file is at <root>/config.ts). */
export const ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * THE data-location seam (the Electron contract, 2026-09-17): LH_DATA_DIR
 * relocates every MUTABLE record — chat sessions, graph ledgers, the
 * embedding model cache — when set. The desktop shell points it at
 * userData so nothing is written inside the read-only .app bundle
 * (macOS translocation guarantees the bundle is read-only anyway).
 * Unset (plain web dev / repo work) it resolves to the repo's data/,
 * byte-for-byte as before. Read-only assets (prompts) stay ROOT-anchored
 * on purpose: they ship inside the app bundle by design.
 */
const DATA_ROOT = process.env.LH_DATA_DIR
	? path.resolve(process.env.LH_DATA_DIR)
	: path.join(ROOT, "data");

/** The workspace every legacy record migrates into, and the one that can
 *  never be deleted (there is always at least one course). */
export const GENERAL_WORKSPACE_ID = "general";

/**
 * COURSE WORKSPACES (PLAN.md Phase 1): every chat, job and knowledge-graph
 * file lives inside ONE workspace directory — workspaces/<id>/{chats,jobs,
 * graph,imports}. The data root keeps only the GLOBAL records: settings,
 * prompt overrides, debug traces, the learner layer (learner/) and the
 * migration backups. Paths for one workspace come from workspacePaths(id);
 * the store layer binds adapters to them (src/store/workspaces.ts).
 */
export const PATHS = {
	root: ROOT,
	/** Teacher system prompt — the agent's instructions (src/agent/). */
	teacherPrompt: path.join(ROOT, "src", "agent", "system-prompt.md"),
	data: DATA_ROOT,
	/** One directory per course workspace, plus index.json (the active one). */
	workspaces: path.join(DATA_ROOT, "workspaces"),
	/** The global learner layer above all workspaces (feedback, traces,
	 *  profile, bridges) — never written into a workspace graph. */
	learner: path.join(DATA_ROOT, "learner"),
	/** Migration backups and deleted workspaces (never read by the app). */
	backups: path.join(DATA_ROOT, "backups"),
	/** The GENERAL workspace's chats and graph directories. Production code
	 *  resolves paths per workspace; these name the default workspace for
	 *  tests, scripts and the migration. */
	chats: path.join(DATA_ROOT, "workspaces", GENERAL_WORKSPACE_ID, "chats"),
	graph: path.join(DATA_ROOT, "workspaces", GENERAL_WORKSPACE_ID, "graph"),
	/** Debug artifacts (env-gated): data/debug/provider-events/<chatId>.jsonl
	 * raw provider stream recordings (src/agent/provider-events.ts). */
	debug: path.join(DATA_ROOT, "debug"),
} as const;

/** Every path inside one workspace directory. Ids are validated by the
 *  caller (src/store/workspaces.ts); this is pure path arithmetic. */
export interface WorkspacePaths {
	root: string;
	/** workspace.json — the workspace's name/archive record. */
	meta: string;
	chats: string;
	jobs: string;
	graph: string;
	/** Reserved for future per-course documents (created empty). */
	imports: string;
	ledgers: { nodes: string; chains: string; sessions: string; coverage: string };
	sources: string;
	sourceOrganization: string;
	positions: string;
	renderSettings: string;
	graphFormat: string;
}

export function workspacePaths(id: string): WorkspacePaths {
	const root = path.join(PATHS.workspaces, id);
	const graph = path.join(root, "graph");
	return {
		root,
		meta: path.join(root, "workspace.json"),
		chats: path.join(root, "chats"),
		jobs: path.join(root, "jobs"),
		graph,
		imports: path.join(root, "imports"),
		ledgers: {
			nodes: path.join(graph, "nodes.jsonl"),
			chains: path.join(graph, "chains.jsonl"),
			sessions: path.join(graph, "sessions.jsonl"),
			coverage: path.join(graph, "coverage.jsonl"),
		},
		sources: path.join(graph, "sources.json"),
		sourceOrganization: path.join(graph, "source-organization.json"),
		positions: path.join(graph, "positions.json"),
		renderSettings: path.join(graph, "render-settings.json"),
		graphFormat: path.join(graph, "format.json"),
	};
}

const GENERAL_PATHS = workspacePaths(GENERAL_WORKSPACE_ID);

// ─── Models ────────────────────────────────────────────────────────────────
// BYOK ALL THE WAY DOWN (owner, 2026-09-22): there are NO factory default
// models. Every engine resolves from the user's model slots (settings.json
// models section: strong/cheap/vision) over per-role/ChatSettings overrides,
// and a chain that ends empty REFUSES honestly (503 models_not_configured).
// .env stays for secrets (API keys) only. What remains here are ENGINE
// CONSTRUCTION FACTS: the thinking-level scale and the default order.

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Every agent role in the app. The conversation pair (prober/teacher)
 *  resolves chat.model → strong slot; background roles resolve their own
 *  override → tier slot (core/settings-resolution.ts ROLE_SLOT). */
export type ModelRole =
	| "prober"
	| "teacher"
	| "researcher"
	| "demoBuilder"
	| "visualMaker"
	| "pdfReader"
	| "extractor"
	| "auditor"
	/** The reasoning-trace extractor (PLAN.md Phase 3) — cheap slot. */
	| "tracer";

/**
 * The GENERAL workspace's graph files (tests/scripts; production resolves
 * workspacePaths(id).ledgers). The graph store (src/store/graph.ts) is owned
 * by the app's extraction pipeline. Line shapes: src/core/contracts.ts. CHAINS ARE THE STORED
 * TRUTH (owner, 2026-09-30): edges are a derived view, never stored.
 */
export const LEDGER_FILES = GENERAL_PATHS.ledgers;

/**
 * Notes-import bookkeeping (NOT a ledger): one JSON map, src-id → NotesSource
 * record (contracts/graph.ts) — the file path + import time + the run's usage
 * log. Read-modify-write like a chat file, not append-only like the ledgers.
 */
export const SOURCES_FILE = GENERAL_PATHS.sources;
/** Presentation-only source names/folder placement; never extraction identity. */
export const SOURCE_ORGANIZATION_FILE = GENERAL_PATHS.sourceOrganization;
/** The layout ledger (read-modify-write like sources.json): nodeId →
 *  {x,y} resting positions from the incremental settle (core/layout.ts).
 *  Carries an updatedAt stamp for future live-physics conflict handling. */
export const POSITIONS_FILE = GENERAL_PATHS.positions;

/**
 * Graph render settings (the settings-panel controls): one small JSON blob,
 * read-modify-write. Shared shape/sanitizer: src/core/render-settings.ts.
 */
export const RENDER_SETTINGS_FILE = GENERAL_PATHS.renderSettings;

/** The graph-family FORMAT STAMP sidecar (schema-versioning wave,
 *  2026-10-10): one version for the whole family — the four JSONL ledgers,
 *  sources.json, render-settings.json. LAZY v1: absent = v1; the first
 *  graph-family write creates it. positions.json is REBUILDABLE and rides
 *  along unversioned by design (owner ruling). */
export const GRAPH_FORMAT_FILE = GENERAL_PATHS.graphFormat;

/**
 * THE USER SETTINGS RECORD (settings-storage wave, 2026-09-19): one
 * versioned, DELTA-shaped JSON blob at the data-dir seam holding every
 * non-secret product preference — general, agent (background
 * model/thinking overrides + tool toggles + prompt-override switches),
 * appearance, graph. Explicit user choices only: ABSENT keys resolve to the
 * factory defaults compiled into src/core/settings.ts (FACTORY_SETTINGS), so
 * a software update that adds a knob (new tool, new role, new appearance
 * field) needs no migration — old records simply lack the new keys. The
 * version field is a PRIVATE schema counter for breaking shape changes
 * only (field renamed/meaning changed), unrelated to the app release
 * version. Secrets (API keys, login tokens) NEVER live here — auth.json /
 * .env.local keep that role. (The `chat` default-settings section died
 * with per-session models, owner 2026-09-28 — sessions own their model
 * from birth, stamped from the strong slot.)
 */
export const SETTINGS_FILE = path.join(DATA_ROOT, "settings.json");

/**
 * User prompt-override files (settings-storage wave, 2026-09-19): the
 * per-segment system-prompt overrides mirroring the SOURCE layout
 * (src/agent/prompts/) — the shared base as prompts/system-prompt.md,
 * fragments as prompts/teacher/<file> / prompts/prober/<file>. File
 * PRESENCE alone is not the override: settings.json's agent.prompts map
 * (segmentPath → boolean) is the explicit switch, so a user can keep a
 * customized file on disk but run the source default to compare. The
 * segment list itself is ALWAYS derived from source at runtime (the
 * loader in src/store/prompt-overrides.ts) — code updates that add,
 * remove, or reorder fragments adapt automatically; an override keyed to
 * a vanished segment stops composing but stays on disk.
 */
export const PROMPTS_OVERRIDE_DIR = path.join(DATA_ROOT, "prompts");

/**
 * THE AUTH/KEY STORE (auth-keys wave, 2026-09-19): BYOK provider keys in a
 * flat {VAR: value} JSON map — the SAME file the Electron app has always
 * hand-edited (owner decision: option A, zero migration). Desktop main.cjs
 * passes LH_AUTH_FILE pointing at userData/auth.json (mode 0600); in dev
 * (no Electron) the default is the repo-root auth.json (gitignored, same
 * pattern as .env.local — a worktree may symlink it to the master copy).
 * The SERVER reads/writes this file directly at call time (no restart to
 * change a key); it reflects the values into process.env at boot with
 * FILL-GAP precedence — real environment variables (incl. .env.local in
 * dev) always win (src/server/keys.ts). Hand-edits still work: the file is
 * re-read from disk on every API access. Secrets NEVER go in settings.json
 * — this file keeps that role, alongside .env.local.
 */
export const AUTH_FILE = process.env.LH_AUTH_FILE
	? path.resolve(process.env.LH_AUTH_FILE)
	: path.join(ROOT, "auth.json");
