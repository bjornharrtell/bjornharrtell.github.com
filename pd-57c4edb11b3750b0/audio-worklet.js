// AudioWorklet queue for the native PDxD music renderer.
// The main thread renders 48 kHz mono float blocks from the wasm core and posts them here.
class PDPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.current = null;
    this.offset = 0;
    this.needPosted = false;
    this.underruns = 0;
    this.callbacks = 0;
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === "pcm") {
        this.queue.push(event.data.samples);
        this.needPosted = false;
      }
    };
  }

  process(inputs, outputs) {
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;
    if (!this.current && this.queue.length === 0) this.underruns++;
    for (let i = 0; i < output.length; i++) {
      if (!this.current || this.offset >= this.current.length) {
        this.current = this.queue.shift() || null;
        this.offset = 0;
      }
      output[i] = this.current ? this.current[this.offset++] : 0;
    }
    if (!this.needPosted && this.queue.length < 2) {
      this.needPosted = true;
      this.port.postMessage({ type: "need", frames: 4800 });
    }
    this.callbacks++;
    if (this.callbacks % 64 === 0) {
      this.port.postMessage({ type: "stats", underruns: this.underruns });
    }
    return true;
  }
}

registerProcessor("pd-player", PDPlayer);
