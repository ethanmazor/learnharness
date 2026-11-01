/**
 * The sidebar's course grouping (PLAN.md Phase 1) — pure, so the render
 * order and the keyboard walk share one derivation (tests pin it).
 *
 * Order: the ACTIVE course first, then the other open courses in workspace
 * order, then archived courses (rendered inside the "Archived" fold). Rows
 * inside a group keep the list's order (newest activity first, or the
 * search ranking). A group is EXPANDED when the learner said so, else when
 * it is the active course; a search query expands every group that has a
 * match and hides the ones that do not.
 */

import type { ChatListItem, WorkspaceSummary } from "@/src/core";

export interface CourseGroup {
	workspace: WorkspaceSummary;
	chats: ChatListItem[];
	expanded: boolean;
}

export function groupChatsByCourse(
	chats: readonly ChatListItem[],
	workspaces: readonly WorkspaceSummary[],
	expandedOverrides: Readonly<Record<string, boolean>>,
	searching: boolean,
): { open: CourseGroup[]; archived: CourseGroup[] } {
	const byWorkspace = new Map<string, ChatListItem[]>();
	for (const chat of chats) {
		const list = byWorkspace.get(chat.workspaceId);
		if (list) list.push(chat);
		else byWorkspace.set(chat.workspaceId, [chat]);
	}
	const ordered = [...workspaces].sort((a, b) => Number(b.active) - Number(a.active));
	const toGroup = (workspace: WorkspaceSummary): CourseGroup => ({
		workspace,
		chats: byWorkspace.get(workspace.id) ?? [],
		expanded: searching ? true : (expandedOverrides[workspace.id] ?? workspace.active),
	});
	const keep = (group: CourseGroup) => !searching || group.chats.length > 0;
	return {
		open: ordered.filter((w) => !w.archived).map(toGroup).filter(keep),
		archived: ordered.filter((w) => w.archived).map(toGroup).filter(keep),
	};
}

/** The rows the keyboard walk visits, in render order: expanded groups
 *  only, the archived fold only when open (or while searching). */
export function visibleRows(
	groups: { open: CourseGroup[]; archived: CourseGroup[] },
	archivedOpen: boolean,
	searching: boolean,
): ChatListItem[] {
	const rows: ChatListItem[] = [];
	for (const group of groups.open) if (group.expanded) rows.push(...group.chats);
	if (archivedOpen || searching) for (const group of groups.archived) if (group.expanded) rows.push(...group.chats);
	return rows;
}
