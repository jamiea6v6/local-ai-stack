def solve_circuit(V, I, R, P, unknown):
    if unknown not in ("V", "I", "R", "P"):
        return "Insufficient data"
    if unknown == "V":
        if I is not None and R is not None:
            return I * R
        if P is not None and I is not None:
            if I == 0:
                return "Insufficient data"
            return P / I
        if P is not None and R is not None:
            product = P * R
            if product < 0:
                return "Insufficient data"
            return product ** 0.5
        return "Insufficient data"
    if unknown == "I":
        if V is not None and R is not None:
            if R == 0:
                return "Insufficient data"
            return V / R
        if V is not None and P is not None:
            if V == 0:
                return "Insufficient data"
            return P / V
        if P is not None and R is not None:
            ratio = P / R if R != 0 else -1.0
            if ratio < 0:
                return "Insufficient data"
            return ratio ** 0.5
        return "Insufficient data"
    if unknown == "R":
        if V is not None and I is not None:
            if I == 0:
                return "Insufficient data"
            return V / I
        if V is not None and P is not None:
            if P == 0:
                return "Insufficient data"
            return (V ** 2) / P
        if P is not None and I is not None:
            if I == 0:
                return "Insufficient data"
            return P / (I ** 2)
        return "Insufficient data"
    if V is not None and I is not None:
        return V * I
    if V is not None and R is not None:
        if R == 0:
            return "Insufficient data"
        return (V ** 2) / R
    if I is not None and R is not None:
        return (I ** 2) * R
    return "Insufficient data"
