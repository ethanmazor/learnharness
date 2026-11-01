/** Edit (PATCH {text?, quote?, tags?}) or delete one feedback item. */
import { deleteFeedback, LearnerInputError, updateFeedback } from "@/src/server";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = await request.json().catch(() => null);
	try {
		return Response.json({ feedback: updateFeedback(id, body) });
	} catch (error) {
		if (error instanceof LearnerInputError) return Response.json({ error: error.message }, { status: error.message === "No such feedback" ? 404 : 400 });
		throw error;
	}
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		deleteFeedback(id);
		return Response.json({ ok: true });
	} catch (error) {
		if (error instanceof LearnerInputError) return Response.json({ error: error.message }, { status: 404 });
		throw error;
	}
}
