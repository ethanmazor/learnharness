/**
 * LearnerStore — the fs adapter for the GLOBAL learner layer (PLAN.md
 * Phases 2–5): data/learner/{feedback,traces,concepts,edges}.jsonl plus
 * profile.json. Implements core/ports.ts LearnerStore. Same idioms as the
 * graph adapter: sync fs, append-only JSONL, corrupt lines skipped, a lazy
 * format stamp (learner/format.json) with honest refusal of a newer one.
 * Lives above every course workspace — never inside a workspace graph.
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import type { LearnerLedger, LearnerStore } from "../core/ports.ts";

/** The learner-layer format this build understands. */
export const CURRENT_LEARNER_FORMAT_VERSION = 1;

export function createLearnerStore(dir: string): LearnerStore {
	const formatFile = path.join(dir, "format.json");
	const ledgerFile = (ledger: LearnerLedger) => path.join(dir, `${ledger}.jsonl`);
	const profileFile = path.join(dir, "profile.json");

	function assertFormat(): void {
		let version: unknown;
		try {
			version = (JSON.parse(fs.readFileSync(formatFile, "utf-8")) as { version?: unknown }).version;
		} catch {
			return; // absent or corrupt = v1 (lazy stamp)
		}
		if (typeof version === "number" && version > CURRENT_LEARNER_FORMAT_VERSION) {
			throw new Error(
				`Learner data is stamped with format version ${version}, but this build understands only ${CURRENT_LEARNER_FORMAT_VERSION}. Upgrade the app.`,
			);
		}
	}

	function ensureFormat(): void {
		fs.mkdirSync(dir, { recursive: true });
		if (!fs.existsSync(formatFile)) {
			fs.writeFileSync(formatFile, JSON.stringify({ version: CURRENT_LEARNER_FORMAT_VERSION }, null, "\t") + "\n", "utf-8");
		}
	}

	return {
		appendLine(ledger, line) {
			assertFormat();
			ensureFormat();
			fs.appendFileSync(ledgerFile(ledger), `${JSON.stringify(line)}\n`, "utf-8");
		},
		readLines(ledger) {
			assertFormat();
			let raw: string;
			try {
				raw = fs.readFileSync(ledgerFile(ledger), "utf-8");
			} catch {
				return [];
			}
			const out: Array<{ id: string; rev: number } & Record<string, unknown>> = [];
			for (const text of raw.split("\n")) {
				const trimmed = text.trim();
				if (!trimmed) continue;
				try {
					const parsed = JSON.parse(trimmed) as unknown;
					if (typeof parsed === "object" && parsed !== null && typeof (parsed as { id?: unknown }).id === "string" && typeof (parsed as { rev?: unknown }).rev === "number") {
						out.push(parsed as { id: string; rev: number } & Record<string, unknown>);
					}
				} catch {
					// a torn append never takes the learner layer down
				}
			}
			return out;
		},
		readProfile() {
			assertFormat();
			try {
				return JSON.parse(fs.readFileSync(profileFile, "utf-8")) as unknown;
			} catch {
				return null;
			}
		},
		writeProfile(profile) {
			assertFormat();
			ensureFormat();
			const tmp = `${profileFile}.tmp-${crypto.randomUUID().slice(0, 8)}`;
			try {
				fs.writeFileSync(tmp, JSON.stringify(profile, null, "\t") + "\n", "utf-8");
				fs.renameSync(tmp, profileFile);
			} finally {
				fs.rmSync(tmp, { force: true });
			}
		},
	};
}

/** The app's learner store (data/learner under the LH_DATA_DIR seam). */
export const learnerStore: LearnerStore = createLearnerStore(PATHS.learner);
