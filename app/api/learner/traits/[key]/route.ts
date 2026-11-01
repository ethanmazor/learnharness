/**
 * The learner's own decisions on one trait (PLAN.md Phase 3):
 * {action: "edit", value} | {action: "pin", pinned, item?} |
 * {action: "delete", item?} | {action: "add-item", value} |
 * {action: "override", workspaceId, value | null}.
 */
import { applyTraitAction, LearnerInputError } from "@/src/server";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ key: string }> }) {
	const { key } = await params;
	const body = await request.json().catch(() => null);
	try {
		return Response.json({ profile: applyTraitAction(key, body) });
	} catch (error) {
		if (error instanceof LearnerInputError) return Response.json({ error: error.message }, { status: 400 });
		throw error;
	}
}
