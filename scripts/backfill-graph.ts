/**
 * One-time backfill: wipe the legacy ledgers and re-extract every chat with
 * the redesigned pipeline (vision §1, commit b07c907). Run from the master
 * tree only — data never crosses trees:
 *
 *   npx tsx --env-file=.env.local scripts/backfill-graph.ts
 */
import { chatStore } from "../src/store/chats.ts";
import { createExtractionPipeline, type ExtractionPipeline } from "../src/agent/subagents/extraction.ts";
import { getGraph } from "../src/core/graph.ts";
import { effectiveSettings, workspaceStores } from "../src/server/stores.ts";

async function main() {
	const only = process.argv[2]; // optional: extract just one chat id
	const chats = only ? chatStore.listChats().filter((c) => c.id === only) : chatStore.listChats();
	console.log(`[backfill] ${chats.length} chats to extract`);
	// One pipeline per course workspace: each chat extracts into its own
	// workspace's graph (PLAN.md Phase 1).
	const pipelines = new Map<string, ExtractionPipeline>();
	const pipelineFor = (workspaceId: string) => {
		let pipeline = pipelines.get(workspaceId);
		if (!pipeline) {
			pipeline = createExtractionPipeline({
				...workspaceStores(workspaceId),
				// Live budget: the graph section's setting, same as the app's trigger
				getChunkTokens: () => effectiveSettings().graph.extractionChunkTokens,
			});
			pipelines.set(workspaceId, pipeline);
		}
		return pipeline;
	};
	for (const chat of chats) {
		const pipeline = pipelineFor(chat.workspaceId);
		const t0 = Date.now();
		try {
			const stats = await pipeline.runExtraction(chat.id);
			console.log(
				`[backfill] ${chat.id} (${chat.title.slice(0, 40)}): ` +
					`${stats.nodes} nodes, ${stats.chains ?? 0} chains in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
			);
		} catch (err) {
			console.error(`[backfill] ${chat.id} FAILED:`, err);
		}
	}
	for (const workspaceId of pipelines.keys()) {
		const graph = getGraph(workspaceStores(workspaceId).graphStore);
		console.log(`[backfill] ${workspaceId} done: ${graph.nodes.length} nodes, ${graph.chains.length} chains`);
	}
}

main();
