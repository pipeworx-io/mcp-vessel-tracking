# @pipeworx/vessel-tracking

Live worldwide ship positions from AIS radio broadcasts. Platform key (aisstream.io), BYO accepted.

## Tools

- `live_ships_in_area(...)` — vessels broadcasting right now in a bounding box or around a point, with position, speed, course, navigational status, type, destination and IMO, plus a breakdown by vessel type.
- `live_ship_position(...)` — live position for specific vessels by MMSI.
- `ais_coverage_check(...)` — whether any receiver actually covers a location, so a zero can be read correctly.

## Auth

Platform key (`PLATFORM_AISSTREAM_KEY`), or BYO via `_apiKey`. Free, instant signup at https://aisstream.io.

## Coverage — read this before trusting a zero

aisstream is a community network of **terrestrial** receivers, so coverage follows where volunteers run hardware. Verified 2026-07-27 with a 60-second subscription:

| Region | Vessels heard |
|---|---|
| Mediterranean | 221 |
| English Channel | 50 (30s) |
| Strait of Malacca | 24 (30s) |
| **Persian Gulf / Strait of Hormuz** | **0** |
| **Gulf of Oman** | **0** |
| **Red Sea / Bab el-Mandeb** | **0** |

There is **no coverage of the Gulf or Red Sea**. Satellite AIS — the paid product from Spire/ORBCOMM — is what covers open ocean and unreceivered coasts, and this is not that. Asking about Hormuz returns `coverage: "none"` with a redirect to `chokepoint_status`, never a bare `0`.

The count field is named `vessels_observed`, not `vessel_count`, because it measures what was heard in a listening window rather than what is present. Every zero carries a `coverage` verdict of `confirmed`, `none` or `unconfirmed`.

### Sampling caveat

AIS transmit intervals depend on motion: a vessel underway broadcasts every 2-10 seconds, one at anchor roughly every 3 minutes. Short windows therefore under-count stationary ships. `live_ship_position` is **best effort by nature** — a 35s window found 1 of 8 vessels confirmed transmitting moments earlier — so widen `window_seconds` (max 40; beyond that callers time out) or use `vesselfinder_vessel` for a stored last-known position.

## Data sources

- Stream: `wss://stream.aisstream.io/v0/stream`

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "vessel-tracking": {
      "url": "https://gateway.pipeworx.io/vessel-tracking/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Vessel Tracking data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [All tools and guides](https://github.com/pipeworx-io/examples)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
