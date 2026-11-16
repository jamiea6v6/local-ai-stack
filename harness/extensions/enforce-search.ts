/**
 * enforce-search — require a lookup before answering a factual question.
 *
 * Why this exists: two runs of the same Test B prompt produced opposite failures.
 *   - job2:  searched twice, fetched once, cited a real package
 *   - runB:  made ZERO tool calls, invented an embedding model name
 *           ("all-Mini-Llama-L6", "ollama pull all-Mini-Llama"), then hedged with
 *           "assuming the necessary documentation confirms the following"
 *
 * enforce-fetch.ts did not catch runB, because it only fires after a websearch happens.
 * No search meant no obligation. That policed the step *after* the decision to verify
 * rather than the decision itself, so a model that simply skipped verification was
 * unconstrained.
 *
 * This hook moves the gate earlier: `before_agent_start` sees the raw user prompt, and if
 * it looks like a factual question about the world, the first turn is required to include a
 * search. Cheap heuristics, deliberately conservative — a false positive costs one search,
 * a false negative costs a fabricated fact.
 *
 * Known limitation, stated plainly: this is pattern matching on the prompt, not
 * understanding. It will miss factual requests phrased as tasks ("summarise this spec") and
 * may fire on code tasks that mention a noun. It is a floor, not a ceiling. The stronger
 * guarantee — the model itself deciding it needs to look something up — is not something
 * a harness can force without parsing intent.
 *
 * ── BUG FIXED 2026-11-13 ────────────────────────────────────────────────────────
 * The gate used to bail out on `!event.context.canContinue`. That is exactly backwards.
 *
 * The context preview handed to this handler is built from the entries committed so far,
 * and it is rebuilt only AFTER each handler runs. At the moment this gate runs, the model
 * has just produced a final assistant message with no tool calls queued — so the preview
 * says lastRole === "assistant", canContinue === false. That is precisely the case the
 * gate exists to catch, and the guard suppressed it. Measured on brain1 with a probe
 * extension: the CW-filter prompt logged `canContinue=false lastRole=assistant`, and the
 * gate never fired — the model answered from memory with zero tool calls and shipped
 * package names that do not exist on Debian 13.
 *
 * Pushing a custom_message entry is what ENABLES the continuation: the entry is committed
 * as a user-role message, so the next context preview has finalRole === "user" and
 * contextCanContinue becomes true. The check therefore has to be "is there a conversation
 * to continue", not "can we continue right now".
 *
 * A nudge cap was also added. Without it, a model that refuses to search would be nudged
 * forever, because `searches` only counts actual lookups and so never reached
 * MAX_SEARCHES. This mirrors enforce-fetch.ts's MAX_NUDGES.
 */

import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Questions that usually require an external fact. */
const QUESTION_PATTERNS = [
	/\bwhat (is|are|was|were)\b/i,
	/\bhow (do|does|did|can|to|much|many)\b/i,
	/\bwhy (is|are|does|do|did|would)\b/i,
	/\bwho (is|was|are|were)\b/i,
	/\bwhen (is|was|does|did)\b/i,
	/\bwhere (is|are|does|did)\b/i,
	/\bwhich\b/i,
	/\bcan (i|you|it|we)\b/i,
	/\bis there\b/i,
	/\bdoes (it|the)\b.*\bwork\b/i,
	/\bused (for|to|as|by)\b/i,
	/\bsupported\b/i,
	/\bavailable\b/i,
	/\bcompare\b/i,
	/\bdifference between\b/i,
];

/** Phrases that mean "go look it up", which we can treat as already satisfied. */
const LOOKING_UP = [
	/\b(search|look ?up|find|check|verify|confirm|research)\b/i,
	/\b(doc|docs|documentation|readme|manual|spec|specs)\b/i,
	/\bhttps?:\/\//i,
];

/** Prompts that are plainly about local files, not the world. */
const LOCAL_ONLY =
	/\b(read|edit|write|fix|refactor|rename|delete|move)\b.*\b(this|these|the following|file|code|repo)\b/i;

const MAX_SEARCHES = 4;

/**
 * How many times to nudge before giving up. Without a cap, a model that refuses to look
 * anything up is nudged forever: `searches` only counts real lookups, so it never
 * reaches MAX_SEARCHES. Same reasoning as enforce-fetch.ts's MAX_NUDGES.
 */
const MAX_NUDGES = 2;

/**
 * Do not push a lookup the model has no context room to act on.
 *
 * Measured on brain1 (8192-token window, 4718-token baseline): a websearch plus a
 * webfetch plus a full program-sized answer does not fit. A turn that overflows ends
 * with stopReason=length and produces NO output, which is strictly worse than the
 * unverified answer this gate exists to prevent — the user gets nothing instead of
 * something to check.
 *
 * So the gate stands down when the conversation has already grown past the point where
 * a lookup could be answered, and says so instead of forcing the call. Verified
 * facts the model already has still get stated; only the lookup is skipped.
 */
const CONTEXT_LIMIT = 8192;
const CONTEXT_ROOM_FOR_LOOKUP = 6500;

/**
 * Where gate messages are logged so they can be copied. The TUI renders gate messages in
 * the input area where they overwrite each other and cannot be selected (FAILURE_LEDGER
 * U-01). The model still receives the message either way — `display` only controls
 * rendering, not whether the entry becomes part of the LLM context.
 */
const LOG_PATH = "~/.pi/agent/gate-log.md";

interface SearchGate {
	searches: number;
	satisfied: boolean;
	currentPrompt: string;
	nudgesGiven: number;
}

function logGate(kind: string, text: string): void {
	try {
		appendFileSync(LOG_PATH, `\n## ${kind}\n\n${text}\n`);
	} catch {
		// A missing log directory must never break the gate.
	}
}

/**
 * Whether pushing a custom message would actually enable a continuation.
 *
 * `event.context.canContinue` describes the state BEFORE this handler's entries are
 * committed, and it is false in precisely the case this gate exists to catch. After the
 * entry is committed the context gains a user-role message and canContinue becomes true.
 * So the question to ask is whether there is a conversation to continue at all.
 */
function canContinueAfterPush(context: any): boolean {
	const llmMessages = context?.llmMessages;
	if (!Array.isArray(llmMessages)) return false;
	return llmMessages.some((m: any) => m && m.role !== "system");
}

/**
 * Rough token count of the conversation so far.
 *
 * Used to avoid pushing a search the model has no room to act on. Measured on brain1:
 * a search plus a fetch plus a program-sized answer does not fit the box's 8192-token
 * window, and a turn that overflows ends with stopReason=length and NO output — worse
 * than the unverified answer the gate was trying to prevent.
 *
 * The estimate is characters/4, which is rough, but it only has to be good enough to
 * tell "there is room" from "there is not".
 */
function estimateTokens(context: any): number {
	const llmMessages = context?.llmMessages;
	if (!Array.isArray(llmMessages)) return 0;
	let chars = 0;
	for (const m of llmMessages) {
		const c = m?.content;
		if (typeof c === "string") chars += c.length;
		else if (Array.isArray(c)) {
			for (const part of c) {
				if (typeof part?.text === "string") chars += part.text.length;
			}
		}
	}
	return Math.ceil(chars / 4);
}

export default function (pi: ExtensionAPI) {
	let gate: SearchGate = { searches: 0, satisfied: false, currentPrompt: "", nudgesGiven: 0 };

	// Session changes reset the gate; without this a resumed session inherits stale counts.
	pi.on("session_start", () => {
		gate = { searches: 0, satisfied: false, currentPrompt: "", nudgesGiven: 0 };
	});

	/** Record the prompt so the gates can judge whether the duty was met. */
	pi.on("before_agent_start", (event) => {
		gate.currentPrompt = event.prompt ?? "";
		gate.searches = 0;
		gate.nudgesGiven = 0;
		gate.satisfied = LOOKING_UP.some((re) => re.test(gate.currentPrompt));
	});

	/**
	 * FIRST-TURN GATE — this is the one that matters.
	 *
	 * The original design fired only at `agent_before_settle`, which is AFTER the model
	 * has already written its answer. Measured on brain1: the model wrote a 2599-token
	 * answer first, then was told to go and verify it. By then the context window was
	 * full and the turn died with stopReason=length and no output at all.
	 *
	 * Injecting the requirement BEFORE the first model request fixes the ordering:
	 * the model looks things up while it still has room, and the answer it finally
	 * gives is the verified one. The prompt below costs ~120 tokens and saves a
	 * 2599-token throwaway answer.
	 *
	 * This fires only on the first turn of a prompt that looks like a factual
	 * question, so ordinary work is untouched.
	 */
	pi.on("before_agent_start", (event) => {
		const prompt = event.prompt ?? "";
		if (LOOKING_UP.some((re) => re.test(prompt))) return;
		if (!QUESTION_PATTERNS.some((re) => re.test(prompt))) return;
		if (LOCAL_ONLY.test(prompt) && !QUESTION_PATTERNS.some((re) => /what|why|how much|how many/i.test(prompt))) {
			return;
		}

		const message =
			"Before you answer: look up the FACTS you need. Use websearch, then webfetch the most " +
			"relevant result, then continue.\n\n" +
			"Any specific you would otherwise state from memory — a package name, a command, a version, " +
			"an API signature, a config key, a file path — must come from a source. Guessed specifics " +
			"are the failure mode here, not general knowledge.\n\n" +
			"Search FIRST, then answer once. Do not draft an answer first and verify afterwards: on this " +
			"box the context window is small enough that a draft leaves no room for the evidence.\n\n" +
			"Two things this does NOT mean:\n" +
			"  - You do not need a source for CODE YOU WRITE. Look up the external facts it depends " +
			"on, then write the code yourself.\n" +
			"  - You do not need to find a finished program to copy. Look up the API and install " +
			"commands you need, then write your own.\n\n" +
			"If the request is to write or change a program, WRITE IT to a file with the write tool " +
			"rather than only describing it in the reply — a file can be checked, a chat reply cannot.\n\n" +
			"If a search fails or returns nothing usable, say plainly that you could not verify it " +
			"rather than answering from memory. If the fact is genuinely something you know without " +
			"looking, say so in one sentence and stop.";

		logGate("lookup-required", message);

		// The handler must RETURN the message; the runner collects result.message and
		// appends it to the turn as a custom entry (which becomes a user-role message
		// in the LLM context). Pushing onto event.messages does nothing — the event
		// object has no such field.
		return {
			message: {
				customType: "lookup-required",
				content: message,
				display: false,
			},
		};
	});

	pi.on("tool_execution_end", (event) => {
		if (event.parentToolCallId) return;
		if (event.toolName === "websearch" || event.toolName === "webfetch") {
			gate.searches += 1;
			gate.satisfied = true;
			gate.nudgesGiven = 0;
		}
	});

	/**
	 * A fresh continuation can only be requested once Pi is about to settle. If the prompt
	 * looked like a factual question, no lookup happened, and the model is about to answer —
	 * make it search first.
	 */
	pi.on("agent_before_settle", (event) => {
		if (gate.satisfied) return;
		if (gate.searches >= MAX_SEARCHES) return;
		if (gate.nudgesGiven >= MAX_NUDGES) return;

		const needsLookup = QUESTION_PATTERNS.some((re) => re.test(gate.currentPrompt));
		if (!needsLookup) return;
		if (LOCAL_ONLY.test(gate.currentPrompt) && !QUESTION_PATTERNS.some((re) => /what|why|how much|how many/i.test(gate.currentPrompt))) {
			return;
		}
		// The push itself supplies the user-role message that makes the continuation legal.
		if (!canContinueAfterPush(event.context)) return;

		// No room to act on a lookup? Then requiring one produces an empty answer.
		// Say what is known and let the user decide, instead of forcing a call that
		// cannot fit.
		const used = estimateTokens(event.context);
		if (used > CONTEXT_ROOM_FOR_LOOKUP) {
			logGate(
				"search-skipped-no-room",
				`Skipped the required lookup: the conversation is already ~${used} tokens, and a search ` +
					`plus a fetch plus an answer does not fit the ${CONTEXT_LIMIT}-token window this box is ` +
					`pinned to. A turn that overflows returns no output at all, which is worse than an ` +
					`answer the user can check. Answer from what you already know, and say plainly which ` +
					`specifics you could not verify.`,
			);
			event.entries.push({
				type: "custom_message",
				customType: "search-skipped-no-room",
				content:
					"You did not look anything up, and there is not enough context left on this box to do it " +
					"and still produce an answer. Answer now from what you already know, and state plainly " +
					"which specifics you could not verify.",
				display: false,
			});
			return;
		}

		gate.nudgesGiven += 1;

		const message =
			"You have not looked anything up before answering a factual question.\n\n" +
			"Any specific you are about to state — a product, package, command, model name, version, " +
			"number, or API — must come from a source, not from memory. Guessed specifics are the " +
			"failure mode here, not general knowledge.\n\n" +
			"Call websearch now, then webfetch the most relevant result, then answer from what it says " +
			"and name the source. If a search fails or returns nothing usable, say explicitly that " +
			"you could not verify it rather than answering from memory. If your knowledge is genuinely " +
			"sufficient and no lookup is needed, say so in one sentence and stop.\n\n" +
			"Do NOT reply that you understand, that you will comply, or that you will verify from now " +
			"on. A promise to look something up is not a lookup. Either call the tools in this turn, " +
			"or answer the question with nothing but the specific fact you already know.\n\n" +
			"IMPORTANT: this is a continuation of the request below, not a new request. Your previous " +
			"answer is not accepted — it did not verify anything. Answer THAT request, this time " +
			"searching first:\n\n" +
			"--- ORIGINAL REQUEST ---\n" +
			gate.currentPrompt +
			"\n--- END ORIGINAL REQUEST ---";

		logGate("search-required", message);

		event.entries.push({
			type: "custom_message",
			customType: "search-required",
			content: message,
			display: false,
		});

		return { continue: true };
	});
}
