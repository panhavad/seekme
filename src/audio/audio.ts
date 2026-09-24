/**
 * Every sound in SeekMe is synthesised at runtime with the Web Audio API, so
 * the whole game stays a single tiny download and works with no network.
 */
export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private droneGain: GainNode | null = null;
  private tensionFilter: BiquadFilterNode | null = null;
  private heartTimer = 0;
  private muted = false;

  get enabled(): boolean {
    return this.ctx !== null && !this.muted;
  }

  /** Must be called from a user gesture (browser autoplay rules). */
  async resume(): Promise<void> {
    if (!this.ctx) this.init();
    if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
  }

  private init(): void {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.85;
    this.master.connect(ctx.destination);

    // Shared white-noise buffer used by splashes, steps and wind.
    const length = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    this.noise = buffer;

    this.startAmbience();
  }

  private startAmbience(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;

    // Low nocturnal drone.
    const drone = ctx.createOscillator();
    drone.type = 'sawtooth';
    drone.frequency.value = 42;
    const droneFilter = ctx.createBiquadFilter();
    droneFilter.type = 'lowpass';
    droneFilter.frequency.value = 180;
    const gain = ctx.createGain();
    gain.gain.value = 0.05;
    drone.connect(droneFilter).connect(gain).connect(this.master);
    drone.start();
    this.droneGain = gain;

    // Distant wind through the alleys.
    const wind = ctx.createBufferSource();
    wind.buffer = this.noise;
    wind.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 420;
    windFilter.Q.value = 0.7;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.035;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.08;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.025;
    lfo.connect(lfoGain).connect(windGain.gain);
    lfo.start();
    wind.connect(windFilter).connect(windGain).connect(this.master);
    wind.start();
    this.tensionFilter = windFilter;
  }

  setListener(position: [number, number, number], forward: [number, number, number]): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const listener = ctx.listener;
    const [x, y, z] = position;
    const [fx, fy, fz] = forward;

    if (listener.positionX) {
      listener.positionX.value = x;
      listener.positionY.value = y;
      listener.positionZ.value = z;
      listener.forwardX.value = fx;
      listener.forwardY.value = fy;
      listener.forwardZ.value = fz;
      listener.upX.value = 0;
      listener.upY.value = 1;
      listener.upZ.value = 0;
    } else {
      // Safari fallback
      (listener as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
      (listener as unknown as { setOrientation(...args: number[]): void }).setOrientation(fx, fy, fz, 0, 1, 0);
    }
  }

  /** Rising tension as the seeker closes in (0..1). */
  setTension(value: number): void {
    if (!this.droneGain || !this.tensionFilter || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.droneGain.gain.setTargetAtTime(0.045 + value * 0.09, t, 0.6);
    this.tensionFilter.frequency.setTargetAtTime(420 + value * 620, t, 0.8);
  }

  private panner(x: number, z: number, refDistance = 4, maxDistance = 46): PannerNode | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const panner = ctx.createPanner();
    panner.panningModel = 'equalpower';
    panner.distanceModel = 'linear';
    panner.refDistance = refDistance;
    panner.maxDistance = maxDistance;
    panner.rolloffFactor = 1;
    if (panner.positionX) {
      panner.positionX.value = x;
      panner.positionY.value = 0.6;
      panner.positionZ.value = z;
    } else {
      (panner as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, 0.6, z);
    }
    return panner;
  }

  /** Water splash - the sound both ghosts can hear and locate. */
  splash(x: number, z: number, strength = 1): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise || this.muted) return;
    const now = ctx.currentTime;
    const panner = this.panner(x, z);
    if (!panner) return;
    panner.connect(this.master);

    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    source.playbackRate.value = 1.4;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 1.4;
    filter.frequency.setValueAtTime(900, now);
    filter.frequency.exponentialRampToValueAtTime(3200, now + 0.12);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.5 * strength, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
    source.connect(filter).connect(gain).connect(panner);
    source.start(now);
    source.stop(now + 0.5);

    // the hollow "plop" that gives the splash its position
    const plop = ctx.createOscillator();
    plop.type = 'sine';
    plop.frequency.setValueAtTime(680, now);
    plop.frequency.exponentialRampToValueAtTime(160, now + 0.22);
    const plopGain = ctx.createGain();
    plopGain.gain.setValueAtTime(0.28 * strength, now);
    plopGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
    plop.connect(plopGain).connect(panner);
    plop.start(now);
    plop.stop(now + 0.32);

    cleanup(panner, now + 0.6, ctx);
  }

  /** Soft footfall for the local ghost. */
  step(x: number, z: number, warm: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise || this.muted) return;
    const now = ctx.currentTime;
    const panner = this.panner(x, z, 2, 20);
    if (!panner) return;
    panner.connect(this.master);

    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    source.playbackRate.value = warm ? 0.7 : 0.55;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = warm ? 900 : 620;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.09, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    source.connect(filter).connect(gain).connect(panner);
    source.start(now);
    source.stop(now + 0.2);
    cleanup(panner, now + 0.3, ctx);
  }

  /** The chime of new ice melting into a permanent pond. */
  melt(x: number, z: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;
    const now = ctx.currentTime;
    const panner = this.panner(x, z, 6, 40);
    if (!panner) return;
    panner.connect(this.master);

    [880, 1320, 1760].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + i * 0.06);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now + i * 0.06);
      gain.gain.exponentialRampToValueAtTime(0.14, now + i * 0.06 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.06 + 0.55);
      osc.connect(gain).connect(panner);
      osc.start(now + i * 0.06);
      osc.stop(now + i * 0.06 + 0.6);
    });
    cleanup(panner, now + 1.0, ctx);
  }

  /** Heartbeat that quickens when danger is close (0..1). */
  updateHeartbeat(dt: number, danger: number, x: number, z: number): void {
    if (!this.ctx || danger <= 0.05 || this.muted) return;
    const interval = 1.15 - danger * 0.6;
    this.heartTimer += dt;
    if (this.heartTimer < interval) return;
    this.heartTimer = 0;

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const panner = this.panner(x, z, 3, 24);
    if (!panner || !this.master) return;
    panner.connect(this.master);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(74, now);
    osc.frequency.exponentialRampToValueAtTime(42, now + 0.18);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18 * danger, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
    osc.connect(gain).connect(panner);
    osc.start(now);
    osc.stop(now + 0.26);
    cleanup(panner, now + 0.4, ctx);
  }

  /**
   * The love ping: a warm two-note call that carries much further than a
   * splash, so a sweetheart across the maze still hears it - just faintly.
   */
  lovePing(x: number, z: number, mine: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;
    const now = ctx.currentTime;
    // Your own call sits right on top of you; theirs falls away with distance.
    const panner = this.panner(x, z, mine ? 2 : 7, mine ? 18 : 110);
    if (!panner) return;
    panner.connect(this.master);

    // A rising "coo-ee" with a gentle vibrato, then a soft heart thump.
    const notes = [587.33, 880, 1174.66];
    notes.forEach((freq, i) => {
      const start = now + i * 0.17;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, start);
      osc.frequency.exponentialRampToValueAtTime(freq * 1.06, start + 0.22);

      const vibrato = ctx.createOscillator();
      vibrato.frequency.value = 5.5;
      const vibratoGain = ctx.createGain();
      vibratoGain.gain.value = freq * 0.012;
      vibrato.connect(vibratoGain).connect(osc.frequency);
      vibrato.start(start);
      vibrato.stop(start + 0.5);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(mine ? 0.16 : 0.2, start + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.46);
      osc.connect(gain).connect(panner);
      osc.start(start);
      osc.stop(start + 0.5);
    });

    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(120, now);
    thump.frequency.exponentialRampToValueAtTime(58, now + 0.26);
    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(0.0001, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.16, now + 0.03);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
    thump.connect(thumpGain).connect(panner);
    thump.start(now);
    thump.stop(now + 0.36);

    cleanup(panner, now + 1.2, ctx);
  }

  /** A short chirp for an emote, positioned at whoever played it. */
  emote(kind: string, x: number, z: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;
    const now = ctx.currentTime;
    const panner = this.panner(x, z, 4, 36);
    if (!panner) return;
    panner.connect(this.master);

    // Each feeling gets its own little motif.
    const motifs: Record<string, { notes: number[]; type: OscillatorType; step: number }> = {
      surprise: { notes: [520, 880], type: 'triangle', step: 0.09 },
      angry: { notes: [220, 175, 147], type: 'sawtooth', step: 0.1 },
      sad: { notes: [392, 330, 262], type: 'sine', step: 0.16 },
      scared: { notes: [660, 590, 660, 590], type: 'sine', step: 0.08 },
      scream: { notes: [1200, 900, 1400, 700], type: 'square', step: 0.07 },
      annoyed: { notes: [330, 294], type: 'sawtooth', step: 0.12 },
      love: { notes: [523, 659, 784], type: 'triangle', step: 0.11 },
      tease: { notes: [740, 494, 740, 494], type: 'square', step: 0.08 },
      heart: { notes: [659, 784, 988, 1175], type: 'triangle', step: 0.1 },
      kiss: { notes: [988, 1319], type: 'sine', step: 0.12 },
      blush: { notes: [440, 554, 659, 554], type: 'sine', step: 0.13 },
      wink: { notes: [880, 1175], type: 'triangle', step: 0.07 },
    };
    const motif = motifs[kind] ?? motifs.surprise;

    motif.notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = motif.type;
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      const start = now + i * motif.step;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.1, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + motif.step + 0.12);
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 2600;
      osc.connect(filter).connect(gain).connect(panner);
      osc.start(start);
      osc.stop(start + motif.step + 0.16);
    });

    cleanup(panner, now + 1.2, ctx);
  }

  /** Round-end stinger. */
  stinger(win: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;
    const now = ctx.currentTime;
    const notes = win ? [392, 523.25, 659.25, 783.99] : [392, 311.13, 261.63, 196];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = win ? 'triangle' : 'sawtooth';
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      const start = now + i * 0.13;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(win ? 0.18 : 0.13, start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.7);
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = win ? 2600 : 900;
      osc.connect(filter).connect(gain).connect(this.master!);
      osc.start(start);
      osc.stop(start + 0.75);
    });
  }

  /** Short UI blip. */
  blip(high = true): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = high ? 660 : 330;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.06, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    osc.connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + 0.14);
  }

  setMuted(value: boolean): void {
    this.muted = value;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(value ? 0 : 0.85, this.ctx.currentTime, 0.1);
    }
  }
}

function cleanup(node: AudioNode, when: number, ctx: AudioContext): void {
  const delay = Math.max(0, (when - ctx.currentTime) * 1000);
  window.setTimeout(() => node.disconnect(), delay + 60);
}
