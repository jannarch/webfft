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
        this._jitterDelayMs = 100; // 100ms buffer to smooth out delivery jitter
        this._jitterStarted = false;
        
        // Noise gate: suppress output when signal is weak
        this._noiseGateThreshold = 0.015;
        this._noiseGateEnabled = true;
        
        // Crossfade state
        this._prevChunk = null;
    }

    _initAudio() {
        if (!this.audioCtx) {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: this.sampleRate
            });
            this.gainNode = this.audioCtx.createGain();
            this.gainNode.gain.value = 0;
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
        this._mode = mode;
        this._jitterBuffer = [];
        this._jitterStarted = false;
        this.nextStartTime = 0;
        this._prevChunk = null;

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.ws = new WebSocket(`${protocol}//${window.location.host}/ws/audio`);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
            console.log(`Audio WebSocket connected. Requesting ${frequencyHz} Hz in ${mode} mode`);
            this.ws.send(JSON.stringify({ action: "start", freq_hz: frequencyHz, mode: mode }));
        };

        this.ws.onmessage = (event) => {
            if (!this.isPlaying) return;
            this._jitterBuffer.push(event.data);

            if (!this._jitterStarted) {
                const chunksNeeded = Math.max(4, Math.ceil(this._jitterDelayMs / 20));
                if (this._jitterBuffer.length >= chunksNeeded) {
                    this._jitterStarted = true;
                    this.nextStartTime = this.audioCtx.currentTime + (this._jitterDelayMs / 1000);
                    this.gainNode.gain.setValueAtTime(0, this.nextStartTime);
                    this.gainNode.gain.linearRampToValueAtTime(this.volume, this.nextStartTime + 0.1);
                    this._drainBuffer();
                }
            } else {
                this._drainBuffer();
            }
        };

        this.ws.onclose = () => {
            console.log("Audio WebSocket closed.");
            this.stop();
        };
    }

    _drainBuffer() {
        const merged = this._mergeChunks(40);
        for (const chunk of merged) {
            this._scheduleAudioChunk(chunk);
        }
    }

    _mergeChunks(targetMs) {
        const targetSamples = Math.floor(this.sampleRate * targetMs / 1000);
        const merged = [];
        let current = null;
        let currentLen = 0;

        while (this._jitterBuffer.length > 0) {
            const chunk = this._jitterBuffer.shift();
            const int16 = new Int16Array(chunk);
            
            if (current === null) {
                current = new Int16Array(int16);
                currentLen = int16.length;
            } else {
                const combined = new Int16Array(currentLen + int16.length);
                combined.set(current, 0);
                combined.set(int16, currentLen);
                current = combined;
                currentLen += int16.length;
            }

            if (currentLen >= targetSamples) {
                merged.push(current.buffer.slice(0));
                current = null;
                currentLen = 0;
            }
        }

        if (current !== null && currentLen > 0) {
            merged.push(current.buffer.slice(0));
        }

        return merged;
    }

    stop() {
        this.isPlaying = false;
        this._jitterBuffer = [];
        this._jitterStarted = false;
        this._prevChunk = null;
        if (this.ws) {
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ action: "stop" }));
            }
            this.ws.close();
            this.ws = null;
        }
        if (this.gainNode) {
            const now = this.audioCtx.currentTime;
            this.gainNode.gain.cancelScheduledValues(now);
            this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
            this.gainNode.gain.linearRampToValueAtTime(0, now + 0.05);
        }
    }

    _scheduleAudioChunk(buffer) {
        const int16Array = new Int16Array(buffer);
        const float32Array = new Float32Array(int16Array.length);
        
        for (let i = 0; i < int16Array.length; i++) {
            float32Array[i] = int16Array[i] / 32768.0;
        }

        if (this._noiseGateEnabled) {
            let sumSq = 0;
            for (let i = 0; i < float32Array.length; i++) {
                sumSq += float32Array[i] * float32Array[i];
            }
            const rms = Math.sqrt(sumSq / float32Array.length);
            if (rms < this._noiseGateThreshold) {
                float32Array.fill(0);
            }
        }

        // Crossfade with previous chunk to eliminate clicks
        if (this._prevChunk !== null) {
            const fadeSamples = Math.min(64, float32Array.length, this._prevChunk.length);
            for (let i = 0; i < fadeSamples; i++) {
                const t = i / fadeSamples;
                float32Array[i] = this._prevChunk[this._prevChunk.length - fadeSamples + i] * (1 - t) + float32Array[i] * t;
            }
        }
        this._prevChunk = new Float32Array(float32Array);

        const audioBuffer = this.audioCtx.createBuffer(1, float32Array.length, this.sampleRate);
        const channelData = audioBuffer.getChannelData(0);
        channelData.set(float32Array);

        const source = this.audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.gainNode);

        if (this.nextStartTime < this.audioCtx.currentTime + 0.05) {
            this.nextStartTime = this.audioCtx.currentTime + 0.05;
        }

        source.start(this.nextStartTime);
        this.nextStartTime += audioBuffer.duration;
    }
}
