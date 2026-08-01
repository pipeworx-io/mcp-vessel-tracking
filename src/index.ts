interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Vessel Tracking — live worldwide ship positions from AIS.
 *
 * Source: aisstream.io, a WebSocket firehose of AIS messages contributed by a
 * community of TERRESTRIAL receivers. That word matters more than anything else
 * in this file, so it is worth being blunt about it up front:
 *
 *   aisstream has receivers where volunteers put receivers. It has excellent
 *   coverage of the Mediterranean, the English Channel, northern Europe, the
 *   US coasts and the Singapore/Malacca approaches. It has NO coverage of the
 *   Persian Gulf, the Gulf of Oman or the Red Sea — verified empirically on
 *   2026-07-27, when a 60-second subscription returned 221 vessels in a
 *   Mediterranean control box and exactly ZERO across all three of those
 *   regions. Satellite AIS, which is what actually covers open ocean and
 *   unreceivered coasts, is a paid product from Spire/ORBCOMM and is not this.
 *
 * The single most dangerous failure mode for this pack is therefore reporting
 * "0 vessels" for the Strait of Hormuz. A caller pricing a shipping-disruption
 * market would read that as "traffic has stopped" when the truth is "nobody is
 * listening here." Every code path below is built so that an unobserved area
 * and an empty area are impossible to confuse:
 *
 *   - the count field is named `vessels_observed`, never `vessel_count`, because
 *     what we measured is what we heard in a window, not what is present;
 *   - a zero always carries a `coverage` verdict explaining how to read it;
 *   - known-dark regions are named, and the response points at the tool that
 *     CAN answer for them (imf-portwatch chokepoint_status) instead of
 *     silently returning nothing.
 *
 * Second sampling caveat, disclosed on every response: AIS transmit intervals
 * depend on motion. A vessel underway broadcasts every 2-10 seconds, but one at
 * anchor or moored broadcasts roughly every 3 minutes. A short listening window
 * therefore under-counts stationary vessels far more than moving ones. Widen
 * `window_seconds` when the question is about how many ships are *there* rather
 * than how many are *moving*.
 */


const STREAM_URL = 'https://stream.aisstream.io/v0/stream';

const COVERAGE_NOTE =
  'aisstream is a community network of land-based AIS receivers, so coverage follows where volunteers ' +
  'run hardware: strong across the Mediterranean, English Channel, northern Europe, US coasts and the ' +
  'Singapore/Malacca approaches; absent over the Persian Gulf, Gulf of Oman and Red Sea, and thin over ' +
  'open ocean generally. Results are what was heard in a short listening window, not a census.';

const DESC_TAIL =
  ' COVERAGE IS PARTIAL AND TERRESTRIAL — there is no receiver coverage in the Persian Gulf, Strait of ' +
  'Hormuz, Gulf of Oman or Red Sea, so this tool cannot answer questions about those waters (use ' +
  'chokepoint_status for Hormuz/Suez/Bab el-Mandeb transit counts instead). Counts are vessels heard ' +
  'during a listening window of a few seconds, not a complete count of vessels present.';

/**
 * Regions confirmed to return zero traffic. Verified 2026-07-27 with a 60s
 * subscription against a Mediterranean control that returned 221 vessels in the
 * same window. These exist so a caller asking about Hormuz gets told the truth
 * and gets redirected, rather than receiving a zero they might trade on.
 */
const KNOWN_DARK: { name: string; box: BBox; instead: string }[] = [
  {
    name: 'Persian Gulf and Strait of Hormuz',
    box: { south: 23.0, west: 47.5, north: 30.5, east: 57.5 },
    instead:
      'Use chokepoint_status({ chokepoint: "Strait of Hormuz" }) — IMF PortWatch publishes daily transit ' +
      'counts for Hormuz (roughly 8 days behind, and the response states its own lag).',
  },
  {
    name: 'Gulf of Oman and northern Arabian Sea',
    box: { south: 15.0, west: 56.0, north: 26.5, east: 68.0 },
    instead: 'Use chokepoint_status({ chokepoint: "Strait of Hormuz" }) for the adjacent chokepoint.',
  },
  {
    name: 'Red Sea, Bab el-Mandeb and the southern Suez approaches',
    box: { south: 11.0, west: 32.0, north: 30.5, east: 44.0 },
    instead:
      'Use chokepoint_status({ chokepoint: "Suez Canal" }) or ({ chokepoint: "Bab el-Mandeb" }) for daily ' +
      'transit counts in these waters.',
  },
];

interface BBox { south: number; west: number; north: number; east: number }

// ── AIS enum decoding ───────────────────────────────────────────────
// Sentinel values in the AIS spec mean "not available" rather than a real
// reading; they must decode to null, not to a plausible-looking number.
// Speed 102.3kn, course 360deg and heading 511deg are all "unknown" markers.

const NAV_STATUS: Record<number, string> = {
  0: 'under way using engine', 1: 'at anchor', 2: 'not under command',
  3: 'restricted manoeuvrability', 4: 'constrained by draught', 5: 'moored',
  6: 'aground', 7: 'engaged in fishing', 8: 'under way sailing',
  11: 'under tow astern', 12: 'under tow alongside', 14: 'AIS-SART/MOB/EPIRB',
  15: 'undefined',
};

function shipType(code: number | undefined): string | null {
  if (code == null || code === 0) return null; // 0 = "not available", not a type
  if (code >= 20 && code <= 29) return 'wing in ground';
  if (code === 30) return 'fishing';
  if (code === 31 || code === 32) return 'towing';
  if (code === 33) return 'dredging';
  if (code === 34) return 'diving ops';
  if (code === 35) return 'military ops';
  if (code === 36) return 'sailing';
  if (code === 37) return 'pleasure craft';
  if (code >= 40 && code <= 49) return 'high speed craft';
  if (code === 50) return 'pilot vessel';
  if (code === 51) return 'search and rescue';
  if (code === 52) return 'tug';
  if (code === 53) return 'port tender';
  if (code === 55) return 'law enforcement';
  if (code === 58) return 'medical transport';
  if (code >= 60 && code <= 69) return 'passenger';
  if (code >= 70 && code <= 79) return 'cargo';
  if (code >= 80 && code <= 89) return 'tanker';
  if (code >= 90 && code <= 99) return 'other';
  return 'other';
}

const clean = (s: unknown): string | undefined => {
  if (typeof s !== 'string') return undefined;
  // AIS pads fixed-width text fields with spaces and '@' sentinels.
  const t = s.replace(/@+/g, ' ').trim();
  return t.length ? t : undefined;
};

interface Vessel {
  mmsi: number;
  name?: string;
  imo?: number;
  ship_type?: string | null;
  latitude: number;
  longitude: number;
  speed_knots?: number | null;
  course_degrees?: number | null;
  heading_degrees?: number | null;
  nav_status?: string | null;
  destination?: string;
  draught_metres?: number | null;
  last_report_utc?: string;
  messages_heard: number;
}

// ── Stream collection ───────────────────────────────────────────────

/**
 * Open the AIS stream, subscribe, and listen for `windowSeconds`.
 *
 * Cloudflare Workers have no `new WebSocket()` constructor — you upgrade a
 * fetch() and read `response.webSocket`. Published standalone builds of this
 * pack run under Node, which does have the constructor. Both are supported so
 * the same source works in the gateway and as a published npm server.
 */
async function collect(
  apiKey: string,
  boxes: BBox[],
  windowSeconds: number,
  mmsiFilter?: string[],
): Promise<{ vessels: Map<number, Vessel>; frames: number; closed?: string }> {
  const subscription: Record<string, unknown> = {
    APIKey: apiKey,
    BoundingBoxes: boxes.map((b) => [[b.south, b.west], [b.north, b.east]]),
  };
  if (mmsiFilter?.length) subscription.FiltersShipMMSI = mmsiFilter;

  const vessels = new Map<number, Vessel>();
  let frames = 0;

  const ingest = (raw: string) => {
    frames++;
    let m: Record<string, any>;
    try { m = JSON.parse(raw); } catch { return; }
    const md = m.MetaData;
    if (!md) return;
    const mmsi = md.MMSI;
    const lat = md.latitude, lon = md.longitude;
    if (typeof mmsi !== 'number') return;

    const v: Vessel = vessels.get(mmsi) ?? {
      mmsi, latitude: lat, longitude: lon, messages_heard: 0,
    };
    v.messages_heard++;
    if (typeof lat === 'number') { v.latitude = lat; v.longitude = lon; }
    if (md.time_utc) v.last_report_utc = String(md.time_utc).replace(' +0000 UTC', 'Z').replace(' ', 'T');
    const nameFromMeta = clean(md.ShipName);
    if (nameFromMeta) v.name = nameFromMeta;

    const body = m.Message?.PositionReport ?? m.Message?.StandardClassBPositionReport;
    if (body) {
      v.speed_knots = typeof body.Sog === 'number' && body.Sog < 102.3 ? body.Sog : null;
      v.course_degrees = typeof body.Cog === 'number' && body.Cog < 360 ? body.Cog : null;
      v.heading_degrees = typeof body.TrueHeading === 'number' && body.TrueHeading < 511 ? body.TrueHeading : null;
      if (typeof body.NavigationalStatus === 'number') {
        v.nav_status = NAV_STATUS[body.NavigationalStatus] ?? null;
      }
    }
    const stat = m.Message?.ShipStaticData;
    if (stat) {
      const n = clean(stat.Name); if (n) v.name = n;
      if (typeof stat.ImoNumber === 'number' && stat.ImoNumber > 0) v.imo = stat.ImoNumber;
      const t = shipType(stat.Type); if (t) v.ship_type = t;
      const dest = clean(stat.Destination); if (dest) v.destination = dest;
      if (typeof stat.MaximumStaticDraught === 'number' && stat.MaximumStaticDraught > 0) {
        v.draught_metres = stat.MaximumStaticDraught;
      }
    }
    vessels.set(mmsi, v);
  };

  const resp = await fetch(STREAM_URL, { headers: { Upgrade: 'websocket' } });
  const cfSocket = (resp as unknown as { webSocket?: WebSocket }).webSocket;

  if (cfSocket) {
    (cfSocket as unknown as { accept(): void }).accept();
    return await new Promise((resolve) => {
      let closed: string | undefined;
      cfSocket.addEventListener('message', (ev: MessageEvent) => {
        const d = ev.data;
        ingest(typeof d === 'string' ? d : new TextDecoder().decode(d as ArrayBuffer));
      });
      cfSocket.addEventListener('close', (ev: CloseEvent) => {
        closed = `stream closed (code ${ev.code})${ev.reason ? `: ${ev.reason}` : ''}`;
      });
      try {
        cfSocket.send(JSON.stringify(subscription));
      } catch (e) {
        resolve({ vessels, frames, closed: `could not subscribe: ${(e as Error).message}` });
        return;
      }
      setTimeout(() => {
        try { cfSocket.close(); } catch { /* already closed */ }
        resolve({ vessels, frames, closed });
      }, windowSeconds * 1000);
    });
  }

  // Node fallback (published standalone build).
  const Ctor = (globalThis as unknown as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!Ctor) throw new Error('No WebSocket support in this runtime.');
  return await new Promise((resolve) => {
    const ws = new Ctor(STREAM_URL.replace(/^https/, 'wss'));
    (ws as unknown as { binaryType: string }).binaryType = 'arraybuffer';
    let closed: string | undefined;
    ws.addEventListener('open', () => ws.send(JSON.stringify(subscription)));
    ws.addEventListener('message', (ev: MessageEvent) => {
      const d = ev.data;
      ingest(typeof d === 'string' ? d : new TextDecoder().decode(d as ArrayBuffer));
    });
    ws.addEventListener('close', (ev: CloseEvent) => {
      closed = `stream closed (code ${ev.code})${ev.reason ? `: ${ev.reason}` : ''}`;
    });
    setTimeout(() => {
      try { ws.close(); } catch { /* already closed */ }
      resolve({ vessels, frames, closed });
    }, windowSeconds * 1000);
  });
}

// ── Coverage reasoning ──────────────────────────────────────────────

function boxesOverlap(a: BBox, b: BBox): boolean {
  return a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west;
}

function darkRegionFor(box: BBox) {
  return KNOWN_DARK.find((r) => boxesOverlap(box, r.box));
}

/**
 * Turn a raw observation into a verdict a caller can safely act on. The whole
 * point is that `vessels_observed: 0` is never returned bare — it always
 * arrives with an explanation of whether zero means "empty" or "deaf".
 */
function coverageVerdict(box: BBox, observed: number, windowSeconds: number) {
  const dark = darkRegionFor(box);
  if (observed > 0) {
    return {
      coverage: 'confirmed' as const,
      coverage_note:
        `Receivers are live in this area — ${observed} vessel${observed === 1 ? '' : 's'} heard in ` +
        `${windowSeconds}s. Vessels at anchor or moored transmit only about every 3 minutes, so a window ` +
        `this short under-counts stationary ships; widen window_seconds for a fuller picture.`,
    };
  }
  if (dark) {
    return {
      coverage: 'none' as const,
      coverage_note:
        `This area falls inside the ${dark.name}, where aisstream has no receiver coverage at all ` +
        `(verified 2026-07-27). Zero vessels heard here means NOBODY IS LISTENING, not that the water is ` +
        `empty — this region carries heavy commercial traffic. Do not read this as a traffic measurement.`,
      see_instead: dark.instead,
    };
  }
  return {
    coverage: 'unconfirmed' as const,
    coverage_note:
      `Nothing was heard in ${windowSeconds}s. That could mean the area is genuinely quiet, or that it has ` +
      `no receiver coverage — a short window cannot tell those apart. Retry with a larger window_seconds, ` +
      `or call ais_coverage_check for this location before treating zero as a measurement.`,
  };
}

// ── Input helpers ───────────────────────────────────────────────────

function radiusToBox(lat: number, lon: number, km: number): BBox {
  const dLat = km / 111.32;
  // Longitude degrees shrink toward the poles; guard the cosine near them.
  const dLon = km / (111.32 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  return {
    south: Math.max(lat - dLat, -90), north: Math.min(lat + dLat, 90),
    west: Math.max(lon - dLon, -180), east: Math.min(lon + dLon, 180),
  };
}

function requireKey(args: Record<string, unknown>): string {
  const key = args._apiKey as string | undefined;
  if (!key) {
    throw new Error(
      'Live AIS requires an aisstream.io API key. Get a free one at aisstream.io and pass it as _apiKey.',
    );
  }
  return key;
}

function readWindow(args: Record<string, unknown>): number {
  const raw = Number(args.window_seconds ?? 12);
  if (!Number.isFinite(raw)) return 12;
  return Math.min(Math.max(raw, 3), 25);
}

function readBox(args: Record<string, unknown>): BBox {
  const { south, west, north, east, latitude, longitude, radius_km } = args as Record<string, number>;
  if ([south, west, north, east].every((n) => typeof n === 'number')) {
    if (south >= north || west >= east) {
      throw new Error('Invalid bounding box: south must be less than north, and west less than east.');
    }
    return { south, west, north, east };
  }
  if (typeof latitude === 'number' && typeof longitude === 'number') {
    return radiusToBox(latitude, longitude, Math.min(Math.max(Number(radius_km ?? 50), 1), 500));
  }
  throw new Error('Provide either latitude+longitude (with optional radius_km) or south/west/north/east.');
}

const roundBox = (b: BBox) => ({
  south: +b.south.toFixed(4), west: +b.west.toFixed(4),
  north: +b.north.toFixed(4), east: +b.east.toFixed(4),
});

// ── Tools ───────────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'live_ships_in_area',
    description:
      'Live ship positions right now in a geographic area, from AIS radio broadcasts — what vessels are ' +
      'sailing near a port, coastline, strait or set of coordinates at this moment. Returns each vessel ' +
      'heard with its position, speed, course, navigational status, type, destination and IMO where ' +
      'broadcast, plus a breakdown by vessel type (cargo, tanker, passenger, fishing, tug). Give either a ' +
      'centre point (latitude + longitude + radius_km) or a bounding box.' + DESC_TAIL,
    inputSchema: {
      type: 'object' as const,
      properties: {
        latitude: { type: 'number', description: 'Centre latitude, e.g. 43.3 for Marseille' },
        longitude: { type: 'number', description: 'Centre longitude, e.g. 5.4 for Marseille' },
        radius_km: { type: 'number', description: 'Radius around the centre point in km (default 50, max 500)' },
        south: { type: 'number', description: 'Bounding box southern latitude (alternative to centre+radius)' },
        west: { type: 'number', description: 'Bounding box western longitude' },
        north: { type: 'number', description: 'Bounding box northern latitude' },
        east: { type: 'number', description: 'Bounding box eastern longitude' },
        ship_type: {
          type: 'string',
          description: 'Optional filter on decoded type, e.g. "tanker", "cargo", "passenger", "fishing", "tug"',
        },
        window_seconds: {
          type: 'number',
          description:
            'How long to listen, 3-25 seconds (default 12). Longer windows hear more vessels, especially ' +
            'anchored ones which only transmit every ~3 minutes.',
        },
        limit: { type: 'number', description: 'Maximum vessels to return (default 50, max 300)' },
        _apiKey: { type: 'string', description: 'aisstream.io API key (free at aisstream.io)' },
      },
    },
  },
  {
    name: 'live_ship_position',
    description:
      'Where is a specific ship right now — live AIS position for one or more vessels by MMSI number. ' +
      'Returns position, speed, course, navigational status and destination as currently broadcast. ' +
      'BEST EFFORT BY NATURE: this listens for a live broadcast rather than reading a stored position, and ' +
      'many vessels transmit less than once a minute, so a single call frequently hears nothing even for a ' +
      'ship that is definitely sailing. Measured behaviour, not a caveat for form. Improve the odds with a ' +
      'longer window_seconds, or use live_ships_in_area if you know roughly where the ship is. For a ' +
      'guaranteed last-known position rather than a live catch, use vesselfinder_vessel (paid key).' + DESC_TAIL,
    inputSchema: {
      type: 'object' as const,
      properties: {
        mmsi: {
          type: 'array',
          items: { type: 'string' },
          description: 'One or more 9-digit MMSI numbers, e.g. ["219034351"]',
        },
        window_seconds: {
          type: 'number',
          description:
            'How long to listen, 3-40 seconds (default 30). Hit rate scales almost linearly with this: many ' +
            'vessels transmit less than once a minute, so a 10-second window will usually miss and a ' +
            '40-second one often succeeds. Prefer a long window here — the wait buys the answer.',
        },
        _apiKey: { type: 'string', description: 'aisstream.io API key (free at aisstream.io)' },
      },
      required: ['mmsi'],
    },
  },
  {
    name: 'ais_coverage_check',
    description:
      'Does live AIS tracking actually work at this location? Listens at a point and reports whether any ' +
      'community receiver covers it, so you can tell the difference between "no ships here" and "no ' +
      'receivers here" before trusting a zero. Use this whenever a vessel search comes back empty, and ' +
      'always before treating an empty result as evidence that shipping has stopped.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        latitude: { type: 'number', description: 'Latitude to test' },
        longitude: { type: 'number', description: 'Longitude to test' },
        radius_km: { type: 'number', description: 'Radius to test around the point in km (default 150)' },
        window_seconds: { type: 'number', description: 'How long to listen, 3-25 seconds (default 15)' },
        _apiKey: { type: 'string', description: 'aisstream.io API key (free at aisstream.io)' },
      },
      required: ['latitude', 'longitude'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const apiKey = requireKey(args);
  const windowSeconds = readWindow(args);

  switch (name) {
    case 'live_ships_in_area': {
      const box = readBox(args);
      const limit = Math.min(Math.max(Number(args.limit ?? 50), 1), 300);
      const wantType = (args.ship_type as string | undefined)?.toLowerCase().trim();

      // Redirect before spending 12 seconds listening to silence.
      const dark = darkRegionFor(box);
      if (dark) {
        return {
          area: roundBox(box),
          vessels_observed: 0,
          vessels: [],
          ...coverageVerdict(box, 0, 0),
          note: COVERAGE_NOTE,
        };
      }

      const { vessels, frames, closed } = await collect(apiKey, [box], windowSeconds);
      let list = [...vessels.values()];
      if (wantType) list = list.filter((v) => v.ship_type?.toLowerCase().includes(wantType));
      list.sort((a, b) => b.messages_heard - a.messages_heard);

      const byType: Record<string, number> = {};
      for (const v of list) {
        const k = v.ship_type ?? 'type not broadcast';
        byType[k] = (byType[k] ?? 0) + 1;
      }

      return {
        area: roundBox(box),
        observation_window_seconds: windowSeconds,
        vessels_observed: list.length,
        ...(wantType ? { filtered_to_type: wantType, vessels_observed_before_filter: vessels.size } : {}),
        by_ship_type: byType,
        vessels: list.slice(0, limit),
        ...(list.length > limit ? { truncated_to: limit } : {}),
        ...coverageVerdict(box, list.length, windowSeconds),
        ...(closed ? { stream_note: closed } : {}),
        messages_received: frames,
        note: COVERAGE_NOTE,
      };
    }

    case 'live_ship_position': {
      const raw = args.mmsi;
      const mmsis = (Array.isArray(raw) ? raw : [raw]).map((m) => String(m).trim()).filter(Boolean);
      if (!mmsis.length) throw new Error('Provide at least one MMSI number.');
      // Wider cap than the area tools on purpose: catching one named vessel is a
      // waiting game, and a short window is the difference between an answer and
      // a shrug. Verified 2026-07-27 — five vessels seen transmitting moments
      // earlier were all missed by a 25s window.
      //
      // Capped at 40s rather than higher because callers time out around 45s: a
      // 55s window returned a client timeout instead of the honest "not heard"
      // this tool works hard to give. An opaque hang is worse than a clean miss.
      const listen = Math.min(Math.max(Number(args.window_seconds ?? 30), 3), 40);

      const world: BBox = { south: -90, west: -180, north: 90, east: 180 };
      const { vessels, closed } = await collect(apiKey, [world], listen, mmsis);

      const found = [...vessels.values()];
      const foundSet = new Set(found.map((v) => String(v.mmsi)));
      const missing = mmsis.filter((m) => !foundSet.has(m));

      return {
        observation_window_seconds: listen,
        requested: mmsis,
        found: found.length,
        vessels: found,
        not_heard: missing,
        ...(missing.length
          ? {
              not_heard_note:
                'These vessels did not transmit within range of a community receiver during the listening ' +
                'window. This is the COMMON outcome, not an anomaly, and it is not evidence the ship is not ' +
                'sailing — many vessels broadcast less than once a minute, and one at anchor only every ~3 ' +
                'minutes. Retry with window_seconds up to 40, or use live_ships_in_area if you know the ' +
                'vessel\'s rough location; vesselfinder_vessel (paid key) returns a stored last-known ' +
                'position instead of waiting for a live broadcast.',
            }
          : {}),
        ...(closed ? { stream_note: closed } : {}),
        note: COVERAGE_NOTE,
      };
    }

    case 'ais_coverage_check': {
      const lat = Number(args.latitude), lon = Number(args.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        throw new Error('Provide numeric latitude and longitude.');
      }
      const box = radiusToBox(lat, lon, Math.min(Math.max(Number(args.radius_km ?? 150), 1), 500));
      const listen = Math.min(Math.max(Number(args.window_seconds ?? 15), 3), 25);

      const dark = darkRegionFor(box);
      if (dark) {
        return {
          location: { latitude: lat, longitude: lon },
          area_tested: roundBox(box),
          receivers_detected: false,
          tested_live: false,
          ...coverageVerdict(box, 0, 0),
          note: COVERAGE_NOTE,
        };
      }

      const { vessels, frames } = await collect(apiKey, [box], listen);
      return {
        location: { latitude: lat, longitude: lon },
        area_tested: roundBox(box),
        observation_window_seconds: listen,
        receivers_detected: vessels.size > 0,
        tested_live: true,
        vessels_observed: vessels.size,
        messages_received: frames,
        ...coverageVerdict(box, vessels.size, listen),
        note: COVERAGE_NOTE,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 }, provider: 'aisstream.io' } satisfies McpToolExport;
