/**
 * Course workspaces (PLAN.md Phase 1): GET lists every workspace (with the
 * active flag and chat counts); POST {name} creates one.
 */
import { listWorkspaceSummaries, stores, workspaceErrorResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ workspaces: listWorkspaceSummaries() });
}

export async function POST(request: Request) {
	const body = (await request.json().catch(() => ({}))) as { name?: unknown; activate?: unknown };
	try {
		const created = stores.workspaceStore.create(typeof body.name === "string" ? body.name : "");
		if (body.activate === true) stores.workspaceStore.setActive(created.id);
		return Response.json({ workspace: created, workspaces: listWorkspaceSummaries() }, { status: 201 });
	} catch (error) {
		return workspaceErrorResponse(error);
	}
}
