class WebAudioPlayer {
    constructor(sampleRate = 48000) {
        this.sampleRate = sampleRate;
        this.audioCtx = null;
        this.gainNode = null;
        this.ws = null;

        this.isPlaying = false;
        this.volume = 0.5;

        // Raw incoming chunk queue (Int16Array items from WebSocket)
        this._queue = [];

        // Lookahead scheduler state
        this._scheduleAheadSec = 0.3;    // schedule up to 300ms ahead of playback (increased from 250ms)
        this._initialBufferSec = 0.2;    // wait for 200ms of audio before starting (increased from 150ms)
        this._nextPlayTime = 0;           // next Web Audio API timestamp to schedule at
        this._started = false;            // has playback started yet?
        this._totalQueued = 0;            // total seconds of audio in the queue
        this._schedulerTimer = null;      // setInterval handle
        this._maxBufferSec = 1.5;         // maximum buffer size before dropping chunks (increased from 600ms)
    }

    _initAudio() {
        if (!this.audioCtx) {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: this.sampleRate
            });
            this.gainNode = this.audioCtx.createGain();
            this.gainNode.gain.value = this.volume;
            this.gainNode.connect(this.audioCtx.destination);
        }
    }

    setVolume(val) {
        this.volume = Math.max(0, Math.min(1, val));
        if (this.gainNode) {
            this.gainNode.gain.setTargetAtTime(this.volume, this.audioCtx.currentTime, 0.05);
        }
    }

    start(frequencyHz, mode = 'FM') {
        if (this.isPlaying) this.stop();
        this._initAudio();

        if (this.audioCtx.state === 'suspended') {
            this.audioCtx.resume();
        }

        this.isPlaying = true;
        this._queue = [];
        this._totalQueued = 0;
        this._started = false;
        this._nextPlayTime = 0;

        // Start the lookahead scheduler pump — runs every 20ms
        this._schedulerTimer = setInterval(() => this._schedulerPump(), 20);

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.ws = new WebSocket(`${protocol}//${window.location.host}/ws/audio`);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
            console.log(`[Audio] WS open → requesting ${(frequencyHz / 1e6).toFixed(4)} MHz [${mode}]`);
            this.ws.send(JSON.stringify({ action: 'start', freq_hz: frequencyHz, mode: mode }));
        };

        this.ws.onmessage = (event) => {
            if (!this.isPlaying) return;
            const int16 = new Int16Array(event.data);
            const durationSec = int16.length / this.sampleRate;

            // Overrun protection: cap total buffered audio to prevent latency buildup
            if (this._totalQueued > this._maxBufferSec) {
                const dropped = this._queue.shift();
                if (dropped) this._totalQueued -= dropped.length / this.sampleRate;
            }

            this._queue.push(int16);
            this._totalQueued += durationSec;
        };

        this.ws.onclose = () => {
            console.log('[Audio] WS closed.');
            this.stop();
        };

        this.ws.onerror = (err) => {
            console.error('[Audio] WS error:', err);
        };
    }

    /**
     * Lookahead scheduler pump — runs every 20ms via setInterval.
     * Schedules all queued chunks whose start time falls within the
     * lookahead window (now + _scheduleAheadSec). This is the standard
     * Web Audio API pattern for gapless, stutter-free playback.
     */
    _schedulerPump() {
        if (!this.isPlaying || !this.audioCtx) return;

        const now = this.audioCtx.currentTime;

        // Wait for the initial buffer to fill before starting playback
        if (!this._started) {
            if (this._totalQueued < this._initialBufferSec) return;
            // Start scheduling slightly ahead of now for a clean start
            this._nextPlayTime = now + 0.05;
            this._started = true;
        }

        // Pump all chunks that fall within the lookahead window
        while (this._queue.length > 0 && this._nextPlayTime < now + this._scheduleAheadSec) {
            const int16 = this._queue.shift();
            const durationSec = int16.length / this.sampleRate;
            this._totalQueued = Math.max(0, this._totalQueued - durationSec);

            const float32 = new Float32Array(int16.length);
            for (let i = 0; i < int16.length; i++) {
                float32[i] = int16[i] / 32768.0;
            }

            const audioBuffer = this.audioCtx.createBuffer(1, float32.length, this.sampleRate);
            audioBuffer.getChannelData(0).set(float32);

            const source = this.audioCtx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(this.gainNode);
            source.start(this._nextPlayTime);

            this._nextPlayTime += durationSec;
        }

        // Underrun: playhead caught up and queue is empty — re-buffer cleanly
        if (this._started && this._nextPlayTime < now && this._queue.length === 0) {
            console.warn('[Audio] Underrun — re-buffering...');
            this._started = false;
            this._nextPlayTime = 0;
            this._totalQueued = 0;
        }
    }

    stop() {
        this.isPlaying = false;
        this._queue = [];
        this._totalQueued = 0;
        this._started = false;
        this._nextPlayTime = 0;

        if (this._schedulerTimer !== null) {
            clearInterval(this._schedulerTimer);
            this._schedulerTimer = null;
        }
        if (this.ws) {
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ action: 'stop' }));
            }
            this.ws.close();
            this.ws = null;
        }
        if (this.gainNode && this.audioCtx) {
            const now = this.audioCtx.currentTime;
            this.gainNode.gain.cancelScheduledValues(now);
            this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
            this.gainNode.gain.linearRampToValueAtTime(0, now + 0.08);
        }
    }
}