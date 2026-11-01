/**
 * The ACTIVE course (PLAN.md Phase 1): a UI choice only — it decides what the
 * home graph, source directory and New chat use. A chat's own turns never
 * follow it (they stay in the chat's workspace).
 */
import { listWorkspaceSummaries, stores, workspaceErrorResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
	const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
	if (typeof body?.id !== "string") return Response.json({ error: "Body must be {id: string}" }, { status: 400 });
	try {
		stores.workspaceStore.setActive(body.id);
		return Response.json({ workspaces: listWorkspaceSummaries() });
	} catch (error) {
		return workspaceErrorResponse(error);
	}
}
