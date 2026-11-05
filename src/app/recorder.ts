// Every game is recorded. Only the latest recording is kept, in memory: starting a new game discards the previous one,
// and nothing is stored after the tab closes. The download button saves the current game, even while it is still running.

/** Page states the recorder follows (see `status()` in main.ts). */
export type GameState = 'idle' | 'loading' | 'live' | 'paused' | 'ended' | 'error';

export interface Recorder {
  state(value: GameState): void;
  /** Called when a new game starts or the worker is left: finish the current file, keep it until the next game starts. */
  stop(): void;
}

interface Session {
  rec: MediaRecorder;
  stream: MediaStream;
  waiters: (() => void)[];
  chunks: Blob[];
  bytes: number;
  mime: string;
  name: string;
}

const MAX_BYTES = 96 * 1024 * 1024;

export function installRecorder(
  canvas: HTMLCanvasElement,
  { button }: { button: HTMLButtonElement },
  currentSeed: () => number,
): Recorder {
  const supported = typeof canvas.captureStream === 'function' && typeof MediaRecorder === 'function';
  // `last` is the newest recording (running or finished); `active` is set only while it still records.
  let active: Session | null = null,
    last: Session | null = null;
  const refresh = () => {
    button.disabled = !supported || !last?.chunks.length;
  };
  if (!supported) button.title = 'This browser cannot record the game canvas.';
  refresh();

  function begin(): void {
    if (!supported) return;
    try {
      const stream = canvas.captureStream(35);
      const type = ['video/webm;codecs=vp8', 'video/mp4', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
      const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const session: Session = {
        rec,
        stream,
        waiters: [],
        chunks: [],
        bytes: 0,
        mime: rec.mimeType || type || 'video/webm',
        name: 'evoweights-doom-seed-' + currentSeed() + '-' + new Date().toISOString().replace(/[:.]/g, '-'),
      };
      rec.ondataavailable = ({ data }) => {
        if (data.size && last === session) {
          session.chunks.push(data);
          session.bytes += data.size;
          refresh();
          if (session.bytes >= MAX_BYTES) end();
        }
        session.waiters.splice(0).forEach((r) => r());
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        session.waiters.splice(0).forEach((r) => r());
      };
      rec.onerror = () => end();
      active = last = session;
      refresh();
      rec.start(1000);
    } catch {
      active = null;
    }
  }
  function end(): void {
    const a = active;
    active = null;
    if (a && a.rec.state !== 'inactive') a.rec.stop();
  }
  async function download(): Promise<void> {
    // While a game runs, flush the recorder first so the file contains everything up to now.
    const s = last;
    if (!s) return;
    if (s.rec.state !== 'inactive')
      await new Promise<void>((r) => {
        s.waiters.push(r);
        s.rec.requestData();
        setTimeout(r, 1500);
      });
    if (!s.chunks.length) return;
    const url = URL.createObjectURL(new Blob(s.chunks, { type: s.mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = s.name + (/mp4/i.test(s.mime) ? '.mp4' : '.webm');
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  button.addEventListener('click', () => {
    download().catch(() => {});
  });
  return {
    state(value) {
      if (value === 'live') {
        if (active?.rec.state === 'paused') active.rec.resume();
        else if (!active) begin();
      } else if (value === 'paused' && active?.rec.state === 'recording') active.rec.pause();
      else if (value === 'ended' || value === 'error' || value === 'idle') end();
    },
    stop() {
      end();
    },
  };
}
