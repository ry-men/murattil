"""Filtre de confiance (GOP) pour les fautes du modèle mini : une faute n'est gardée que si le modèle
« entend » vraiment autre chose que le texte attendu à cet endroit (alignement forcé CTC)."""
import numpy as np

def log_softmax(x):
    m = x.max(-1, keepdims=True)
    return x - m - np.log(np.exp(x - m).sum(-1, keepdims=True))

def force_align(lp, ids, filler_pen=1.5):
    """Viterbi CTC semi-global (numpy) : du bruit (filler) est permis avant et après le texte.
    Renvoie pour chaque frame l'indice du jeton de référence aligné (-1 = blanc ou filler)."""
    T, L = lp.shape[0], len(ids)
    S = 2 * L + 1
    lab = np.zeros(S, dtype=int); lab[1::2] = ids
    skip_ok = np.zeros(S, dtype=bool)
    for k in range(3, S, 2):
        skip_ok[k] = lab[k] != lab[k - 2]
    filler = lp.max(-1) - filler_pen
    NEG = -1e9
    # colonnes : 0 = filler avant, 1..S = trellis, S+1 = filler après
    dp = np.full(S + 2, NEG); dp[0] = filler[0]; dp[1] = lp[0, 0]
    if L: dp[2] = lp[0, lab[1]]
    bp = np.zeros((T, S + 2), dtype=np.int32)
    idx = np.arange(1, S + 1)
    for t in range(1, T):
        emit = lp[t, lab]  # S
        emit[0::2] = lp[t, 0]
        stay = dp[1:S + 1]
        prev1 = dp[0:S]  # s-1 (pour s=1 : filler avant)
        prev2 = np.full(S, NEG); prev2[2:] = np.where(skip_ok[2:], dp[1:S - 1], NEG)
        fromf = np.full(S, NEG); fromf[1] = dp[0]  # c1 directement depuis le filler
        cand = np.stack([stay, prev1, prev2, fromf])
        arg = cand.argmax(0)
        src = np.choose(arg, [idx, idx - 1, idx - 2, np.zeros(S, dtype=int)])
        nd = np.empty(S + 2)
        nd[1:S + 1] = cand.max(0) + emit
        bp[t, 1:S + 1] = src
        nd[0] = dp[0] + filler[t]; bp[t, 0] = 0
        c = [(dp[S + 1], S + 1), (dp[S], S), (dp[S - 1], S - 1)]
        v, a = max(c); nd[S + 1] = v + filler[t]; bp[t, S + 1] = a
        dp = nd
    s_ = max([(dp[S], S), (dp[S - 1], S - 1), (dp[S + 1], S + 1)])[1]
    tok = np.full(T, -1)
    for t in range(T - 1, -1, -1):
        k = s_ - 1
        if 0 <= k < S and k % 2 == 1:
            tok[t] = k // 2
        s_ = bp[t, s_]
    return tok

def token_scores(lp, ids, tok):
    """Score par jeton de référence : max sur ses frames de log p(jeton) - log p(meilleur). 0 = entendu tel quel."""
    L = len(ids)
    sc = np.full(L, -9.0)
    best = lp.max(-1)
    for t, k in enumerate(tok):
        if k >= 0:
            sc[k] = max(sc[k], lp[t, ids[k]] - best[t])
    return sc
