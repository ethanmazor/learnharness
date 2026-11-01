/** Delete one trace (a tombstone — the input is never re-traced). */
import { deleteTrace, LearnerInputError } from "@/src/server";

export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		deleteTrace(id);
		return Response.json({ ok: true });
	} catch (error) {
		if (error instanceof LearnerInputError) return Response.json({ error: error.message }, { status: 404 });
		throw error;
	}
}
