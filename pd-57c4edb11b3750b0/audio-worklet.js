// AudioWorklet queue for the native PDxD music renderer (48 kHz mono).
const BLOCK_FRAMES = 960; // One 50 Hz music tick.
const TARGET_FRAMES = BLOCK_FRAMES * 3;
const LOW_WATER_FRAMES = BLOCK_FRAMES * 2;

class PDPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.current = null;
    this.offset = 0;
    this.queuedFrames = 0; // Includes the unconsumed part of current.
    this.maxQueuedFrames = 0;
    this.needPosted = false;
    this.readyPosted = false;
    this.started = false;
    this.startupFrames = 0;
    this.underruns = 0;
    this.missingFrames = 0;
    this.callbacks = 0;
    this.outputFrames = 0;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data?.type === "pcm" && data.samples instanceof Float32Array && data.samples.length) {
        this.queue.push(data.samples);
        this.queuedFrames += data.samples.length;
        this.maxQueuedFrames = Math.max(this.maxQueuedFrames, this.queuedFrames);
        this.needPosted = false;
        if (!this.readyPosted && this.queuedFrames >= TARGET_FRAMES) {
          this.readyPosted = true;
          this.port.postMessage({ type: "ready", queuedFrames: this.queuedFrames });
        }
        this.requestRefill();
      } else if (data?.type === "start") {
        this.started = true;
        this.requestRefill();
      }
    };
  }

  requestRefill() {
    if (this.started && !this.needPosted && this.queuedFrames <= LOW_WATER_FRAMES) {
      this.needPosted = true;
      this.port.postMessage({ type: "need", frames: BLOCK_FRAMES });
    }
  }

  process(inputs, outputs) {
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;
    let missing = 0;
    if (!this.started) {
      output.fill(0);
      this.startupFrames += output.length;
    } else {
      for (let i = 0; i < output.length; i++) {
        if (!this.current || this.offset >= this.current.length) {
          this.current = this.queue.shift() || null;
          this.offset = 0;
        }
        if (this.current) {
          output[i] = this.current[this.offset++];
          this.queuedFrames--;
        } else {
          output[i] = 0;
          missing++;
        }
      }
      // Count every active callback missing PCM, including a partial tail.
      if (missing) { this.underruns++; this.missingFrames += missing; }
      this.requestRefill();
    }
    this.callbacks++;
    this.outputFrames += output.length;
    if (this.callbacks % 64 === 0) {
      this.port.postMessage({ type: "stats", underruns: this.underruns,
        missingFrames: this.missingFrames, startupFrames: this.startupFrames,
        queuedFrames: this.queuedFrames, maxQueuedFrames: this.maxQueuedFrames,
        callbacks: this.callbacks, outputFrames: this.outputFrames, started: this.started });
    }
    return true;
  }
}

registerProcessor("pd-player", PDPlayer);
