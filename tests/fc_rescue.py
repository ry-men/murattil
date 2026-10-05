# Vérifie si FastConformer entend les mots que Zipformer a ratés (segments par ayah depuis le journal de l'app).
import sys, json, re, subprocess, numpy as np, onnxruntime as ort, Levenshtein
A = "/home/claude/assets/"
vocab = {int(k): v for k, v in json.load(open(A + "vocab.json")).items()}
sess = ort.InferenceSession(A + "fastconformer_full_mixed.onnx")
inp = [i.name for i in sess.get_inputs()]
diag = json.load(open(sys.argv[2])); wav = sys.argv[1]
pcm = np.frombuffer(subprocess.check_output(["ffmpeg","-hide_banner","-loglevel","error","-i",wav,"-f","f32le","-ar","16000","-ac","1","pipe:1"]), dtype=np.float32)
quran = {(v["surah"], v["ayah"]): v for v in json.load(open("public/quran.json"))}
def norm(s):
    s = re.sub(r"[ً-ٰٟۖ-ۭـ]", "", s)
    s = s.replace("ٱ","ا").replace("أ","ا").replace("إ","ا").replace("آ","ا").replace("ى","ي").replace("ة","ه").replace("ؤ","و").replace("ئ","ي").replace("ء","")
    return re.sub(r"[^ء-ي ]", "", s).strip()
def transcribe(x):
    o = sess.run(None, {inp[0]: x[None, :], inp[1]: np.array([len(x)], dtype=np.int64)})[0][0]
    prev, t = -1, ""
    for b in o.argmax(-1):
        b = int(b)
        if b != prev and b != 1024 and b in vocab: t += vocab[b]
        prev = b
    return t.replace("▁", " ").strip()
first = {}
for e in diag["events"]:
    if e["type"] in ("word_progress", "verse_match"):
        first.setdefault(e["ayah"], e["t"])
missed = {(m["ayah"], m["word"]): m["text"] for m in diag["record"]["missed"]}
ayahs = sorted(first)
rescued = 0
for i, a in enumerate(ayahs):
    t0 = max(0, first[a] - 1.8); t1 = (first[ayahs[i+1]] - 0.3) if i + 1 < len(ayahs) else len(pcm)/16000
    hyp = transcribe(pcm[int(t0*16000):int(t1*16000)])
    hn = norm(hyp).split()
    for (ma, mw), txt in missed.items():
        if ma != a: continue
        w = norm(txt)
        best = max([Levenshtein.ratio(w, h) for h in hn] + [0])
        ok = best >= 0.75
        rescued += ok
        print(f"{a}:{mw} {txt} → {'ENTENDU' if ok else 'absent'} ({best:.2f}) | FC: {hyp}")
print("rescued", rescued, "/", len(missed))
