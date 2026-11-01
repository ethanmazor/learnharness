import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { GENERAL_WORKSPACE_ID, workspacePaths, type WorkspacePaths } from "../../config.ts";
import { emptySourceOrganization, parseSourceOrganization } from "../core/source-organization.ts";
import type { SourceOrganizationStore } from "../core/ports.ts";
import { emit } from "../core/events.ts";
import { assertGraphFormat, ensureGraphFormat } from "./graph-format.ts";

/** One workspace's source-organization sidecar (its graph/ directory). */
export function createSourceOrganizationStore(paths: WorkspacePaths): SourceOrganizationStore {
	const SOURCE_ORGANIZATION_FILE = paths.sourceOrganization;
	return {
		read() {
			assertGraphFormat(paths.graphFormat);
			let raw: string;
			try { raw = fs.readFileSync(SOURCE_ORGANIZATION_FILE, "utf8"); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySourceOrganization();
				throw error;
			}
			return parseSourceOrganization(JSON.parse(raw));
		},
		write(state) {
			assertGraphFormat(paths.graphFormat);
			const valid = parseSourceOrganization(state);
			fs.mkdirSync(path.dirname(SOURCE_ORGANIZATION_FILE), { recursive: true });
			ensureGraphFormat(paths.graphFormat);
			const tmp = `${SOURCE_ORGANIZATION_FILE}.${randomUUID()}.tmp`;
			try {
				fs.writeFileSync(tmp, JSON.stringify(valid, null, "\t") + "\n", "utf8");
				fs.renameSync(tmp, SOURCE_ORGANIZATION_FILE);
			} finally { fs.rmSync(tmp, { force: true }); }
			emit("sources-changed", {});
		},
	};
}

/** The GENERAL workspace's sidecar — tests and scripts only. */
export const sourceOrganizationStore: SourceOrganizationStore = createSourceOrganizationStore(workspacePaths(GENERAL_WORKSPACE_ID));
