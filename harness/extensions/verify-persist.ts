/**
 * verify-persist — require a second look after a failing verify.
 *
 * Why this exists: in a 3-run pass-rate measurement, run 1 scored 19/21 and stopped after
 * ONE verify call. The two failures were real and visible in the output it had already seen:
 *
 *   FAIL  V = I*R: expected 10.0, got <raised TypeError: ... 'NoneType' and 'float'>
 *   FAIL  I = V/R: expected 2.4, got <raised TypeError: ... 'NoneType' and 'float'>
 *
 * Runs 2 and 3 called verify a second time, read the FAIL lines, fixed the named cases, and
 * scored 21/21. So the difference between 19/21 and 21/21 was not capability — it was whether
 * the model looked at its own result a second time.
 *
 * This is the cheapest possible version of "look again": after a verify that reported FAIL,
 * settlement is blocked once and the model is handed its own failing cases. Nothing is
 * re-derived; the point is only to make the second look obligatory rather than optional.
 *
 * Deliberately not applied to passing verifies, and capped at MAX_LOOKS so a genuinely
 * stubborn failure cannot loop. When the cap is exhausted the failures are surfaced to the
 * user rather than hidden.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_LOOKS = 3;

export default function (pi: ExtensionAPI) {
	let failedSpec: string | null = null;
	let failedCandidate: string | undefined;
	let lastReport = "";
	let looks = 0;
	let surfaced = false;

	pi.on("session_start", () => {
		failedSpec = null;
		failedCandidate = undefined;
		lastReport = "";
		looks = 0;
		surfaced = false;
	});

	pi.on("tool_execution_start", (event) => {
		if (event.parentToolCallId) return;
		if (event.toolName !== "verify") return;
		// A new verify supersedes any outstanding obligation.
		failedSpec = null;
		failedCandidate = undefined;
		looks = 0;
		surfaced = false;
	});

	pi.on("tool_execution_end", (event) => {
		if (event.parentToolCallId) return;
		if (event.toolName !== "verify") return;

		const result = event.result as { content?: { type: string; text?: string }[] } | undefined;
		const text = result?.content?.find((c) => c.type === "text")?.text ?? "";

		// An errored verify is not a pass. verify throws on a timeout or a missing
		// spec, and the old code returned here — so a hung or mistyped verify
		// created no obligation and the model could settle as if it had succeeded.
		if (event.isError) {
			failedSpec = "the same spec";
			failedCandidate = undefined;
			lastReport = `VERIFY ERRORED — this is not a pass.\n${text.trim().slice(0, 800)}`;
			return;
		}

		const failed = /VERIFY:\s*FAIL/i.test(text) || /\nFAIL\s/.test(text);

		if (failed) {
			// Failing lines only — the model already has the file, it needs the deltas.
			const lines = text
				.split("\n")
				.filter((l) => l.trim().startsWith("FAIL"))
				.slice(0, 12);
			lastReport = lines.join("\n") || text.slice(0, 800);
			const m = text.match(/FILE:\s*(\S+)/);
			failedCandidate = m?.[1];
			const s = text.match(/SPEC:\s*(\S+)/);
			failedSpec = s?.[1] ?? "the same spec";
		} else {
			failedSpec = null;
			lastReport = "";
			looks = 0;
		}
	});

	pi.on("agent_before_settle", (event) => {
		if (!failedSpec) return;
		if (!event.context.canContinue) return;

		if (looks >= MAX_LOOKS) {
			// Out of retries. Make the remaining failures visible rather than silent.
			if (!surfaced) {
				surfaced = true;
				event.entries.push({
					type: "custom_message",
					customType: "verify-gave-up",
					content:
						`Stopping after ${MAX_LOOKS} attempts. These cases are still failing — treat them as ` +
						`unresolved, not as passing:\n\n${lastReport}\n\n` +
						"Either fix them yourself, or hand this to a larger model. Do not report success.",
					display: true,
				});
			}
			return;
		}

		looks += 1;

		event.entries.push({
			type: "custom_message",
			customType: "verify-failed",
			content:
				"verify reported FAIL and you have not run it again.\n\n" +
				"Still failing:\n" +
				lastReport +
				"\n\nFix exactly those cases in " +
				(failedCandidate ?? "the file") +
				", then call verify again on " +
				failedSpec +
				". Do not rewrite the whole file, and do not treat the step as done while cases fail.",
			display: true,
		});

		return { continue: true };
	});
}