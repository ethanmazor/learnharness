/**
 * The learner's concept links (PLAN.md Phase 5): GET ?workspaceId=&history=1
 * lists concepts + links (suggestions included); POST {from, to, type,
 * wording?, workspaceId?} adds the learner's own link.
 */
import { addBridge, LearnerInputError, listBridges } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const params = new URL(request.url).searchParams;
	return Response.json(listBridges({ workspaceId: params.get("workspaceId") ?? undefined, history: params.get("history") === "1" }));
}

export async function POST(request: Request) {
	const body = await request.json().catch(() => null);
	try {
		return Response.json({ edge: addBridge(body) }, { status: 201 });
	} catch (error) {
		if (error instanceof LearnerInputError) return Response.json({ error: error.message }, { status: 400 });
		throw error;
	}
}
