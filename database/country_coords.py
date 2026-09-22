"""
database/country_coords.py
Latitude and Longitude mapping for ITU (International Telecommunication Union) country codes.
Used to plot shortwave transmitting countries on the Web-SDR map.
"""

# Map of ITU 3-letter / 2-letter codes to approximate center (lat, lon) coordinates
ITU_COUNTRY_COORDS = {
    "AFG": (33.9391, 67.7099),
    "ALB": (41.1533, 20.1683),
    "ALG": (28.0339, 1.6596),
    "AND": (42.5063, 1.5218),
    "ANG": (-11.2027, 17.8739),
    "ARG": (-38.4161, -63.6167),
    "ARM": (40.0691, 45.0382),
    "ARS": (23.8859, 45.0792),   # Saudi Arabia
    "ATG": (17.0608, -61.7964),
    "AUS": (-25.2744, 133.7751),  # Australia
    "AUT": (47.5162, 14.5501),   # Austria
    "AZR": (40.1431, 47.5769),   # Azerbaijan
    "B":   (50.5039, 4.4699),     # Belgium
    "BAH": (25.0343, -77.3963),
    "BED": (26.0667, 50.5577),   # Bahrain
    "BER": (32.3078, -64.7505),
    "BGD": (23.6850, 90.3563),   # Bangladesh
    "BLR": (53.7098, 27.9534),   # Belarus
    "BLZ": (17.1899, -88.4976),
    "BOL": (-16.2902, -63.5887),
    "BOT": (-22.3285, 24.6849),
    "BRA": (-14.2350, -51.9253),  # Brazil
    "BRU": (4.5353, 114.7277),   # Brunei
    "BUL": (42.7339, 25.4858),   # Bulgaria
    "CAN": (56.1304, -106.3468), # Canada
    "CBG": (12.5657, 104.9910),  # Cambodia
    "CHL": (-35.6751, -71.5430), # Chile
    "CHN": (35.8617, 104.1954),  # China
    "CLM": (4.5709, -74.2973),   # Colombia
    "CNE": (12.2628, 44.4305),
    "COG": (-0.2280, 15.8277),
    "CUB": (21.5218, -77.7812),  # Cuba
    "CYP": (35.1264, 33.4299),
    "CZE": (49.8175, 15.4730),   # Czech Republic
    "D":   (51.1657, 10.4515),    # Germany
    "DNK": (56.2639, 9.5018),    # Denmark
    "DOM": (18.7357, -70.1627),
    "E":   (40.4637, -3.7492),    # Spain
    "EGY": (26.8206, 30.8025),   # Egypt
    "EQA": (-1.8312, -78.1834),  # Ecuador
    "EST": (58.5953, 25.0136),
    "ETH": (9.1450, 40.4897),    # Ethiopia
    "F":   (46.2276, 2.2137),     # France
    "FIN": (61.9241, 25.7482),   # Finland
    "FJI": (-17.7134, 178.0650),
    "G":   (55.3781, -3.4360),    # United Kingdom
    "GEO": (42.3154, 43.3569),
    "GHA": (7.9465, -1.0232),
    "GMB": (13.4432, -15.3101),
    "GRC": (39.0742, 21.8243),   # Greece
    "GTM": (15.7835, -90.2308),
    "GUY": (4.8604, -58.9302),
    "HND": (15.1999, -86.2419),
    "HNG": (47.1625, 19.5033),   # Hungary
    "HOL": (52.1326, 5.2913),    # Netherlands
    "HRV": (45.1000, 15.2000),   # Croatia
    "HTI": (18.9712, -72.2852),
    "I":   (41.8719, 12.5674),    # Italy
    "IND": (20.5937, 78.9629),   # India
    "INS": (-0.7893, 113.9213),  # Indonesia
    "IRL": (53.1424, -7.6921),
    "IRN": (32.4279, 53.6880),   # Iran
    "IRQ": (33.2232, 43.6793),   # Iraq
    "ISL": (64.9631, -19.0208),
    "ISR": (31.0461, 34.8516),   # Israel
    "J":   (36.2048, 138.2529),  # Japan
    "JOR": (30.5852, 36.2384),
    "KAZ": (48.0196, 66.9237),   # Kazakhstan
    "KEN": (-0.0236, 37.9062),   # Kenya
    "KGZ": (41.2044, 74.7661),   # Kyrgyzstan
    "KOR": (35.9078, 127.7669),  # South Korea
    "KWT": (29.3117, 47.4818),   # Kuwait
    "LAO": (19.8563, 102.4955),  # Laos
    "LBN": (33.8547, 35.8623),   # Lebanon
    "LBY": (26.3351, 17.2283),   # Libya
    "LKA": (7.8731, 80.7718),    # Sri Lanka
    "LTU": (55.1694, 23.8813),
    "LVA": (56.8796, 24.6032),
    "MAU": (-20.3484, 57.5522),
    "MDA": (47.4116, 28.3699),
    "MDG": (-18.7669, 46.8691),  # Madagascar
    "MEX": (23.6345, -102.5528), # Mexico
    "MKD": (41.6086, 21.7453),
    "MLI": (17.5707, -3.9962),
    "MLT": (35.9375, 14.3754),
    "MNP": (15.0979, 145.6739),  # Saipan / Northern Mariana
    "MNG": (46.8625, 103.8467),  # Mongolia
    "MOZ": (-18.6657, 35.5296),
    "MRC": (31.7917, -7.0926),   # Morocco
    "MWI": (-13.2543, 34.3015),
    "MYA": (21.9162, 95.9560),   # Myanmar
    "MYS": (4.2105, 101.9758),   # Malaysia
    "NCG": (12.8654, -85.2072),
    "NGR": (9.0820, 8.6753),     # Nigeria
    "NIG": (17.6078, 8.0817),    # Niger
    "NOR": (60.4720, 8.4689),    # Norway
    "NPL": (28.3949, 84.1240),   # Nepal
    "NZL": (-40.9006, 174.8860), # New Zealand
    "OMA": (21.5126, 55.9233),   # Oman
    "PAK": (30.3753, 69.3451),   # Pakistan
    "PAQ": (8.5380, -80.7821),
    "PHL": (12.8797, 121.7740),  # Philippines
    "PNG": (-6.314993, 143.95555),# Papua New Guinea
    "POL": (51.9194, 19.1451),   # Poland
    "POR": (39.3999, -8.2245),   # Portugal
    "PRG": (-23.4425, -58.4438),
    "PRK": (40.3399, 127.5101),  # North Korea
    "PRU": (-9.1900, -75.0152),  # Peru
    "ROU": (45.9432, 24.9668),   # Romania
    "RRR": (45.9432, 24.9668),   # Romania (Radio Romania)
    "RUS": (61.5240, 105.3188),  # Russia
    "RWA": (-1.9403, 29.8739),
    "SEN": (14.4974, -14.4524),
    "SEY": (-4.6796, 55.4920),   # Seychelles
    "SNG": (1.3521, 103.8198),   # Singapore
    "SOM": (5.1521, 46.1996),
    "SRB": (44.0165, 21.0059),   # Serbia
    "SUD": (12.8628, 30.2176),   # Sudan
    "SVK": (48.6690, 19.6990),   # Slovakia
    "SVN": (46.1512, 14.9955),
    "SWE": (60.1282, 18.6435),   # Sweden
    "SWZ": (-26.5225, 31.4659),  # Eswatini
    "SYR": (34.8021, 38.9968),   # Syria
    "TZA": (-6.3690, 34.8888),   # Tanzania
    "THA": (15.8700, 100.9925),  # Thailand
    "TJK": (38.8610, 71.2761),   # Tajikistan
    "TKM": (38.9697, 59.5563),   # Turkmenistan
    "TUN": (33.8869, 9.5375),    # Tunisia
    "TUR": (38.9637, 35.2433),   # Turkey
    "TWN": (23.6978, 120.9605),  # Taiwan
    "UAE": (23.4241, 53.8478),   # UAE
    "UGA": (1.3733, 32.2903),
    "UKR": (48.3794, 31.1656),   # Ukraine
    "URG": (-32.5228, -55.7658),
    "USA": (37.0902, -95.7129),  # United States
    "UZB": (41.3775, 64.5853),   # Uzbekistan
    "VAT": (41.9029, 12.4534),   # Vatican City
    "VEN": (6.4238, -66.5897),   # Venezuela
    "VTN": (14.0583, 108.2772),  # Vietnam
    "VUT": (-15.3767, 166.9592),
    "YEM": (15.5527, 48.5164),
    "ZAM": (-13.1339, 27.8493),
    "ZWB": (-19.0154, 29.1549),  # Zimbabwe
}

def get_country_coords(itu_code: str) -> tuple[float, float] | None:
    """Return (lat, lon) for a given ITU country code if known."""
    if not itu_code:
        return None
    code = itu_code.strip().upper()
    return ITU_COUNTRY_COORDS.get(code, None)
