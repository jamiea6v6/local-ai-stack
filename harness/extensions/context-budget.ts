/**
 * context-budget — keep the prompt inside the context window on a small box.
 *
 * Why this exists: brain1's Ollama window is 8192 tokens and Pi loads AGENTS.md
 * from every directory between the working directory and the filesystem root.
 * `~/AGENTS.md` is a symlink to the homelab doc store's AGENTS.md, which costs
 * **2340 tokens** on every single turn.
 *
 * Measured baseline prompt on brain1:
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

/** The window this box is pinned to. Matches brain1's OLLAMA_CONTEXT_LENGTH. */
const CONTEXT_LIMIT = 8192;

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

		// Trim the largest non-harness context file first, and only as much as
		// the shortfall requires. One file at a time keeps the change minimal.
		const candidates = files
			.map((f: any, i: number) => ({ f, i }))
			.filter(({ f }: any) => !f.path?.endsWith(HARNESS_AGENTS))
			.filter(({ f }: any) => (f.content ?? "").length > TRIM_THRESHOLD_CHARS)
			.sort((a: any, b: any) => (b.f.content?.length ?? 0) - (a.f.content?.length ?? 0));

		for (const { f, i } of candidates) {
			const original = f.content ?? "";
			const originalTokens = estimateTokens(original);
			const need = REQUIRED_HEADROOM - headroom;
			if (originalTokens <= need) continue;

			// Keep a short head so the model still knows what the file is.
			const keepChars = Math.max(600, Math.floor(original.length * 0.12));
			const trimmed =
				original.slice(0, keepChars).trimEnd() +
				`\n\n[TRIMMED TO FIT THE ${CONTEXT_LIMIT}-TOKEN CONTEXT WINDOW — ` +
				`the rest of this file is at ${f.path}. Read that path with the read tool ` +
				`if you need the details.]`;

			options.contextFiles[i] = { ...f, content: trimmed };
			// Trim the next file too if the shortfall is still not covered.
			// before_agent_start fires once per turn, so one trim per turn is
			// not enough when several files are large.
			continue;
		}
	});
}
