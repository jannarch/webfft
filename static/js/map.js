/* static/js/map.js */

class LocalizationMap {
    constructor(containerId) {
        this.map = L.map(containerId).setView([-6.2088, 106.8456], 13); // Default Jakarta
        this.localizationPoints = [];
        this.estimateMarker = null;
        this.estimateCircle = null;
        
        // Dark theme map tiles (CartoDB Dark Matter)
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
            subdomains: 'abcd',
            maxZoom: 20
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
}
