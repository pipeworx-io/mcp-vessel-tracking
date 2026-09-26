interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
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


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Vessel Tracking');
}

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

  const resp = await pwFetch(STREAM_URL, { headers: { Upgrade: 'websocket' } });
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
