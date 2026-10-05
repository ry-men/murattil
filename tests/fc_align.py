# Repêchage par alignement : FastConformer sur [ayah précédente .. début de la suivante], alignement mot à mot.
import sys, json, re, subprocess, numpy as np, onnxruntime as ort, Levenshtein
A = "/home/claude/assets/"
vocab = {int(k): v for k, v in json.load(open(A + "vocab.json")).items()}
sess = ort.InferenceSession(A + "fastconformer_full_mixed.onnx"); inp = [i.name for i in sess.get_inputs()]
wav, diagf = sys.argv[1], sys.argv[2]; shift = float(sys.argv[3]) if len(sys.argv) > 3 else 0
diag = json.load(open(diagf))
pcm = np.frombuffer(subprocess.check_output(["ffmpeg","-hide_banner","-loglevel","error","-i",wav,"-f","f32le","-ar","16000","-ac","1","pipe:1"]), dtype=np.float32)
sys.path.insert(0, "tests")
words_of = json.load(open("/tmp/claude-0/words78.json"))
def norm(s):
    s = re.sub(r"[ً-ٰٟۖ-ۭـ]", "", s)
    for a, b in (("ٱ","ا"),("أ","ا"),("إ","ا"),("آ","ا"),("ى","ي"),("ة","ه"),("ؤ","و"),("ئ","ي"),("ء","")): s = s.replace(a, b)
    return re.sub(r"[^ء-ي ]", "", s).strip()
def tr(x):
    o = sess.run(None, {inp[0]: x[None, :], inp[1]: np.array([len(x)], dtype=np.int64)})[0][0]
    prev, t = -1, ""
    for b in o.argmax(-1):
        b = int(b)
        if b != prev and b != 1024 and b in vocab: t += vocab[b]
        prev = b
    return t.replace("▁", " ").strip()
def align(E, H):
    n, m = len(E), len(H)
    S = np.zeros((n+1, m+1)); bt = np.zeros((n+1, m+1), dtype=int)
    R = [[Levenshtein.ratio(e, h) for h in H] for e in E]
    for i in range(1, n+1):
        for j in range(1, m+1):
            opts = (S[i-1][j-1] + (R[i-1][j-1] if R[i-1][j-1] >= 0.6 else -0.3), S[i-1][j], S[i][j-1])
            k = int(np.argmax(opts)); S[i][j] = opts[k]; bt[i][j] = k
    i, j, pairs = n, m, {}
    while i > 0 and j > 0:
        k = bt[i][j]
        if k == 0: pairs[i-1] = (j-1, R[i-1][j-1]); i -= 1; j -= 1
        elif k == 1: i -= 1
        else: j -= 1
    return pairs
first = {}
for e in diag["events"]:
    if e["type"] in ("word_progress", "verse_match"): first.setdefault(e["ayah"], e["t"] - shift)
missed = sorted({(m["ayah"], m["word"]) for m in json.load(open(sys.argv[4]))["record"]["missed"]}) if len(sys.argv) > 4 else sorted({(m["ayah"], m["word"]) for m in diag["record"]["missed"]})
res = 0
for a in sorted({x[0] for x in missed}):
    if a not in first: continue
    t0 = first.get(a-1, first[a] - 3.0) - 0.5; t1 = first.get(a+1, first[a] + 6) + 0.8
    hyp = tr(pcm[int(max(0,t0)*16000):int(t1*16000)])
    before = words_of.get(str(a-1), []); cur = words_of[str(a)]; after = words_of.get(str(a+1), [])[:3]
    E = [norm(w) for w in before + cur + after]; H = norm(hyp).split()
    pairs = align(E, H)
    for (ma, mw) in missed:
        if ma != a: continue
        p = pairs.get(len(before) + mw)
        ok = p is not None and p[1] >= 0.75
        res += ok
        print(f"{a}:{mw} {cur[mw]} → {'ENTENDU' if ok else 'absent'} {p} | {hyp[:90]}")
print("rescued", res, "/", len(missed))
