/** Local picnic effects and looping music, unlocked by a user gesture. */
import { siteUrl } from '../shared/site.js';
export const PICNIC_SOUNDS = ['plop', 'empty-click', 'unfold', 'eating', 'mmmrrraww', 'hug', 'finale'];
export const OUCH_SOUNDS = ['ouch_1', 'ouch_2', 'ouch_3', 'ouch_4', 'ouch_5'];
/** Cosmetic randomness stays separate from the engine's seeded simulation. */
export function ouchVariant(random) {
    return OUCH_SOUNDS[Math.floor(random * OUCH_SOUNDS.length)];
}
/** Return at most one of each cue when counters jump over several simulation tics. */
export function picnicSoundsBetween(before, current) {
    if (!before || current.tic <= before.tic)
        return [];
    const sounds = [];
    if (current.ammo < before.ammo)
        sounds.push('plop');
    const previous = before.picnic;
    const next = current.picnic;
    if ((before.ammo > 0 && current.ammo === 0) || (next?.unfolding && !previous?.unfolding)) {
        sounds.push('empty-click', 'unfold');
    }
    if (!next || !previous)
        return sounds;
    if (next.bearsFed > previous.bearsFed)
        sounds.push('eating');
    if (next.bearsBefriended > previous.bearsBefriended)
        sounds.push('hug', 'mmmrrraww');
    if (next.timesBitten > previous.timesBitten)
        sounds.push('ouch');
    if (next.ending && !previous.ending)
        sounds.push('finale');
    return sounds;
}
const MAX_VOICES = 6;
const VOLUME = 0.36;
const MUSIC_VOLUME = 0.45;
export class PicnicAudio {
    context;
    gain;
    musicGain;
    ouchGain;
    loading;
    buffers = new Map();
    musicBuffer;
    musicSource;
    musicOffset = 0;
    musicStartedAt = 0;
    playing = false;
    voices = new Set();
    previous;
    muted = false;
    /** Call directly inside a play/unmute click handler, before awaiting any other work. */
    async unlock() {
        if (typeof AudioContext === 'undefined')
            return;
        try {
            if (!this.context) {
                this.context = new AudioContext();
                this.gain = this.context.createGain();
                this.gain.gain.value = this.muted ? 0 : VOLUME;
                this.gain.connect(this.context.destination);
                this.musicGain = this.context.createGain();
                this.musicGain.gain.value = MUSIC_VOLUME;
                this.musicGain.connect(this.gain);
                this.ouchGain = this.context.createGain();
                this.ouchGain.gain.value = 2;
                this.ouchGain.connect(this.gain);
            }
            const context = this.context;
            const resumed = context.resume().catch(() => undefined);
            // Muted visitors download nothing (VERIFIED: the music alone is 5.3 MB); the unmute click calls unlock() again.
            if (!this.muted)
                this.loading ??= this.load(context);
            await Promise.all([resumed, this.loading]);
            this.startMusic();
        }
        catch {
            // Browser audio can be disabled by user policy. The visual game remains usable.
        }
    }
    /** Follow the game transport; resuming continues from the paused music position. */
    setPlaying(playing) {
        this.playing = playing;
        if (playing)
            this.startMusic();
        else
            this.stopMusic();
    }
    setMuted(muted) {
        this.muted = muted;
        if (!this.context || !this.gain)
            return;
        const now = this.context.currentTime;
        this.gain.gain.cancelScheduledValues(now);
        this.gain.gain.setValueAtTime(this.gain.gain.value, now);
        this.gain.gain.linearRampToValueAtTime(muted ? 0 : VOLUME, now + 0.025);
    }
    /** Discard events from the previous episode and stop its sounds. */
    reset() {
        this.setPlaying(false);
        this.musicOffset = 0;
        this.previous = undefined;
        for (const voice of this.voices) {
            voice.onended = null;
            voice.stop();
            voice.disconnect();
        }
        this.voices.clear();
    }
    update(state) {
        if (this.previous && state.tic < this.previous.tic) {
            const playing = this.playing;
            this.reset();
            this.setPlaying(playing);
        }
        if (state.tic === this.previous?.tic)
            return;
        const sounds = picnicSoundsBetween(this.previous, state);
        // Copy the small counters: callers may reuse and mutate a packet between frames.
        this.previous = { ...state, picnic: state.picnic ? { ...state.picnic } : undefined };
        for (const sound of sounds)
            this.play(sound);
    }
    async load(context) {
        const decode = async (path) => {
            try {
                const response = await fetch(siteUrl('assets/huggingdoom/' + path));
                if (!response.ok)
                    return;
                return await context.decodeAudioData(await response.arrayBuffer());
            }
            catch {
                // An unavailable audio asset must never stop the game.
                return;
            }
        };
        await Promise.all([
            ...[...PICNIC_SOUNDS, ...OUCH_SOUNDS].map(async (name) => {
                const path = name.startsWith('ouch_') ? `gamemusic/${name}.mp3` : `sounds/${name}.wav`;
                const buffer = await decode(path);
                if (buffer && this.context === context)
                    this.buffers.set(name, buffer);
            }),
            (async () => {
                const buffer = await decode('gamemusic/gamemusic_huggingdoom.mp3');
                if (buffer && this.context === context) {
                    this.musicBuffer = buffer;
                    this.startMusic();
                }
            })(),
        ]);
    }
    startMusic() {
        const context = this.context;
        if (!this.playing ||
            this.musicSource ||
            !context ||
            context.state !== 'running' ||
            !this.musicGain ||
            !this.musicBuffer)
            return;
        const source = context.createBufferSource();
        source.buffer = this.musicBuffer;
        source.loop = true;
        source.connect(this.musicGain);
        this.musicSource = source;
        this.musicStartedAt = context.currentTime;
        source.start(this.musicStartedAt, this.musicOffset);
    }
    stopMusic() {
        const source = this.musicSource;
        if (!source || !this.context || !this.musicBuffer)
            return;
        this.musicOffset = (this.musicOffset + this.context.currentTime - this.musicStartedAt) % this.musicBuffer.duration;
        source.stop();
        source.disconnect();
        this.musicSource = undefined;
    }
    play(sound) {
        const context = this.context;
        const buffer = this.buffers.get(sound === 'ouch' ? ouchVariant(Math.random()) : sound);
        if (this.muted || !context || context.state !== 'running' || !this.gain || !buffer)
            return;
        if (this.voices.size >= MAX_VOICES) {
            const oldest = this.voices.values().next().value;
            if (oldest) {
                oldest.onended = null;
                oldest.stop();
                oldest.disconnect();
                this.voices.delete(oldest);
            }
        }
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(sound === 'ouch' && this.ouchGain ? this.ouchGain : this.gain);
        source.onended = () => {
            source.disconnect();
            this.voices.delete(source);
        };
        this.voices.add(source);
        const delay = sound === 'unfold' ? 0.11 : sound === 'mmmrrraww' ? 0.13 : 0;
        source.start(context.currentTime + delay);
    }
}
