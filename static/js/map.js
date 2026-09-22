/* static/js/map.js */

class LocalizationMap {
    constructor(containerId) {
        this.map = L.map(containerId).setView([-6.2088, 106.8456], 13); // Default Jakarta
        this.localizationPoints = [];
        this.estimateMarker = null;
        this.estimateCircle = null;
        
        // Dark theme map tiles (Esri World Dark Gray Base - 100% free, no API key required)
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
            attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
            maxZoom: 16
        }).addTo(this.map);
        
        this.markers = L.layerGroup().addTo(this.map);
        this.receiverMarker = null;
        
        // Custom icons
        this.txIcon = L.icon({
            iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-red.png',
            shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
            iconSize: [25, 41],
            iconAnchor: [12, 41],
            popupAnchor: [1, -34],
            shadowSize: [41, 41]
        });
        
        this.rxIcon = L.icon({
            iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-green.png',
            shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
            iconSize: [25, 41],
            iconAnchor: [12, 41],
            popupAnchor: [1, -34],
            shadowSize: [41, 41]
        });
    }
    
    setReceiverLocation(lat, lng) {
        if (this.receiverMarker) {
            this.receiverMarker.setLatLng([lat, lng]);
        } else {
            this.receiverMarker = L.marker([lat, lng], {icon: this.rxIcon})
                .addTo(this.map)
                .bindPopup("<b>SDR Receiver</b>");
        }
        this.map.panTo([lat, lng]);
    }

    getReceiverLocation() {
        if (this.receiverMarker) {
            return this.receiverMarker.getLatLng();
        }
        return this.map.getCenter();
    }

    renderLocalizationPoints(point, estimate) {
        if (!point) return;
        const marker = L.marker([point.latitude, point.longitude], {icon: this.txIcon})
            .addTo(this.markers)
            .bindPopup(`<b>${point.label}</b><br>RSSI: ${point.rssi_dbm.toFixed(1)} dBm`);
        this.localizationPoints.push(marker);
        if (estimate && estimate.latitude && estimate.longitude) {
            this.showEstimate(estimate);
        }
    }

    showEstimate(estimate) {
        if (!estimate || !estimate.latitude || !estimate.longitude) return;
        if (this.estimateMarker) {
            this.estimateMarker.setLatLng([estimate.latitude, estimate.longitude]);
        } else {
            this.estimateMarker = L.marker([estimate.latitude, estimate.longitude], {icon: this.txIcon})
                .addTo(this.markers)
                .bindPopup(`<b>Estimated Source</b><br>${estimate.method}<br>Confidence: ${estimate.confidence_radius_m?.toFixed(0)} m`);
        }
        if (this.estimateCircle) {
            this.estimateCircle.setLatLng([estimate.latitude, estimate.longitude]);
            this.estimateCircle.setRadius(Math.max(estimate.confidence_radius_m || 500, 100));
        } else {
            this.estimateCircle = L.circle([estimate.latitude, estimate.longitude], {
                color: 'orange',
                fillColor: '#f59e0b',
                fillOpacity: 0.15,
                radius: Math.max(estimate.confidence_radius_m || 500, 100)
            }).addTo(this.markers);
        }
        this.map.panTo([estimate.latitude, estimate.longitude]);
    }

    clearLocalization() {
        this.localizationPoints.forEach(marker => this.markers.removeLayer(marker));
        this.localizationPoints = [];
        if (this.estimateMarker) {
            this.markers.removeLayer(this.estimateMarker);
            this.estimateMarker = null;
        }
        if (this.estimateCircle) {
            this.markers.removeLayer(this.estimateCircle);
            this.estimateCircle = null;
        }
    }
    
    addDetection(id, lat, lng, freq, power) {
        if (!lat || !lng) return;
        
        const m = L.marker([lat, lng], {icon: this.txIcon});
        m.bindPopup(`
            <b>Suspect Transmitter #${id}</b><br>
            Freq: ${(freq/1e6).toFixed(3)} MHz<br>
            Power: ${power.toFixed(1)} dBm
        `);
        this.markers.addLayer(m);
        
        // Add uncertainty circle
        L.circle([lat, lng], {
            color: 'red',
            fillColor: '#f03',
            fillOpacity: 0.1,
            radius: 500 // 500m radius estimation
        }).addTo(this.markers);
    }
    
    clearDetections() {
        this.markers.clearLayers();
    }

    renderTransmitterMarkers(stations, rxPos) {
        if (!this.stationLayerGroup) {
            this.stationLayerGroup = L.layerGroup().addTo(this.map);
        }
        this.stationLayerGroup.clearLayers();

        if (!stations || !Array.isArray(stations) || stations.length === 0) return;

        const rx = rxPos || this.getReceiverLocation();
        const bounds = L.latLngBounds();
        if (rx && Number.isFinite(rx.lat) && Number.isFinite(rx.lng)) {
            bounds.extend([rx.lat, rx.lng]);
        }

        let count = 0;
        const addedCoords = new Set();

        for (const st of stations) {
            if (!st.lat || !st.lon) continue;

            const coordKey = `${st.lat.toFixed(2)},${st.lon.toFixed(2)}`;
            bounds.extend([st.lat, st.lon]);

            const popupContent = `
                <div style="font-family:'Inter',sans-serif; font-size:0.8rem; color:#e8f0ff;">
                    <b style="color:#22d3a0; font-size:0.9rem;">${st.station}</b><br>
                    <b>Frequency:</b> ${st.frequency_khz} kHz<br>
                    <b>Country (ITU):</b> ${st.itu || 'N/A'}<br>
                    <b>Language:</b> ${st.language || 'N/A'}<br>
                    <b>Target Region:</b> ${st.target || 'N/A'}<br>
                    <b>Schedule:</b> ${st.time_str || '0000-2400'} UTC
                </div>
            `;

            const circleMarker = L.circleMarker([st.lat, st.lon], {
                radius: 7,
                color: '#22d3a0',
                fillColor: '#0d1526',
                fillOpacity: 0.9,
                weight: 2
            }).bindPopup(popupContent);

            this.stationLayerGroup.addLayer(circleMarker);

            // Draw vector path line from SDR Receiver to Transmitter Country
            if (rx && Number.isFinite(rx.lat) && Number.isFinite(rx.lng) && !addedCoords.has(coordKey)) {
                addedCoords.add(coordKey);
                const line = L.polyline([[rx.lat, rx.lng], [st.lat, st.lon]], {
                    color: '#3d8bff',
                    weight: 1.5,
                    opacity: 0.65,
                    dashArray: '4, 6'
                });
                this.stationLayerGroup.addLayer(line);
            }

            count++;
            if (count >= 40) break;
        }

        if (bounds.isValid() && count > 0) {
            try {
                this.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 7 });
            } catch (err) {
                console.error("Map fitBounds failed:", err);
            }
        }
    }
}
