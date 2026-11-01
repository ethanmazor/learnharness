# PLAN — course workspaces and a learner model

Status: **Phases 1–5 implemented (functionality); Windows build and docs pending.** Plan approved with all defaults.

Decisions already made (asked during planning):

| # | Decision | Answer |
|---|---|---|
| D1 | Workspace scoping | **A chat belongs to one course.** A turn and every worker it starts use that chat's course. The "active course" is a UI choice only: home graph, sidebar, New chat. |
| D2 | How the profile/feedback reach agents | **Transcript marker** (`learner-context`), added at session start and again only when the *active* trait set changes. Works with prompt caching. |
| D3 | Feedback submission | **Store, and tell the agent on the next turn** (a quiet marker). Submitting feedback does not start a turn by itself. |
| D4 | Trace extractor input | **All learner channels:** answers, question thinking, reading thinking, practice thinking, and composer messages. |

Everything marked **[default]** below is my proposal and needs your OK. Section 9 lists the open questions.

---

## 0. Verification of the brief's "external research" facts

| Claim | Verified against code |
|---|---|
| Next.js inside Electron | ✅ `electron/main.cjs` launches the standalone Next server on loopback. Next is `^16.4.3`. |
| Agent runtime `@earendil-works/pi-agent-core` | ✅ pinned `1.4.0`. One `Agent` is built per turn (`src/agent/teacher-agent.ts`). |
| Chats in `chats/*.json` | ✅ `src/store/chats.ts`, under `LH_DATA_DIR` (default repo `data/`). |
| Graph in `graph/{nodes,chains,sessions,coverage}.jsonl` | ✅ `config.ts LEDGER_FILES`. The graph dir also holds `sources.json`, `source-organization.json`, `positions.json`, `render-settings.json` and `format.json`. |
| Settings + editable prompts next to them | ✅ `settings.json`, `prompts/` (override files, switched on by `agent.prompts` in settings). |
| Prober / Teacher (explain/quiz, `plan_init`) / Practitioner | ✅ `createProberAgent` / `createTeacherAgent` / `createPracticeAgent`. |
| Background workers | ✅ researcher, demoBuilder, visualMaker, pdfReader (`src/agent/subagents/runner.ts`). |
| Extractor → Auditor → Merger | ⚠️ Partly. Extractor and Auditor are LLM agents. **The Merger is deterministic code** (`mergeFindings`), not an agent. |
| "Graph nodes are objective facts" rule | ✅ `docs/architecture.md §6`: "The graph stores objective propositions and reasoning chains, not learner understanding levels." |
| Upstream issue #207 | ❓ Could not check: `gh` is not installed here. I'm taking your description (prerequisites leaking across courses) as given. |
| Extra, not in the brief | **Jobs** (`jobs/*.json`) are per chat, so they must move per workspace too. A **bundled Python skill** (`skills/learnharness/scripts/`) reads `data/chats` and `data/graph` directly, and will break unless updated. |
| Environment | `node_modules` is **not installed** in this checkout. Phase 1 starts with `npm ci`, then reading `node_modules/next/dist/docs/` (route handlers, dynamic params), as AGENTS.md requires. |

---

## 1. Current architecture map

| Layer | Files | Responsibility |
|---|---|---|
| Paths | `config.ts` | `PATHS`, `LEDGER_FILES`, `SOURCES_FILE`, `POSITIONS_FILE`, … are **module-level constants** computed once from `LH_DATA_DIR`. `SETTINGS_FILE`, `PROMPTS_OVERRIDE_DIR`, `AUTH_FILE`. |
| Ports | `src/core/ports.ts` | `ChatStore`, `GraphStore`, `JobStore`, `SettingsStore`, `PromptOverrideStore`, `SourceOrganizationStore`, `AuthStore`. |
| Adapters | `src/store/{chats,graph,graph-format,jobs,settings,prompt-overrides,render-settings,source-organization}.ts` | Synchronous fs JSON/JSONL. Each one imports its fixed path from `config.ts`. |
| Composition root | `src/server/stores.ts` | `stores = {chatStore, graphStore, sourceOrganizationStore, jobStore, settingsStore}` singletons. |
| Turn composition | `src/server/chat-handler.ts` | Gates → compaction → `inputAppends` → build Prober/Teacher/Practitioner with tool contexts → `runPiTurn` → `onFinish` (persist, usage, `triggerExtraction`, compaction kick). |
| Input events | `src/core/input-events.ts` | `text`, `answer`, `continue`, `retry`, `retry-question`, `thinking` (practice), `next`, plus server `steers`. |
| Native record | `src/core/native-messages.ts` | `LhMessage` = pi messages + `id`. `LhMarkerMessage` custom types (`graph-context`, `probe-handoff`, `plan-block`, `practice-thinking`, …). `toLlmMessages` flattens markers to user text. |
| Prompts | `src/agent/prompt-segments.ts`, `src/core/prompt-segments.ts`, `src/agent/prompts/{prober,teacher,practice,shared}/NN-*.md`, `src/agent/system-prompt.md` | Composed per turn. Overrides are per-segment files plus switches. Practice uses an **allowlist** of shared fragments. Background-worker prompts (extractor, auditor, …) are **hard-coded in TS and not editable** today. |
| Tools | `src/agent/tools.ts`, `src/agent/tools/*.ts` | Question tools pause the turn. Job tools dispatch workers. `plan_init`, `probe_done`, `problem`/`conclude`, graph readers. |
| Workers | `src/agent/subagents/{runner,extraction,…}.ts`, `src/server/jobs.ts` | Job runner and delivery. Extraction pipeline (one shared instance in `chat-handler.ts`). Shared background-LLM semaphore. |
| Settings | `src/core/settings.ts`, `settings-resolution.ts` | Delta-shaped record. `ROLE_SLOT` maps roles to strong/cheap/vision. |
| Events | `src/core/events.ts`, `/api/events`, `components/server-events.tsx` | Process-local change notifications. |
| UI | `components/sidebar.tsx` (session list), `components/chat.tsx` (transcript), `src/core/view.ts` (`projectView`: one assistant **view message = a group** of consecutive native assistant/toolResult messages; text parts carry `sourceMessageId`), `components/home.tsx` (graph), `components/settings/*` | |
| Routes | `app/chat/[id]`, `app/chat/new`, `app/settings`, `app/api/{chat,chats,graph,jobs,settings,…}` | |
| Tests | `tests/*.test.ts(x)` (node:test via tsx), golden fixtures under `tests/fixtures/golden-data/` (a real legacy data dir) | |

How a message is rendered: `chat.tsx` maps `projectView(record)` → each assistant group renders `<Message><MessageContent>` with a `switch` over part types (`text`, `reasoning`, `tool-*`, `data-*`). A feedback box or assumption chips go **after** `</MessageContent>` for each assistant group.

How agents get context: system prompt (composed segments) + `record.messages` via `toLlmMessages` + tool registries closed over contexts built in `chat-handler.ts`.

---

## 2. Cross-cutting design

### 2.1 New data layout (under `LH_DATA_DIR`)

```
data/
  settings.json              (global, unchanged)
  prompts/                   (global overrides, unchanged)
  debug/                     (global, unchanged)
  backups/pre-workspaces-<ISO>/   (one-time migration backup)
  workspaces/
    index.json               { version, activeWorkspaceId }            [default]
    general/                 (the migrated legacy data)
      workspace.json         { version, id, name, createdAt, archivedAt? }
      chats/  jobs/  graph/  imports/   (imports/ is reserved; empty for now)
    ws_<base36>_<rand>/ …
  learner/                   (global learner layer, above all workspaces)
    feedback.jsonl           Phase 2
    traces.jsonl             Phase 3
    profile.json             Phase 3
    concepts.jsonl, edges.jsonl   Phase 5
    format.json              lazy format stamp (same pattern as graph/format.json)
```

- **[default]** Workspace ids are opaque (`general`, `ws_…`), like chat ids. **Renaming changes only `workspace.json`** and never moves the directory, so evidence links stay valid.
- **[default]** `jobs/` is per workspace (jobs belong to chats). `render-settings.json` stays in each workspace's `graph/`, copied from the legacy one at migration. Settings, prompt overrides, auth and debug stay global.
- `imports/` is created empty and reserved for future per-course documents. Today's notes import (`graph/sources.json` + extraction) already becomes per workspace because it lives in `graph/`.

### 2.2 Making stores workspace-scoped (D1)

Today the paths are import-time constants. Plan:

1. `config.ts`: keep `PATHS.data/root/debug`, `SETTINGS_FILE`, `PROMPTS_OVERRIDE_DIR`, `AUTH_FILE`. Add `PATHS.workspaces`, `PATHS.learner`, and a pure `workspacePaths(id)` → `{root, chats, jobs, graph, imports, ledgers, sources, positions, …}`. The legacy `LEDGER_FILES`/`SOURCES_FILE`/… constants are removed. Callers move to `workspacePaths`.
2. Each adapter becomes a **factory**: `createChatStore(paths)`, `createGraphStore(paths)`, `createJobStore(paths)`, `createSourceOrganizationStore(paths)`, `createRenderSettingsStore(paths)`. The bodies stay the same. Graph-format stamping takes the workspace graph dir.
3. `src/server/stores.ts`: `storesFor(workspaceId)` (cached per id) returns the same `Stores` shape as today. Add `workspaceOfChat(chatId)`: a cached lookup that scans `workspaces/*/chats/<id>.json` (chat ids are globally unique). Add `storesForChat(chatId)`.
4. `chat-handler.ts`, `turn-service.ts`, `jobs.ts`, the job runner, compaction, the extraction pipeline, dismissal, and every `/api/chats/[id]/*` route resolve stores via `storesForChat(chatId)`. The **extraction pipeline** gets stores per run: its registry keys become `workspaceId:sourceId`, and the audit→merge FIFO lock stays process-wide.
5. Graph routes (`/api/graph/*`), notes import, `POST /api/chats`, observability graph revision, and the home graph take an explicit `workspaceId`. **[default]** It comes from a `?workspace=` query parameter or body field. If missing, it falls back to `index.json.activeWorkspaceId`.
6. A new `WorkspaceStore` port plus adapter: `list()`, `get(id)`, `create(name)`, `rename(id, name)`, `archive(id, archived)`, `delete(id)`, `active()`, `setActive(id)`.
7. A new `LearnerStore` port (global, one adapter over `learner/`), filled in from Phase 2 on.

The ESLint import zones are unchanged: core declares the ports, store implements them, server wires them.

### 2.3 Learner layer conventions (Phases 2–5)

- Every inferred fact carries `evidence: EvidenceRef[]`, where `EvidenceRef = { workspaceId, chatId, messageId, kind: "answer"|"thinking"|"readingThinking"|"practiceThinking"|"composer"|"feedback"|"stack", feedbackId?, traceId? }`, and `confidence ∈ [0,1]`.
- JSONL ledgers are append-only. Edits and deletes are new lines (`op: "update"|"delete"`, or a full new revision with the same `id`). The reader folds by id, latest line wins. Corrupt lines are skipped, matching the graph adapter. `profile.json` is a read-modify-write JSON document with an atomic temp-file rename.
- Nothing in `learner/` is ever written into `workspaces/*/graph/`.

### 2.4 New settings (section `learner`, delta-shaped, all with factory defaults) **[default values]**

```ts
learner: {
  enabled: true,               // master switch for tracing + injection
  traceExtraction: true,       // Phase 3 worker
  activationSessions: 3,       // inferred trait → active after N distinct sessions
  feedbackWeight: 3,           // evidence weight of explicit feedback vs 1 for inferred
  contextTokenBudget: 600,     // learner-context marker budget (≈ chars/4)
  recentFeedbackItems: 5,
  stackMaxDepth: 4,            // Phase 4
  bridgeHops: 2,               // Phase 5 search depth
}
```

Plus a new background model role **`tracer`** (cheap slot), shown in Settings → Agent → background models next to extractor/auditor.

### 2.5 Prompt editability

- New **agent-facing** doctrine goes in new numeric fragments, which are editable through the existing override mechanism with no new machinery:
  - `shared/50-learner-profile.md`: how to use the learner-context marker and feedback markers. Also added to the **practice allowlist** so the Practitioner gets it.
  - `teacher/60-assumptions.md`: the `assumptions` tool and the assumption diff (Phase 4).
  - `teacher/62-learning-stack.md`: recursive descent (Phase 4).
  - `teacher/64-bridges.md`: query `my_bridges` before explaining (Phase 5). **[default]** Prober and Practitioner get only the read side of bridges through the shared fragment.
- New **worker** prompts (trace extractor) are not editable today, because worker prompts are hard-coded. **[default]** Add a fourth prompt directory `src/agent/prompts/tracer/` with its own `PromptAgent` kind `"tracer"`, extend `isValidSegmentPath`, and show it in the existing prompt editor. The tracer composes only its own directory, no shared base. Packaging: confirm `scripts/build-server.mjs` copies the new directory.

---

## 3. Phase 1 — Course workspaces

**Data:** as in 2.1/2.2. `workspace.json`:

```json
{ "version": 1, "id": "general", "name": "General", "createdAt": "…", "archivedAt": null }
```

**Migration** (`src/store/workspace-migration.ts`, run once at server boot from `stores.ts`, idempotent):

1. If `workspaces/` exists → do nothing. If the legacy `chats/`, `graph/` and `jobs/` are all absent (fresh install) → create `workspaces/general` empty.
2. Otherwise **copy** the legacy `chats/`, `graph/` and `jobs/` to `backups/pre-workspaces-<ISO>/`, then compare file count and byte size against the originals. On a mismatch, stop the migration and touch nothing. What the app does next is Q1.3.
3. Build `workspaces/.staging-general/` by **renaming** (same filesystem, atomic per directory) `chats/`, `graph/` and `jobs/` into it, then write `workspace.json`, then rename the staging dir to `workspaces/general`, then write `index.json` (active = general).
4. A crash between steps leaves either the legacy layout (re-run) or a staging dir (resume). Both cases are tested.
5. The retired-ledger cleanup in `graph.ts` (it deletes `edges.jsonl`/`events.jsonl`) moves to run per workspace graph dir.

**API (new):** `GET/POST /api/workspaces`, `PATCH /api/workspaces/[id]` (`{name}` | `{archived}`), `DELETE /api/workspaces/[id]`, `PUT /api/workspaces/active`. `GET /api/chats` gains `workspaceId` on each item. **[default]** It returns all workspaces' chats; the sidebar groups them.

**Delete course [default]:** refused (409) while any of its chats has a live turn, a computing job, or a registered extraction. Uses a typed-name confirmation dialog. **Moves the directory to `backups/deleted-workspaces/<id>-<ISO>/`** instead of hard-deleting it. Learner evidence that points to it stays, marked "source deleted" in the UI. `general` can be renamed or archived but **not deleted** (there must always be one workspace).

**Archive [default]:** archived courses collapse into an "Archived" fold at the bottom of the sidebar. Their chats stay openable and readable. New chat is disabled in them. They can be unarchived.

**UI:**
- Sidebar: a **course switcher** at the top (current course name + menu: switch, New course…, Rename, Archive, Delete…). Below it, the session list is **grouped under course headings** (collapsible). The active course is expanded first and the others are collapsed. The existing search and Teaching/Practice/All filter apply across all groups. Each heading has a "+" for a new chat in that course.
- "+ Teaching / + Practice" create in the **active** course. `/chat/new?workspace=<id>` carries the choice. `POST /api/chats` takes `workspaceId`.
- Home graph, chains view, notes import, source organization and coverage show the **active** course.
- Opening a chat from another course does **not** change the active course **[default]**. The chat header shows a small course label.

**Changed files (main):** `config.ts`, `src/core/ports.ts`, `src/core/contracts/*` (workspace types), all `src/store/*` adapters (factory form), `src/server/stores.ts`, `chat-handler.ts`, `turn-service.ts`, `jobs.ts`, `compaction.ts`, `observability.ts`, `graph.ts`, `source-*.ts`, `src/agent/subagents/{runner,extraction}.ts` (deps per run), every `app/api/chats/**` and `app/api/graph/**` route, `app/chat/*/page.tsx`, `app/page.tsx`, `components/{sidebar,home,new-session,graph-view,notes-import,…}.tsx`, `skills/learnharness/scripts/_data.py` (+ `graph.py`/`sessions.py`: a `--workspace` flag; default = active from `index.json`; legacy layout still readable), `skills/learnharness/references/data-format.md`, `docs/architecture.md §8`, `docs/development.md`.

**New files:** `src/store/workspaces.ts`, `src/store/workspace-migration.ts`, `src/core/contracts/workspace.ts`, `app/api/workspaces/**`, `components/course-switcher.tsx`, tests below.

**Tests:** migration (legacy → general, fresh install, re-run no-op, interrupted at each step, backup verified), workspace CRUD and refusal rules, chat locator, **isolation** (a turn and extraction in chat A of course X never touch course Y's ledgers), golden fixtures read through migration, sidebar grouping render test. About 15 existing tests that `unlink(path.join(PATHS.chats, …))` move to the general workspace's paths. This is mechanical.

---

## 4. Phase 2 — Per-response feedback

**Unit of feedback [default]:** one **assistant view group** (what you see as one agent response). The stored `messageId` is the group's first native assistant message id. `messageIds` lists every native assistant message in the group. For "This part lost me", the quoted span also records the **native source message id** of the text part it came from (`sourceMessageId`).

**Schema** (`learner/feedback.jsonl`, one line per revision):

```ts
interface FeedbackItem {
  id: string;                 // fb_<base36>_<rand>
  rev: number;                // edits append rev+1; op:"delete" tombstones
  op?: "delete";
  workspaceId: string;
  chatId: string;
  messageId: string;          // group's first assistant message id
  messageIds: string[];
  type: "rewrite" | "reading" | "lost" | "tags";
  text?: string;              // rewrite / reading / note on "lost"
  quote?: { text: string; sourceMessageId: string; start?: number; end?: number };
  tags: Array<"too-abstract" | "steps-skipped" | "too-many-steps" | "wrong-start" | "good">;
  createdAt: string;
  updatedAt: string;
}
```

One submission can combine tags with one text type. Rewrite, reading and lost can each be submitted several times per message.

**Agent visibility (D3):** on submit, the server appends a `learner-feedback` marker to the chat. Its model-facing content is a short bracketed line, e.g. `[Learner feedback on your previous response] Tags: too abstract. "How I would say it": …`. `details` holds the feedback id. It is visible in the transcript as a compact line. **[default]** If a turn is running or a question is pending, the feedback is saved to `feedback.jsonl` at once, but its marker waits in a pending queue and is added with your next input. A marker must never land between a question's tool call and its result, because providers reject that history shape.

**UI:** under each assistant group, a quiet "Feedback" disclosure (collapsed by default, keyboard reachable). Inside: two textareas (How I would say it / How I read this), tag chips, and a **"This part lost me"** mode: select text in the response → a floating "Lost me here" button captures the quote → optional note. Dictation works in these textareas (the same `useDictationTarget` claim as the other fields). Submitted items show as small chips you can edit or delete. Not shown on chats while a turn streams.

**Routes:** `GET /api/learner/feedback?chatId=`, `POST`, `PATCH /api/learner/feedback/[id]`, `DELETE`.

**Tests:** ledger fold (edit, delete), marker placement rules, quote capture helper (pure), render test.

---

## 5. Phase 3 — Reasoning style model

### 5.1 Trace extractor (worker, `tracer` role, cheap slot)

- **Trigger:** at turn settlement (next to `triggerExtraction`) **and** at feedback submit. It collects learner inputs not yet traced: answers + `thinking` + `readingThinking` (toolResult details), `practice-thinking` markers, composer `user` messages (D4), and new feedback items. It does not need any message-count threshold. Inputs under ~15 words with no thinking are skipped **[default]**. Also runs for practice sessions (unlike graph extraction). Gated by `learner.enabled && learner.traceExtraction`, the background-LLM semaphore and subscription background consent. One run per chat at a time.
- **Context given to the worker:** the learner input(s), plus the assistant prose immediately before them (trimmed), so it can tell what you were reacting to. It submits through a single `submit_traces` tool, the same pattern as the extractor.
- **Trace schema** (`learner/traces.jsonl`):

```ts
interface ReasoningTrace {
  id: string; rev: number; op?: "delete";
  evidence: EvidenceRef;                  // the source learner message
  respondingTo?: string;                  // assistant message id
  steps: Array<{ order: number; text: string }>;
  assumptionsUsed: string[];
  assumptionsMissing: string[];           // skipped / lacked
  references: Array<{ kind: "analogy"|"topic"|"example"; text: string; domain?: string }>;
  entryPoint: "example-first"|"definition-first"|"visual"|"procedure"|"intuition"|"analogy"|"question"|"unclear";
  signals: {                              // optional per-trace style observations
    abstraction?: "concrete"|"mixed"|"abstract";
    stepSize?: "small"|"medium"|"large";
    notation?: string[]; formatting?: string[];
  };
  confidence: number;                     // worker's own
  model: string; createdAt: string;
}
```

Feedback items are traced too. Their trace evidence has `kind: "feedback"` and is weighted by `feedbackWeight`. Quick tags map **deterministically** with no LLM: too abstract → abstraction "concrete", steps skipped → stepSize "small", too many steps → stepSize "large", wrong start → conflict evidence against the current entry point, good → support for every active trait at that time.

### 5.2 Profile (`learner/profile.json`)

Aggregation is **deterministic code** (`src/core/learner-profile.ts`, pure), folding traces + feedback. No extra LLM call.

```ts
interface LearnerProfile {
  version: 1;
  traits: Record<TraitKey, Trait>;                       // global
  overrides: Record<WorkspaceId, Partial<Record<TraitKey, Trait>>>;
  updatedAt: string;
}
type TraitKey = "entryPoint"|"abstraction"|"stepSize"|"notation"|"analogyDomains"|"formatting"|"missingAssumptions";
interface Trait {
  value: string | string[];           // scalar traits: one value; list traits: items
  confidence: number;
  evidenceCount: number;
  evidence: EvidenceRef[];            // capped list shown in UI; full set derivable
  sessions: number;                   // distinct chatIds supporting the value
  firstSeen: string; lastUpdated: string;
  source: "inferred" | "feedback" | "edited";
  status: "candidate" | "active";
  pinned: boolean;
  history: Array<{ at: string; value: Trait["value"]; confidence: number; reason: string }>;
}
```

- **Confidence [default]:** `s / (s + c + 1)`, where `s` = weighted support for the current value and `c` = weighted support for competing values (feedback weight 3, inferred 1).
- **Activation:** `inferred` → `active` when `sessions ≥ activationSessions`. `feedback`/`edited` → active at once.
- **Conflict:** competing evidence lowers confidence and appends a history entry. The value only **switches** when a competing value itself meets the activation rule and passes the current one in support. The switch is recorded in `history`. Pinned traits never switch automatically. Their confidence still updates and is shown.
- **List traits** (notation, analogy domains, formatting, missing assumptions): each item is a sub-trait with its own evidence and activation.
- **Per-course overrides [default]:** evidence carries `workspaceId`, so aggregation also runs per workspace. An override is created only by **your edit** ("Override for this course") in v1. Automatic per-course divergence is shown as a hint but not applied (see Q3.2).
- **Edits and deletes:** an edit sets `source: "edited"` and status active. Delete adds a tombstone `{deletedAt}`. **[default]** Evidence from before the delete is ignored, and later evidence can bring the trait back as a new candidate.

### 5.3 Context injection (D2)

- `src/core/learner-context.ts` (pure) renders a compact block: active traits (with any course overrides applied), then the most recent relevant feedback (same chat first, then same course, max `recentFeedbackItems`), truncated to `contextTokenBudget`.
- `chat-handler.ts`, before building the agent: if `learner.enabled` and the rendered **active-trait fingerprint** differs from the last `learner-context` marker in this chat (or there is none), append a new `learner-context` marker in the same write-ahead as the input. New-feedback markers (Phase 2) cover feedback between refreshes.
- The marker renders as a collapsible "How I learn — applied" card. `shared/50-learner-profile.md` tells all three agents to use it to choose structure, order, step size and format. The marker is model-facing text, so it travels through compaction summaries like other markers.

### 5.4 UI — "How I learn" panel

A new route `/learner` (sidebar entry under Settings) with tabs: **Traits** (each trait: value, confidence bar, status, sessions, source, evidence list linking to `/chat/<id>#msg-<messageId>`; actions: edit, pin, delete, override for current course), **Feedback** (all items, edit or delete), **Traces** (read-only list, delete). The **Bridges** tab comes in Phase 5.

Routes: `GET /api/learner/profile`, `PATCH /api/learner/profile/traits/[key]` (edit/pin/override), `DELETE …`, `GET/DELETE /api/learner/traces[/id]`.

**Tests:** aggregation (activation threshold, feedback activates at once, conflict lowers confidence without switching, switch with history, pin, delete tombstone), context rendering under budget, marker refresh only on fingerprint change, tracer input collection (all five channels, skip rule), worker with an injected fake engine.

---

## 6. Phase 4 — Assumptions and recursive descent

### 6.1 Explicit assumptions

A new **Teacher** tool `assumptions` (non-terminating, server-side validation, result = short ack):

```ts
{ items: Array<{ id: string; label: string; statement: string;
                 kind: "assumption" | "prerequisite"; graphNodeId?: string }>,
  diff?: { learnerPathMessageId: string;
           usedNotByLearner: string[];      // item ids
           divergence: Array<{ learnerStep: string; myStep: string; note: string }> } }
```

Doctrine (`teacher/60-assumptions.md`): call it before or with each `explain`/worked solution. If the learner's own reasoning came first, fill `diff` and build the explanation from the learner's entry point and steps, filling only the gaps. `projectView` attaches the call to its group. The UI renders **chips** under that assistant group (label, hover shows statement). The diff renders as a small "Your path vs mine" disclosure.

### 6.2 Learning stack

- **State is derived from the chat record** (like the plan status): `stack-push` / `stack-pop` markers plus `stack_push`/`stack_pop` tool calls. `core/learning-stack.ts` folds them into `frames: [{ id, label, statement, origin: {kind:"root"|"chip"|"feedback"|"agent", ref}, pushedAt }]`. This survives restarts with no second copy that could disagree. (Your brief says "store stack state with the chat". It is stored in the chat record, as markers.)
- **Push from the UI:** "I don't get this" on a chip, or "Push to stack" on a "lost me" feedback item, sends a new input event `{type:"stack", action:"push", …}`. This appends a `stack-push` marker (model text: `[Learning stack] The learner lacks: <label> — <statement>. Teach this first, then return.`) **and starts a turn**. It is disabled while a question is pending or a turn runs.
- **Agent tools (Teacher):** `stack_push` (a deeper missing prerequisite, refused past `stackMaxDepth`) and `stack_pop` (when the learner has shown understanding; requires `evidenceMessageId`). After a pop, the doctrine is to resume the frame above.
- **UI breadcrumb** above the composer: `Original problem › A › B`. Clicking a crumb = **jump back** (`action:"jump", frameId` → pops everything above that frame and starts a turn to resume). "×" on the top crumb = **close level** (pop without resuming? see Q4.2).
- **Evidence (4.4):** every push adds an `EvidenceRef{kind:"stack"}` to the `missingAssumptions` trait. Every pop records a resolution, which feeds Phase 5 (6.3).
- **Prober / Practitioner:** no chips or stack in v1 **[default]**.

### 6.3 Hooks for Phase 5

When a frame pops, write a `resolution` line (frame label, parent frame label, chatId, workspaceId, evidence ids) to `learner/traces.jsonl` as `type: "stack-resolution"`. Phase 5 turns it into an edge.

**Tests:** stack fold (push/pop/jump/depth limit/restart), tool validation, input-event parsing, marker flattening, breadcrumb render, chips render.

---

## 7. Phase 5 — Learner-specific bridges

### 7.1 Storage behind an interface

```ts
// src/core/ports.ts
interface LearnerGraphStore {
  concepts(): LearnerConcept[];
  upsertConcept(c: LearnerConcept): void;
  edges(opts?: { includeReplaced?: boolean }): LearnerEdge[];
  appendEdge(e: LearnerEdge): void;
  replaceEdge(oldId: string, next: LearnerEdge): void;   // sets old.validUntil + replacedBy
  deleteEdge(id: string): void;                          // tombstone (only for your own edges / rejected suggestions)
}
```

The JSONL adapter is `src/store/learner-graph.ts` (`learner/concepts.jsonl`, `learner/edges.jsonl`, revision lines, fold by id). Graph queries (`core/learner-bridges.ts`: N-hop search) are pure functions over `concepts()`/`edges()`, so a Graphiti adapter could replace the store without agent changes.

```ts
interface LearnerConcept { id; label; aliases: string[]; workspaces: string[];
  objectiveLinks: Array<{ workspaceId: string; nodeId: string }>; createdAt; updatedAt }
interface LearnerEdge { id; rev; from; to;
  type: "analogy"|"understood-through"|"same-structure"|"prerequisite-for-me"|"contrast";
  wording?: string; source: "mine"|"extracted-confirmed"|"extracted-unconfirmed";
  confidence: number; evidence: EvidenceRef[]; createdAt;
  validUntil?: string; replacedBy?: string; rejectedAt?: string }
```

### 7.2 Proposals and trust

- The tracer (Phase 3) also outputs `bridges: [{fromLabel, toLabel, type, wording}]` from your references and analogies. The server matches labels to concepts (fuzzy, `core/fuzzy.ts`), creating concepts when needed, and appends `extracted-unconfirmed` edges.
- Unconfirmed edges appear as **suggestions** (Bridges tab, plus a count badge). Confirm → `extracted-confirmed`. Reject → `rejectedAt`. Only `mine` and `extracted-confirmed` count with full weight. **[default]** Unconfirmed edges are never shown to agents.
- Stack resolutions (6.3) → a `prerequisite-for-me` edge, source `extracted-unconfirmed`, with the stack evidence. See Q5.1.

### 7.3 Teacher query

A new read tool `my_bridges({ concept, hops? })` → trusted paths (≤ `bridgeHops`) from concepts you already understand to the target, each with your wording. Doctrine (`teacher/64-bridges.md`): call it before explaining a new concept and explain through the strongest path ("explain eigenvectors through your steady-state idea from Markov chains"). The Prober and Practitioner get the same read tool **[default]**.

### 7.4 UI

Bridges tab in `/learner`: a **list view first** (filter: course / all; columns from → type → to, wording, source, confidence; add, edit, delete; suggestions section with confirm/reject). Then a simple force-directed view (reusing `d3-force`, already a dependency) with the same filter. Editing an edge = `replaceEdge`, so the old edge is kept and marked replaced.

**Tests:** fold/replace/tombstone, N-hop query (trusted only, hop limit, cycles), label matching, tracer → suggestion, stack resolution → edge, render tests.

---

## 8. Done criteria and README

After Phase 5: all phases work end to end, `npm run typecheck && npm run lint && npm test` pass, PLAN.md status is updated, the README gains a "Courses and your learner model" section describing workspaces, `workspaces/` and `learner/`, and `docs/architecture.md` §8 storage table is updated.

---

## 9. Open questions (please answer or accept the defaults)

**Phase 1**
- **Q1.1** Delete course: move it to `backups/deleted-workspaces/` (default) or hard-delete?
- **Q1.2** Should a chat be **movable** between courses? Default: not in Phase 1 (moving would need its graph contributions moved too).
- **Q1.3** If the migration backup check fails at first launch: refuse to start the server with a clear error (default), or continue on the legacy layout without workspaces?
- **Q1.4** Update the bundled Python skill (`skills/learnharness`) to understand workspaces in Phase 1? Default: yes.
- **Q1.5** Graph render settings (sizes and colors): per course (default, because the file lives in each course's `graph/`) or one global setting?

**Phase 2**
- **Q2.1** Is a feedback unit = one visible agent response (a view group) right, or do you want feedback per paragraph/step?
- **Q2.2** Should "Good" carry an optional note too?

**Phase 3**
- **Q3.1** The trait vocabulary and value enums in 5.1/5.2: anything to add (e.g. "wants the why before the how", "language/terminology level")?
- **Q3.2** Per-course overrides: only by your edit (default), or created automatically when a course's own evidence meets the threshold and disagrees with the global value?
- **Q3.3** The tracer runs a cheap-model call after most turns. OK, or should it batch (e.g. every N inputs or at session end)?
- **Q3.4** Adding a `tracer` prompt directory to the prompt editor (2.5): OK?

**Phase 4**
- **Q4.1** Pushing a stack frame starts a turn at once (default). OK?
- **Q4.2** "Close level" (×): pop and resume the frame below (same as jump), or pop silently without telling the agent?
- **Q4.3** Default `stackMaxDepth = 4`?

**Phase 5**
- **Q5.1** Stack resolutions → bridge edge as `extracted-unconfirmed` (default) or auto-confirmed, since you went through it yourself?
- **Q5.2** Prober/Practitioner also get `my_bridges` (default yes)?

## 10. Risks

- **Real data migration.** It moves your only copy of chats and graph. Mitigations: verified backup first, atomic renames, staging-directory resume, and tests against the golden fixtures (a real legacy data dir). I'll also recommend you copy your data dir by hand before first launch.
- **Store refactor reach.** About 140 store call sites and about 15 tests change from singletons to per-workspace stores. The risk is a missed call site that silently uses the wrong course. Mitigation: no global singleton remains (a missed site fails typecheck), plus isolation tests.
- **Background work across courses.** Extraction registries and the job registry are keyed by chat, or source + workspace. Course deletion preflights all of them.
- **Cost.** The tracer adds a cheap-model call per settled turn. It sits behind the semaphore, subscription consent, and an off switch.
- **Prompt cache.** The marker design only appends. A refresh happens only when the active-trait set changes.
- **Model behavior.** Assumption chips, diffs, stack discipline and bridge use depend on the model following the doctrine. Tools validate structure, not quality, and there is no evaluation loop (out of scope).
- **Privacy.** `learner/` holds personal inferences. It stays local like everything else and is excluded from builds (check `scripts/build-server.mjs` data exclusion).
- **Upstream merges.** This fork diverges widely from upstream in store wiring, so future upstream pulls will conflict in `src/store`, `src/server` and `components/sidebar.tsx`.

## 11. Status

| Phase | Status |
|---|---|
| 0 Plan | ✅ Approved (all defaults) |
| 1 Workspaces | ✅ Done — migration, course store, chat/job routing, per-course graph, sidebar grouping + switcher, Python skill. Tests: workspace-migration, workspaces, course-groups, tests/skills |
| 2 Feedback | ✅ Done — feedback box, learner/feedback.jsonl, learner-feedback marker. Tests: learner-feedback |
| 3 Style model | ✅ Done — tracer worker (cheap slot, editable prompt), traces, profile fold, learner-context marker, /learner panel. Tests: learner-model |
| 4 Assumptions + stack | ✅ Done — assumptions tool + chips, stack_push/pop, stack input, breadcrumb, stack evidence. Tests: learning-stack |
| 5 Bridges | ✅ Done — concepts/edges behind LearnerGraphStore, suggestions, my_bridges tool, list + graph UI. Tests: learner-bridges |
| Remaining | ⏳ README section, docs/architecture.md §8 update, Windows .exe build, manual testing by you |
