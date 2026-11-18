"""Deterministic test spec for solve_circuit.

Run:  python3 circuit_spec.py /path/to/module.py

GROUND TRUTH (verified exhaustively over all 12 known/unknown combinations):

Every pair of distinct knowns determines every unknown, via exactly one formula:

    unknown V:  known(I,R) -> V=I*R      known(I,P) -> V=P/I      known(R,P) -> V=sqrt(P*R)
    unknown I:  known(V,R) -> I=V/R      known(V,P) -> I=P/V      known(R,P) -> I=sqrt(P/R)
    unknown R:  known(V,I) -> R=V/I      known(V,P) -> R=V^2/P    known(I,P) -> R=P/I^2
    unknown P:  known(V,I) -> P=V*I      known(V,R) -> P=V^2/R    known(I,R) -> P=I^2*R

There are 4 quantities, choose 2 = 6 known pairs per unknown, and all 12 combinations are
solvable. So "Insufficient data" is required ONLY when fewer than two quantities are known,
or when a value needed as a divisor is zero. A previous version of this spec demanded
"Insufficient data" for known(R,P) -> I, which is wrong: P=I^2*R gives I=sqrt(P/R). The model
was right and the spec was wrong. Do not reintroduce that contradiction.

Exits 0 when every case passes, non-zero otherwise, so `verify` can use the exit code.
Nothing here asks the model's opinion — the pass/fail decision is entirely in this file.
"""

import importlib.util
import math
import sys

SPEC = "Insufficient data"

# (V, I, R, P, unknown, expected, note)
CASES = [
    # --- all six known-pairs for each unknown ---
    (None, 2.0, 5.0, None, "V", 10.0, "V = I*R"),
    (None, 3.0, None, 12.0, "V", 4.0, "V = P/I"),
    (None, None, 4.0, 10.0, "V", math.sqrt(40.0), "V = sqrt(P*R)"),
    (12.0, None, 5.0, None, "I", 2.4, "I = V/R"),
    (6.0, None, None, 2.0, "I", 1.0 / 3.0, "I = P/V"),
    (None, None, 4.0, 10.0, "I", math.sqrt(2.5), "I = sqrt(P/R)"),
    (12.0, 2.0, None, None, "R", 6.0, "R = V/I"),
    (24.0, None, None, 6.0, "R", 96.0, "R = V^2/P"),
    (None, 3.0, None, 2.0, "R", 2.0 / 9.0, "R = P/I^2"),
    (24.0, 3.0, None, None, "P", 72.0, "P = V*I"),
    (12.0, None, 4.0, None, "P", 36.0, "P = V^2/R"),
    (None, 3.0, 7.0, None, "P", 63.0, "P = I^2*R"),
    # --- insufficient: fewer than two knowns ---
    (None, None, None, None, "V", SPEC, "no data at all"),
    (12.0, None, None, None, "P", SPEC, "one known value only"),
    (None, None, 5.0, None, "I", SPEC, "one known value only"),
    # --- a zero KNOWN value is fine and often meaningful ---
    (0.0, 5.0, None, None, "R", 0.0, "V=0 known, R = V/I = 0"),
    (0.0, None, 5.0, None, "I", 0.0, "V=0 known, I = V/R = 0"),
    (None, 2.0, 0.0, None, "P", 0.0, "R=0 known, P = I^2*R = 0"),
    # --- guards: a zero DIVISOR is genuinely unsolvable ---
    (12.0, None, None, 0.0, "R", SPEC, "P=0 is a divisor for R"),
    (None, 2.0, None, 0.0, "I", SPEC, "V=0 is a divisor for I"),
    # NOTE: V=I*R with R=0 is NOT a division, so it is solvable (V=0). Do not add it as a guard.

    # --- inconsistent input: no real solution ---
    (None, None, -4.0, 10.0, "V", SPEC, "P*R negative, no real V"),
]


def approx(a, b):
    """Numeric comparison with tolerance, or exact match for the sentinel string."""
    if isinstance(a, str) or isinstance(b, str):
        return a == b
    try:
        return abs(float(a) - float(b)) < 1e-9
    except (TypeError, ValueError):
        return False


def main():
    if len(sys.argv) < 2:
        print("usage: python3 circuit_spec.py /path/to/module.py")
        return 2

    path = sys.argv[1]
    spec = importlib.util.spec_from_file_location("candidate", path)
    if spec is None or spec.loader is None:
        print(f"ERROR: cannot load {path}")
        return 2
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: importing {path} raised {type(exc).__name__}: {exc}")
        return 2

    solve = getattr(mod, "solve_circuit", None)
    if not callable(solve):
        print("ERROR: no callable solve_circuit(V, I, R, P, unknown) in module")
        return 2

    passed = 0
    failures = []
    for V, I, R, P, unknown, expected, note in CASES:
        try:
            got = solve(V, I, R, P, unknown)
        except Exception as exc:  # noqa: BLE001
            got = f"<raised {type(exc).__name__}: {exc}>"
        if approx(expected, got):
            passed += 1
            print(f"PASS  {note}")
        else:
            failures.append(note)
            print(f"FAIL  {note}: expected {expected!r}, got {got!r}")

    print()
    print(f"{passed}/{len(CASES)} passed")
    if failures:
        print("failed cases:")
        for f in failures:
            print(f"  - {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())