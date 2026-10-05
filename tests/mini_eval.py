"""Évalue muaalem-mini (ONNX int8 réel) sur un enregistrement complet : fautes signalées par ayah.
python tests/mini_eval.py <wav> <sourate> <de> <à> [--json out.json]
Découpe aux silences (comme le serveur), phonèmes CTC, puis analysis.analyze_segment (même logique que l'app)."""
import sys, json, numpy as np, soundfile as sf, onnxruntime as ort
sys.path.insert(0, '/home/claude/murattil/tests')
from gop import log_softmax, force_align, token_scores
sys.path.insert(0, "/home/claude/murattil/server")
from analysis import analyze_segment, default_moshaf, to_json

def split_long(wave, max_s=14.0, SR=16000):  # copie de server/model.py (sans torch)
    if len(wave) <= max_s * SR: return [wave]
    hop = int(0.02 * SR); energy = np.sqrt(np.convolve(wave ** 2, np.ones(hop) / hop, mode="same"))
    parts, start = [], 0
    while len(wave) - start > max_s * SR:
        lo, hi = start + int(0.6 * max_s * SR), start + int(max_s * SR)
        cut = lo + int(np.argmin(energy[lo:hi])); parts.append(wave[start:cut]); start = cut
    parts.append(wave[start:]); return parts
from transformers import SeamlessM4TFeatureExtractor

M = "/tmp/claude-0/real/"
vocab = {int(k): v for k, v in json.load(open(M + "vocab.json")).items()}
sess = ort.InferenceSession(M + "web.onnx", providers=["CPUExecutionProvider"])
fe = SeamlessM4TFeatureExtractor(feature_size=80, num_mel_bins=80, padding_value=1, stride=2, sampling_rate=16000)

def logits(w):
    f = fe(w, sampling_rate=16000, return_tensors="np")
    return sess.run(None, {"input_features": f["input_features"], "attention_mask": f["attention_mask"].astype(np.int64)})[0][0]

def greedy(lg):
    out, prev = [], 0
    for i in lg.argmax(-1):
        i = int(i)
        if i and i != prev: out.append(vocab[i])
        prev = i
    return "".join(out)

def run(path, surah, a, b, max_s=14.0):
    import subprocess
    w = np.frombuffer(subprocess.check_output(["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ar", "16000", "-ac", "1", "pipe:1"]), dtype=np.float32).copy()
    lgs = [logits(p) for p in split_long(w, max_s)]
    pred = "".join(greedy(l) for l in lgs)
    res = analyze_segment(pred, surah, a, b, default_moshaf(), include_basmala=(a == 1))
    out = to_json(res)
    if TAU is not None:
        out = gop_filter(np.concatenate([log_softmax(l) for l in lgs]), out, surah)
    return pred, out

TAU = None
INS_P = 0.5
def gop_filter(lp, res, surah):
    """Garde une faute seulement si le modèle entend vraiment autre chose que l'attendu :
    - remplacement / oubli : un jeton attendu de la zone a un score < TAU (log-proba relative au meilleur)
    - ajout : un phonème non-blanc de proba > INS_P dans les frames entre les deux jetons voisins
    - madd : écart de durée d'au moins 2 temps."""
    from analysis import _phonetize, ayah_text
    inv = {v: k for k, v in vocab.items()}
    m = default_moshaf()
    for r in res:
        ph = _phonetize(ayah_text(surah, r["ayah"]), m, surah).phonemes
        ids = [inv.get(c, -1) for c in ph]
        if -1 in ids: continue
        tok = force_align(lp, ids)
        sc = token_scores(lp, ids, tok)
        frames_of = {}
        for t, k in enumerate(tok):
            if k >= 0: frames_of.setdefault(k, []).append(t)
        keep = []
        for e in r["errors"]:
            s0, s1 = (e.get("ph") or (None, None))[:2] if e.get("ph") else (None, None)
            if e.get("exp_len") is not None and e.get("got_len") is not None:
                if abs(e["exp_len"] - e["got_len"]) >= 2: keep.append(e)
                continue
            if s0 is None: keep.append(e); continue
            if s1 > s0:
                e["_gop"] = float(sc[s0:s1].min())
                if e["_gop"] < TAU: keep.append(e)
            else:
                a_ = max(frames_of.get(s0 - 1, [0])) if s0 > 0 else 0
                b_ = min(frames_of.get(s0, [lp.shape[0] - 1]))
                seg = lp[a_ + 1:b_, 1:] if b_ > a_ + 1 else None
                e["_ins"] = float(np.exp(seg.max())) if seg is not None and seg.size else 0.0
                if e["_ins"] > INS_P: keep.append(e)
        r["errors"] = keep
    return res

if __name__ == "__main__":
    path, s, a, b = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
    if "--tau" in sys.argv: TAU = float(sys.argv[sys.argv.index("--tau") + 1])
    pred, res = run(path, s, a, b)
    n = sum(len(r["errors"]) for r in res)
    cats = {}
    for r in res:
        for e in r["errors"]: cats[e["category"]] = cats.get(e["category"], 0) + 1
    print(f"{path.split('/')[-1]}: {len(res)}/{b-a+1} ayahs couvertes, {n} fautes {cats}")
    if "--v" in sys.argv:
        for r in res:
            for e in r["errors"]: print(f"  {r['ayah']}:{e['word']} {e['word_text']} [{e['category']}] {e['message']}")
    if "--json" in sys.argv: json.dump({"pred": pred, "res": res}, open(sys.argv[sys.argv.index("--json") + 1], "w"), ensure_ascii=False)
