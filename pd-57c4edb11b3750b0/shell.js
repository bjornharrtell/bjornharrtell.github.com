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

// Table packs by the chooser's F1..F4 order. Nightmare is the source-recovered table; the other
// three are geometry/feature extracts built from their modules with tools/build_pack.py.
const TABLES = [
  { id: "ignition", name: "Ignition", pack: "./table_a.pack.bin", full: false },
  { id: "steel-wheel", name: "Steel Wheel", pack: "./table_b.pack.bin", full: false },
  { id: "beat-box", name: "Beat Box", pack: "./table_c.pack.bin", full: false },
  { id: "nightmare", name: "Nightmare", pack: "./table.pack.bin", full: true },
];
let tableReady = false;

// The original chooser (recovered `SELC` module, see docs/spec/table-select.md) is a native screen
// of the core: 320x254 RGB, 50 Hz, acting on Amiga raw key releases.
const SELECT_PACK = "./select.pack.bin";
let mode = "loading"; // "select" | "game"
let selectCore = 0;
let selectReady = false;
let selectBytes = null; // the select pack, with the saved hall of fame patched in
let fameAt = -1;        // offset of its 192-byte `FAME` block (four tables x four entries x 12 bytes)
let hallTable = -1;     // index into TABLES of the table in play, for saving its list
const FAME_KEY = "pd.hall-of-fame.v1";
let selectWidth = 320;
let selectHeight = 254;

const canvas = document.getElementById("screen");
const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
if (gl) gl.disable(gl.DITHER); // Keep2x pixel pairs and scanline brightness deterministic.
if (!gl) throw new Error("WebGL2 is required");

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

const PLAYER_KEYS = new Map([
  ["F1", 0x50], ["F2", 0x51], ["F3", 0x52], ["F4", 0x53], ["F5", 0x54], ["F6", 0x55], ["F7", 0x56], ["F8", 0x57],
  ["Enter", 0x43],
]);

// Amiga raw key codes the select screen understands: F1-F4 choose, Space flips to the hall of
// fame, and the letters/digits feed its hidden-message sequences.
const AMIGA_RAW = new Map([
  ["F1", 0x50], ["F2", 0x51], ["F3", 0x52], ["F4", 0x53], ["Space", 0x40],
  ["Digit1", 0x01], ["Digit2", 0x02], ["Digit3", 0x03], ["Digit4", 0x04], ["Digit5", 0x05],
  ["Digit6", 0x06], ["Digit7", 0x07], ["Digit8", 0x08], ["Digit9", 0x09], ["Digit0", 0x0A],
  ["KeyQ", 0x10], ["KeyW", 0x11], ["KeyE", 0x12], ["KeyR", 0x13], ["KeyT", 0x14],
  ["KeyY", 0x15], ["KeyU", 0x16], ["KeyI", 0x17], ["KeyO", 0x18], ["KeyP", 0x19],
  ["KeyA", 0x20], ["KeyS", 0x21], ["KeyD", 0x22], ["KeyF", 0x23], ["KeyG", 0x24],
  ["KeyH", 0x25], ["KeyJ", 0x26], ["KeyK", 0x27], ["KeyL", 0x28],
  ["KeyZ", 0x31], ["KeyX", 0x32], ["KeyC", 0x33], ["KeyV", 0x34], ["KeyB", 0x35],
  ["KeyN", 0x36], ["KeyM", 0x37],
]);
const selectKeysDown = new Set();

function selectKey(code, release) {
  if (selectCore && selectReady) api.pd_select_key(selectCore, code, release ? 1 : 0);
}

addEventListener("keydown", (e) => {
  void ensureAudio();
  if (mode === "select") {
    const raw = AMIGA_RAW.get(e.code);
    if (raw !== undefined && !e.repeat) {
      selectKeysDown.add(e.code);
      selectKey(raw, false);
    }
    if (raw !== undefined) e.preventDefault();
    return;
  }
  if (api.pd_core_name_active(core)) {
    // `$741E` while initials are typed: letters, digits and Space enter, Backspace erases.
    const raw = e.code === "Backspace" ? 0x41 : AMIGA_RAW.get(e.code);
    if (raw !== undefined && !e.repeat && !e.code.startsWith("F")) api.pd_core_name_key(core, raw);
    e.preventDefault();
    return;
  }
  if (e.code === "KeyP") { toggle(); return; }
  // The table module's `$741E`: F1-F8 set the number of players, Enter adds one (before the first shot).
  const playerKey = PLAYER_KEYS.get(e.code);
  if (playerKey !== undefined && core && !e.repeat) { api.pd_core_player_key(core, playerKey); e.preventDefault(); return; }
  if (KEYMAP.has(e.code)) { keys.add(KEYMAP.get(e.code)); e.preventDefault(); }
});
addEventListener("keyup", (e) => {
  if (mode === "select") {
    const raw = AMIGA_RAW.get(e.code);
    if (raw !== undefined && selectKeysDown.delete(e.code)) selectKey(raw, true);
    if (raw !== undefined) e.preventDefault();
    return;
  }
  if (KEYMAP.has(e.code)) { keys.delete(KEYMAP.get(e.code)); e.preventDefault(); }
});

// Touch zones: the left and right halves of the screen are the flipper triggers. Holding
// either side for LONG_PRESS_MS also pulls the plunger; releasing launches the ball.
const touchPointers = new Map();

function clearTouchPointers() {
  for (const pointer of touchPointers.values()) clearTimeout(pointer.timer);
  touchPointers.clear();
}

// A tap on a banner is the matching F-key; a tap on the hall of fame is Space. Banner rows are
// the original copper bands: lines $2C-$65, $67-$A0, $A2-$DB and $DD-$116 (window starts at $2C).
const BANNER_ROWS = [[0, 58], [59, 117], [118, 176], [177, 235]];

function tapSelect(e) {
  const rect = canvas.getBoundingClientRect();
  const layout = tableRect();
  const px = ((e.clientX - rect.left) / rect.width) * canvas.width - layout.x;
  const py = canvas.height - ((e.clientY - rect.top) / rect.height) * canvas.height - layout.y;
  if (px < 0 || py < 0 || px >= layout.w || py >= layout.h) return;
  const row = Math.floor(((layout.h - py) / layout.h) * selectHeight); // py counts up from the bottom of the picture
  const banner = BANNER_ROWS.findIndex(([from, to]) => row >= from && row < to);
  // F-keys are raw $50-$53 on a banner; anywhere else Space ($40) flips the page.
  const raw = banner >= 0 ? 0x50 + banner : 0x40;
  // The chooser acts on the key release it sees one frame later; hold the key for a few frames like a finger would.
  selectKey(raw, false);
  setTimeout(() => selectKey(raw, true), 120);
}

canvas.addEventListener("pointerdown", (e) => {
  if (mode === "select") {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    unlockAudio();
    tapSelect(e);
    return;
  }
  if (!MOBILE_LAYOUT.matches || (e.pointerType === "mouse" && e.button !== 0)) return;
  e.preventDefault();
  // On iOS this is not an activation event for touch, but it lets Android resume
  // immediately. The pointerup handler below performs the full start.
  unlockAudio();
  const pointer = {
    startX: e.clientX, startY: e.clientY, startTime: performance.now(),
    bit: e.clientX < innerWidth / 2 ? FLIP_LEFT : FLIP_RIGHT,
    launch: false,
    timer: 0,
  };
  pointer.timer = setTimeout(() => { pointer.launch = true; }, LONG_PRESS_MS);
  touchPointers.set(e.pointerId, pointer);
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
});

// A quick flick up the screen (at least a tenth of its height within a fifth of a second) nudges the table.
function flickCheck(e) {
  const pointer = touchPointers.get(e.pointerId);
  if (!pointer || e.type !== "pointerup") return;
  const rise = pointer.startY - e.clientY;
  if (rise > innerHeight * 0.1 && performance.now() - pointer.startTime < 200 && Math.abs(e.clientX - pointer.startX) < rise) pulseNudge();
}

function releaseTouch(e) {
  flickCheck(e);
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
// Browsers only allow sound after a gesture; the first one of any kind starts the music.
for (const type of ["pointerdown", "touchend", "click", "keydown"]) addEventListener(type, () => { void ensureAudio(); }, { passive: true });
document.addEventListener("click", () => { unlockAudio(); });
canvas.addEventListener("contextmenu", (e) => {
  if (MOBILE_LAYOUT.matches) e.preventDefault();
});

addEventListener("blur", () => { keys.clear(); clearTouchPointers(); });
// Leaving the tab pauses the game and the music; coming back resumes both from where they stopped. The clock is
// reset so the time spent away is not played back as catch-up ticks.
let autoPaused = false;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    keys.clear(); clearTouchPointers();
    if (running) { running = false; autoPaused = true; runBtn.textContent = "Resume"; }
    if (audioContext && audioContext.state === "running") audioContext.suspend().catch(() => {});
  } else {
    tickAccumulator = 0;
    last = performance.now();
    if (autoPaused) { running = true; autoPaused = false; runBtn.textContent = "Pause"; }
    unlockAudio();
    void ensureAudio();
  }
});

runBtn.addEventListener("click", toggle);
stepBtn.addEventListener("click", () => { if (mode !== "game") return; running = false; runBtn.textContent = "Resume"; renderOnce(); });
tablesBtn.addEventListener("click", () => { location.href = location.pathname; });

function toggle() {
  if (mode !== "game") return;
  running = !running;
  runBtn.textContent = running ? "Pause" : "Resume";
}

// Phone nudges (a quick flick up the screen) are short pulses of the nudge key: a few ticks down, then up.
let nudgePulse = 0;
const NUDGE_PULSE_TICKS = 6;
function pulseNudge() { nudgePulse = NUDGE_PULSE_TICKS; }

function inputBits() {
  let bits = nudgePulse > 0 ? NUDGE_LEFT : 0;
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
uniform float sourceRows;     // 542 for a table, 254 for the select screen
uniform int rgbMode;          // 1: the select screen supplies RGB, not palette indices
uniform sampler2D rgbTex;
uniform sampler2D indices;   //320x542, nearest-neighbour at2x
uniform sampler2D palette;   //69x1 RGB (32base+32EHB+5header/separator)
uniform vec2 tableOrigin;    // bottom-left of the table in framebuffer pixels
uniform vec2 tableSize;      // displayed table size in framebuffer pixels
uniform float scanlineFactor; // 0.65 desktop D7, 0.75 mobile; 1.0 disables
out vec4 colour;
void main() {
  vec2 p = gl_FragCoord.xy - tableOrigin;
  if (p.x < 0.0 || p.y < 0.0 || p.x >= tableSize.x || p.y >= tableSize.y) {
    colour = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  // Flip Y: GL textures start bottom-left, the Amiga framebuffer starts top-left.
  vec2 uv = vec2(p.x / tableSize.x, 1.0 - p.y / tableSize.y);
  vec3 rgb;
  if (rgbMode == 1) {
    rgb = texture(rgbTex, uv).rgb;
  } else {
    float index = floor(texture(indices, uv).r * 255.0);
    rgb = texture(palette, vec2((index + 0.5) / 69.0, 0.5)).rgb;
  }
  // Scanlines everywhere. At two or more physical pixels per source row they are whole dark rows (the D7 pattern);
  // below that, as on a phone, the same darkening is a smooth wave with one period per source row.
  float scale = tableSize.y / sourceRows;
  float scanline = 1.0;
  if (scanlineFactor < 1.0 && scale > 0.0) {
    if (scale >= 2.0) {
      float darkLines = max(1.0, floor(scale * 0.5));
      scanline = mod(p.y, scale) < darkLines ? scanlineFactor : 1.0;
    } else {
      float wave = 0.5 + 0.5 * cos(6.2831853 * p.y / scale);
      scanline = mix(scanlineFactor, 1.0, wave);
    }
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

const rgbTex = gl.createTexture();
gl.activeTexture(gl.TEXTURE2);
gl.bindTexture(gl.TEXTURE_2D, rgbTex);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
gl.activeTexture(gl.TEXTURE0);

gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
gl.uniform1i(gl.getUniformLocation(program, "indices"), 0);
gl.uniform1i(gl.getUniformLocation(program, "rgbTex"), 2);
gl.uniform1i(gl.getUniformLocation(program, "palette"), 1);
const tableOriginLoc = gl.getUniformLocation(program, "tableOrigin");
const tableSizeLoc = gl.getUniformLocation(program, "tableSize");
const scanlineLoc = gl.getUniformLocation(program, "scanlineFactor");
const sourceRowsLoc = gl.getUniformLocation(program, "sourceRows");
const rgbModeLoc = gl.getUniformLocation(program, "rgbMode");

// On phones the canvas covers the viewport's physical pixel grid, but the table itself is
// drawn at the largest whole-pixel scale that fits. Every original pixel becomes a square
// integer block instead of some 3-pixel and some 4-pixel columns. The remaining viewport
// stays black; scanlines then run on the physical even/odd rows of those integer blocks.
function sourceSize() {
  return mode === "select" ? [selectWidth, selectHeight] : [WIDTH, HEIGHT];
}

// Where the picture sits inside the canvas, in GL framebuffer pixels (origin bottom-left).
function tableRect() {
  const [srcW, srcH] = sourceSize();
  const mobile = MOBILE_LAYOUT.matches;
  const w = mobile ? Math.max(1, Math.round((canvas.clientWidth || window.innerWidth) * (window.devicePixelRatio || 1))) : srcW * 2;
  const h = mobile ? Math.max(1, Math.round((canvas.clientHeight || window.innerHeight) * (window.devicePixelRatio || 1))) : srcH * 2;
  if (!mobile) return { x: 0, y: 0, w, h };
  const fit = Math.min(w / srcW, h / srcH);
  const scale = fit >= 1 ? Math.floor(fit) : fit;
  const tw = Math.max(1, Math.round(srcW * scale));
  const th = Math.max(1, Math.round(srcH * scale));
  return { x: Math.floor((w - tw) / 2), y: Math.floor((h - th) / 2), w: tw, h: th };
}

function layoutCanvas() {
  const mobile = MOBILE_LAYOUT.matches;
  const [srcW, srcH] = sourceSize();
  const cssWidth = canvas.clientWidth || window.innerWidth;
  const cssHeight = canvas.clientHeight || window.innerHeight;
  const pixelRatio = mobile ? (window.devicePixelRatio || 1) : 1;
  const pixelWidth = mobile ? Math.max(1, Math.round(cssWidth * pixelRatio)) : srcW * 2;
  const pixelHeight = mobile ? Math.max(1, Math.round(cssHeight * pixelRatio)) : srcH * 2;
  if (!mobile) canvas.style.height = `${pixelHeight}px`;
  else canvas.style.height = "";

  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  const rect = tableRect();
  gl.uniform2f(tableOriginLoc, rect.x, rect.y);
  gl.uniform2f(tableSizeLoc, rect.w, rect.h);
  gl.uniform1f(scanlineLoc, mobile ? 0.75 : 0.65);
  gl.uniform1f(sourceRowsLoc, srcH);
  gl.uniform1i(rgbModeLoc, mode === "select" ? 1 : 0);
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
selectCore = api.pd_select_new();
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
  // The menu song belongs to the select screen; the table's own player takes over after it.
  const menu = mode === "select";
  const count = menu
    ? api.pd_select_audio_render(selectCore, Math.min(frames, api.pd_select_audio_buffer_len()))
    : api.pd_core_audio_render(core, Math.min(frames, api.pd_core_audio_buffer_len()));
  if (count === 0) return;
  const ptr = menu ? api.pd_select_audio_buffer(selectCore) : api.pd_core_audio_buffer(core);
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
  // Nothing to play until the select screen or a table is loaded; do not prime an empty mixer.
  if (!tableReady && !selectReady) return;
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
  mode = "game";
  document.body.classList.remove("selecting");
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

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} not built (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

// Load a table's pack and start it. `updateUrl` keeps ?table= bookmarkable for direct launches.
async function startTable(id, updateUrl = true) {
  const table = TABLES.find((candidate) => candidate.id === id);
  if (!table) return;
  try {
    const bytes = await fetchBytes(table.pack);
    if (!commitPlayfield(bytes)) throw new Error("pack rejected by the core");
    installHall(TABLES.indexOf(table));
    if (updateUrl) history.replaceState(null, "", `?table=${encodeURIComponent(table.id)}`);
    document.getElementById("pfnote").textContent = table.full
      ? "optional replacement for Nightmare"
      : `${table.name} is a geometry/feature preview; artwork and rules are not recovered`;
    enterGame(table.name);
  } catch (error) {
    console.warn("table load failed", error);
    document.title = `${table.name}: ${error.message}`;
    // Back to the chooser so the player can pick again.
    if (selectReady) enterSelect();
  }
}

// ---- table select (recovered SELC module) ----
function findFame(bytes) {
  for (let i = 0; i + 12 <= bytes.length; i++) {
    if (bytes[i] === 0x46 && bytes[i + 1] === 0x41 && bytes[i + 2] === 0x4d && bytes[i + 3] === 0x45 &&
        bytes[i + 4] === 0 && bytes[i + 5] === 0 && bytes[i + 6] === 0 && bytes[i + 7] === 192) return i + 8;
  }
  return -1;
}

function savedFame() {
  try {
    const text = localStorage.getItem(FAME_KEY);
    if (text && /^[0-9a-f]{384}$/.test(text)) return Uint8Array.from(text.match(/../g), (h) => parseInt(h, 16));
  } catch (e) { /* storage unavailable: defaults only */ }
  return null;
}

function persistFame() {
  try {
    localStorage.setItem(FAME_KEY, Array.from(selectBytes.subarray(fameAt, fameAt + 192), (b) => b.toString(16).padStart(2, "0")).join(""));
  } catch (e) { /* not persisted */ }
}

function uploadSelectPack() {
  memory().set(selectBytes, api.pd_select_scratch(selectCore));
  if (!api.pd_select_load(selectCore, selectBytes.length)) throw new Error("select pack rejected by the core");
}

// A table's list goes to the core when the table starts; entries typed at game over come back and are saved.
function installHall(index) {
  hallTable = index;
  if (fameAt < 0 || index < 0) return;
  memory().set(selectBytes.subarray(fameAt + 48 * index, fameAt + 48 * index + 48), api.pd_core_scratch(core));
  api.pd_core_high_scores_load(core);
}

function collectHall() {
  if (hallTable < 0 || fameAt < 0 || !api.pd_core_high_scores_dirty(core)) return;
  const ptr = api.pd_core_high_scores_export(core);
  if (!ptr) return;
  selectBytes.set(memory().slice(ptr, ptr + 48), fameAt + 48 * hallTable);
  persistFame();
}

async function loadSelectPack() {
  const bytes = await fetchBytes(SELECT_PACK);
  selectBytes = bytes;
  fameAt = findFame(bytes);
  const saved = savedFame();
  if (saved && fameAt >= 0) bytes.set(saved, fameAt);
  if (bytes.length > api.pd_select_scratch_len()) throw new Error("select pack too large");
  uploadSelectPack();
  selectWidth = api.pd_select_width();
  selectHeight = api.pd_select_height();
  selectReady = true;
}

function enterSelect() {
  if (selectBytes) uploadSelectPack(); // shows the list as saved so far
  mode = "select";
  document.body.classList.remove("playing");
  document.body.classList.add("selecting");
  document.title = "Pinball Dreams — choose a table";
  resetClock();
  layoutCanvas();
  uploadSelect();
  draw();
  startGameLoop();
  void ensureAudio();
}

function uploadSelect() {
  const ptr = api.pd_select_pixels(selectCore);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, rgbTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, selectWidth, selectHeight, 0, gl.RGB, gl.UNSIGNED_BYTE,
    memory().subarray(ptr, ptr + selectWidth * selectHeight * 3));
  gl.activeTexture(gl.TEXTURE0);
}

function stepSelect(ticks) {
  for (let i = 0; i < ticks; i++) api.pd_select_frame(selectCore);
  uploadSelect();
  draw();
  const chosen = api.pd_select_chosen(selectCore);
  if (chosen >= 0 && mode === "select") {
    mode = "loading";
    void startTable(TABLES[chosen].id, false);
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
  const players = api.pd_core_players(core);
  document.getElementById("player").textContent = String(Math.min(api.pd_core_player(core) + 1, players));
  document.getElementById("players").textContent = String(players);
  document.getElementById("player-scores").textContent = players > 1
    ? Array.from({ length: players }, (_, i) => `P${i + 1} ${api.pd_core_player_score(core, i)}`).join("  ") : "";
  const state = api.pd_core_state(core);
  document.getElementById("game-state").textContent = (state === 5 || state === 10) && !api.pd_core_launch_ready(core)
    ? "Preparing the next ball" : ({
    5: "Hold Space to pull, release to launch", 10: "Hold Space to pull, release to relaunch", 1: "In play",
    2: "Ball out", 7: "Tilt", 3: "Game over — press Space to restart", 6: "Starting a new game",
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
  feedInitials();
  api.pd_core_tick(core, inputBits());
  if (nudgePulse > 0) nudgePulse -= 1;
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
  const elapsed = Math.min(now - last, 100); // a long gap (throttled or stalled tab) is dropped, never replayed
  last = now;
  tickAccumulator += elapsed;

  if (mode === "select") {
    let selectTicks = 0;
    while (tickAccumulator >= TICK_MS && selectTicks < 4) {
      tickAccumulator -= TICK_MS;
      selectTicks += 1;
    }
    if (selectTicks > 0) stepSelect(selectTicks);
    requestAnimationFrame(loop);
    return;
  }
  if (mode !== "game") {
    tickAccumulator = 0;
    requestAnimationFrame(loop);
    return;
  }

  let ticks = 0;
  while (tickAccumulator >= TICK_MS && ticks < 4) {
    tickAccumulator -= TICK_MS;
    feedInitials();
    api.pd_core_tick(core, inputBits());
    if (nudgePulse > 0) nudgePulse -= 1;
    ticks += 1;
  }
  if (ticks > 0) {
    collectHall();
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

const requestedTable = new URLSearchParams(location.search).get("table");
if (requestedTable) {
  // The hall of fame lives in the select pack; load it first so the table gets its saved list.
  void loadSelectPack().catch((error) => console.warn("select pack unavailable", error)).then(() => startTable(requestedTable, false));
} else {
  loadSelectPack().then(enterSelect).catch((error) => {
    // Without the select pack fall back to the recovered table so the page still runs.
    console.warn("select screen unavailable", error);
    void startTable("nightmare", false);
  });
}


// ---- phones: nudge by a flick up the screen, and typing initials without a keyboard ----
const nameForm = document.getElementById("name-entry");
const nameInput = document.getElementById("name-input");
function wantsTouchControls() { return MOBILE_LAYOUT.matches && mode === "game"; }

function syncTouchControls() {
  const asking = MOBILE_LAYOUT.matches && mode === "game" && api.pd_core_name_active(core) === 1;
  if (asking && nameForm.hidden) { nameForm.hidden = false; nameInput.value = ""; setTimeout(() => nameInput.focus(), 50); }
  if (!asking && !nameForm.hidden) nameForm.hidden = true;
}
setInterval(syncTouchControls, 250);

// The core takes one character per tick (like the keyboard handler); feed them from the form.
let initialsQueue = [];
nameForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = (nameInput.value.toUpperCase().replace(/[^A-Z0-9 ]/g, "") + "   ").slice(0, 3);
  initialsQueue = Array.from(text, (ch) => ch.charCodeAt(0));
  nameForm.hidden = true;
});
function feedInitials() {
  if (initialsQueue.length === 0) return;
  if (api.pd_core_name_active(core) !== 1) { initialsQueue = []; return; }
  api.pd_core_name_char(core, initialsQueue.shift());
}
