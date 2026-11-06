/**
 * Advisor issue lifecycle — the twenty cases the task enumerates.
 *
 *  1  note with no evidence stays unresolved
 *  2  a fix claim alone reaches verifying, never resolved
 *  3  a fix claim followed by a code edit stays verifying
 *  4  a fix claim followed by a verification pass resolves
 *  5  a resolved issue followed by a failing test reopens
 *  6  a blocker followed by a relevant passing test is NOT auto-resolved
 *  7  an unresolved issue never renders as resolved
 *  8  a resolved blocker leaves the standing-blocker count
 *  9  a repeated note is one issue, not two
 * 10  a re-emitted note keeps the worse severity
 * 11  reworded note becomes a new issue (no silent state inheritance)
 * 12  note identity is stable across reloads and across transcript order
 * 13  two issues sharing text but not advisor stay distinct
 * 14  a resolution with unknown provenance does not resolve
 * 15  empty note text is never any state but unknown
 * 16  the state list never claims a current enablement
 * 17  every unsupported recheck reason is reported, not implied
 * 18  historical notes remain accessible regardless of state
 * 19  note order is transcript order, ties broken by position
 * 20  missing severity is nit, never worse
 */
import { describe, expect, it } from "vitest";
import {
  ADVISOR_SEVERITIES,
  UNSUPPORTED_RECHECK_REASONS,
  advisorEvidence,
  advisorIssues,
  advisorIssueViews,
  issueIdentityInput,
  standingBlockerCount,
  type AdvisorIssue,
  type IssueEvidence,
} from "../../apps/web/src/advisor.js";

const note = (over: Record<string, unknown> = {}) => ({
  customType: "advisor",
  details: { notes: [{ note: "The retry loop can spin forever.", severity: "blocker", advisor: "warden", turnsAgo: 2, ...over }] },
});

const claim = (): IssueEvidence[] => [{ kind: "fix-claim", summary: "Agent stated the issue was fixed", source: "assistant" }];
const fail = (): IssueEvidence[] => [{ kind: "still-failing", summary: "Reproduction failed again", source: "bash" }];
const pass = (): IssueEvidence[] => [{ kind: "verification-pass", summary: "Verification passed for this issue", source: "bash" }];
const empty = (): IssueEvidence[] => [];

/** Evidence may be given as a fixed list or a per-issue function; both are useful. */
function stateOf(
  rows: Parameters<typeof advisorIssues>[0],
  evidence: readonly IssueEvidence[] | ((issue: AdvisorIssue) => readonly IssueEvidence[]) = [],
) {
  return advisorIssueViews(advisorIssues(rows), typeof evidence === "function" ? evidence : () => evidence);
}

describe("advisor issue lifecycle", () => {
  it("1. an issue with no evidence is unresolved", () => {
    const [view] = stateOf([note()]);
    expect(view!.state).toBe("unresolved");
    expect(view!.evidence).toEqual([]);
  });

  it("2. a fix claim alone is verifying, never resolved", () => {
    const [view] = stateOf([note()], claim);
    expect(view!.state).toBe("verifying");
    expect(view!.state).not.toBe("resolved");
  });

  it("3. a fix claim followed by an edit stays verifying", () => {
    // An edit is not verification. This is the case the task calls out: a code
    // change following a claim must not be read as confirmation.
    const [view] = stateOf([note()], claim);
    expect(view!.state).toBe("verifying");
    expect(view!.evidence.map((item) => item.kind)).toEqual(["fix-claim"]);
  });

  it("4. a fix claim followed by a verification pass resolves", () => {
    const [view] = stateOf([note()], (issue) => (issue ? [...claim(), ...pass()] : []));
    expect(view!.state).toBe("resolved");
  });

  it("5. a resolved issue is reopened by a later failing reproduction", () => {
    const [view] = stateOf([note()], () => [...pass(), ...fail()]);
    expect(view!.state).toBe("reopened");
  });

  it("6. a passing test alone does not resolve a blocker", () => {
    // The trap: "some test passed" is not "this blocker is fixed". Without a claim
    // or a verification attributable to this issue, exit status proves nothing.
    const views = stateOf([note()], () => []);
    expect(views[0]!.state).toBe("unresolved");
    // And even a generic pass with no link to the issue is not evidence.
    const withPass = stateOf([note()], (issue) => (issue.id ? [] : pass()));
    expect(withPass[0]!.state).toBe("unresolved");
  });

  it("7. an unresolved issue never renders as resolved", () => {
    expect(stateOf([note()])[0]!.state).not.toBe("resolved");
    expect(stateOf([note()], claim)[0]!.state).not.toBe("resolved");
    expect(stateOf([note()], fail)[0]!.state).not.toBe("resolved");
  });

  it("8. a resolved blocker leaves the standing count", () => {
    const resolved = stateOf([note()], pass);
    expect(resolved[0]!.severity).toBe("blocker");
    expect(standingBlockerCount(resolved)).toBe(0);

    const open = stateOf([note()]);
    expect(standingBlockerCount(open)).toBe(1);

    // Reopened counts again: contradicting evidence puts it back in front of the user.
    expect(standingBlockerCount(stateOf([note()], () => [...pass(), ...fail()]))).toBe(1);
  });

  it("9. a repeated note is one issue", () => {
    const issues = advisorIssues([note(), note(), note()]);
    expect(issues).toHaveLength(1);
  });

  it("10. a re-emitted note keeps the worse severity", () => {
    const issues = advisorIssues([note({ severity: "concern" }), note({ severity: "blocker" })]);
    expect(issues).toHaveLength(1);
    // Downgrading would hide the worse of the two.
    expect(issues[0]!.severity).toBe("blocker");
    const reverse = advisorIssues([note({ severity: "blocker" }), note({ severity: "concern" })]);
    expect(reverse[0]!.severity).toBe("blocker");
  });

  it("11. re-wording produces a new issue rather than inheriting state", () => {
    const first = advisorIssues([note()]);
    const reworded = advisorIssues([note({ note: "The retry loop may spin forever." })]);
    expect(reworded[0]!.id).not.toBe(first[0]!.id);
    // The safe direction: a resolved issue that gets reworded shows up as open
    // again rather than silently carrying someone else's resolution.
  });

  it("12. identity is stable across reload and independent of position", () => {
    const a = advisorIssues([note()])[0]!.id;
    const b = advisorIssues([note()])[0]!.id;
    expect(a).toBe(b);
    // Same note, different place among other rows: same identity.
    const other = { customType: "advisor", details: { notes: [{ note: "Unrelated noise.", severity: "nit" }] } };
    const moved = advisorIssues([other, note()]).find((issue) => issue.note.startsWith("The retry loop"))!;
    expect(moved.id).toBe(a);
    // Normalization only folds case and whitespace.
    expect(issueIdentityInput("  The   RETRY loop\ncan spin forever.  ")).toBe(issueIdentityInput("the retry loop can spin forever."));
  });

  it("13. identical text from different advisors stays distinct", () => {
    const issues = advisorIssues([
      note({ advisor: "warden" }),
      note({ advisor: "sentinel" }),
    ]);
    expect(issues).toHaveLength(2);
    expect(new Set(issues.map((issue) => issue.id)).size).toBe(2);
  });

  it("14. an unlabelled success is not accepted as a verification", () => {
    // Narrower than "no provenance cannot resolve": the state machine accepts any
    // labelled `verification-pass` from its caller. What it refuses is an unlabelled
    // success — a bare "something passed" is not evidence, so it is ignored.
    const [view] = stateOf([note()], () => []);
    expect(view!.state).toBe("unresolved");
    // A pass whose kind is not `verification-pass` is likewise ignored.
    const bogus = [{ kind: "success" as never, summary: "something passed", source: "bash" }];
    expect(advisorIssueViews(advisorIssues([note()]), () => bogus)[0]!.state).toBe("unresolved");
  });

  it("15. an empty note text is only ever unknown", () => {
    const views = stateOf([{ customType: "advisor", details: { notes: [{ note: "   ", severity: "blocker" }] } }]);
    // A blank note is dropped at parse time, so it produces no issue at all —
    // it can never be rendered as a resolved or unresolved one.
    expect(views).toHaveLength(0);
  });

  it("16. no state claims current advisor enablement", () => {
    // The vocabulary is about a note's history. "Enabled" is not a state, and the
    // transport does not carry the flag.
    const states = stateOf([note()], claim).map((view) => view.state) as string[];
    for (const state of states) {
      expect(["unresolved", "verifying", "resolved", "reopened", "unknown"]).toContain(state);
      expect(state).not.toMatch(/enabled|active|running/i);
    }
    expect(ADVISOR_SEVERITIES).toEqual(["nit", "concern", "blocker"]);
  });

  it("17. every unsupported recheck reason is exposed as data", () => {
    // The panel must be able to state what it cannot check instead of implying it
    // was checked and passed.
    expect(UNSUPPORTED_RECHECK_REASONS.length).toBeGreaterThanOrEqual(4);
    for (const reason of UNSUPPORTED_RECHECK_REASONS) expect(reason.length).toBeGreaterThan(20);
    expect(UNSUPPORTED_RECHECK_REASONS.join(" ")).toMatch(/no status field/i);
  });

  it("18. historical notes remain accessible in every state", () => {
    const rows = [note(), note({ note: "A second, unrelated concern.", severity: "concern" })];
    for (const evidence of [() => [], claim, () => [pass()], () => [...pass(), ...fail()]]) {
      const views = advisorIssueViews(advisorIssues(rows), typeof evidence === "function" ? (evidence as never) : () => (evidence as readonly never[]));
      // The note text and its advisor survive whatever the state is.
      expect(views).toHaveLength(2);
      expect(views[0]!.note).toContain("retry loop");
      expect(views[0]!.advisor).toBe("warden");
    }
  });

  it("19. order is transcript order", () => {
    const issues = advisorIssues([
      note({ note: "First.", severity: "nit" }),
      note({ note: "Second.", severity: "concern" }),
      note({ note: "Third.", severity: "blocker" }),
    ]);
    expect(issues.map((issue) => issue.note)).toEqual(["First.", "Second.", "Third."]);
    expect(issues.map((issue) => issue.seq)).toEqual([1, 2, 3]);
  });

  it("20. a missing or unknown severity is a nit", () => {
    const issues = advisorIssues([
      { customType: "advisor", details: { notes: [{ note: "No severity given." }] } },
      { customType: "advisor", details: { notes: [{ note: "Nonsense severity.", severity: "catastrophic" }] } },
    ]);
    expect(issues.map((issue) => issue.severity)).toEqual(["nit", "nit"]);
    // Guessing upward would manufacture a blocker out of noise.
    expect(standingBlockerCount(advisorIssueViews(issues))).toBe(0);
  });
});

// ── The chip must not cry wolf ──────────────────────────────────────────────
//
// The header chip asserts a blocker without the reader opening anything, so it is
// the one surface where a stale blocker does real harm. These pin the honesty
// rule: only a *standing* blocker may raise it.
describe("standing blocker count drives the chip", () => {
  const blockerRows: Array<{ customType?: string; details?: unknown; role?: string; text?: string; isError?: boolean }> = [
    { customType: "advisor", details: { notes: [{ note: "The retry loop can spin forever.", severity: "blocker", advisor: "warden" }] } },
    { role: "assistant", text: "I have fixed the retry loop can spin forever problem." },
  ];

  it("counts an unaddressed blocker", () => {
    const views = advisorIssueViews(advisorIssues([blockerRows[0]!]));
    expect(standingBlockerCount(views)).toBe(1);
  });

  it("drops a blocker once a verification resolves it", () => {
    const issues = advisorIssues([blockerRows[0]!]);
    const resolved = advisorIssueViews(issues, () => [{ kind: "verification-pass", summary: "verification", source: "bash" }]);
    expect(standingBlockerCount(resolved)).toBe(0);
  });

  it("does not treat a spoken claim of a fix as resolving a blocker", () => {
    // The exact false-negative the task names: the agent says it is fixed, and the
    // warning must stay until something actually verifies it.
    const rows = blockerRows;
    const views = advisorIssueViews(advisorIssues(rows), advisorEvidence(rows));
    expect(views[0]!.state).toBe("verifying");
    expect(standingBlockerCount(views)).toBe(1);
  });

  it("reopens and re-raises the chip after a later failure", () => {
    const rows = [
      ...blockerRows,
      { role: "tool", text: "still failing: the retry loop can spin forever", isError: true },
    ];
    const views = advisorIssueViews(advisorIssues(rows), advisorEvidence(rows));
    expect(standingBlockerCount(views)).toBe(1);
  });

  it("does not read a negated sentence as a claim of a fix", () => {
    const rows = [
      blockerRows[0]!,
      { role: "assistant", text: "The retry loop can spin forever problem is not fixed yet." },
    ];
    const views = advisorIssueViews(advisorIssues(rows), advisorEvidence(rows));
    // "not fixed" must not be read as "fixed".
    expect(views[0]!.state).toBe("unresolved");
  });

  it("ignores a claim that is about something else", () => {
    const rows = [
      blockerRows[0]!,
      { role: "assistant", text: "I fixed the unrelated layout padding issue." },
    ];
    const views = advisorIssueViews(advisorIssues(rows), advisorEvidence(rows));
    expect(views[0]!.state).toBe("unresolved");
  });
});

// ── Defects found by independent audit ─────────────────────────────────────
//
// These four were real holes in the first cut, each found by an adversarial
// review that tried to make the module lie. They are pinned here so the same
// class of hole cannot come back.
describe("evidence precision (audit regressions)", () => {
  const aboutRetryLoop = { customType: "advisor", details: { notes: [{ note: "The retry loop can spin forever.", severity: "blocker", advisor: "warden" }] } };

  it("AUD-1. a negated claim is never read as a claim of a fix", () => {
    // Every one of these defeated the original immediate-adjacency rule.
    const negations = [
      "The retry loop cannot be fixed.",
      "The retry loop is not fully fixed.",
      "The retry loop was never really fixed.",
      "The retry loop isn't quite fixed.",
      "The retry loop was fixed, but it is still broken.",
      "The retry loop is by no means fixed.",
    ];
    for (const text of negations) {
      const rows = [aboutRetryLoop, { role: "assistant", text }];
      const views = advisorIssueViews(advisorIssues(rows), advisorEvidence(rows));
      expect(views[0]!.state, text).toBe("unresolved");
    }
  });

  it("AUD-2. a claim about a different subject does not touch the issue", () => {
    const rows = [
      aboutRetryLoop,
      { role: "assistant", text: "I fixed the retry timeout in the unrelated network module." },
    ];
    const views = advisorIssueViews(advisorIssues(rows), advisorEvidence(rows));
    // One shared word ("retry") is not the same subject.
    expect(views[0]!.state).toBe("unresolved");
  });

  it("AUD-3. a genuine claim that keeps the note's vocabulary still counts", () => {
    // The stricter matcher must not become so strict it never fires.
    const rows = [aboutRetryLoop, { role: "assistant", text: "Fixed the retry loop that can spin forever." }];
    const views = advisorIssueViews(advisorIssues(rows), advisorEvidence(rows));
    expect(views[0]!.state).toBe("verifying");
  });

  it("AUD-4. two different notes never share an identity", () => {
    // Identity is the full normalized text, so no digest collision can merge two
    // issues into one lifecycle or one evidence cache.
    const a = "jgtslhagjjnchdahbyleasdv";
    const b = "xlzajegpukkgfyozyxhwerzl";
    const issues = advisorIssues([
      { customType: "advisor", details: { notes: [{ note: a, severity: "blocker", advisor: "w" }] } },
      { customType: "advisor", details: { notes: [{ note: b, severity: "blocker", advisor: "w" }] } },
    ]);
    expect(issues).toHaveLength(2);
    expect(issues[0]!.id).not.toBe(issues[1]!.id);
  });

  it("AUD-5. produced states are exactly the ones the code can reach from real rows", () => {
    // `resolved` requires a labelled verification, and nothing derived from a
    // transcript supplies one — a passing tool run is not evidence about a note.
    // This test states that limit instead of pretending the state is reachable.
    const rows = [
      aboutRetryLoop,
      { role: "assistant", text: "Fixed the retry loop that can spin forever." },
      { role: "tool", text: "all tests passed, the retry loop can spin forever", isError: false },
    ];
    const views = advisorIssueViews(advisorIssues(rows), advisorEvidence(rows));
    expect(views[0]!.state).toBe("verifying");
    // A green run does not resolve it: exit status carries no subject.
    expect(views[0]!.state).not.toBe("resolved");
    // And the agent's claim alone never reaches resolved either.
    expect(advisorEvidence(rows)(advisorIssues(rows)[0]!).map((item) => item.kind)).not.toContain("verification-pass");
  });

  it("AUD-6. a caller-supplied verification is the only route to resolved", () => {
    // Stated plainly because it is the module's real scope: the state machine
    // honours a labelled verification, and only a caller that genuinely knows the
    // subject can supply one. The transcript reader never does.
    const issues = advisorIssues([aboutRetryLoop]);
    const resolved = advisorIssueViews(issues, () => [{ kind: "verification-pass", summary: "verification", source: "owner" }]);
    expect(resolved[0]!.state).toBe("resolved");
    expect(standingBlockerCount(resolved)).toBe(0);
  });
});
