/**
 * Per-response feedback (PLAN.md Phase 2): GET ?chatId= | ?workspaceId=
 * lists the live items; POST creates one (stored in learner/feedback.jsonl
 * and handed to the chat's agent on the learner's next turn).
 */
import { LearnerInputError, listFeedback, submitFeedback } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const params = new URL(request.url).searchParams;
	return Response.json({ feedback: listFeedback({ chatId: params.get("chatId") ?? undefined, workspaceId: params.get("workspaceId") ?? undefined }) });
}

export async function POST(request: Request) {
	const body = await request.json().catch(() => null);
	try {
		return Response.json({ feedback: submitFeedback(body) }, { status: 201 });
	} catch (error) {
		if (error instanceof LearnerInputError) return Response.json({ error: error.message }, { status: 400 });
		throw error;
	}
}
