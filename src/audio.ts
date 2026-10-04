// Micro robuste : 16 kHz mono, reprise automatique après coupure.
export type MicStatus = "off" | "starting" | "on" | "recovering" | "denied" | "error";

export interface MicOptions {
  workletUrl: string;
  onChunk: (samples: Float32Array) => void;
  onLevel?: (rms: number) => void;
  onStatus?: (status: MicStatus, detail?: string) => void;
}

export class Mic {
  private opts: MicOptions;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private wakeLock: { release(): Promise<void> } | null = null;
  private active = false;
  private paused = false;
  private lastChunkAt = 0;
  private watchdog: number | undefined;
  private restarting = false;
  status: MicStatus = "off";

  constructor(opts: MicOptions) {
    this.opts = opts;
    this.onVisibility = this.onVisibility.bind(this);
    this.onDeviceChange = this.onDeviceChange.bind(this);
  }

  private set(status: MicStatus, detail?: string) {
    this.status = status;
    this.opts.onStatus?.(status, detail);
  }

  async start(): Promise<void> {
    this.active = true;
    this.paused = false;
    this.set("starting");
    document.addEventListener("visibilitychange", this.onVisibility);
    navigator.mediaDevices?.addEventListener?.("devicechange", this.onDeviceChange);
    await this.open();
    this.watchdog = window.setInterval(() => this.check(), 1000);
    void this.lockScreen();
  }

  /** Appelé sur un geste utilisateur : relance l'audio si le navigateur l'a suspendu. */
  kick() {
    if (this.active && this.ctx && this.ctx.state !== "running") void this.ctx.resume().catch(() => undefined);
  }

  pause(p: boolean) {
    this.paused = p;
  }

  async stop(): Promise<void> {
    this.active = false;
    clearInterval(this.watchdog);
    document.removeEventListener("visibilitychange", this.onVisibility);
    navigator.mediaDevices?.removeEventListener?.("devicechange", this.onDeviceChange);
    this.close();
    try { await this.wakeLock?.release(); } catch { /* */ }
    this.wakeLock = null;
    this.set("off");
  }

  private async open(): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      const name = (e as DOMException)?.name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        this.set("denied");
        this.active = false;
        throw e;
      }
      this.set("error", String((e as Error)?.message ?? e));
      throw e;
    }
    for (const t of this.stream.getAudioTracks()) {
      t.onended = () => this.recover("piste micro terminée");
      t.onmute = () => { /* iOS : coupure système (appel, Siri) — le watchdog relance */ };
    }
    // 16 kHz natif si possible (meilleur filtrage), sinon le worklet rééchantillonne.
    let ctx: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    for (const rate of [16000, undefined]) {
      try {
        ctx = new AudioContext(rate ? { sampleRate: rate, latencyHint: "interactive" } : { latencyHint: "interactive" });
        source = ctx.createMediaStreamSource(this.stream);
        break;
      } catch {
        void ctx?.close().catch(() => undefined);
        ctx = null;
      }
    }
    if (!ctx || !source) throw new Error("AudioContext indisponible");
    this.ctx = ctx;
    const c = ctx;
    ctx.onstatechange = () => {
      if (!this.active) return;
      if (c.state !== "running") void c.resume().catch(() => this.recover("contexte audio suspendu"));
    };
    await ctx.audioWorklet.addModule(this.opts.workletUrl);
    const node = new AudioWorkletNode(ctx, "audio-stream-processor");
    this.node = node;
    node.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      this.lastChunkAt = performance.now();
      const samples = new Float32Array(ev.data);
      if (this.opts.onLevel) {
        let s = 0;
        for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
        this.opts.onLevel(Math.sqrt(s / samples.length));
      }
      if (!this.paused) this.opts.onChunk(samples);
    };
    source.connect(node);
    // Le worklet doit être tiré par la sortie : gain nul pour ne rien entendre.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute).connect(ctx.destination);
    if (ctx.state !== "running") await ctx.resume().catch(() => undefined);
    this.lastChunkAt = performance.now();
    this.set("on");
  }

  private close() {
    try { this.node?.port.close(); } catch { /* */ }
    this.node?.disconnect();
    this.node = null;
    this.stream?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    this.stream = null;
    if (this.ctx) { this.ctx.onstatechange = null; void this.ctx.close().catch(() => undefined); }
    this.ctx = null;
  }

  private async recover(reason: string) {
    if (!this.active || this.restarting) return;
    this.restarting = true;
    this.set("recovering", reason);
    this.close();
    for (let i = 0; i < 5 && this.active; i++) {
      try {
        await this.open();
        this.restarting = false;
        return;
      } catch {
        if (this.status === "denied") break;
        await new Promise((r) => setTimeout(r, 700 * (i + 1)));
      }
    }
    this.restarting = false;
    if (this.active) this.set("error", "Micro indisponible");
  }

  private check() {
    if (!this.active || this.restarting || document.hidden) return;
    const silentFor = performance.now() - this.lastChunkAt;
    const track = this.stream?.getAudioTracks()[0];
    if (!track || track.readyState === "ended") { void this.recover("piste perdue"); return; }
    if (this.ctx && this.ctx.state !== "running") { void this.ctx.resume().catch(() => undefined); }
    if (silentFor > 2500) void this.recover("flux audio bloqué");
  }

  private onVisibility() {
    if (!this.active) return;
    if (!document.hidden) {
      void this.lockScreen();
      this.lastChunkAt = performance.now();
      if (this.ctx?.state !== "running") void this.ctx?.resume().catch(() => this.recover("retour au premier plan"));
    }
  }

  private onDeviceChange() {
    if (this.active) void this.recover("changement de micro");
  }

  private async lockScreen() {
    try {
      const wl = (navigator as unknown as { wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock;
      if (wl && !document.hidden) this.wakeLock = await wl.request("screen");
    } catch { /* non supporté */ }
  }
}
