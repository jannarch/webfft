class WebAudioPlayer {
    constructor(sampleRate = 48000) {
        this.sampleRate = sampleRate;
        this.audioCtx = null;
        this.gainNode = null;
        this.ws = null;
        
        this.isPlaying = false;
        this.nextStartTime = 0;
        this.volume = 0.5;
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

    start(frequencyHz) {
        if (this.isPlaying) this.stop();
        this._initAudio();
        
        if (this.audioCtx.state === 'suspended') {
            this.audioCtx.resume();
        }

        this.isPlaying = true;
        this.nextStartTime = this.audioCtx.currentTime + 0.1; // Small buffer delay to prevent stutter

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.ws = new WebSocket(`${protocol}//${window.location.host}/ws/audio`);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
            console.log(`Audio WebSocket connected. Requesting ${frequencyHz} Hz`);
            this.ws.send(JSON.stringify({ action: "start", freq_hz: frequencyHz }));
        };

        this.ws.onmessage = (event) => {
            if (!this.isPlaying) return;
            this._scheduleAudioChunk(event.data);
        };

        this.ws.onclose = () => {
            console.log("Audio WebSocket closed.");
            this.stop();
        };
    }

    stop() {
        this.isPlaying = false;
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

        // Schedule playback
        if (this.nextStartTime < this.audioCtx.currentTime) {
            // We underran (starved), reset the clock
            this.nextStartTime = this.audioCtx.currentTime + 0.05;
        }

        source.start(this.nextStartTime);
        this.nextStartTime += audioBuffer.duration;
    }
}
