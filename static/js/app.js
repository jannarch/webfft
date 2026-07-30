/* static/js/app.js */

console.log('static/js/app.js loaded');

document.addEventListener('DOMContentLoaded', () => {
    console.log('DOMContentLoaded event fired');
    try {
        console.log('Web-SDR app initializing...');

        window.addEventListener('error', (event) => {
            console.error('Global JS error:', event.message, 'at', event.filename + ':' + event.lineno + ':' + event.colno);
            if (typeof logDebug === 'function') logDebug(`Global JS error: ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`);
        });

        // ─── Initialize Components ───────────────────────────────────────────────
        let spectrum = null;
        let waterfall = null;
        let map = null;
        let audioPlayer = null;
        
        let receiverLocation = { lat: -6.2088, lng: 106.8456 };
        function applyReceiverLocation(lat, lng) {
            receiverLocation = { lat, lng };
            if (map && typeof map.setReceiverLocation === 'function') {
                map.setReceiverLocation(lat, lng);
            }
        }
        function getActiveReceiverLocation() {
            if (map && typeof map.getReceiverLocation === 'function') {
                const pos = map.getReceiverLocation();
                if (pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lng)) {
                    receiverLocation = { lat: pos.lat, lng: pos.lng };
                    return receiverLocation;
                }
            }
            return receiverLocation;
        }
        try {
            spectrum = new SpectrumChart('spectrum-canvas');
            waterfall = new WaterfallChart('waterfall-canvas');
            // Link waterfall so it follows spectrum zoom/pan
            spectrum.setWaterfall(waterfall);
            spectrum.onCopy = classifySignal;
        } catch (err) {
            console.error('Failed to initialize charts:', err);
            if (typeof logDebug === 'function') logDebug('Failed to initialize charts: ' + err.message);
        }

        try {
            map = new LocalizationMap('map-container');
            applyReceiverLocation(-6.2088, 106.8456);
        } catch (err) {
            console.error('Failed to initialize map:', err);
            if (typeof logDebug === 'function') logDebug('Failed to initialize map: ' + err.message);
        }

        try {
            audioPlayer = new WebAudioPlayer(48000);
        } catch (err) {
            console.error('Failed to initialize audio player:', err);
            if (typeof logDebug === 'function') logDebug('Failed to initialize audio player: ' + err.message);
        }

    // ─── DOM Elements ────────────────────────────────────────────────────────
    const startFreqInput = document.getElementById('start-freq-input');
    const stopFreqInput = document.getElementById('stop-freq-input');
    const scanModeInput = document.getElementById('scan-mode-input');
    const sweepStepInput = document.getElementById('sweep-step-input');
    const dwellTimeInput = document.getElementById('dwell-time-input');
    const lnaInput = document.getElementById('lna-input');
    const lnaVal = document.getElementById('lna-val');
    const vgaInput = document.getElementById('vga-input');
    const vgaVal = document.getElementById('vga-val');
    const ampInput = document.getElementById('amp-input');
    const threshInput = document.getElementById('thresh-input');
    const threshVal = document.getElementById('thresh-val');
    const snrInput = document.getElementById('snr-input');
    const snrVal = document.getElementById('snr-val');
    
    const btnStart = document.getElementById('btn-start');
    const btnStop = document.getElementById('btn-stop');
    const btnRecord = document.getElementById('btn-record');
    const btnRefreshDet = document.getElementById('btn-refresh-det');
    const btnReload = document.getElementById('btn-reload');
    const btnCaptureLoc = document.getElementById('btn-capture-loc');
    const btnResetLoc = document.getElementById('btn-reset-loc');
    const btnEstimateLoc = document.getElementById('btn-estimate-loc');
    const btnUseGps = document.getElementById('btn-use-gps');
    const btnSetReceiver = document.getElementById('btn-set-receiver');
    const receiverCoordsInput = document.getElementById('receiver-coords-input');
    const classifyFreqInput = document.getElementById('classify-freq-input');
    const btnClassify = document.getElementById('btn-classify');
    const btnListen = document.getElementById('btn-listen');
    const volumeInput = document.getElementById('volume-input');
    const volumeVal = document.getElementById('volume-val');
    const audioControls = document.getElementById('audio-controls');
    const debugLog = document.getElementById('debug-log');
    
    const statusText = document.getElementById('status-text');
    const statusIndicator = document.getElementById('status-indicator');
    const detectionsTableBody = document.querySelector('#detections-table tbody');
    
    const classificationDisplay = document.getElementById('classification-display');
    const classificationDetails = document.getElementById('classification-details');
    const classType = document.getElementById('class-type');
    const classMod = document.getElementById('class-mod');
    const classBw = document.getElementById('class-bw');
    const classConf = document.getElementById('class-conf');

    // ─── Debug Logging Helper ───────────────────────────────────────────────
    function logDebug(message) {
        console.log(message);
        if (typeof debugLog !== 'undefined' && debugLog) {
            const time = new Date().toLocaleTimeString();
            if (debugLog.innerText === 'No debug messages yet.') debugLog.innerText = '';
            debugLog.innerText = `${time} - ${message}\n${debugLog.innerText}`.trim();
        }
    }

    // ─── WebSocket Connection ────────────────────────────────────────────────
    let ws = null;
    
    function connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${protocol}//${window.location.host}/ws/spectrum`);
        
        ws.onopen = () => {
            logDebug("WebSocket connected.");
        };
        
        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            spectrum.updateData(data.freqs_hz, data.magnitude_db, data.peaks);
            waterfall.appendData(data.magnitude_db, data.freqs_hz);
        };
        
        ws.onclose = () => {
            logDebug("WebSocket closed. Reconnecting in 2s...");
            setTimeout(connectWebSocket, 2000);
        };
    }

    // ─── REST API Calls ──────────────────────────────────────────────────────
    async function fetchStatus() {
        try {
            const res = await fetch('/api/status');
            const data = await res.json();
            
            // Update UI
            if (data.mode === 'hardware') {
                statusIndicator.className = 'status-badge hardware';
                statusText.innerText = 'HARDWARE';
            } else {
                statusIndicator.className = 'status-badge simulation';
                statusText.innerText = 'SIMULATION';
            }

            // Update freq display in header
            const freqDisplay = document.getElementById('freq-display');
            if (freqDisplay) {
                freqDisplay.innerText = (data.config.center_frequency_hz / 1e6).toFixed(3) + ' MHz';
            }
            
            if (data.running) {
                btnStart.disabled = true;
                btnStop.disabled = false;
            } else {
                btnStart.disabled = false;
                btnStop.disabled = true;
            }
            
            // Sync inputs if not focused to avoid overriding user typing
            if (data.config.scan_mode === 'single') {
                const center = data.config.center_frequency_hz;
                const sr = data.config.sample_rate_hz;
                const start = (center - sr / 2) / 1e6;
                const stop = (center + sr / 2) / 1e6;
                if (document.activeElement !== startFreqInput) startFreqInput.value = start.toFixed(1);
                if (document.activeElement !== stopFreqInput) stopFreqInput.value = stop.toFixed(1);
                
                document.getElementById('row-sweep-step').style.display = 'none';
                document.getElementById('row-dwell-time').style.display = 'none';
            } else {
                const start = data.config.sweep_start_hz / 1e6;
                const stop = data.config.sweep_stop_hz / 1e6;
                if (document.activeElement !== startFreqInput) startFreqInput.value = start.toFixed(1);
                if (document.activeElement !== stopFreqInput) stopFreqInput.value = stop.toFixed(1);
                
                document.getElementById('row-sweep-step').style.display = 'flex';
                document.getElementById('row-dwell-time').style.display = 'flex';
            }
            if (document.activeElement !== scanModeInput) scanModeInput.value = data.config.scan_mode;
            if (document.activeElement !== sweepStepInput) sweepStepInput.value = (data.config.sweep_step_hz / 1e6).toFixed(1);
            if (document.activeElement !== dwellTimeInput) dwellTimeInput.value = data.config.dwell_time_ms;
            
            lnaInput.value = data.config.lna_gain;
            lnaVal.innerText = data.config.lna_gain;
            vgaInput.value = data.config.vga_gain;
            vgaVal.innerText = data.config.vga_gain;
            ampInput.checked = data.config.amp_enabled;
            
            threshInput.value = data.config.threshold_db;
            threshVal.innerText = data.config.threshold_db;
            spectrum.setThreshold(data.config.threshold_db);
            
            if (data.recording.active) {
                btnRecord.innerHTML = `⏹ Stop Rec (${(data.recording.elapsed_sec).toFixed(0)}s)`;
                btnRecord.classList.remove('btn-ghost');
                btnRecord.classList.add('btn-danger');
            } else {
                btnRecord.innerHTML = `⏺ Record IQ`;
                btnRecord.classList.remove('btn-danger');
                btnRecord.classList.add('btn-ghost');
            }
            
        } catch (e) {
            console.error("Status fetch failed:", e);
            logDebug("Status fetch failed: " + e.message || e);
        }
    }
    
    async function updateConfig(payload) {
        await fetch('/api/config', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        fetchStatus();
    }
    
    async function fetchDetections() {
        try {
            const res = await fetch('/api/detections');
            const rows = await res.json();
            
            detectionsTableBody.innerHTML = '';
            map.clearDetections();
            
            rows.forEach(r => {
                const tr = document.createElement('tr');
                const pwr = r.power_dbm;
                const pwrClass = pwr > -60 ? 'pwr-high' : pwr > -80 ? 'pwr-mid' : 'pwr-low';
                tr.innerHTML = `
                    <td>${r.timestamp.split('.')[0].replace('T',' ')}</td>
                    <td>${(r.frequency_hz / 1e6).toFixed(3)}</td>
                    <td class="${pwrClass}">${pwr.toFixed(1)}</td>
                    <td>${(r.confidence * 100).toFixed(0)}%</td>
                `;
                detectionsTableBody.appendChild(tr);
                map.addDetection(r.id, r.latitude, r.longitude, r.frequency_hz, r.power_dbm);
            });
        } catch (e) {
            console.error("Failed to fetch detections:", e);
        }
    }
    
    async function classifySignal(freqHz) {
        try {
            const res = await fetch(`/api/classify?frequency_hz=${freqHz}`);
            const data = await res.json();
            
            classificationDisplay.style.display = 'none';
            classificationDetails.style.display = 'flex';
            
            classType.textContent = data.signal_type || 'Unknown';
            classMod.textContent = data.modulation || 'N/A';
            classBw.textContent = data.typical_bandwidth_khz ? `${data.typical_bandwidth_khz} kHz` : 'N/A';
            classConf.textContent = data.confidence === 'high' ? 'High' : 'Low';
            
            logDebug(`Classified ${(freqHz/1e6).toFixed(4)} MHz as ${data.signal_type}`);
        } catch (e) {
            console.error("Classification failed:", e);
            logDebug("Classification failed: " + (e.message || e));
        }
    }

    // ─── Event Listeners ─────────────────────────────────────────────────────
    
    function updateTuningFromRange() {
        const start = parseFloat(startFreqInput.value) * 1e6;
        const stop = parseFloat(stopFreqInput.value) * 1e6;
        if (isNaN(start) || isNaN(stop) || start >= stop) return;
        
        const mode = scanModeInput.value;
        if (mode === 'single') {
            const sr = stop - start;
            const center = start + (sr / 2);
            updateConfig({
                center_frequency_hz: center,
                sample_rate_hz: sr,
                scan_mode: mode
            });
        } else {
            updateConfig({
                sweep_start_hz: start,
                sweep_stop_hz: stop,
                scan_mode: mode
            });
        }
    }

    startFreqInput.addEventListener('change', updateTuningFromRange);
    stopFreqInput.addEventListener('change', updateTuningFromRange);

    scanModeInput.addEventListener('change', (e) => {
        updateTuningFromRange();
    });

    sweepStepInput.addEventListener('change', (e) => {
        updateConfig({ sweep_step_hz: parseFloat(e.target.value) * 1e6 });
    });

    dwellTimeInput.addEventListener('change', (e) => {
        updateConfig({ dwell_time_ms: parseFloat(e.target.value) });
    });
    
    lnaInput.addEventListener('input', (e) => {
        lnaVal.innerText = e.target.value;
    });
    lnaInput.addEventListener('change', (e) => {
        updateConfig({ lna_gain: parseInt(e.target.value) });
    });
    
    vgaInput.addEventListener('input', (e) => {
        vgaVal.innerText = e.target.value;
    });
    vgaInput.addEventListener('change', (e) => {
        updateConfig({ vga_gain: parseInt(e.target.value) });
    });
    
    ampInput.addEventListener('change', (e) => {
        updateConfig({ amp_enabled: e.target.checked });
    });
    
    threshInput.addEventListener('input', (e) => {
        threshVal.innerText = e.target.value;
        spectrum.setThreshold(parseFloat(e.target.value));
    });
    threshInput.addEventListener('change', (e) => {
        updateConfig({ threshold_db: parseFloat(e.target.value) });
    });
    
    snrInput.addEventListener('input', (e) => {
        snrVal.innerText = e.target.value;
    });
    snrInput.addEventListener('change', (e) => {
        updateConfig({ min_snr_db: parseFloat(e.target.value) });
    });
    
    btnStart.addEventListener('click', async () => {
        await fetch('/api/start', {method: 'POST'});
        fetchStatus();
    });
    
    btnStop.addEventListener('click', async () => {
        await fetch('/api/stop', {method: 'POST'});
        fetchStatus();
    });
    
    btnRecord.addEventListener('click', async () => {
        if (btnRecord.classList.contains('btn-danger')) {
            await fetch('/api/record/stop', {method: 'POST'});
        } else {
            await fetch('/api/record/start', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({notes: "Web Recording"})
            });
        }
        fetchStatus();
    });
    
    btnClassify.addEventListener('click', async () => {
        const mhz = parseFloat(classifyFreqInput.value);
        if (!Number.isFinite(mhz) || mhz <= 0) {
            logDebug('Invalid frequency for classification');
            return;
        }
        await classifySignal(mhz * 1e6);
    });
    
    classifyFreqInput.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
            await btnClassify.click();
        }
    });
    
    btnRefreshDet.addEventListener('click', fetchDetections);
    logDebug('Attached refresh button');

    btnSetReceiver.addEventListener('click', () => {
        const parts = receiverCoordsInput.value.split(/[\s,]+/);
        const lat = parseFloat(parts[0]);
        const lon = parseFloat(parts[1]);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
            applyReceiverLocation(lat, lon);
            logDebug(`Receiver location set manually to ${lat}, ${lon}`);
        } else {
            logDebug('Invalid manual receiver coordinates (format should be: lat, lon)');
        }
    });

    btnUseGps.addEventListener('click', () => {
        if (!navigator.geolocation) {
            alert('Browser GPS is not available.');
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const lat = pos.coords.latitude;
                const lon = pos.coords.longitude;
                receiverCoordsInput.value = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
                applyReceiverLocation(lat, lon);
                logDebug(`Receiver location updated from GPS: ${lat}, ${lon}`);
            },
            (err) => {
                console.error('GPS failed:', err);
                logDebug('GPS failed: ' + err.message);
                alert('Unable to get GPS location. Use manual input instead.');
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
        );
    });

    btnCaptureLoc.addEventListener('click', async () => {
        try {
            const loc = getActiveReceiverLocation();
            const payload = {
                latitude: loc.lat,
                longitude: loc.lng,
                rssi_dbm: null,
                label: 'Captured from UI'
            };
            const res = await fetch('/api/localization/capture', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            logDebug(`Captured localization point (${data.count} total)`);
            map.renderLocalizationPoints(data.point, data.estimate);
        } catch (e) {
            console.error('Capture failed:', e);
            logDebug('Capture failed: ' + (e.message || e));
        }
    });

    btnResetLoc.addEventListener('click', async () => {
        try {
            await fetch('/api/localization/reset', {method: 'POST'});
            map.clearLocalization();
            logDebug('Localization points reset');
        } catch (e) {
            console.error('Reset failed:', e);
            logDebug('Reset failed: ' + (e.message || e));
        }
    });

    btnEstimateLoc.addEventListener('click', async () => {
        try {
            const res = await fetch('/api/localization/estimate');
            const data = await res.json();
            map.showEstimate(data);
            logDebug(`Estimate: ${data.message}`);
        } catch (e) {
            console.error('Estimate failed:', e);
            logDebug('Estimate failed: ' + (e.message || e));
        }
    });

    btnReload.addEventListener('click', async () => {
        logDebug('Reload button clicked');
        try {
            btnReload.disabled = true;
            btnReload.innerText = 'Reloading...';
            await fetch('/api/reload', {method: 'POST'});
            await fetchStatus();
        } catch (e) {
            console.error('Reload failed:', e);
            logDebug('Reload failed: ' + (e.message || e));
            alert('Hardware reload failed. See console for details.');
        } finally {
            btnReload.disabled = false;
            btnReload.innerText = 'Reload Hardware';
        }
    });

    // Audio Playback
    if (btnListen && audioPlayer) {
        btnListen.addEventListener('click', () => {
            if (audioPlayer.isPlaying) {
                audioPlayer.stop();
                btnListen.innerHTML = '▶ Listen';
                btnListen.classList.replace('btn-danger', 'btn-primary');
                if (audioControls) audioControls.style.display = 'none';
            } else {
                const freqHz = parseFloat(classifyFreqInput.value) * 1e6;
                if (!isNaN(freqHz)) {
                    audioPlayer.start(freqHz);
                    btnListen.innerHTML = '⏹ Stop';
                    btnListen.classList.replace('btn-primary', 'btn-danger');
                    if (audioControls) audioControls.style.display = 'flex';
                } else {
                    alert("Please enter a valid frequency to listen to.");
                }
            }
        });
    }

    if (volumeInput && audioPlayer) {
        volumeInput.addEventListener('input', (e) => {
            const vol = parseFloat(e.target.value);
            audioPlayer.setVolume(vol);
            if (volumeVal) volumeVal.innerText = Math.round(vol * 100) + '%';
        });
    }

    // ─── Boot ────────────────────────────────────────────────────────────────
    connectWebSocket();
    fetchStatus();
    fetchDetections();
    
    // Poll status every 2 seconds (for recording timer etc)
    setInterval(fetchStatus, 2000);
    setInterval(fetchDetections, 10000);
    console.log('Web-SDR app initialized successfully.');
    } catch (err) {
        console.error('Web-SDR initialization failed:', err);
        alert('Web-SDR initialization error. Check browser console.');
    }
});
