def solve_circuit(V, I, R, P, unknown):
    if unknown == "R" and V is not None and P is not None and I is None:
        return P / V if V else "Insufficient data"
    if unknown == "P" and I is not None and R is not None and V is None:
        return I * R
    if unknown == "I" and R is not None and P is not None and V is None:
        return P / R if R else "Insufficient data"
    return "Insufficient data"
