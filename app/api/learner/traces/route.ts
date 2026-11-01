/** Reasoning traces (PLAN.md Phase 3), newest first: ?chatId= | ?workspaceId=. */
import { listTraceEntries } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const params = new URL(request.url).searchParams;
	const traces = listTraceEntries({ chatId: params.get("chatId") ?? undefined, workspaceId: params.get("workspaceId") ?? undefined })
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	return Response.json({ traces });
}
