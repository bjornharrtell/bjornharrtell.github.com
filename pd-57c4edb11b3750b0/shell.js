import { rasterPaletteRgb } from "./palette.mjs";

// Browser shell for the Pinball Dreams port core.
//
// The core is plain wasm32 with a C ABI (see core/src/ffi.rs), so this file needs no
// wasm-bindgen: instantiate, call pd_core_tick, and upload the indexed framebuffer.
//
// D7:320x542 full-table indices, displayed at2x with scanlines; simulation stays original.
// plus32 table and5 raster palette words. One palette-LUT texture converts indices to RGB in the fragment
// shader, so palette effects stay exact and the whole frame costs two uploads.

const CORE_URL = new URL("./pd_core.wasm", import.meta.url);

const WIDTH = 320;
const HEIGHT = 542;

const MOBILE_LAYOUT = matchMedia("(max-width: 720px), (pointer: coarse)");
const LONG_PRESS_MS = 450;

// M6 spike: Nightmare is the source-recovered table; the three preview packs are
// geometry/feature extracts built from the other modules with tools/build_pack.py.
const TABLES = [
  { id: "ignition", name: "Ignition", pack: "./table_a.pack.bin", full: false },
  { id: "steel-wheel", name: "Steel Wheel", pack: "./table_b.pack.bin", full: false },
  { id: "beat-box", name: "Beat Box", pack: "./table_c.pack.bin", full: false },
  { id: "nightmare", name: "Nightmare", pack: "./table.pack.bin", full: true },
];
let tableReady = false;

const canvas = document.getElementById("screen");
const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
if (gl) gl.disable(gl.DITHER); // Keep2x pixel pairs and scanline brightness deterministic.
if (!gl) throw new Error("WebGL2 is required");

const tableSelectEl = document.getElementById("table-select");
const selectStatusEl = document.getElementById("select-status");
const tablesBtn = document.getElementById("tables");
const framesEl = document.getElementById("frames");
const hashEl = document.getElementById("hash");
const fpsEl = document.getElementById("fps");
const runBtn = document.getElementById("run");
const stepBtn = document.getElementById("step");

// ---- input bits, matching core/src/sim.rs ----
const FLIP_LEFT = 1 << 0;
const FLIP_RIGHT = 1 << 1;
const NUDGE_LEFT = 1 << 2;
const NUDGE_RIGHT = 1 << 3;
const LAUNCH = 1 << 4;

const keys = new Set();
const KEYMAP = new Map([
  ["ShiftLeft", FLIP_LEFT], ["ArrowLeft", FLIP_LEFT],
  ["ShiftRight", FLIP_RIGHT], ["ArrowRight", FLIP_RIGHT],
  ["KeyA", NUDGE_LEFT], ["KeyD", NUDGE_RIGHT],
  ["Space", LAUNCH], ["ArrowUp", LAUNCH],
]);

let running = true;

addEventListener("keydown", (e) => {
  void ensureAudio();
  if (e.code === "KeyP") { toggle(); return; }
  if (KEYMAP.has(e.code)) { keys.add(KEYMAP.get(e.code)); e.preventDefault(); }
});
addEventListener("keyup", (e) => {
  if (KEYMAP.has(e.code)) { keys.delete(KEYMAP.get(e.code)); e.preventDefault(); }
});

// Touch zones: the left and right halves of the screen are the flipper triggers. Holding
// either side for LONG_PRESS_MS also pulls the plunger; releasing launches the ball.
const touchPointers = new Map();

function clearTouchPointers() {
  for (const pointer of touchPointers.values()) clearTimeout(pointer.timer);
  touchPointers.clear();
}

canvas.addEventListener("pointerdown", (e) => {
  if (!MOBILE_LAYOUT.matches || (e.pointerType === "mouse" && e.button !== 0)) return;
  e.preventDefault();
  // On iOS this is not an activation event for touch, but it lets Android resume
  // immediately. The pointerup handler below performs the full start.
  unlockAudio();
  const pointer = {
    bit: e.clientX < innerWidth / 2 ? FLIP_LEFT : FLIP_RIGHT,
    launch: false,
    timer: 0,
  };
  pointer.timer = setTimeout(() => { pointer.launch = true; }, LONG_PRESS_MS);
  touchPointers.set(e.pointerId, pointer);
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
});

function releaseTouch(e) {
  unlockAudio();
  void ensureAudio();
  const pointer = touchPointers.get(e.pointerId);
  if (!pointer) return;
  e.preventDefault();
  clearTimeout(pointer.timer);
  touchPointers.delete(e.pointerId);
}

canvas.addEventListener("pointerup", releaseTouch);
canvas.addEventListener("pointercancel", releaseTouch);
canvas.addEventListener("lostpointercapture", releaseTouch);
canvas.addEventListener("touchend", () => { void ensureAudio(); }, { passive: true });
document.addEventListener("click", () => { unlockAudio(); });
canvas.addEventListener("contextmenu", (e) => {
  if (MOBILE_LAYOUT.matches) e.preventDefault();
});

addEventListener("blur", () => { keys.clear(); clearTouchPointers(); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { keys.clear(); clearTouchPointers(); }
  else unlockAudio();
});

runBtn.addEventListener("click", toggle);
stepBtn.addEventListener("click", () => { running = false; runBtn.textContent = "Resume"; renderOnce(); });
tablesBtn.addEventListener("click", () => { location.href = location.pathname; });

function toggle() {
  running = !running;
  runBtn.textContent = running ? "Pause" : "Resume";
}

function inputBits() {
  let bits = 0;
  for (const bit of keys) bits |= bit;
  for (const pointer of touchPointers.values()) {
    bits |= pointer.bit;
    if (pointer.launch) bits |= LAUNCH;
  }
  return bits;
}

// ---- GL setup ----
const vertexShader = `#version 300 es
void main() {
  // Fullscreen triangle; texcoords derived from position.
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const fragmentShader = `#version 300 es
precision highp float;
const float SOURCE_ROWS = 542.0;
uniform sampler2D indices;   //320x542, nearest-neighbour at2x
uniform sampler2D palette;   //69x1 RGB (32base+32EHB+5header/separator)
uniform vec2 tableOrigin;    // bottom-left of the table in framebuffer pixels
uniform vec2 tableSize;      // displayed table size in framebuffer pixels
uniform float scanlineFactor; // 0.65 for desktop D7; 1.0 disables on mobile
out vec4 colour;
void main() {
  vec2 p = gl_FragCoord.xy - tableOrigin;
  if (p.x < 0.0 || p.y < 0.0 || p.x >= tableSize.x || p.y >= tableSize.y) {
    colour = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  // Flip Y: GL textures start bottom-left, the Amiga framebuffer starts top-left.
  vec2 uv = vec2(p.x / tableSize.x, 1.0 - p.y / tableSize.y);
  float index = floor(texture(indices, uv).r * 255.0);
  vec3 rgb = texture(palette, vec2((index + 0.5) / 69.0, 0.5)).rgb;
  // Desktop keeps the D7 scanline pattern. Phones disable it: at whole-pixel mobile scales
  // the lines are sub-pixel at normal viewing distance and only muddy the original artwork.
  float scale = tableSize.y / SOURCE_ROWS;
  float scanline = 1.0;
  if (scanlineFactor < 1.0 && scale >= 1.0) {
    float darkLines = max(1.0, floor(scale * 0.5));
    scanline = mod(p.y, scale) < darkLines ? scanlineFactor : 1.0;
  }
  colour = vec4(rgb * scanline, 1.0);
}`;

function compile(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader));
  }
  return shader;
}

const program = gl.createProgram();
gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexShader));
gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentShader));
gl.linkProgram(program);
if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
  throw new Error(gl.getProgramInfoLog(program));
}
gl.useProgram(program);

const indexTex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, indexTex);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

const paletteTex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, paletteTex);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 64, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array(64 * 3));

gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
gl.uniform1i(gl.getUniformLocation(program, "indices"), 0);
gl.uniform1i(gl.getUniformLocation(program, "palette"), 1);
const tableOriginLoc = gl.getUniformLocation(program, "tableOrigin");
const tableSizeLoc = gl.getUniformLocation(program, "tableSize");
const scanlineLoc = gl.getUniformLocation(program, "scanlineFactor");

// On phones the canvas covers the viewport's physical pixel grid, but the table itself is
// drawn at the largest whole-pixel scale that fits. Every original pixel becomes a square
// integer block instead of some 3-pixel and some 4-pixel columns. The remaining viewport
// stays black; scanlines then run on the physical even/odd rows of those integer blocks.
function layoutCanvas() {
  const mobile = MOBILE_LAYOUT.matches;
  const cssWidth = canvas.clientWidth || window.innerWidth;
  const cssHeight = canvas.clientHeight || window.innerHeight;
  const pixelRatio = mobile ? (window.devicePixelRatio || 1) : 1;
  const pixelWidth = mobile ? Math.max(1, Math.round(cssWidth * pixelRatio)) : 640;
  const pixelHeight = mobile ? Math.max(1, Math.round(cssHeight * pixelRatio)) : 1084;

  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  let tableWidth = pixelWidth;
  let tableHeight = pixelHeight;
  if (mobile) {
    const fit = Math.min(pixelWidth / WIDTH, pixelHeight / HEIGHT);
    const scale = fit >= 1 ? Math.floor(fit) : fit;
    tableWidth = Math.max(1, Math.round(WIDTH * scale));
    tableHeight = Math.max(1, Math.round(HEIGHT * scale));
  }

  gl.uniform2f(tableOriginLoc,
    Math.floor((pixelWidth - tableWidth) / 2),
    Math.floor((pixelHeight - tableHeight) / 2));
  gl.uniform2f(tableSizeLoc, tableWidth, tableHeight);
  gl.uniform1f(scanlineLoc, mobile ? 1.0 : 0.65);
}

layoutCanvas();
addEventListener("resize", () => { layoutCanvas(); draw(); });
if (window.visualViewport) {
  visualViewport.addEventListener("resize", () => { layoutCanvas(); draw(); });
}

// ---- core ----
async function instantiateCore() {
  const response = await fetch(CORE_URL);
  const bytes = await response.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance;
}

const instance = await instantiateCore();

const api = instance.exports;

if (api.pd_core_pixels_len() !== WIDTH * HEIGHT) {
  throw new Error("core framebuffer size mismatch");
}
if (api.pd_core_palette_len() !== 37) {
  throw new Error("core palette size mismatch");
}
if (api.pd_core_tick_hz() !== 50) {
  throw new Error("core tick rate mismatch: " + api.pd_core_tick_hz());
}

const core = api.pd_core_new();
const memory = () => new Uint8Array(api.memory.buffer);

// ---- native music ----
// The wasm core renders the recovered 50 Hz player into 48 kHz float blocks. An
// AudioWorklet owns the output clock; the main thread only fills its queue.
let audioContext = null;
let audioPrepare = null;
let audioNode = null;
let audioStarting = false;
const AUDIO_BLOCK_FRAMES = 960;
const AUDIO_READY_TIMEOUT_MS = 5000;
const AUDIO_WORKLET_URL = new URL("./audio-worklet.js?v=20261024-mobile-audio", import.meta.url);
const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
const audioUnderrunsEl = document.getElementById("audio-underruns");

function pumpAudio(frames) {
  if (!audioNode) return;
  const count = api.pd_core_audio_render(core, Math.min(frames, api.pd_core_audio_buffer_len()));
  if (count === 0) return;
  const ptr = api.pd_core_audio_buffer(core);
  const samples = new Float32Array(api.memory.buffer, ptr, count).slice();
  audioNode.port.postMessage({ type: "pcm", samples }, [samples.buffer]);
}

// Load the worklet module before the first gesture. iOS Safari will not create an
// AudioWorkletNode after an awaited module load, even if the pointer event itself was
// a user gesture.
function prepareAudio() {
  if (audioPrepare) return audioPrepare;
  audioPrepare = (async () => {
    if (!AudioContextCtor) throw new Error("Web Audio is not available");
    try {
      audioContext = new AudioContextCtor({ sampleRate: 48000 });
    } catch (error) {
      // Some phones only expose their native hardware rate.
      audioContext = new AudioContextCtor();
    }
    await audioContext.audioWorklet.addModule(AUDIO_WORKLET_URL);
  })();
  audioPrepare.catch(() => {
    audioPrepare = null;
    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }
  });
  return audioPrepare;
}

// Call synchronously from a qualifying gesture. iOS treats pointerdown as activation
// only for a mouse; touch activation happens on pointerup/touchend/click.
function unlockAudio() {
  void prepareAudio().catch(() => {});
  if (audioContext && audioContext.state !== "running") {
    audioContext.resume().catch(() => {});
  }
}

async function ensureAudio() {
  unlockAudio();
  // The selection screen can be clicked before a pack exists; do not prime an empty mixer.
  if (!tableReady) return;
  if (audioStarting) return;
  audioStarting = true;
  let readyTimeout = null;
  try {
    await prepareAudio();
    if (audioContext.state !== "running") await audioContext.resume();
    if (audioNode) return;
    audioNode = new AudioWorkletNode(audioContext, "pd-player");
    const ready = new Promise((resolve, reject) => {
      readyTimeout = setTimeout(() => reject(new Error("audio worklet priming timed out")), AUDIO_READY_TIMEOUT_MS);
      audioNode.onprocessorerror = () => {
        clearTimeout(readyTimeout);
        reject(new Error("audio worklet processor failed"));
      };
      audioNode.port.onmessage = (event) => {
        if (!event.data) return;
        if (event.data.type === "ready") {
          clearTimeout(readyTimeout);
          resolve();
        } else if (event.data.type === "need") pumpAudio(event.data.frames);
        else if (event.data.type === "stats" && audioUnderrunsEl) {
          audioUnderrunsEl.textContent = String(event.data.underruns);
        }
      };
    });
    // Connect before priming so the processor is running on every engine. It outputs
    // silence until the start message, so this does not create an audible underrun.
    audioNode.connect(audioContext.destination);
    for (let i = 0; i < 3; i++) pumpAudio(AUDIO_BLOCK_FRAMES);
    await ready;
    audioNode.port.postMessage({ type: "start" });
  } catch (error) {
    if (audioNode) {
      audioNode.port.onmessage = null;
      audioNode.onprocessorerror = null;
      audioNode.disconnect();
      audioNode = null;
    }
    if (audioContext) {
      await audioContext.close().catch(() => {});
      audioContext = null;
    }
    audioPrepare = null;
    console.warn("music unavailable", error);
  } finally {
    clearTimeout(readyTimeout);
    audioStarting = false;
  }
}

// Start loading while the page is idle; the context stays suspended until a gesture.
void prepareAudio().catch(() => {});

// Playfield data: the user's own disks, converted by tools/playfield.py. Nothing is bundled in git,
// but if web/playfield.bin exists it is picked up automatically, so the page is ready to run.
const pfInput = document.getElementById("pf");
const SCRATCH_LEN = api.pd_core_scratch_len();

function commitPlayfield(bytes) {
  const ptr = api.pd_core_scratch(core);
  memory().set(bytes, ptr);
  if (!api.pd_core_commit_playfield(core, bytes.length)) return false;
  tableReady = true;
  api.pd_core_render(core);
  upload();
  draw();
  return true;
}

let selectBusy = false;

const PREVIEW_COLOURS = {
  ignition: [255, 123, 82],
  "steel-wheel": [112, 184, 232],
  "beat-box": [217, 146, 255],
  nightmare: [159, 224, 112],
};

function findChunk(bytes, magic) {
  const match = (at) => {
    if (at + 8 > bytes.length) return false;
    for (let i = 0; i < 4; i++) if (bytes[at + i] !== magic.charCodeAt(i)) return false;
    return true;
  };
  for (let at = 12; at + 8 <= bytes.length; at++) {
    if (!match(at)) continue;
    if (magic === "DISP") {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const width = view.getUint16(at + 4);
      const rows = view.getUint16(at + 6);
      const planes = view.getUint16(at + 8);
      const rowBytes = view.getUint16(at + 10);
      const length = view.getUint32(at + 12);
      if (width !== WIDTH || planes !== 6 || rowBytes !== 40 || length !== rows * 240) continue;
      if (at + 16 + length > bytes.length) continue;
      return { rows, start: at + 16 };
    }
    if (magic === "PALX") {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const length = view.getUint32(at + 4);
      if (length !== 64 || at + 8 + length > bytes.length) continue;
      const palette = new Uint16Array(32);
      for (let i = 0; i < 32; i++) palette[i] = view.getUint16(at + 8 + i * 2);
      return palette;
    }
  }
  return null;
}

function paintPackPreview(button, bytes, colour) {
  if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(0, 4)) !== "PDTB") return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const preview = document.createElement("canvas");
  preview.className = "preview";
  preview.width = 128;
  preview.height = 208;
  const context = preview.getContext("2d");
  const image = context.createImageData(preview.width, preview.height);
  const display = findChunk(bytes, "DISP");
  const palette = findChunk(bytes, "PALX");
  if (display && palette) {
    for (let py = 0; py < preview.height; py++) {
      const y = Math.floor(py * display.rows / preview.height);
      for (let px = 0; px < preview.width; px++) {
        const x = Math.floor(px * WIDTH / preview.width);
        const row = display.start + y * 240;
        let index = 0;
        for (let plane = 0; plane < 6; plane++) {
          const byte = bytes[row + plane * 40 + (x >> 3)];
          index |= ((byte >> (7 - (x & 7))) & 1) << plane;
        }
        const word = palette[index & 31];
        const half = index >= 32 ? 0.5 : 1;
        const pixel = (py * preview.width + px) * 4;
        image.data[pixel] = Math.floor(((word >> 8) & 15) * 17 * half);
        image.data[pixel + 1] = Math.floor(((word >> 4) & 15) * 17 * half);
        image.data[pixel + 2] = Math.floor((word & 15) * 17 * half);
        image.data[pixel + 3] = 255;
      }
    }
  } else {
    const planeLength = view.getUint32(4);
    if (!planeLength || planeLength % 120) return;
    const rows = planeLength / 120;
    for (let py = 0; py < preview.height; py++) {
      const y = Math.floor(py * rows / preview.height);
      for (let px = 0; px < preview.width; px++) {
        const x = Math.floor(px * WIDTH / preview.width);
        const at = 12 + y * 120 + (x >> 3);
        const bit = 0x80 >> (x & 7);
        const value = ((bytes[at] & bit) ? 1 : 0) |
          ((bytes[at + 40] & bit) ? 2 : 0) |
          ((bytes[at + 80] & bit) ? 4 : 0);
        const pixel = (py * preview.width + px) * 4;
        if (value & 3) {
          image.data[pixel] = colour[0];
          image.data[pixel + 1] = colour[1];
          image.data[pixel + 2] = colour[2];
          image.data[pixel + 3] = 255;
        } else if (value & 4) {
          image.data[pixel] = colour[0] >> 1;
          image.data[pixel + 1] = colour[1] >> 1;
          image.data[pixel + 2] = colour[2] >> 1;
          image.data[pixel + 3] = 255;
        }
      }
    }
  }
  context.putImageData(image, 0, 0);
  button.prepend(preview);
}

async function loadPreviews() {
  await Promise.allSettled(TABLES.map(async (table) => {
    const button = tableSelectEl.querySelector(`[data-table="${table.id}"]`);
    if (!button) return;
    const response = await fetch(table.pack);
    if (!response.ok) return;
    const bytes = new Uint8Array(await response.arrayBuffer());
    paintPackPreview(button, bytes, PREVIEW_COLOURS[table.id]);
  }));
}

function resetClock() {
  tickAccumulator = 0;
  last = performance.now();
  frames = 0;
  fpsWindowStart = last;
  fpsFrames = 0;
  framesEl.textContent = "0";
  fpsEl.textContent = "0";
  hashEl.textContent = "—";
}

function enterGame(title) {
  document.body.classList.add("playing");
  running = true;
  runBtn.textContent = "Pause";
  document.title = `${title} — Pinball Dreams preview`;
  resetClock();
  layoutCanvas();
  api.pd_core_render(core);
  upload();
  draw();
  startGameLoop();
  void ensureAudio();
}

async function selectTable(id, updateUrl = true) {
  const table = TABLES.find((candidate) => candidate.id === id);
  if (!table || selectBusy) return;
  selectBusy = true;
  for (const button of tableSelectEl.querySelectorAll("[data-table]")) button.disabled = true;
  selectStatusEl.textContent = `Loading ${table.name}…`;
  try {
    const response = await fetch(table.pack);
    if (!response.ok) throw new Error(`pack not built (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!commitPlayfield(bytes)) throw new Error("pack rejected by the core");
    if (updateUrl) history.replaceState(null, "", `?table=${encodeURIComponent(table.id)}`);
    document.getElementById("pfnote").textContent = table.full
      ? "optional replacement for Nightmare"
      : `${table.name} is a geometry/feature preview; artwork and rules are not recovered`;
    enterGame(table.name);
  } catch (error) {
    selectStatusEl.textContent = `${table.name}: ${error.message}. ` +
      "Build this pack with tools/build_pack.py and place it beside shell.js.";
    console.warn("table load failed", error);
  } finally {
    selectBusy = false;
    for (const button of tableSelectEl.querySelectorAll("[data-table]")) button.disabled = false;
  }
}

pfInput.addEventListener("change", async () => {
  const file = pfInput.files && pfInput.files[0];
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!commitPlayfield(bytes)) {
    alert(`could not load ${file.name} (${bytes.length} bytes).\n` +
          "Expected a table pack from tools/build_pack.py or a raw 62,400-byte playfield.");
  } else {
    enterGame(file.name.replace(/\.pack\.bin$|\.bin$/i, ""));
  }
});

function frameBytes() {
  const ptr = api.pd_core_pixels(core);
  return memory().subarray(ptr, ptr + WIDTH * HEIGHT);
}

function paletteBytes() {
  return rasterPaletteRgb(api.memory.buffer, api.pd_core_palette(core));
}

// ---- frame loop ----
// The core advances one tick per call; the display refresh drives how many ticks happen.
// A PAL frame is 50 Hz, so on a 60 Hz display some frames run zero ticks and others one.
const TICK_MS = 1000 / 50;
let tickAccumulator = 0;
let last = performance.now();
let frames = 0;
let fpsWindowStart = last;
let fpsFrames = 0;
let loopStarted = false;

function startGameLoop() {
  if (loopStarted) return;
  loopStarted = true;
  requestAnimationFrame(loop);
}

function updateGameStatus() {
  document.getElementById("score").textContent = api.pd_core_score(core).toString().padStart(12, "0");
  document.getElementById("ball").textContent = String(api.pd_core_ball_number(core));
  const state = api.pd_core_state(core);
  document.getElementById("game-state").textContent = (state === 5 || state === 10) && !api.pd_core_launch_ready(core)
    ? "Preparing the next ball" : ({
    5: "Hold Space to pull, release to launch", 10: "Hold Space to pull, release to relaunch", 1: "In play",
    2: "Ball out", 3: "Game over — press Space to restart", 6: "Starting a new game",
  })[state] ?? "Load a table";
  document.getElementById("charge").value = -api.pd_core_charge(core);
}

function upload() {
  updateGameStatus();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, indexTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, WIDTH, HEIGHT, 0, gl.RED, gl.UNSIGNED_BYTE, frameBytes());

  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, paletteTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 69, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, paletteBytes());
}

function draw() {
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function renderOnce() {
  api.pd_core_tick(core, inputBits());
  api.pd_core_render(core);
  upload();
  draw();
  frames += 1;
  framesEl.textContent = String(frames);
  hashEl.textContent = BigInt.asUintN(64, api.pd_core_frame_hash(core)).toString(16);
}

function loop(now) {
  if (!running) {
    last = now;
    tickAccumulator = 0;
    requestAnimationFrame(loop);
    return;
  }
  const elapsed = now - last;
  last = now;
  tickAccumulator += elapsed;

  let ticks = 0;
  while (tickAccumulator >= TICK_MS && ticks < 4) {
    tickAccumulator -= TICK_MS;
    api.pd_core_tick(core, inputBits());
    ticks += 1;
  }
  if (ticks > 0) {
    api.pd_core_render(core);
    upload();
    draw();
    frames += ticks;
    framesEl.textContent = String(frames);
    hashEl.textContent = BigInt.asUintN(64, api.pd_core_frame_hash(core)).toString(16);
  }

  fpsFrames += 1;
  if (now - fpsWindowStart >= 500) {
    fpsEl.textContent = String(Math.round((fpsFrames * 1000) / (now - fpsWindowStart)));
    fpsFrames = 0;
    fpsWindowStart = now;
  }
  requestAnimationFrame(loop);
}

for (const button of tableSelectEl.querySelectorAll("[data-table]")) {
  button.addEventListener("click", () => { void selectTable(button.dataset.table); });
}

void loadPreviews();

const requestedTable = new URLSearchParams(location.search).get("table");
if (requestedTable) {
  void selectTable(requestedTable, false);
} else {
  selectStatusEl.textContent = "Select a table to load its pack.";
}
