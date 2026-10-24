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
const MAX_PIXEL_RATIO = 3;

const canvas = document.getElementById("screen");
const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
if (gl) gl.disable(gl.DITHER); // Keep2x pixel pairs and scanline brightness deterministic.
if (!gl) throw new Error("WebGL2 is required");

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
  const pointer = touchPointers.get(e.pointerId);
  if (!pointer) return;
  e.preventDefault();
  clearTimeout(pointer.timer);
  touchPointers.delete(e.pointerId);
}

canvas.addEventListener("pointerup", releaseTouch);
canvas.addEventListener("pointercancel", releaseTouch);
canvas.addEventListener("lostpointercapture", releaseTouch);
canvas.addEventListener("contextmenu", (e) => {
  if (MOBILE_LAYOUT.matches) e.preventDefault();
});

addEventListener("blur", () => { keys.clear(); clearTouchPointers(); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { keys.clear(); clearTouchPointers(); }
});

runBtn.addEventListener("click", toggle);
stepBtn.addEventListener("click", () => { running = false; runBtn.textContent = "Resume"; renderOnce(); });

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
uniform sampler2D indices;   //320x542, nearest-neighbour at2x
uniform sampler2D palette;   //69x1 RGB (32base+32EHB+5header/separator)
uniform vec2 tableOrigin;    // bottom-left of the table in framebuffer pixels
uniform vec2 tableSize;      // displayed table size in framebuffer pixels
uniform vec2 sourceSize;     // 320x542 logical table size
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
  // D7 presentation effect: one dark half-row per logical row. Aligning it to the source
  // rows keeps scanlines crisp when the table is scaled to a phone's physical resolution.
  float rowPixels = tableSize.y / sourceSize.y;
  float scanline = 1.0;
  if (rowPixels >= 1.5) {
    scanline = fract(uv.y * sourceSize.y) < 0.5 ? 0.65 : 1.0;
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
gl.uniform2f(gl.getUniformLocation(program, "sourceSize"), WIDTH, HEIGHT);

// On phones the canvas is as large as the viewport's physical pixel grid, and the shader
// letterboxes the 320x542 table inside it. That gives the browser no resampling to do:
// pixels and scanlines stay aligned to the table's logical rows at any device pixel ratio.
function layoutCanvas() {
  const mobile = MOBILE_LAYOUT.matches;
  const cssWidth = canvas.clientWidth || window.innerWidth;
  const cssHeight = canvas.clientHeight || window.innerHeight;
  const pixelRatio = mobile ? Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO) : 1;
  const pixelWidth = mobile ? Math.max(1, Math.round(cssWidth * pixelRatio)) : 640;
  const pixelHeight = mobile ? Math.max(1, Math.round(cssHeight * pixelRatio)) : 1084;

  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  let tableWidth = pixelWidth;
  let tableHeight = pixelHeight;
  if (mobile) {
    const scale = Math.min(pixelWidth / WIDTH, pixelHeight / HEIGHT);
    tableWidth = Math.max(1, Math.round(WIDTH * scale));
    tableHeight = Math.max(1, Math.round(HEIGHT * scale));
  }

  gl.uniform2f(tableOriginLoc,
    Math.floor((pixelWidth - tableWidth) / 2),
    Math.floor((pixelHeight - tableHeight) / 2));
  gl.uniform2f(tableSizeLoc, tableWidth, tableHeight);
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

// Playfield data: the user's own disks, converted by tools/playfield.py. Nothing is bundled in git,
// but if web/playfield.bin exists it is picked up automatically, so the page is ready to run.
const pfInput = document.getElementById("pf");
const SCRATCH_LEN = api.pd_core_scratch_len();

function commitPlayfield(bytes) {
  const ptr = api.pd_core_scratch(core);
  memory().set(bytes, ptr);
  if (!api.pd_core_commit_playfield(core, bytes.length)) return false;
  api.pd_core_render(core);
  upload();
  draw();
  return true;
}

pfInput.addEventListener("change", async () => {
  const file = pfInput.files && pfInput.files[0];
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!commitPlayfield(bytes)) {
    alert(`could not load ${file.name} (${bytes.length} bytes).\n` +
          "Expected a table pack from tools/build_pack.py or a raw 62,400-byte playfield.");
  }
});

// Autoload: prefer a table pack, fall back to a bare playfield, then leave the picker.
(async () => {
  for (const name of ["table.pack.bin", "playfield.bin"]) {
    try {
      const response = await fetch(`./${name}`);
      if (!response.ok) continue;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (commitPlayfield(bytes)) {
        document.getElementById("pfnote").textContent =
          `autoloaded web/${name} - pick another file to replace it`;
        return;
      }
    } catch (e) {
      // try the next candidate
    }
  }
})();

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

requestAnimationFrame(loop);
