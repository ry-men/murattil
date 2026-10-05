// Export du diagnostic : l'audio de la séance (WAV 16 kHz) + le journal du moteur (JSON).
import type { SessionRecord } from "./store";

function wav(chunks: Int16Array[]): Blob {
  const n = chunks.reduce((s, c) => s + c.length, 0);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, n * 2, true);
  let off = 44;
  for (const c of chunks) { new Int16Array(buf, off, c.length).set(c); off += c.length * 2; }
  return new Blob([buf], { type: "audio/wav" });
}

export async function exportDiagnostic(d: {
  audio: Int16Array[]; log: Record<string, unknown>[]; record: SessionRecord; verdicts: [string, number][];
}): Promise<"share" | "download"> {
  const stamp = new Date(d.record.date).toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const base = `murattil-${stamp}`;
  const meta = {
    app: "murattil", version: "0.5", userAgentData: (navigator as unknown as { userAgentData?: unknown }).userAgentData ?? null, userAgent: navigator.userAgent, record: d.record,
    verdicts: d.verdicts, events: d.log,
  };
  const files = [
    new File([wav(d.audio)], `${base}.wav`, { type: "audio/wav" }),
    new File([JSON.stringify(meta)], `${base}.json`, { type: "application/json" }),
  ];
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
  if (nav.canShare?.({ files }) && nav.share) {
    try {
      await nav.share({ files, title: "Diagnostic Murattil" });
      return "share";
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") return "share";
    }
  }
  for (const f of files) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  return "download";
}
