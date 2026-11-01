/** One link: PATCH {action: confirm | reject | edit, from?, to?, type?, wording?}; DELETE. */
import { changeBridge, deleteBridge, LearnerInputError } from "@/src/server";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = await request.json().catch(() => null);
	try {
		return Response.json({ edge: changeBridge(id, body) });
	} catch (error) {
		if (error instanceof LearnerInputError) return Response.json({ error: error.message }, { status: error.message === "No such link" ? 404 : 400 });
		throw error;
	}
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		deleteBridge(id);
		return Response.json({ ok: true });
	} catch (error) {
		if (error instanceof LearnerInputError) return Response.json({ error: error.message }, { status: 404 });
		throw error;
	}
}
