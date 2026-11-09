// 문단별 mp3 조각을 한 회차짜리 mp3 하나로 이어 붙인다.
// - 모든 조각은 24kHz(MPEG-2 Layer III) 이어야 한다 (Worker가 세 엔진 모두 이렇게 받음)
// - 조각 사이에는 무음 프레임을 넣고, 맨 앞에 Xing 헤더를 붙여 길이·탐색이 정확하게 되게 한다
// - 프레임 하나 = 576샘플 = 24ms 라서 각 문단의 시작 시간을 정확히 알 수 있다

const BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

export const SAMPLE_RATE = 24000;
const SPF = 576;
const FRAME_SEC = SPF / SAMPLE_RATE;

function readHeader(u8, i) {
  if (u8[i] !== 0xFF || (u8[i + 1] & 0xE0) !== 0xE0) return null;
  const b1 = u8[i + 1], b2 = u8[i + 2], b3 = u8[i + 3];
  const ver = (b1 >> 3) & 3;
  if (ver === 1) return null;
  if (((b1 >> 1) & 3) !== 1) return null; // Layer III만
  const bri = b2 >> 4;
  const sri = (b2 >> 2) & 3;
  if (bri === 0 || bri === 15 || sri === 3) return null;
  const mpeg1 = ver === 3;
  const br = (mpeg1 ? BR1 : BR2)[bri] * 1000;
  const sr = SR[ver][sri];
  const len = Math.floor(((mpeg1 ? 144 : 72) * br) / sr) + ((b2 >> 1) & 1);
  return { len, sr, spf: mpeg1 ? 1152 : 576, mono: (b3 >> 6) === 3 };
}

function hasVbrTag(u8, start, len) {
  const end = Math.min(start + len, start + 48);
  let s = "";
  for (let i = start + 4; i < end; i++) s += String.fromCharCode(u8[i]);
  return /Xing|Info|VBRI/.test(s);
}

// mp3 한 조각에서 오디오 프레임 위치만 뽑는다 (ID3 태그, VBR 정보 프레임 제외)
export function parseFrames(u8) {
  let i = 0;
  if (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) {
    const size = ((u8[6] & 0x7f) << 21) | ((u8[7] & 0x7f) << 14) | ((u8[8] & 0x7f) << 7) | (u8[9] & 0x7f);
    i = 10 + size + ((u8[5] & 0x10) ? 10 : 0);
  }
  const frames = [];
  let sr = 0;
  let first = true;
  while (i + 4 <= u8.length) {
    const h = readHeader(u8, i);
    if (!h) { i++; continue; }
    if (i + h.len > u8.length) break;
    // 다음 프레임도 이어지는지 확인해서 우연히 0xFF가 나온 경우를 걸러낸다
    if (i + h.len + 4 <= u8.length && !readHeader(u8, i + h.len)) { i++; continue; }
    if (first) {
      first = false;
      if (hasVbrTag(u8, i, h.len)) { i += h.len; continue; }
    }
    if (sr && h.sr !== sr) throw new Error(`표본 빈도가 섞여 있어요 (${sr} / ${h.sr})`);
    sr = h.sr;
    frames.push([i, h.len]);
    i += h.len;
  }
  return { frames, sampleRate: sr };
}

// MPEG-2 Layer III, 24kHz, 모노, 8kbps 무음 프레임 (24바이트, 24ms)
function silenceFrame() {
  const f = new Uint8Array(24);
  f[0] = 0xFF; f[1] = 0xF3; f[2] = 0x14; f[3] = 0xC4;
  return f;
}
const SILENCE = silenceFrame();

export function silenceCount(seconds) {
  return Math.max(0, Math.round(seconds / FRAME_SEC));
}

// parts: [{ bytes: Uint8Array, gap: 앞에 둘 쉼(초) }]
// 결과: { blob, starts: [각 조각이 시작하는 시간(초)], ends, duration }
export function assemble(parts) {
  const pieces = [];
  const starts = [];
  const ends = [];
  let frameCount = 0;
  let audioBytes = 0;
  const frameOffsets = []; // TOC 계산용: 프레임 100개마다 바이트 위치

  const pushFrame = (u8, off, len) => {
    if (frameCount % 100 === 0) frameOffsets.push(audioBytes);
    pieces.push(u8.subarray(off, off + len));
    audioBytes += len;
    frameCount++;
  };

  for (const part of parts) {
    const n = silenceCount(part.gap || 0);
    for (let k = 0; k < n; k++) pushFrame(SILENCE, 0, SILENCE.length);
    starts.push(frameCount * FRAME_SEC);
    const { frames, sampleRate } = parseFrames(part.bytes);
    if (frames.length && sampleRate !== SAMPLE_RATE) {
      throw new Error(`24kHz가 아닌 음성 조각이 있어요 (${sampleRate}Hz)`);
    }
    for (const [off, len] of frames) pushFrame(part.bytes, off, len);
    ends.push(frameCount * FRAME_SEC);
  }
  // 끝에 0.5초 여유
  for (let k = 0; k < silenceCount(0.5); k++) pushFrame(SILENCE, 0, SILENCE.length);

  const xing = xingFrame(frameCount, audioBytes, frameOffsets);
  const blob = new Blob([xing, ...pieces], { type: "audio/mpeg" });
  return { blob, starts, ends, duration: frameCount * FRAME_SEC };
}

// 64kbps 프레임(192바이트) 안에 Xing 헤더: 전체 프레임 수, 바이트 수, 탐색표(TOC)
function xingFrame(frames, audioBytes, frameOffsets) {
  const size = 192;
  const f = new Uint8Array(size);
  f[0] = 0xFF; f[1] = 0xF3; f[2] = 0x84; f[3] = 0xC4;
  const total = audioBytes + size;
  let p = 4 + 9; // MPEG-2 모노 side info 9바이트 뒤
  const put32 = v => { f[p++] = (v >>> 24) & 255; f[p++] = (v >>> 16) & 255; f[p++] = (v >>> 8) & 255; f[p++] = v & 255; };
  f.set([0x58, 0x69, 0x6E, 0x67], p); p += 4; // "Xing"
  put32(0x0F);
  put32(frames);
  put32(total);
  for (let i = 0; i < 100; i++) {
    const frameIdx = Math.floor((i / 100) * frames);
    const bucket = Math.floor(frameIdx / 100);
    const base = frameOffsets[Math.min(bucket, frameOffsets.length - 1)] || 0;
    // 100프레임 단위 위치에 근사 (프레임 길이 차이는 무시할 만큼 작음)
    f[p++] = Math.min(255, Math.floor(((size + base) / total) * 256));
  }
  put32(0);
  return f;
}
