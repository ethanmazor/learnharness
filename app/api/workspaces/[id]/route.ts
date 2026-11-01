/**
 * One course workspace (PLAN.md Phase 1): PATCH {name} renames, PATCH
 * {archived: boolean} archives/unarchives; DELETE moves the workspace to
 * backups/deleted-workspaces/ — refused (409) while any of its work runs,
 * and always for the General course.
 */
import { deleteWorkspace, listWorkspaceSummaries, stores, workspaceErrorResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await request.json().catch(() => null)) as { name?: unknown; archived?: unknown } | null;
	if (!body || (body.name === undefined && typeof body.archived !== "boolean")) {
		return Response.json({ error: "Body must be {name} or {archived: boolean}" }, { status: 400 });
	}
	try {
		if (body.name !== undefined) stores.workspaceStore.rename(id, typeof body.name === "string" ? body.name : "");
		if (typeof body.archived === "boolean") stores.workspaceStore.setArchived(id, body.archived);
		return Response.json({ workspaces: listWorkspaceSummaries() });
	} catch (error) {
		return workspaceErrorResponse(error);
	}
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		deleteWorkspace(id);
		return Response.json({ workspaces: listWorkspaceSummaries() });
	} catch (error) {
		return workspaceErrorResponse(error);
	}
}
