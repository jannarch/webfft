/* static/js/charts.js */

class SpectrumChart {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        this.resize();
        
        // Listen to window resize
        window.addEventListener('resize', () => this.resize());
        
        this.freqs = [];
        this.mags = [];
        this.peaks = [];
        this.threshold = -70;
    }
    
    resize() {
        const parent = this.canvas.parentElement;
        this.canvas.width = parent.clientWidth;
        this.canvas.height = parent.clientHeight;
    }
    
    updateData(freqs, mags, peaks) {
        this.freqs = freqs;
        this.mags = mags;
        this.peaks = peaks;
        this.draw();
    }
    
    setThreshold(val) {
        this.threshold = val;
    }
    
    draw() {
        const w = this.canvas.width;
        const h = this.canvas.height;
        const ctx = this.ctx;
        
        ctx.clearRect(0, 0, w, h);
        
        if (!this.freqs || this.freqs.length === 0) {
            ctx.fillStyle = '#64748b';
            ctx.font = '14px Inter';
            ctx.textAlign = 'center';
            ctx.fillText('Waiting for data...', w/2, h/2);
            return;
        }
        
        const minDb = -120;
        const maxDb = 0;
        const rangeDb = maxDb - minDb;
        
        // Draw grid
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        // Horizontal grids (-100, -80, -60, -40, -20)
        for (let db = -100; db <= -20; db += 20) {
            let y = h - ((db - minDb) / rangeDb) * h;
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            
            // Label
            ctx.fillStyle = 'rgba(255,255,255,0.3)';
            ctx.font = '10px monospace';
            ctx.textAlign = 'left';
            ctx.fillText(`${db} dBm`, 5, y - 2);
        }
        ctx.stroke();
        
        // Draw threshold line
        const threshY = h - ((this.threshold - minDb) / rangeDb) * h;
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.5)'; // Danger red
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(0, threshY);
        ctx.lineTo(w, threshY);
        ctx.stroke();
        ctx.setLineDash([]);
        
        // Draw Spectrum
        ctx.beginPath();
        ctx.strokeStyle = '#3b82f6'; // Accent blue
        ctx.lineWidth = 2;
        
        const len = this.freqs.length;
        for (let i = 0; i < len; i++) {
            const x = (i / (len - 1)) * w;
            const y = h - ((this.mags[i] - minDb) / rangeDb) * h;
            
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
        
        // Fill under spectrum
        ctx.lineTo(w, h);
        ctx.lineTo(0, h);
        ctx.fillStyle = 'rgba(59, 130, 246, 0.1)';
        ctx.fill();
        
        // Draw Peaks
        if (this.peaks) {
            ctx.fillStyle = '#ef4444';
            const fMin = this.freqs[0];
            const fMax = this.freqs[this.freqs.length-1];
            const fRange = fMax - fMin;
            
            for (let p of this.peaks) {
                // Ignore peaks out of bounds
                if (p.freq < fMin || p.freq > fMax) continue;
                
                const x = ((p.freq - fMin) / fRange) * w;
                const y = h - ((p.pwr - minDb) / rangeDb) * h;
                
                ctx.beginPath();
                ctx.arc(x, y, 4, 0, Math.PI * 2);
                ctx.fill();
                
                ctx.font = '10px monospace';
                ctx.textAlign = 'center';
                ctx.fillText(`${(p.freq/1e6).toFixed(3)}`, x, y - 8);
            }
        }
    }
}

class WaterfallChart {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) {
            throw new Error(`Waterfall canvas element not found: ${canvasId}`);
        }
        this.ctx = this.canvas.getContext('2d');

        this.historySize = 300; // Number of lines to keep
        this.offscreenCanvas = document.createElement('canvas');
        this.offscreenCtx = this.offscreenCanvas.getContext('2d', { willReadFrequently: true });
        if (!this.offscreenCtx) {
            this.offscreenCtx = this.offscreenCanvas.getContext('2d');
        }
        if (!this.offscreenCtx) {
            throw new Error('Unable to create offscreen 2D context for waterfall chart.');
        }

        window.addEventListener('resize', () => this.resize());
        this.resize();
    }
    
    initOffscreen() {
        this.offscreenCanvas.width = this.canvas.width || 1024;
        this.offscreenCanvas.height = this.historySize;
        this.offscreenCtx.fillStyle = '#0f172a';
        this.offscreenCtx.fillRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);
    }
    
    resize() {
        const parent = this.canvas.parentElement;
        this.canvas.width = parent.clientWidth;
        this.canvas.height = parent.clientHeight;
        this.initOffscreen();
    }
    
    getColor(db) {
        // Simple colormap (Turbo-like or Jet-like)
        // db range approx -120 to -20
        const min = -110;
        const max = -30;
        let norm = (db - min) / (max - min);
        if (norm < 0) norm = 0;
        if (norm > 1) norm = 1;
        
        // Jet colormap approximation
        const r = Math.max(0, Math.min(255, Math.round(255 * (1.5 - Math.abs(1 - 4 * (norm - 0.5))))));
        const g = Math.max(0, Math.min(255, Math.round(255 * (1.5 - Math.abs(1 - 4 * (norm - 0.25))))));
        const b = Math.max(0, Math.min(255, Math.round(255 * (1.5 - Math.abs(1 - 4 * norm)))));
        
        return [r, g, b, 255];
    }
    
    appendData(mags) {
        const w = this.offscreenCanvas.width;
        const h = this.offscreenCanvas.height;
        
        // Shift everything down by 1 pixel
        // 1. Get current image (except last row)
        const imageData = this.offscreenCtx.getImageData(0, 0, w, h - 1);
        // 2. Put it back at y=1
        this.offscreenCtx.putImageData(imageData, 0, 1);
        
        // Draw new row at y=0
        const newRow = this.offscreenCtx.createImageData(w, 1);
        const data = newRow.data;
        
        const len = mags.length;
        for (let x = 0; x < w; x++) {
            // Map x to index in mags
            const idx = Math.floor((x / w) * len);
            const db = mags[idx];
            const color = this.getColor(db);
            
            const i = x * 4;
            data[i] = color[0];
            data[i+1] = color[1];
            data[i+2] = color[2];
            data[i+3] = color[3];
        }
        
        this.offscreenCtx.putImageData(newRow, 0, 0);
        this.draw();
    }
    
    draw() {
        this.ctx.drawImage(this.offscreenCanvas, 0, 0, this.canvas.width, this.canvas.height);
    }
}
