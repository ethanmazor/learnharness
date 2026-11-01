import { deleteSources, readOrganizationAction, sourceDirectoryFor, SourceDeletionError, SourceOrganizationInputError, WorkspaceError, workspaceErrorResponse, workspaceFromRequest } from "@/src/server";
import { emit } from "@/src/core";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	try { return Response.json(sourceDirectoryFor(workspaceFromRequest(request)).read()); }
	catch (error) {
		if (error instanceof WorkspaceError) return workspaceErrorResponse(error);
		return Response.json({ error: "Could not read source organization." }, { status: 500 });
	}
}

export async function DELETE(request: Request) {
	try { return Response.json(deleteSources(workspaceFromRequest(request), await readOrganizationAction(request))); }
	catch (error) {
		if (error instanceof WorkspaceError) return workspaceErrorResponse(error);
		if (error instanceof SourceDeletionError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
		if (error instanceof SourceOrganizationInputError) return Response.json({ error: error.message }, { status: 400 });
		return Response.json({ error: "Could not finish source deletion. Some entries may already have been removed; refresh or retry." }, { status: 500 });
	} finally {
		emit("sources-changed", {}); emit("chats-changed", {}); emit("activity-changed", {});
	}
}

export async function POST(request: Request) {
	try { return Response.json(sourceDirectoryFor(workspaceFromRequest(request)).change(await readOrganizationAction(request))); }
	catch (error) {
		if (error instanceof WorkspaceError) return workspaceErrorResponse(error);
		const input = error instanceof SourceOrganizationInputError;
		return Response.json({ error: input ? error.message : "Could not save source organization." }, { status: input ? 400 : 500 });
	}
}
