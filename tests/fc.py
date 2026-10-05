# Seconde opinion : transcription FastConformer (texte arabe) de segments audio.
import sys, json, subprocess, numpy as np, onnxruntime as ort
A = "/home/claude/assets/"
vocab = json.load(open(A + "vocab.json"))
id2 = {int(k): v for k, v in vocab.items()}
s = ort.InferenceSession(A + "fastconformer_full_mixed.onnx")
names = [i.name for i in s.get_inputs()]
for f in sys.argv[1:]:
    pcm = np.frombuffer(subprocess.check_output(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", f, "-f", "f32le", "-ar", "16000", "-ac", "1", "pipe:1"]), dtype=np.float32)
    out = s.run(None, {names[0]: pcm[None, :], names[1]: np.array([len(pcm)], dtype=np.int64)})[0][0]
    best = out.argmax(-1); prev = -1; txt = ""
    for b in best:
        b = int(b)
        if b != prev and b != 1024 and b in id2: txt += id2[b]
        prev = b
    print(f.split("/")[-1], "→", txt.replace("▁", " ").strip())
