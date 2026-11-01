/**
 * The sidebar's course grouping (PLAN.md Phase 1): order, default
 * expansion, the learner's overrides, search behavior, the keyboard walk's
 * visible rows, and the course header / delete-course dialog renders.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { groupChatsByCourse, visibleRows } from "../components/course-groups.ts";
import { CourseHeader } from "../components/sidebar.tsx";
import { DeleteCourseBody } from "../components/course-switcher.tsx";
import type { ChatListItem, WorkspaceSummary } from "../src/core/index.ts";

const ws = (id: string, extra: Partial<WorkspaceSummary> = {}): WorkspaceSummary => ({ id, name: id.toUpperCase(), createdAt: "2026-11-01", archived: false, active: false, chatCount: 0, ...extra });
const chat = (id: string, workspaceId: string): ChatListItem => ({
	id, workspaceId, title: id, kind: "teach", createdAt: "2026-11-01", updatedAt: "2026-11-01", messageCount: 0,
	phase: "probe", pendingQuestion: false, pendingProblem: false, busy: false, compacting: false,
});

describe("groupChatsByCourse", () => {
	const workspaces = [ws("general"), ws("la", { active: true }), ws("old", { archived: true })];
	const chats = [chat("c1", "general"), chat("c2", "la"), chat("c3", "old"), chat("c4", "la")];

	it("puts the active course first, keeps chat order, separates archived courses", () => {
		const groups = groupChatsByCourse(chats, workspaces, {}, false);
		assert.deepEqual(groups.open.map((g) => g.workspace.id), ["la", "general"]);
		assert.deepEqual(groups.open[0]!.chats.map((c) => c.id), ["c2", "c4"]);
		assert.deepEqual(groups.archived.map((g) => g.workspace.id), ["old"]);
	});

	it("expands only the active course by default; the learner's toggles win", () => {
		const groups = groupChatsByCourse(chats, workspaces, { general: true, la: false }, false);
		assert.deepEqual(groups.open.map((g) => [g.workspace.id, g.expanded]), [["la", false], ["general", true]]);
		assert.deepEqual(visibleRows(groups, false, false).map((c) => c.id), ["c1"]);
	});

	it("a search expands courses with matches and hides empty ones (archived included)", () => {
		const groups = groupChatsByCourse([chat("c3", "old")], workspaces, { old: false }, true);
		assert.deepEqual(groups.open, []);
		assert.deepEqual(visibleRows(groups, false, true).map((c) => c.id), ["c3"]);
	});

	it("archived rows are walked only when the fold is open", () => {
		const groups = groupChatsByCourse(chats, workspaces, { old: true }, false);
		assert.ok(!visibleRows(groups, false, false).some((c) => c.id === "c3"));
		assert.ok(visibleRows(groups, true, false).some((c) => c.id === "c3"));
	});
});

describe("course chrome renders", () => {
	it("CourseHeader shows the name, count and a per-course new-session button (not for archived)", () => {
		const html = renderToStaticMarkup(<CourseHeader group={{ workspace: ws("la", { name: "Linear Algebra" }), chats: [chat("c", "la")], expanded: true }} onToggle={() => {}} onNew={() => {}} />);
		assert.match(html, /Linear Algebra/);
		assert.match(html, /aria-expanded="true"/);
		assert.match(html, /New teaching session in Linear Algebra/);
		const archived = renderToStaticMarkup(<CourseHeader group={{ workspace: ws("x", { archived: true }), chats: [], expanded: false }} onToggle={() => {}} onNew={() => {}} />);
		assert.doesNotMatch(archived, /course-new-session/);
	});

	it("DeleteCourseBody keeps Delete disabled until the name is typed", () => {
		const props = { course: { name: "Biology", chatCount: 2 }, busy: false, failure: null, onTyped: () => {}, onClose: () => {}, onRun: () => {} };
		assert.match(renderToStaticMarkup(<DeleteCourseBody {...props} typed="Bio" />), /disabled=""[^>]*>Delete course/);
		assert.doesNotMatch(renderToStaticMarkup(<DeleteCourseBody {...props} typed="Biology" />), /disabled=""[^>]*>Delete course/);
		assert.match(renderToStaticMarkup(<DeleteCourseBody {...props} typed="" />), /2 sessions/);
	});
});
