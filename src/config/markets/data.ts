// Market geography configuration — the ONLY place phases, zones and localities are defined.
// Every boundary and coordinate here is an APPROXIMATE assumption from general knowledge,
// pending owner approval. Nothing has been checked against a source yet (completeness 0,
// lastCheckedAt null). See docs/research/GEOGRAPHY.md.

import type { MarketConfig } from "./schema";

type LocalityRow = [id: string, name: string, lat: number, lng: number, aliases: string[]];

const NORTH_ZONE_ID = "north-bengaluru";

// [id, name, lat, lng, aliases] — centroids approximate, need verification.
const NORTH_BENGALURU_LOCALITIES: LocalityRow[] = [
  ["hebbal", "Hebbal", 13.0358, 77.597, ["hebbala", "hebbal flyover"]],
  ["hebbal-kempapura", "Hebbal Kempapura", 13.048, 77.596, ["kempapura"]],
  ["nagawara", "Nagawara", 13.041, 77.62, ["nagavara"]],
  ["kalyan-nagar", "Kalyan Nagar", 13.028, 77.64, ["kalyananagar", "kalyan nagara"]],
  ["hennur", "Hennur", 13.039, 77.639, ["hennur road", "hennur cross", "hennur main road"]],
  ["kothanur", "Kothanur", 13.064, 77.646, ["kothnur", "k narayanapura"]],
  ["thanisandra", "Thanisandra", 13.056, 77.633, ["thanisandra main road"]],
  ["hegde-nagar", "Hegde Nagar", 13.067, 77.628, []],
  ["amruthahalli", "Amruthahalli", 13.066, 77.6, ["amrutahalli"]],
  ["byatarayanapura", "Byatarayanapura", 13.06, 77.594, ["byatarayanapura yelahanka"]],
  ["sahakara-nagar", "Sahakara Nagar", 13.063, 77.587, ["sahakar nagar", "sahakaranagar"]],
  ["kodigehalli", "Kodigehalli", 13.064, 77.578, []],
  ["vidyaranyapura", "Vidyaranyapura", 13.078, 77.556, ["vidyaranyapuram"]],
  ["jakkur", "Jakkur", 13.078, 77.606, ["jakkuru", "jakkur plantation"]],
  ["allalasandra", "Allalasandra", 13.089, 77.585, []],
  ["yelahanka", "Yelahanka", 13.1007, 77.5963, ["yelahanka old town", "yelahanka town"]],
  ["yelahanka-new-town", "Yelahanka New Town", 13.099, 77.578, ["yelahanka newtown"]],
  ["kogilu", "Kogilu", 13.103, 77.615, ["kogilu cross"]],
  ["kannuru", "Kannuru", 13.108, 77.665, ["kannur"]],
  ["bagalur", "Bagalur", 13.134, 77.668, ["bagaluru", "bagalur road"]],
  ["kattigenahalli", "Kattigenahalli", 13.138, 77.629, []],
  ["hunasamaranahalli", "Hunasamaranahalli", 13.145, 77.621, []],
  ["singanayakanahalli", "Singanayakanahalli", 13.149, 77.594, []],
  ["bettahalasur", "Bettahalasur", 13.15, 77.626, ["bettahalsoor"]],
  ["chikkajala", "Chikkajala", 13.165, 77.629, ["chikka jala"]],
  ["rajanukunte", "Rajanukunte", 13.166, 77.56, ["rajankunte"]],
  ["doddajala", "Doddajala", 13.178, 77.656, ["dodda jala"]],
  ["sadahalli", "Sadahalli", 13.194, 77.659, ["sadahalli gate"]],
  [
    "kia-airport-area",
    "Kempegowda International Airport area",
    13.1986,
    77.7066,
    ["kempegowda international airport", "kia", "kial", "bial", "bengaluru airport"],
  ],
  ["devanahalli", "Devanahalli", 13.2473, 77.7119, ["devanhalli", "devanahalli town"]],
  ["doddaballapur", "Doddaballapur", 13.2957, 77.5364, ["doddaballapura", "doddaballapur road"]],
];

export const MARKET_CONFIG: MarketConfig = {
  phases: [
    { id: "north-bengaluru", name: "North Bengaluru", order: 1, active: true },
    // Placeholder names; inactive phases must not be collected and carry no localities.
    { id: "east-bengaluru", name: "East Bengaluru (placeholder)", order: 2, active: false },
    { id: "south-bengaluru", name: "South Bengaluru (placeholder)", order: 3, active: false },
    {
      id: "west-central-bengaluru",
      name: "West / Central Bengaluru (placeholder)",
      order: 4,
      active: false,
    },
  ],
  zones: [
    {
      id: NORTH_ZONE_ID,
      phaseId: "north-bengaluru",
      name: "North Bengaluru",
      // Coarse hand-drawn envelope [lng, lat]; NOT a surveyed or official boundary.
      boundary: {
        type: "Polygon",
        coordinates: [
          [
            [77.5, 13.02],
            [77.66, 13.02],
            [77.72, 13.05],
            [77.76, 13.2],
            [77.74, 13.3],
            [77.52, 13.31],
            [77.48, 13.1],
            [77.5, 13.02],
          ],
        ],
      },
      boundaryApproval: "pending_owner_approval",
      assumptions: [
        "Zone boundary is a coarse approximate envelope, not an official BBMP/BDA/BMRDA boundary.",
        "Southern edge ~13.02N: north of the central city (excludes RT Nagar, HRBR, Horamavu and areas south).",
        "Covers the Bellary Road / NH-44 corridor from Hebbal to Devanahalli and the airport.",
        "Covers Hennur Road, Thanisandra, Bagalur Road, Yelahanka, Jakkur and the Doddaballapur Road side.",
        "Excludes Jalahalli/Peenya (north-west) and Old Madras Road/KR Puram (east) pending owner decision.",
        "Locality centroids are approximate from general knowledge and need verification against an approved source.",
        "Locality boundaries are not defined (null) until an approved source supplies them.",
      ],
    },
  ],
  localities: NORTH_BENGALURU_LOCALITIES.map(([id, name, lat, lng, aliases]) => ({
    id,
    name,
    zoneId: NORTH_ZONE_ID,
    centroid: { lat, lng, precision: "locality_centroid" as const },
    aliases,
    boundary: null,
    dataCoverage: { sourceIds: [], completeness: 0, lastCheckedAt: null },
  })),
};
