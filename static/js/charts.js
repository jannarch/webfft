/* static/js/charts.js */

class SpectrumChart {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');

        // Data
        this.freqs = [];
        this.mags  = [];
        this.peaks = [];
        this.threshold = -70;

        // View range in Hz (null = auto from data)
        this.viewStart = null; // Hz
        this.viewEnd   = null; // Hz
        this.minDb = -120;
        this.maxDb = 0;

        // Interaction state
        this._drag = null;       // { startX, startViewStart, startViewEnd }
        this._mouseFreq = null;  // Hz at current mouse position
        this._mousePwr  = null;  // dBm at current mouse position
        this._hoverPeak = null;  // nearest peak within snap radius

        // Linked waterfall
        this.waterfall = null;

        // Copy callback
        this.onCopy = null;

        this._bindInteraction();
        window.addEventListener('resize', () => this.resize());
        this.resize();
    }

    // Link a WaterfallChart so it follows this view
    setWaterfall(wf) {
        this.waterfall = wf;
    }

    _syncWaterfall() {
        if (this.waterfall) {
            this.waterfall.syncView(this.viewStart, this.viewEnd, this.freqs);
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    _freqRange() {
        if (this.freqs.length < 2) return { fMin: 0, fMax: 1 };
        return {
            fMin: this.viewStart ?? this.freqs[0],
            fMax: this.viewEnd   ?? this.freqs[this.freqs.length - 1],
        };
    }

    _xToFreq(x) {
        const w = this.canvas.width;
        const { fMin, fMax } = this._freqRange();
        return fMin + (x / w) * (fMax - fMin);
    }

    _freqToX(freq) {
        const w = this.canvas.width;
        const { fMin, fMax } = this._freqRange();
        return ((freq - fMin) / (fMax - fMin)) * w;
    }

    _yToDb(y) {
        const h = this.canvas.height;
        return this.maxDb - (y / h) * (this.maxDb - this.minDb);
    }

    _dbToY(db) {
        const h = this.canvas.height;
        return h - ((db - this.minDb) / (this.maxDb - this.minDb)) * h;
    }

    _freqToMag(freq) {
        if (!this.freqs.length) return null;
        const fMin = this.freqs[0];
        const fMax = this.freqs[this.freqs.length - 1];
        const t    = (freq - fMin) / (fMax - fMin);
        const idx  = Math.round(t * (this.freqs.length - 1));
        if (idx < 0 || idx >= this.mags.length) return null;
        return this.mags[idx];
    }

    _snapToPeak(freq, pxTolerance = 12) {
        if (!this.peaks || !this.peaks.length) return null;
        const { fMin, fMax } = this._freqRange();
        const w = this.canvas.width;
        const hzPerPx = (fMax - fMin) / w;
        const hzTol   = hzPerPx * pxTolerance;

        let nearest = null;
        let minDist = Infinity;
        for (const p of this.peaks) {
            const d = Math.abs(p.freq - freq);
            if (d < hzTol && d < minDist) {
                minDist = d;
                nearest = p;
            }
        }
        return nearest;
    }

    // ── Interaction ──────────────────────────────────────────────────────────

    _bindInteraction() {
        const c = this.canvas;

        // Hover tooltip
        c.addEventListener('mousemove', (e) => {
            const rect = c.getBoundingClientRect();
            const scaleX = c.width / rect.width;
            const scaleY = c.height / rect.height;
            const px = (e.clientX - rect.left) * scaleX;
            const py = (e.clientY - rect.top)  * scaleY;

            this._mouseFreq = this._xToFreq(px);
            this._mousePwr  = this._freqToMag(this._mouseFreq);
            this._hoverPeak = this._snapToPeak(this._mouseFreq);

            // Drag-pan
            if (this._drag) {
                const { fMin, fMax } = this._freqRange();
                const hzPerPx = (fMax - fMin) / c.width;
                const delta = (px - this._drag.startX) * hzPerPx;
                this.viewStart = this._drag.startViewStart - delta;
                this.viewEnd   = this._drag.startViewEnd   - delta;
                this._syncWaterfall();
            }

            this.draw();
        });

        c.addEventListener('mouseleave', () => {
            this._mouseFreq = null;
            this._mousePwr  = null;
            this._hoverPeak = null;
            if (this._drag) this._drag = null;
            this.draw();
        });

        // Drag start
        c.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            const rect = c.getBoundingClientRect();
            const scaleX = c.width / rect.width;
            const px = (e.clientX - rect.left) * scaleX;
            const { fMin, fMax } = this._freqRange();
            this._drag = {
                startX:         px,
                startViewStart: this.viewStart ?? fMin,
                startViewEnd:   this.viewEnd   ?? fMax,
            };
            c.style.cursor = 'grabbing';
            e.preventDefault();
        });

        c.addEventListener('mouseup', () => {
            this._drag = null;
            c.style.cursor = 'crosshair';
        });

        // Click: copy frequency to clipboard
        c.addEventListener('click', (e) => {
            if (!this._mouseFreq) return;
            const freqMHz = (this._mouseFreq / 1e6).toFixed(6);
            navigator.clipboard.writeText(freqMHz).then(() => {
                this._showCopiedToast(freqMHz);
                if (typeof this.onCopy === 'function') {
                    this.onCopy(this._mouseFreq);
                }
            }).catch(() => {
                prompt('Copy frequency (MHz):', freqMHz);
                if (typeof this.onCopy === 'function') {
                    this.onCopy(this._mouseFreq);
                }
            });
        });

        // Scroll to zoom
        c.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (!this.freqs.length) return;

            const rect = c.getBoundingClientRect();
            const scaleX = c.width / rect.width;
            const px = (e.clientX - rect.left) * scaleX;

            const { fMin, fMax } = this._freqRange();
            const pivotFreq = this._xToFreq(px);
            const span = fMax - fMin;
            const factor = e.deltaY > 0 ? 1.25 : 0.8; // zoom in/out

            const dataMin = this.freqs[0];
            const dataMax = this.freqs[this.freqs.length - 1];
            const minSpan = (dataMax - dataMin) * 0.01; // max 100× zoom

            let newSpan = span * factor;
            if (newSpan < minSpan) newSpan = minSpan;
            if (newSpan > (dataMax - dataMin)) {
                this.viewStart = null;
                this.viewEnd   = null;
                this._syncWaterfall();
                this.draw();
                return;
            }

            const t = (pivotFreq - fMin) / span;
            this.viewStart = Math.max(dataMin, pivotFreq - t * newSpan);
            this.viewEnd   = Math.min(dataMax, this.viewStart + newSpan);

            this._syncWaterfall();
            this.draw();
        }, { passive: false });

        // Double-click: reset zoom
        c.addEventListener('dblclick', () => {
            this.viewStart = null;
            this.viewEnd   = null;
            this._syncWaterfall();
            this.draw();
        });

        c.style.cursor = 'crosshair';
    }

    _showCopiedToast(freqMHz) {
        let toast = document.getElementById('spectrum-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'spectrum-toast';
            toast.style.cssText = `
                position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
                background:rgba(13,21,38,0.95); border:1px solid rgba(61,139,255,0.4);
                color:#e8f0ff; padding:8px 18px; border-radius:8px; font-size:0.82rem;
                font-family:'JetBrains Mono',monospace; z-index:9999;
                opacity:0; transition:opacity 0.2s;
                pointer-events:none;
            `;
            document.body.appendChild(toast);
        }
        toast.textContent = `📋 Copied: ${freqMHz} MHz`;
        toast.style.opacity = '1';
        clearTimeout(toast._timeout);
        toast._timeout = setTimeout(() => { toast.style.opacity = '0'; }, 2000);
    }

    // ── Public API ───────────────────────────────────────────────────────────

    resize() {
        const parent = this.canvas.parentElement;
        this.canvas.width  = parent.clientWidth;
        this.canvas.height = parent.clientHeight;
        this.draw();
    }

    updateData(freqs, mags, peaks) {
        this.freqs = freqs;
        this.mags  = mags;
        this.peaks = peaks;

        // Clamp view to data bounds if fully outside
        if (freqs.length) {
            const dMin = freqs[0];
            const dMax = freqs[freqs.length - 1];
            if (this.viewStart !== null && this.viewEnd !== null) {
                if (this.viewEnd < dMin || this.viewStart > dMax) {
                    this.viewStart = null;
                    this.viewEnd   = null;
                }
            }
        }

        this.draw();
    }

    setThreshold(val) {
        this.threshold = val;
        this.draw();
    }

    // ── Draw ─────────────────────────────────────────────────────────────────

    draw() {
        const w = this.canvas.width;
        const h = this.canvas.height;
        const ctx = this.ctx;

        ctx.clearRect(0, 0, w, h);

        // — No data placeholder —
        if (!this.freqs || this.freqs.length === 0) {
            ctx.fillStyle = '#3d5270';
            ctx.font = '13px Inter';
            ctx.textAlign = 'center';
            ctx.fillText('Waiting for data…', w / 2, h / 2);
            return;
        }

        const { fMin, fMax } = this._freqRange();
        const rangeDb = this.maxDb - this.minDb;

        // ── Grid (dB) ──────────────────────────────────────────────────────
        ctx.lineWidth = 1;
        for (let db = -100; db <= -20; db += 20) {
            const y = this._dbToY(db);
            ctx.strokeStyle = 'rgba(255,255,255,0.05)';
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();

            ctx.fillStyle = 'rgba(255,255,255,0.25)';
            ctx.font = '9px JetBrains Mono';
            ctx.textAlign = 'left';
            ctx.fillText(`${db}`, 4, y - 3);
        }

        // ── Grid (Freq vertical lines) ─────────────────────────────────────
        const spanMHz = (fMax - fMin) / 1e6;
        const freqStep = this._niceStep(spanMHz, 8); // target ~8 lines
        const firstTick = Math.ceil(fMin / 1e6 / freqStep) * freqStep;
        for (let mhz = firstTick; mhz <= fMax / 1e6; mhz += freqStep) {
            const x = this._freqToX(mhz * 1e6);
            ctx.strokeStyle = 'rgba(255,255,255,0.05)';
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();

            ctx.fillStyle = 'rgba(255,255,255,0.25)';
            ctx.font = '9px JetBrains Mono';
            ctx.textAlign = 'center';
            const label = freqStep < 1 ? mhz.toFixed(2) : freqStep < 10 ? mhz.toFixed(1) : mhz.toFixed(0);
            ctx.fillText(`${label}`, x, h - 4);
        }

        // ── Threshold line ─────────────────────────────────────────────────
        const threshY = this._dbToY(this.threshold);
        ctx.strokeStyle = 'rgba(240,64,96,0.6)';
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(0, threshY);
        ctx.lineTo(w, threshY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(240,64,96,0.7)';
        ctx.font = '9px JetBrains Mono';
        ctx.textAlign = 'right';
        ctx.fillText(`${this.threshold} dBm`, w - 4, threshY - 3);

        // ── Spectrum fill ──────────────────────────────────────────────────
        const visStart = Math.max(0, Math.round(((fMin - this.freqs[0]) / (this.freqs[this.freqs.length-1] - this.freqs[0])) * (this.freqs.length - 1)));
        const visEnd   = Math.min(this.freqs.length - 1, Math.round(((fMax - this.freqs[0]) / (this.freqs[this.freqs.length-1] - this.freqs[0])) * (this.freqs.length - 1)));

        // Gradient fill
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0,   'rgba(61,139,255,0.35)');
        grad.addColorStop(0.7, 'rgba(61,139,255,0.05)');
        grad.addColorStop(1,   'rgba(61,139,255,0)');

        ctx.beginPath();
        let first = true;
        for (let i = visStart; i <= visEnd; i++) {
            const x = this._freqToX(this.freqs[i]);
            const y = this._dbToY(this.mags[i]);
            if (first) { ctx.moveTo(x, y); first = false; }
            else ctx.lineTo(x, y);
        }
        // Close path for fill
        const lastX = this._freqToX(this.freqs[Math.min(visEnd, this.freqs.length-1)]);
        const firstX = this._freqToX(this.freqs[visStart]);
        ctx.lineTo(lastX, h);
        ctx.lineTo(firstX, h);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        // Spectrum line
        ctx.beginPath();
        ctx.strokeStyle = '#3d8bff';
        ctx.lineWidth = 1.5;
        first = true;
        for (let i = visStart; i <= visEnd; i++) {
            const x = this._freqToX(this.freqs[i]);
            const y = this._dbToY(this.mags[i]);
            if (first) { ctx.moveTo(x, y); first = false; }
            else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // ── Peaks ──────────────────────────────────────────────────────────
        for (const p of (this.peaks || [])) {
            if (p.freq < fMin || p.freq > fMax) continue;
            const px = this._freqToX(p.freq);
            const py = this._dbToY(p.pwr);
            const isHovered = this._hoverPeak && this._hoverPeak.freq === p.freq;

            ctx.beginPath();
            ctx.arc(px, py, isHovered ? 6 : 4, 0, Math.PI * 2);
            ctx.fillStyle = isHovered ? '#ff3355' : '#ef4444';
            if (isHovered) ctx.shadowColor = '#ff3355', ctx.shadowBlur = 10;
            ctx.fill();
            ctx.shadowBlur = 0;

            if (isHovered) {
                // Extended label on hover
                this._drawPeakTooltip(ctx, px, py, p);
            } else {
                ctx.fillStyle = 'rgba(255,255,255,0.7)';
                ctx.font = '9px JetBrains Mono';
                ctx.textAlign = 'center';
                ctx.fillText(`${(p.freq / 1e6).toFixed(3)}`, px, py - 9);
            }
        }

        // ── Crosshair + hover tooltip ──────────────────────────────────────
        if (this._mouseFreq !== null && !this._drag) {
            const mx = this._freqToX(this._mouseFreq);
            // Vertical crosshair
            ctx.strokeStyle = 'rgba(255,255,255,0.2)';
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(mx, 0);
            ctx.lineTo(mx, h);
            ctx.stroke();
            ctx.setLineDash([]);

            // Tooltip box
            if (this._mousePwr !== null && !this._hoverPeak) {
                this._drawCrosshairTooltip(ctx, mx, this._mouseFreq, this._mousePwr, w, h);
            }
        }

        // ── Zoom indicator ─────────────────────────────────────────────────
        if (this.viewStart !== null) {
            ctx.fillStyle = 'rgba(61,139,255,0.6)';
            ctx.font = '9px JetBrains Mono';
            ctx.textAlign = 'left';
            ctx.fillText(`🔍 ${(spanMHz).toFixed(3)} MHz span  •  dblclick to reset`, 6, 12);
        }
    }

    _drawCrosshairTooltip(ctx, mx, freq, pwr, w, h) {
        const freqStr = `${(freq / 1e6).toFixed(4)} MHz`;
        const pwrStr  = `${pwr.toFixed(1)} dBm`;
        const text    = `${freqStr}   ${pwrStr}`;

        ctx.font = '11px JetBrains Mono';
        const tw = ctx.measureText(text).width;
        const bw = tw + 16;
        const bh = 22;
        const margin = 6;

        let bx = mx + 10;
        if (bx + bw > w - margin) bx = mx - bw - 10;
        const by = margin;

        ctx.fillStyle = 'rgba(13,21,38,0.9)';
        ctx.strokeStyle = 'rgba(61,139,255,0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, 4);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#e8f0ff';
        ctx.textAlign = 'left';
        ctx.fillText(text, bx + 8, by + 15);
    }

    _drawPeakTooltip(ctx, px, py, p) {
        const w = this.canvas.width;
        const label = [
            `${(p.freq / 1e6).toFixed(4)} MHz`,
            `${p.pwr.toFixed(1)} dBm`,
            `Click to copy`
        ];
        const lineH = 16;
        const bh = label.length * lineH + 12;
        const bw = 150;
        let bx = px + 10;
        if (bx + bw > w - 8) bx = px - bw - 10;
        const by = Math.max(4, py - bh - 8);

        ctx.fillStyle = 'rgba(13,21,38,0.93)';
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, 5);
        ctx.fill();
        ctx.stroke();

        label.forEach((line, i) => {
            ctx.fillStyle = i === 2 ? 'rgba(61,139,255,0.7)' : '#e8f0ff';
            ctx.font = i === 2 ? '9px JetBrains Mono' : '11px JetBrains Mono';
            ctx.textAlign = 'left';
            ctx.fillText(line, bx + 8, by + 16 + i * lineH);
        });
    }

    _niceStep(rangeVal, targetSteps) {
        const raw = rangeVal / targetSteps;
        const mag = Math.pow(10, Math.floor(Math.log10(raw)));
        const norm = raw / mag;
        let nice;
        if (norm < 1.5) nice = 1;
        else if (norm < 3.5) nice = 2;
        else if (norm < 7.5) nice = 5;
        else nice = 10;
        return nice * mag;
    }
}


// ─────────────────────────────────────────────────────────────────────────────
//  WaterfallChart — view-aware, follows SpectrumChart zoom/pan
// ─────────────────────────────────────────────────────────────────────────────

class WaterfallChart {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) throw new Error(`Waterfall canvas not found: ${canvasId}`);
        this.ctx = this.canvas.getContext('2d');

        this.historySize = 300;

        // Offscreen stores the FULL-width history (never cropped)
        this.offscreenCanvas = document.createElement('canvas');
        this.offscreenCtx = this.offscreenCanvas.getContext('2d', { willReadFrequently: true })
                         || this.offscreenCanvas.getContext('2d');
        if (!this.offscreenCtx) throw new Error('Unable to create offscreen 2D context.');

        // Frequency bounds of the data in the offscreen canvas
        this.dataMin = null; // Hz
        this.dataMax = null; // Hz

        // Current view (set by SpectrumChart.syncView); null = show all
        this.viewStart = null;
        this.viewEnd   = null;

        window.addEventListener('resize', () => this.resize());
        this.resize();
    }

    initOffscreen() {
        this.offscreenCanvas.width  = this.canvas.width  || 1024;
        this.offscreenCanvas.height = this.historySize;
        this.offscreenCtx.fillStyle = '#080e1a';
        this.offscreenCtx.fillRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);
    }

    resize() {
        const parent = this.canvas.parentElement;
        this.canvas.width  = parent.clientWidth;
        this.canvas.height = parent.clientHeight;
        this.initOffscreen();
    }

    // Called by SpectrumChart whenever its view changes
    syncView(viewStart, viewEnd, freqs) {
        this.viewStart = viewStart;
        this.viewEnd   = viewEnd;
        if (freqs && freqs.length >= 2) {
            this.dataMin = freqs[0];
            this.dataMax = freqs[freqs.length - 1];
        }
        this.draw();
    }

    getColor(db) {
        const min = -110, max = -30;
        let n = Math.max(0, Math.min(1, (db - min) / (max - min)));
        const r = Math.max(0, Math.min(255, Math.round(255 * (1.5 - Math.abs(1 - 4 * (n - 0.5))))));
        const g = Math.max(0, Math.min(255, Math.round(255 * (1.5 - Math.abs(1 - 4 * (n - 0.25))))));
        const b = Math.max(0, Math.min(255, Math.round(255 * (1.5 - Math.abs(1 - 4 * n)))));
        return [r, g, b, 255];
    }

    // mags     — magnitude array for this frame
    // freqs    — corresponding frequency array (used to store data bounds)
    appendData(mags, freqs) {
        // Store frequency bounds on first data
        if (freqs && freqs.length >= 2) {
            this.dataMin = freqs[0];
            this.dataMax = freqs[freqs.length - 1];
        }

        const ow = this.offscreenCanvas.width;
        const oh = this.offscreenCanvas.height;

        // Scroll: shift everything down by 1 row
        const imageData = this.offscreenCtx.getImageData(0, 0, ow, oh - 1);
        this.offscreenCtx.putImageData(imageData, 0, 1);

        // Draw new row at y=0 (always full width = full frequency range)
        const newRow = this.offscreenCtx.createImageData(ow, 1);
        const data = newRow.data;
        const len  = mags.length;

        for (let x = 0; x < ow; x++) {
            const idx   = Math.floor((x / ow) * len);
            const color = this.getColor(mags[idx]);
            const i = x * 4;
            data[i] = color[0]; data[i+1] = color[1];
            data[i+2] = color[2]; data[i+3] = color[3];
        }
        this.offscreenCtx.putImageData(newRow, 0, 0);
        this.draw();
    }

    draw() {
        const w  = this.canvas.width;
        const h  = this.canvas.height;
        const ow = this.offscreenCanvas.width;
        const oh = this.offscreenCanvas.height;
        const ctx = this.ctx;

        // If a view window is active AND we have data bounds, crop the offscreen
        if (
            this.viewStart !== null && this.viewEnd !== null &&
            this.dataMin   !== null && this.dataMax !== null &&
            this.dataMax > this.dataMin
        ) {
            const dataSpan = this.dataMax - this.dataMin;
            const srcX = Math.max(0, ((this.viewStart - this.dataMin) / dataSpan) * ow);
            const srcEnd = Math.min(ow, ((this.viewEnd - this.dataMin) / dataSpan) * ow);
            const srcW = srcEnd - srcX;
            if (srcW > 0) {
                ctx.clearRect(0, 0, w, h);
                ctx.drawImage(this.offscreenCanvas, srcX, 0, srcW, oh, 0, 0, w, h);
            }
        } else {
            // Full view — show everything
            ctx.drawImage(this.offscreenCanvas, 0, 0, w, h);
        }
    }
}
