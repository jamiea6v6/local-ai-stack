/**
 * enforce-fetch — require a webfetch after every websearch.
 *
 * Why this exists: measured across five runs, the model answered from search snippets and
 * never called webfetch once. It did that in the lab-cradle question, in the browsing
 * question, and in Test A. The cost is real, not stylistic — in Test A it estimated a 20B
 * model at "~10GB" when gpt-oss:20b is 14GB, because the accurate number was one fetch away
 * and it never went.
 *
 * Snippets are search-engine summaries written by someone else. They are adequate for
 * orientation and unreliable for specifics: sizes, versions, prices, part numbers. A model
 * that treats them as evidence inherits their errors without ever seeing them.
 *
 * The rule: after a websearch, the model must call webfetch on at least one result URL before
 * it settles on a final answer. Enforced in the harness rather than requested in the prompt,
 * because prompt-level guidelines were already present in the websearch tool description and
 * were not followed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface FetchGate {
	searchesSinceFetch: number;
	fetchesSinceSearch: number;
	nudgesGiven: number;
}

const MAX_NUDGES = 2;

export default function (pi: ExtensionAPI) {
	let gate: FetchGate = { searchesSinceFetch: 0, fetchesSinceSearch: 0, nudgesGiven: 0 };

	// Session changes reset the gate; without this a resumed session inherits stale counts.
	pi.on("session_start", () => {
		gate = { searchesSinceFetch: 0, fetchesSinceSearch: 0, nudgesGiven: 0 };
	});

	pi.on("tool_execution_start", (event) => {
		if (event.parentToolCallId) return; // nested calls are part of an orchestrating tool
		if (event.toolName === "websearch") {
			gate.searchesSinceFetch += 1;
		} else if (event.toolName === "webfetch") {
			gate.fetchesSinceSearch += 1;
		}
	});

	/**
	 * agent_before_settle is the last point where Pi can request one more model request.
	 * If a search is outstanding and the model is about to finish, push it back into the loop
	 * with an explicit instruction rather than letting it answer from snippets.
	 */
	pi.on("agent_before_settle", async (event) => {
		if (gate.searchesSinceFetch === 0) return;
		if (gate.fetchesSinceSearch > 0) return;
		if (gate.nudgesGiven >= MAX_NUDGES) return;

		gate.nudgesGiven += 1;

		event.entries.push({
			type: "custom_message",
			customType: "fetch-required",
			content:
				"Before you answer: you searched but have not fetched anything. The search result you " +
				"received contains only short search-engine snippets, not page content. Snippets " +
				"summarise pages and frequently get specifics wrong (sizes, versions, numbers).\n\n" +
				"Use webfetch now on the most relevant URL from your search results, then answer from " +
				"what that page actually says, and cite that URL. If webfetch fails, say explicitly " +
				"that you could not verify it rather than answering from the snippet.",
			display: true,
		});

		return { continue: true };
	});

	// Clear the obligation once the model actually fetches something.
	pi.on("tool_execution_end", (event) => {
		if (event.parentToolCallId) return;
		if (event.toolName === "webfetch" && !event.isError) {
			gate.searchesSinceFetch = 0;
			gate.fetchesSinceSearch = 0;
			gate.nudgesGiven = 0;
		}
	});
}