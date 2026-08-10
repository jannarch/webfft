class WebAudioPlayer {
    constructor(sampleRate = 48000) {
        this.sampleRate = sampleRate;
        this.audioCtx = null;
        this.gainNode = null;
        this.ws = null;
        
        this.isPlaying = false;
        this.nextStartTime = 0;
        this.volume = 0.5;

        // Jitter buffer: queue chunks and play with a slight delay
        this._jitterBuffer = [];
        this._jitterDelayMs = 80;  // 80ms buffer to smooth out WebSocket delivery jitter
        this._jitterStarted = false;
        this._drainInterval = null;
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
            // Smooth transition
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
        this._mode = mode;
        this._jitterBuffer = [];
        this._jitterStarted = false;
        this.nextStartTime = 0;

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.ws = new WebSocket(`${protocol}//${window.location.host}/ws/audio`);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
            console.log(`Audio WebSocket connected. Requesting ${frequencyHz} Hz in ${mode} mode`);
            this.ws.send(JSON.stringify({ action: "start", freq_hz: frequencyHz, mode: mode }));
        };

        this.ws.onmessage = (event) => {
            if (!this.isPlaying) return;
            // Push into the jitter buffer instead of playing immediately
            this._jitterBuffer.push(event.data);

            // Once we've accumulated enough buffer, start draining
            if (!this._jitterStarted) {
                const chunksNeeded = Math.max(2, Math.ceil(this._jitterDelayMs / 20));
                if (this._jitterBuffer.length >= chunksNeeded) {
                    this._jitterStarted = true;
                    this.nextStartTime = this.audioCtx.currentTime + (this._jitterDelayMs / 1000);
                    this._startDraining();
                }
            }
        };

        this.ws.onclose = () => {
            console.log("Audio WebSocket closed.");
            this.stop();
        };
    }

    _startDraining() {
        // Drain the jitter buffer at a regular interval (~20ms)
        if (this._drainInterval) clearInterval(this._drainInterval);
        this._drainInterval = setInterval(() => {
            if (!this.isPlaying) {
                clearInterval(this._drainInterval);
                this._drainInterval = null;
                return;
            }
            // Schedule all queued chunks
            while (this._jitterBuffer.length > 0) {
                const chunk = this._jitterBuffer.shift();
                this._scheduleAudioChunk(chunk);
            }
        }, 20);
    }

    stop() {
        this.isPlaying = false;
        this._jitterBuffer = [];
        this._jitterStarted = false;
        if (this._drainInterval) {
            clearInterval(this._drainInterval);
            this._drainInterval = null;
        }
        if (this.ws) {
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ action: "stop" }));
            }
            this.ws.close();
            this.ws = null;
        }
    }

    _scheduleAudioChunk(buffer) {
        // Buffer is an ArrayBuffer containing Int16 PCM data
        const int16Array = new Int16Array(buffer);
        const float32Array = new Float32Array(int16Array.length);
        
        // Convert int16 to float32
        for (let i = 0; i < int16Array.length; i++) {
            float32Array[i] = int16Array[i] / 32768.0;
        }

        const audioBuffer = this.audioCtx.createBuffer(1, float32Array.length, this.sampleRate);
        audioBuffer.getChannelData(0).set(float32Array);

        const source = this.audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.gainNode);

        // Schedule playback — if we fell behind, reset with a small gap
        if (this.nextStartTime < this.audioCtx.currentTime) {
            this.nextStartTime = this.audioCtx.currentTime + 0.01;
        }

        source.start(this.nextStartTime);
        this.nextStartTime += audioBuffer.duration;
    }
}
