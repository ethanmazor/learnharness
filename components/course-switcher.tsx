"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { ArchiveIcon, ArchiveRestoreIcon, CheckIcon, ChevronDownIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { MenuShell } from "@/components/menu-shell";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { useServerEvent, useServerResync } from "@/components/server-events";
import type { WorkspaceSummary } from "@/src/core";

/**
 * COURSE WORKSPACES in the sidebar (PLAN.md Phase 1): the switcher at the
 * top of the session list. One menu: switch course, New course…, and the
 * active course's management — Rename, Archive, Delete…. Archived courses
 * are listed at the bottom with Unarchive. Switching is a UI choice only
 * (the home graph, New chat); a chat always stays in its own course.
 */

/** The workspace list, refetched on workspaces-changed / chats-changed. */
export function useWorkspaces() {
	const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null);
	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/workspaces", { cache: "no-store" });
			if (!res.ok) return;
			const body = (await res.json()) as { workspaces: WorkspaceSummary[] };
			setWorkspaces(body.workspaces);
		} catch {
			/* keep the last snapshot */
		}
	}, []);
	useEffect(() => {
		void refresh();
	}, [refresh]);
	useServerEvent("workspaces-changed", () => void refresh());
	useServerEvent("chats-changed", () => void refresh());
	useServerResync(() => void refresh());

	/** One mutation; the response carries the fresh list. Returns the
	 *  server's error line on failure (rendered by the caller). */
	const mutate = useCallback(async (url: string, method: string, body?: unknown): Promise<string | null> => {
		try {
			const res = await fetch(url, {
				method,
				headers: { "Content-Type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
			const payload = (await res.json().catch(() => ({}))) as { workspaces?: WorkspaceSummary[]; error?: string };
			if (payload.workspaces) setWorkspaces(payload.workspaces);
			return res.ok ? null : (payload.error ?? `Request failed (${res.status})`);
		} catch {
			return "Network error — try again.";
		}
	}, []);
	return { workspaces, refresh, mutate };
}

export function CourseSwitcher({
	workspaces,
	mutate,
}: {
	workspaces: WorkspaceSummary[] | null;
	mutate: (url: string, method: string, body?: unknown) => Promise<string | null>;
}) {
	const router = useRouter();
	const pathname = usePathname();
	const [open, setOpen] = useState(false);
	const [mode, setMode] = useState<"menu" | "create" | "rename">("menu");
	const [draft, setDraft] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<WorkspaceSummary | null>(null);
	const anchorRef = useRef<HTMLButtonElement | null>(null);
	const active = workspaces?.find((w) => w.active) ?? null;

	const close = useCallback(() => {
		setOpen(false);
		setMode("menu");
		setError(null);
	}, []);

	// The menu contract: outside pointerdown closes; Esc is claimed.
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (anchorRef.current?.contains(target)) return;
			close();
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				close();
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open, close]);

	/** After the active course changes: home re-renders against it. */
	const showActive = useCallback(() => {
		if (pathname !== "/") router.push("/");
		router.refresh();
	}, [pathname, router]);

	const switchTo = async (id: string) => {
		const failure = await mutate("/api/workspaces/active", "PUT", { id });
		if (failure) return setError(failure);
		close();
		showActive();
	};

	const submitDraft = async () => {
		const name = draft.trim();
		if (!name) return;
		const failure = mode === "create"
			? await mutate("/api/workspaces", "POST", { name, activate: true })
			: await mutate(`/api/workspaces/${encodeURIComponent(active!.id)}`, "PATCH", { name });
		if (failure) return setError(failure);
		const created = mode === "create";
		close();
		if (created) showActive();
		else router.refresh();
	};

	const setArchived = async (id: string, archived: boolean) => {
		const failure = await mutate(`/api/workspaces/${encodeURIComponent(id)}`, "PATCH", { archived });
		if (failure) return setError(failure);
		close();
		showActive();
	};

	const openList = (workspaces ?? []).filter((w) => !w.archived);
	const archivedList = (workspaces ?? []).filter((w) => w.archived);
	const item = "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-accent";

	return (
		<>
			<button
				ref={anchorRef}
				type="button"
				data-testid="course-switcher"
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => (open ? close() : setOpen(true))}
				className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
			>
				<span className="shrink-0 text-[11px] uppercase tracking-wider text-muted-foreground">Course</span>
				<span className="min-w-0 flex-1 truncate font-prose text-(length:--lh-prose-size)">{active?.name ?? "…"}</span>
				<ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
			</button>
			{open && (
				<MenuShell
					anchorRef={anchorRef}
					testid="course-menu"
					preferredSide="down"
					align="left"
					menuClass="flex w-64 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
				>
					{mode === "menu" ? (
						<>
							{openList.map((w) => (
								<button key={w.id} type="button" data-testid="course-option" onClick={() => void switchTo(w.id)} className={item}>
									<CheckIcon className={w.active ? "size-3.5 shrink-0" : "size-3.5 shrink-0 opacity-0"} />
									<span className="min-w-0 flex-1 truncate text-foreground">{w.name}</span>
									<span className="shrink-0 text-muted-foreground">{w.chatCount}</span>
								</button>
							))}
							<div className="my-0.5 border-t border-border/60" aria-hidden="true" />
							<button type="button" data-testid="course-new" onClick={() => { setMode("create"); setDraft(""); setError(null); }} className={item}>
								<PlusIcon className="size-3.5 shrink-0" />
								New course…
							</button>
							{active && (
								<>
									<button type="button" data-testid="course-rename" onClick={() => { setMode("rename"); setDraft(active.name); setError(null); }} className={item}>
										<PencilIcon className="size-3.5 shrink-0" />
										Rename “{active.name}”…
									</button>
									<button type="button" data-testid="course-archive" onClick={() => void setArchived(active.id, true)} className={item}>
										<ArchiveIcon className="size-3.5 shrink-0" />
										Archive “{active.name}”
									</button>
									{active.id !== "general" && (
										<button
											type="button"
											data-testid="course-delete"
											onClick={() => { setDeleting(active); close(); }}
											className={`${item} text-muted-foreground/80 hover:text-foreground`}
										>
											<Trash2Icon className="size-3.5 shrink-0" />
											Delete “{active.name}”…
										</button>
									)}
								</>
							)}
							{archivedList.length > 0 && (
								<>
									<div className="my-0.5 border-t border-border/60" aria-hidden="true" />
									<div className="px-2.5 py-1 text-[11px] uppercase tracking-wider text-muted-foreground/70">Archived</div>
									{archivedList.map((w) => (
										<button key={w.id} type="button" data-testid="course-unarchive" onClick={() => void setArchived(w.id, false)} className={item}>
											<ArchiveRestoreIcon className="size-3.5 shrink-0" />
											<span className="min-w-0 flex-1 truncate text-foreground">{w.name}</span>
											<span className="shrink-0 text-muted-foreground">Unarchive</span>
										</button>
									))}
								</>
							)}
						</>
					) : (
						<form
							onSubmit={(e) => {
								e.preventDefault();
								void submitDraft();
							}}
							className="flex flex-col gap-2 p-1"
						>
							<label className="text-[11px] uppercase tracking-wider text-muted-foreground" htmlFor="course-name-input">
								{mode === "create" ? "New course" : "Rename course"}
							</label>
							<input
								id="course-name-input"
								data-testid="course-name-input"
								autoFocus
								value={draft}
								maxLength={80}
								onChange={(e) => setDraft(e.target.value)}
								placeholder="e.g. Linear Algebra"
								className="lh-input rounded-md border border-border bg-background px-2 py-1.5 font-prose text-sm text-foreground outline-none"
							/>
							<div className="flex justify-end gap-2">
								<button type="button" onClick={() => setMode("menu")} className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">
									Back
								</button>
								<button type="submit" data-testid="course-name-save" disabled={!draft.trim()} className="rounded-sm border border-border px-3 py-1.5 text-xs text-foreground hover:bg-accent disabled:opacity-40">
									{mode === "create" ? "Create" : "Save"}
								</button>
							</div>
						</form>
					)}
					{error && (
						<div role="alert" data-testid="course-error" className="mt-1 rounded-sm border border-border/60 px-2.5 py-1.5 text-foreground">
							{error}
						</div>
					)}
				</MenuShell>
			)}
			<DeleteCourseDialog
				course={deleting}
				onClose={() => setDeleting(null)}
				onDelete={async (id) => {
					const failure = await mutate(`/api/workspaces/${encodeURIComponent(id)}`, "DELETE");
					if (!failure) {
						setDeleting(null);
						showActive();
					}
					return failure;
				}}
			/>
		</>
	);
}

/** Delete a course: typed-name confirmation; the course moves to
 *  backups/deleted-workspaces/ (recoverable by hand, invisible to the app). */
export function DeleteCourseDialog({
	course,
	onClose,
	onDelete,
}: {
	course: WorkspaceSummary | null;
	onClose: () => void;
	onDelete: (id: string) => Promise<string | null>;
}) {
	const [typed, setTyped] = useState("");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const backdropDismiss = useBackdropDismiss(() => {
		if (!busy) onClose();
	});
	useEffect(() => {
		if (!course) {
			setTyped("");
			setBusy(false);
			setFailure(null);
		}
	}, [course]);
	if (!course) return null;
	const run = async () => {
		if (busy || typed.trim() !== course.name) return;
		setBusy(true);
		setFailure(null);
		const error = await onDelete(course.id);
		setBusy(false);
		if (error) setFailure(error);
	};
	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdropDismiss}>
			<DeleteCourseBody course={course} typed={typed} busy={busy} failure={failure} onTyped={setTyped} onClose={onClose} onRun={() => void run()} />
		</div>,
		document.body,
	);
}

/** The dialog's pure body — exported for render tests. */
export function DeleteCourseBody({
	course,
	typed,
	busy,
	failure,
	onTyped,
	onClose,
	onRun,
}: {
	course: Pick<WorkspaceSummary, "name" | "chatCount">;
	typed: string;
	busy: boolean;
	failure: string | null;
	onTyped: (v: string) => void;
	onClose: () => void;
	onRun: () => void;
}) {
	const matches = typed.trim() === course.name;
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Delete course"
			data-testid="delete-course-dialog"
			onClick={(e) => e.stopPropagation()}
			className="w-[32rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl"
		>
			<h2 className="text-sm font-semibold text-destructive">Delete course?</h2>
			<div className="mt-1.5">
				<code className="font-mono text-sm text-foreground">{course.name}</code>
			</div>
			<p className="mt-2 text-sm text-muted-foreground">
				The course and its {course.chatCount} session{course.chatCount === 1 ? "" : "s"}, knowledge graph and imports leave the app. The files
				are moved to <code className="font-mono text-xs">backups/deleted-workspaces/</code> in your data folder, not erased. What the app
				learned about how you learn stays.
			</p>
			<label className="mt-4 block text-xs text-muted-foreground" htmlFor="delete-course-confirm">
				Type the course name to confirm
			</label>
			<input
				id="delete-course-confirm"
				data-testid="delete-course-input"
				value={typed}
				onChange={(e) => onTyped(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") onRun();
					if (e.key === "Escape") {
						e.stopPropagation();
						onClose();
					}
				}}
				disabled={busy}
				className="lh-input mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 font-prose text-sm text-foreground outline-none"
			/>
			{failure && (
				<div role="alert" data-testid="delete-course-failure" className="mt-3 rounded-sm border border-border/60 px-3 py-2 text-xs text-foreground">
					{failure}
				</div>
			)}
			<div className="mt-4 flex justify-end gap-2">
				<button type="button" onClick={onClose} disabled={busy} className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40">
					Cancel
				</button>
				<button
					type="button"
					data-testid="delete-course-confirm"
					onClick={onRun}
					disabled={busy || !matches}
					className="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-40"
				>
					{busy ? "Deleting…" : "Delete course"}
				</button>
			</div>
		</div>
	);
}
