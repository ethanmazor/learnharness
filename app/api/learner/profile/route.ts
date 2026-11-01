/**
 * The learner profile (PLAN.md Phase 3): recomputed from the ledgers on
 * every read, so a changed activation threshold or feedback weight shows
 * at once. Also carries the courses (for per-course overrides) and the
 * resolved learner settings.
 */
import { effectiveSettings, listWorkspaceSummaries, recomputeProfile, TRAIT_ORDER } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({
		profile: recomputeProfile(),
		order: TRAIT_ORDER,
		workspaces: listWorkspaceSummaries(),
		settings: effectiveSettings().learner,
	});
}
