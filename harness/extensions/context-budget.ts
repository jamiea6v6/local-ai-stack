/**
 * context-budget — keep the prompt inside the context window on a small box.
 *
 * Why this exists: Pi loads AGENTS.md from every directory between the working
 * directory and the filesystem root.
 * `~/AGENTS.md` is a symlink to the homelab doc store's AGENTS.md, which costs
 * **2340 tokens** on every single turn.
 *
 * The window this box actually has is 32768 tokens — the shim requests it per
 * request (see MANIFEST §2). The measurements below were taken while the window
 * was still 8192, which is why they show the trimming this extension exists for.
 *
 * Measured baseline prompt (8192-token era):
 *     no AGENTS.md in ancestry            2378 tokens
 *     + doc-store AGENTS.md               4718 tokens   (+2340)
 *     + Pi harness AGENTS.md              ~5647 tokens   (+929)
 *
 * 8192 minus 4718 leaves ~3400 tokens for the entire conversation. That is not
 * enough to search, read a file, edit it, run the grader, and read the report.
 * Measured consequence: runs died with `stopReason=length` and **zero output**,
 * which is worse than a wrong answer because the user gets nothing at all.
 *
 * Same model, same harness, same prompt, only the working directory differed:
 *     cwd=/tmp/lt4   baseline 3136   -> 11/11 checks passed
 *     cwd=~/looptest3 baseline 5473   -> 10/11, run truncated before the edit
 *
 * What this does: when the estimated prompt leaves too little headroom, large
 * context files are REPLACED by a pointer — "full text at <path>, read it if you
 * need it" — rather than dropped. The model keeps the knowledge that the file
 * exists and can pull it on demand with the read tool. Nothing is lost; it is
 * moved from always-loaded to loaded-when-needed.
 *
 * The Pi harness's own AGENTS.md is never trimmed: it holds the rules that make
 * the harness work, and it is small.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * The window the shim gives Pi. One source of truth: set PI_CONTEXT_LIMIT to
 * override, otherwise it matches OLLAMA_SHIM_CTX (32768) and models.json's
 * contextWindow. Do not re-hardcode 8192 — the shim overrides the server env.
 */
const CONTEXT_LIMIT = Number(process.env.PI_CONTEXT_LIMIT || 32768);

/**
 * How many tokens must remain free for the conversation to have any chance.
 *
 * A run needs room for a tool result, a file read, an edit, the grader's
 * report, and the model's own answer. Below this the turn cannot finish.
 */
const REQUIRED_HEADROOM = 3400;

/** Context files larger than this are candidates for trimming. */
const TRIM_THRESHOLD_CHARS = 1500;

/** Never trim the Pi harness's own rules file. */
const HARNESS_AGENTS = "/.pi/agent/AGENTS.md";

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function promptSize(event: any): { tokens: number; files: any[] } {
	const files = event?.systemPromptOptions?.contextFiles ?? [];
	let chars = 0;
	for (const f of files) chars += (f.content ?? "").length;
	// The tool definitions and the preamble are not exposed to us, so they are
	// estimated from the measured baseline: ~2378 tokens with no context files
	// at all, of which the preamble and tools are the bulk.
	const BASE_TOKENS = 2378;
	return { tokens: BASE_TOKENS + estimateTokens(chars), files };
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event: any) => {
		const options = event?.systemPromptOptions;
		if (!options || !Array.isArray(options.contextFiles)) return;

		const { tokens, files } = promptSize(event);
		const headroom = CONTEXT_LIMIT - tokens;
		if (headroom >= REQUIRED_HEADROOM) return;

		// Trim the largest non-harness context file first.
		const candidates = files
			.map((f: any, i: number) => ({ f, i }))
			.filter(({ f }: any) => !f.path?.endsWith(HARNESS_AGENTS))
			.filter(({ f }: any) => (f.content ?? "").length > TRIM_THRESHOLD_CHARS)
			.sort((a: any, b: any) => (b.f.content?.length ?? 0) - (a.f.content?.length ?? 0));

		// Trim the largest files first, and only as much as the shortfall needs.
		// Headroom is recomputed after every replacement: one file is often
		// enough, and slicing a file to a fixed 12% regardless of the shortfall
		// throws away context the turn could still afford.
		for (const { f, i } of candidates) {
			const current = promptSize(event);
			const shortfall = REQUIRED_HEADROOM - (CONTEXT_LIMIT - current.tokens);
			if (shortfall <= 0) break;

			const original = f.content ?? "";
			// One token is ~4 chars. Leave ~400 chars of slack for the pointer text.
			const keepChars = Math.max(600, original.length - shortfall * 4 - 400);
			if (keepChars >= original.length) continue;

			// Keep a short head so the model still knows what the file is.
			const trimmed =
				original.slice(0, keepChars).trimEnd() +
				`\n\n[TRIMMED TO FIT THE ${CONTEXT_LIMIT}-TOKEN CONTEXT WINDOW — ` +
				`the rest of this file is at ${f.path}. Read that path with the read tool ` +
				`if you need the details.]`;

			options.contextFiles[i] = { ...f, content: trimmed };
		}
	});
}
