/*!
 * jellyfin-refresh-kit.js — drop-in stale-cache / hard-refresh fix for Jellyfin
 * client-script plugins and script collections.
 *
 * MIT License
 * Copyright (c) 2026 <YOUR NAME HERE>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FIXES
 * ---------------------------------------------------------------------------
 * Jellyfin client-script plugins ship JavaScript that the browser caches hard.
 * When you publish a new version, users keep running the old one — sometimes
 * for days — until they hit Ctrl+Shift+R. There are three independent layers of
 * staleness, and a pure-JS kit can only reach two of them:
 *
 *   1. THE SHELL (index.html and every <script> tag statically written into it).
 *      Only the SERVER can fix a statically-tagged file. This kit cannot — but
 *      BOOTSTRAP MODE (below) removes almost all of those tags, so there is
 *      barely any shell left to go stale. What the kit CAN always do is notice
 *      that a new version exists and reload the tab, which re-fetches the shell
 *      under normal revalidation rules.
 *
 *   2. SUB-ASSETS (the sub-scripts and stylesheets your bootstrap loads at
 *      runtime, usually with document.createElement('script')). THIS is the
 *      layer the kit actually fixes: it rewrites those URLs to carry
 *      ?v=<current version> so a new release is a new URL and can never be
 *      served from a stale cache entry.
 *
 *   3. OPEN TABS. A user who left Jellyfin open in a tab for two days never
 *      re-requests anything. The kit polls a tiny version endpoint and, when the
 *      version changes, performs a *safe* auto-reload — never over playback,
 *      never over an open dialog, never while typing.
 *
 * ---------------------------------------------------------------------------
 * MULTI-INSTANCE (v2): N PLUGINS, ONE PAGE
 * ---------------------------------------------------------------------------
 * Since 2.0.0 the kit is no longer a singleton. window.JellyfinRefreshKit is a
 * MANAGER owning a registry of named INSTANCES — one instance per adopting
 * plugin / script collection. Each <script> tag of this file registers exactly
 * ONE instance, configured from that tag's own data-* attributes. Two, three,
 * N plugins can each ship their own copy of the kit (even different kit
 * versions) and they compose on one page:
 *
 *   • ONE createElement wrapper, ever, installed by the first copy to run.
 *     On src/href assignment it consults ALL registered instances'
 *     assetPatterns; the FIRST-REGISTERED instance whose patterns match
 *     versions the URL with THAT instance's resolved version. Registration
 *     order is document order of the kit tags. If patterns of two instances
 *     overlap on a URL, the first-registered instance wins and the manager
 *     logs ONE console.warn naming the overlapping instances the first time
 *     it happens. URLs already carrying v= always pass through untouched.
 *
 *   • PER-INSTANCE: version source + polling cadence + baseline/latest
 *     version, bootstrap entry loading (an instance's entries wait on ITS
 *     version and load sequentially within the instance; different instances
 *     load their entries concurrently with each other), mode (auto/notify/
 *     off), onUpdateAvailable, entryTimeoutMs, idleSeconds, pollSeconds.
 *
 *   • SHARED PAGE-LEVEL MACHINERY: the safety gates, idle tracking, and the
 *     reload budget (storage key 'jellyfin-refresh-kit-budget-v1', unchanged
 *     from 1.x — a page reload is a page-level resource) are one engine. ANY
 *     auto-mode instance that detects an update requests the shared safe
 *     reload. The idle requirement used for that reload is the STRICTEST
 *     (i.e. the MAXIMUM) idleSeconds among the instances currently wanting to
 *     reload, and the effective reload budget is the MINIMUM reloadBudget
 *     among all registered instances — the page honours every adopter's most
 *     conservative ask. Notify-mode instances never trigger the shared
 *     reload; their callback still fires.
 *
 *   • RELOAD COST WITH N INSTANCES: after a reload triggered by instance A,
 *     instance B's unchanged-version assets are re-requested at their SAME
 *     immutable ?v= URLs and come straight back out of the HTTP cache — a
 *     reload for one plugin's update costs the others nothing but cache hits.
 *
 *   • NAMES: each instance has a name — config `name` / attribute data-name.
 *     If omitted, the name is derived deterministically from versionUrl (the
 *     last directory segment of its path, e.g. "/web/KefinTweaks/version.json"
 *     → "KefinTweaks"); with no versionUrl either, it falls back to
 *     "instance-<index>". Registering the same name again with an EQUIVALENT
 *     config is a silent dedupe (you get the existing instance back);
 *     the same name with a DIFFERENT config registers as "name#2" and warns.
 *
 *   • WINDOW CONFIG: window.JellyfinRefreshKitConfig (the 1.x singular form)
 *     applies ONLY to the FIRST instance registered on the page — that keeps
 *     every existing single-plugin adoption byte-compatible. For targeted
 *     config use the keyed form: window.JellyfinRefreshKitConfigs =
 *     { "KefinTweaks": {...}, "DemoPack": {...} } — each entry merges over
 *     (and wins against) the matching instance's tag attributes. Priority per
 *     instance: keyed entry > singular (first instance only) > data-* > defaults.
 *
 * ---------------------------------------------------------------------------
 * REGISTRATION CONTRACT (v1) — FROZEN. This section is the compatibility
 * promise between kit copies of DIFFERENT versions cohabiting a page. Any
 * future kit version MUST keep every numbered clause working forever.
 * ---------------------------------------------------------------------------
 *  1. The FIRST kit copy to execute on a page becomes the manager: it installs
 *     window.JellyfinRefreshKit, the single createElement wrapper, and the
 *     shared page machinery, then registers its own instance.
 *  2. Every copy, at the top of its IIFE, synchronously captures its own
 *     <script> tag config (document.currentScript data-*) and then inspects
 *     window.JellyfinRefreshKit:
 *       a. absent            → become the manager (clause 1).
 *       b. present AND has a function-valued __registerInstance →
 *          call window.JellyfinRefreshKit.__registerInstance(tagConfig,
 *          KIT_VERSION) and do NOTHING else. No second wrapper, no listeners,
 *          no timers — the already-installed manager runs everything, even if
 *          it is an older 2.x than the arriving copy.
 *       c. present WITHOUT __registerInstance (a 1.x singleton) → log ONE
 *          console.warn and go fully inert. The 2.x copy must not fight the
 *          1.x wrapper (double-versioning, double reload engines). Mixing
 *          1.x + 2.x on one page means the 1.x-shipping plugin should upgrade
 *          its kit copy; until then only the 1.x plugin is served.
 *  3. manager.__registerInstance(config, kitVersion) → handle | null:
 *       • config: a PLAIN OBJECT of tag-level options using the documented
 *         option names (name, versionUrl, versionJsonField, getVersion,
 *         pollSeconds, idleSeconds, assetPatterns, entryScripts,
 *         entryTimeoutMs, mode, onUpdateAvailable, reloadBudget). The MANAGER
 *         normalizes and clamps with its own rules and MUST ignore unknown
 *         keys — that is what lets an older manager accept a config written
 *         for a newer kit. The manager also applies the window config layers
 *         (clause: MULTI-INSTANCE → WINDOW CONFIG) itself, so merge behaviour
 *         is decided by exactly one version of the code — the running manager.
 *       • kitVersion: the arriving copy's KIT_VERSION string (diagnostics;
 *         surfaced in state() as registeredByKitVersion).
 *       • returns an instance handle { name, version, latestVersion,
 *         versionedUrl(url, force), checkNow(), state() } — or null on any
 *         internal failure. It MUST NEVER throw.
 *       • duplicate registration (same resolved name + equivalent config)
 *         silently returns the existing instance's handle.
 *  4. manager.__contractVersion is a number (currently 1) naming the newest
 *     contract revision the manager speaks. Revisions are strictly additive:
 *     a v1 call MUST keep working against every future manager.
 *  5. manager.kitVersion is the manager copy's own version string, so an
 *     arriving copy can log/diagnose version skew. Feature skew is bounded by
 *     the manager: features the manager's version lacks are unavailable to
 *     later-arriving instances, but registration itself never breaks.
 *
 * ---------------------------------------------------------------------------
 * BOOTSTRAP MODE (recommended adoption)
 * ---------------------------------------------------------------------------
 * Without bootstrap mode, layer 2 is fixed but the collection's OWN entry files
 * (its config script and its injector/entry script) are still static <script>
 * tags in index.html — unversioned, and therefore cacheable-stale exactly like
 * the shell. Ship a bugfix inside the injector itself and a browser can keep
 * running the old injector indefinitely.
 *
 * Bootstrap mode collapses that surface. index.html carries ONE tag per
 * adopting collection — this kit — and the kit loads the collection's entry
 * files itself:
 *
 *   <script src="/web/KefinTweaks/jellyfin-refresh-kit.js"
 *           data-name="KefinTweaks"
 *           data-version-url="/web/KefinTweaks/version.json"
 *           data-version-json-field="version"
 *           data-asset-patterns="/KefinTweaks/"
 *           data-entry-scripts="/web/KefinTweaks/kefinTweaks-config.js,/web/KefinTweaks/injector.js">
 *   </script>
 *
 * Sequence: resolve the instance's version FIRST → then append each entry in
 * order, each carrying ?v=<version> → the entry code then creates its
 * sub-assets, which the createElement interceptor versions as usual.
 * Everything under the collection's folder is now version-addressed. The ONLY
 * file left unversioned is this kit — a small, stable loader that changes
 * rarely (see LIMITATIONS).
 *
 * Rules the entry loader follows, in priority order:
 *   • Never load an entry before the instance's version resolves...
 *   • ...but never let a dead version endpoint cost the user their plugin.
 *     The first version fetch is raced against entryTimeoutMs (default 3s); on
 *     failure or timeout the entries load UNVERSIONED and the kit logs exactly
 *     one warning. Availability beats freshness.
 *   • Strict order WITHIN an instance. Entry N+1 is appended only after entry
 *     N settles, so a config script is guaranteed to have executed before the
 *     injector that reads it. (script.async = false is also set, belt and
 *     braces.) Different instances' chains run concurrently — they are
 *     independent collections.
 *   • An entry that 404s or throws is logged and SKIPPED; the remaining entries
 *     still load. One bad file must not take the page down with it.
 *   • .css entries become <link rel="stylesheet">, everything else <script>.
 *
 * Bootstrap mode is opt-in and purely additive: with no entryScripts configured
 * the instance behaves exactly as it did before, so existing adoptions keep
 * working.
 *
 * ---------------------------------------------------------------------------
 * DESIGN NOTES (why it looks like this)
 * ---------------------------------------------------------------------------
 * • Zero dependencies, one file, ES2017, no build step. It has to be pasteable
 *   into a JS Injector textarea or served from a plugin's static folder.
 * • It must NEVER break the host page. Every observable entry point is wrapped
 *   so a throw inside the kit cannot escape into Jellyfin's own code.
 * • Interception happens at ASSIGNMENT time, not via MutationObserver. A
 *   document-level observer sees the element AFTER it is inserted, and the
 *   browser has usually already kicked off the fetch by then — mutating .src at
 *   that point either does nothing or causes a double fetch. Wrapping
 *   document.createElement and installing a per-INSTANCE accessor (never on
 *   Element.prototype — that is far too invasive and collides with other
 *   plugins) rewrites the URL before it is ever assigned.
 * • The manager/instance split exists because two plugins each shipping a kit
 *   tag would otherwise collide on the global and double-wrap createElement.
 *   The first copy owns the machinery; every later copy is just configuration.
 *
 * ---------------------------------------------------------------------------
 * KNOWN, DELIBERATE LIMITATIONS
 * ---------------------------------------------------------------------------
 * • WITHOUT bootstrap mode, the FIRST page load after adopting the kit is
 *   inherently unversioned: the host bootstrap may create its script elements
 *   before the version has resolved. Those pass through untouched. From the next
 *   load onwards everything is versioned. This is a one-time cost, not a
 *   recurring bug — and bootstrap mode removes it entirely, because the kit
 *   itself decides when the entries load.
 * • WITH bootstrap mode, one file per collection remains unversioned and
 *   un-fixable from JS: the kit's own <script src> in index.html. Something
 *   has to be the loader, and the loader cannot cache-bust itself. The
 *   mitigation is that this file is small and deliberately stable — the
 *   volatile code lives in the entries. If you need the loader itself to be
 *   fresh, that is a SERVER job: send `Cache-Control: no-cache` (revalidate,
 *   cheap 304s) for this one file.
 * • Bootstrap mode adds one round-trip of latency before the entries start
 *   loading (the version fetch, bounded by entryTimeoutMs). It is a small
 *   same-origin JSON GET, but it is not free.
 * • MULTI-INSTANCE: which instance versions an ambiguous URL is decided by
 *   REGISTRATION ORDER, which is the document order of the kit <script> tags.
 *   Keep assetPatterns disjoint (they name your own folder — they naturally
 *   are); the overlap warning exists to surface accidents, not to arbitrate
 *   deliberate sharing.
 * • MIXING 1.x AND 2.x: a 1.x copy that runs FIRST owns the page (2.x copies
 *   go inert with one warning); a 1.x copy that runs SECOND was never
 *   multi-instance-aware and will double-wrap createElement on top of the 2.x
 *   manager — harmless for correctness (the inner wrapper sees already-
 *   versioned URLs and passes them through) but sloppy. Either way: the
 *   1.x-shipping plugin should upgrade its kit copy.
 * • A CDN's own "@latest" resolution TTL is invisible to JavaScript. jsDelivr
 *   caches the @latest → tag mapping for up to 24h; no amount of ?v= changes
 *   that, because the STALE FILE IS THE CORRECT RESPONSE for that URL. Pin a
 *   version (@1.2.3) or self-host. See README.
 * • The kit cannot add ETag / Cache-Control headers. That needs the server.
 */

(function () {
    'use strict';

    // ─────────────────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @type {string} Version of the kit itself, surfaced in state(). Bump on any
     * behaviour change so a support log identifies the loader precisely.
     *   1.0.0 — interceptor + polling + safe reload.
     *   1.1.0 — bootstrap mode (entryScripts): the kit loads the collection's
     *           entry files itself, after the version resolves.
     *   2.0.0 — multi-instance: manager + named instances, one shared
     *           interceptor and reload engine, registration contract v1 so
     *           multiple kit copies (even different versions) cohabit a page.
     */
    var KIT_VERSION = '2.0.0';

    /**
     * @type {number} Registration-contract revision this copy speaks (see the
     * REGISTRATION CONTRACT header section). Strictly additive; a v1 caller
     * must keep working against every future manager.
     */
    var CONTRACT_VERSION = 1;

    /** @type {string} Console prefix for every message this kit emits. */
    var LOG = '[RefreshKit]';

    /** @type {string} Shared storage key for the cross-tab reload budget. */
    var BUDGET_KEY = 'jellyfin-refresh-kit-budget-v1';

    /** @type {number} Rolling window for the reload budget, in ms. */
    var BUDGET_WINDOW_MS = 60000;

    /**
     * Minimum settle time after the last user interaction, even when the caller
     * configures idleSeconds: 0. Reloading in the same task as a click steals
     * the click from whatever handler was about to run.
     * @type {number}
     */
    var MIN_SETTLE_MS = 1000;

    /** @type {number} How often to re-test the safety gate while blocked. */
    var RETRY_MS = 1000;

    /**
     * Floor between two version fetches (PER INSTANCE — each instance has its
     * own endpoint). visibilitychange/focus/pageshow all fire in a burst when a
     * tab is restored; without a floor that is three fetches back to back.
     * @type {number}
     */
    var MIN_FETCH_GAP_MS = 5000;

    /** @type {number} Hard cap on consecutive blocked-reload retries (~10 min). */
    var MAX_BLOCKED_RETRIES = 600;

    /**
     * Bootstrap mode only: how long to wait for the FIRST version fetch before
     * giving up and loading the entry files unversioned. This is the dial
     * between freshness and availability, and availability has to win — a
     * version.json that 404s must never cost the user their plugin.
     * @type {number}
     */
    var DEFAULT_ENTRY_TIMEOUT_MS = 3000;

    // ─────────────────────────────────────────────────────────────────────────
    // Tiny safe helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Run `fn`, swallowing anything it throws. The kit is a guest on someone
     * else's page; a bug in here must degrade to "the kit stops working", never
     * to "Jellyfin stops working".
     * @template T
     * @param {() => T} fn
     * @param {T} [fallback] Returned when `fn` throws.
     * @returns {T|undefined}
     */
    function safe(fn, fallback) {
        try {
            return fn();
        } catch (err) {
            try { console.debug(LOG, 'suppressed error:', err); } catch (_) { /* console itself is gone */ }
            return fallback;
        }
    }

    /**
     * Clamp a number into [min, max], falling back when it is not a finite
     * number (covers undefined, null, NaN, "12abc" → NaN, Infinity).
     * @param {*} value
     * @param {number} min
     * @param {number} max
     * @param {number} fallback
     * @returns {number}
     */
    function clampNumber(value, min, max, fallback) {
        var n = typeof value === 'string' ? Number(value) : value;
        if (typeof n !== 'number' || !isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, n));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Configuration
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @typedef {Object} RefreshKitConfig
     * @property {string}   [name]              Instance name. Default: derived from versionUrl's parent folder, else "instance-<index>".
     * @property {string}   [versionUrl]        Endpoint returning the current version. Required for polling.
     * @property {string}   [versionJsonField]  If set, the response is parsed as JSON and this field is read (e.g. "version").
     * @property {() => Promise<string>} [getVersion] Config-object only. Overrides versionUrl entirely.
     * @property {number}   [pollSeconds]       Poll interval while visible. Default 60, clamped 15–3600.
     * @property {number}   [idleSeconds]       Required user-idle time before an auto reload. Default 5, clamped 0–300. Page-level reloads use the MAX among instances wanting one.
     * @property {Array<string|RegExp>} [assetPatterns] Substrings/regexes; matching script/link URLs get ?v=<this instance's version>.
     * @property {string[]} [entryScripts] BOOTSTRAP MODE. URLs the kit loads itself, IN ORDER, after this instance's version resolves. Empty = classic mode.
     * @property {number}   [entryTimeoutMs] Max wait for the first version fetch before loading entries unversioned. Default 3000, clamped 250–30000.
     * @property {'auto'|'notify'|'off'} [mode] Default 'auto'.
     * @property {(newV: string, oldV: string) => void} [onUpdateAvailable] Called once per detected version change.
     * @property {number}   [reloadBudget]      Max reloads per 60s window. Default 3. Page-level budget is the MIN among all instances.
     */

    /** @type {Required<Pick<RefreshKitConfig,'pollSeconds'|'idleSeconds'|'mode'|'reloadBudget'>> & RefreshKitConfig} */
    var DEFAULTS = {
        name: '',
        versionUrl: '',
        versionJsonField: '',
        getVersion: null,
        pollSeconds: 60,
        idleSeconds: 5,
        assetPatterns: [],
        entryScripts: [],
        entryTimeoutMs: DEFAULT_ENTRY_TIMEOUT_MS,
        mode: 'auto',
        onUpdateAvailable: null,
        reloadBudget: 3
    };

    /**
     * Read `data-*` attributes off THIS copy's own <script> tag.
     *
     * document.currentScript is only valid during the SYNCHRONOUS execution of
     * the script, which is exactly where this runs — so we capture it now and
     * never rely on it again. Note that a `defer`/`async` tag still reports
     * currentScript correctly; only eval()/injected-text execution does not,
     * which is why the window-config path exists as an escape hatch.
     *
     * Attribute names are the kebab-case form of the option names:
     *   data-name, data-version-url, data-version-json-field, data-poll-seconds,
     *   data-idle-seconds, data-asset-patterns (comma-separated), data-mode,
     *   data-reload-budget, data-entry-scripts (comma-separated, ORDER MATTERS),
     *   data-entry-timeout-ms
     *
     * @returns {Partial<RefreshKitConfig>}
     */
    function readScriptTagConfig() {
        var el = document.currentScript;
        if (!el || !el.dataset) return {};
        var d = el.dataset;
        /** @type {Partial<RefreshKitConfig>} */
        var out = {};
        if (d.name) out.name = d.name;
        if (d.versionUrl) out.versionUrl = d.versionUrl;
        if (d.versionJsonField) out.versionJsonField = d.versionJsonField;
        if (d.pollSeconds) out.pollSeconds = Number(d.pollSeconds);
        if (d.idleSeconds) out.idleSeconds = Number(d.idleSeconds);
        if (d.mode) out.mode = /** @type {any} */ (d.mode);
        if (d.reloadBudget) out.reloadBudget = Number(d.reloadBudget);
        if (d.entryTimeoutMs) out.entryTimeoutMs = Number(d.entryTimeoutMs);
        if (d.entryScripts) {
            // Comma-separated, order-significant. A URL containing a literal
            // comma would have to use the window-config path instead.
            out.entryScripts = d.entryScripts
                .split(',')
                .map(function (s) { return s.trim(); })
                .filter(Boolean);
        }
        if (d.assetPatterns) {
            // Comma-separated substrings only. Regex cannot survive an HTML
            // attribute unambiguously, so regex support is config-object only.
            out.assetPatterns = d.assetPatterns
                .split(',')
                .map(function (s) { return s.trim(); })
                .filter(Boolean);
        }
        return out;
    }

    // Capture this copy's tag config NOW, while currentScript is still valid —
    // regardless of whether this copy ends up being the manager or a mere
    // registrant (REGISTRATION CONTRACT clause 2).
    var tagConfig = safe(readScriptTagConfig, {}) || {};

    // ─────────────────────────────────────────────────────────────────────────
    // Role decision (REGISTRATION CONTRACT clause 2)
    // ─────────────────────────────────────────────────────────────────────────

    var existingManager = safe(function () { return window.JellyfinRefreshKit; }, null);
    if (existingManager) {
        if (typeof existingManager.__registerInstance === 'function') {
            // 2.x manager already installed (possibly an older or newer 2.x than
            // this copy — the contract covers both). Register and bow out: no
            // second wrapper, no listeners, no timers from this copy.
            safe(function () {
                existingManager.__registerInstance(tagConfig, KIT_VERSION);
            });
        } else {
            // A 1.x singleton owns the page. It already wrapped createElement
            // and owns the reload engine; fighting it would mean two wrappers
            // and two reload engines. Degrade gracefully: one warning, inert.
            safe(function () {
                console.warn(LOG, 'a pre-2.0 (singleton) jellyfin-refresh-kit already owns this page; ' +
                    'this ' + KIT_VERSION + ' copy is going inert. The plugin shipping the 1.x copy ' +
                    'should upgrade its kit so both can register as instances.');
            });
        }
        return;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // From here on: THIS COPY IS THE MANAGER (first kit copy on the page).
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Normalize + clamp a merged raw config so the rest of the file can trust
     * it. Only keys present in DEFAULTS are copied — unknown keys from a newer
     * kit copy's config are ignored (REGISTRATION CONTRACT clause 3).
     * @param {Object} raw
     * @returns {RefreshKitConfig}
     */
    function normalizeConfig(raw) {
        /** @type {any} */
        var cfg = {};
        var key;
        for (key in DEFAULTS) { if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) cfg[key] = DEFAULTS[key]; }
        for (key in DEFAULTS) {
            if (Object.prototype.hasOwnProperty.call(DEFAULTS, key) &&
                raw && Object.prototype.hasOwnProperty.call(raw, key) && raw[key] !== undefined) {
                cfg[key] = raw[key];
            }
        }

        cfg.name = typeof cfg.name === 'string' ? cfg.name.trim() : '';
        cfg.pollSeconds = clampNumber(cfg.pollSeconds, 15, 3600, DEFAULTS.pollSeconds);
        cfg.idleSeconds = clampNumber(cfg.idleSeconds, 0, 300, DEFAULTS.idleSeconds);
        cfg.reloadBudget = clampNumber(cfg.reloadBudget, 1, 100, DEFAULTS.reloadBudget);
        if (cfg.mode !== 'auto' && cfg.mode !== 'notify' && cfg.mode !== 'off') cfg.mode = DEFAULTS.mode;
        cfg.entryTimeoutMs = clampNumber(cfg.entryTimeoutMs, 250, 30000, DEFAULTS.entryTimeoutMs);
        if (!Array.isArray(cfg.assetPatterns)) cfg.assetPatterns = [];
        // Entries must be plain non-empty strings: they are appended to the
        // document, so a stray object/regex here is a broken page, not a
        // mis-versioned asset.
        cfg.entryScripts = Array.isArray(cfg.entryScripts)
            ? cfg.entryScripts.filter(function (u) { return typeof u === 'string' && u.trim() !== ''; })
                .map(function (u) { return u.trim(); })
            : [];
        if (typeof cfg.getVersion !== 'function') cfg.getVersion = null;
        if (typeof cfg.onUpdateAvailable !== 'function') cfg.onUpdateAvailable = null;
        cfg.versionUrl = typeof cfg.versionUrl === 'string' ? cfg.versionUrl : '';
        cfg.versionJsonField = typeof cfg.versionJsonField === 'string' ? cfg.versionJsonField : '';
        return cfg;
    }

    /**
     * Derive a deterministic instance name from a versionUrl: the last
     * DIRECTORY segment of its path. "/web/KefinTweaks/version.json" →
     * "KefinTweaks"; "/MyPlugin/RefreshVersion" → "MyPlugin". Deterministic on
     * purpose — the same adoption always resolves to the same name, which is
     * what makes accidental double-registration a silent dedupe.
     * @param {string} versionUrl
     * @returns {string} Derived name, or '' when it cannot be derived.
     */
    function deriveName(versionUrl) {
        if (typeof versionUrl !== 'string' || !versionUrl) return '';
        var s = versionUrl.split('#')[0].split('?')[0];
        s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, ''); // strip scheme://host
        var parts = s.split('/').filter(Boolean);
        if (parts.length >= 2) return parts[parts.length - 2];
        if (parts.length === 1) {
            var stem = parts[0].replace(/\.[^.]*$/, '');
            return stem || parts[0];
        }
        return '';
    }

    /**
     * Structural config equivalence, for silent dedupe of an accidental double
     * include of the SAME adoption. Compared on normalized configs: scalars by
     * ===, functions by reference, patterns by type + string form.
     * @param {RefreshKitConfig} a
     * @param {RefreshKitConfig} b
     * @returns {boolean}
     */
    function configsEquivalent(a, b) {
        var scalar = ['name', 'versionUrl', 'versionJsonField', 'pollSeconds', 'idleSeconds',
            'entryTimeoutMs', 'mode', 'reloadBudget', 'getVersion', 'onUpdateAvailable'];
        for (var i = 0; i < scalar.length; i++) {
            if (a[scalar[i]] !== b[scalar[i]]) return false;
        }
        if (a.entryScripts.length !== b.entryScripts.length) return false;
        for (var j = 0; j < a.entryScripts.length; j++) {
            if (a.entryScripts[j] !== b.entryScripts[j]) return false;
        }
        if (a.assetPatterns.length !== b.assetPatterns.length) return false;
        for (var k = 0; k < a.assetPatterns.length; k++) {
            var pa = a.assetPatterns[k], pb = b.assetPatterns[k];
            if ((pa instanceof RegExp) !== (pb instanceof RegExp)) return false;
            if (String(pa) !== String(pb)) return false;
        }
        return true;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Shared page-level state
    // ─────────────────────────────────────────────────────────────────────────

    /** @type {Array<Object>} Instances, in registration (= tag document) order. */
    var registry = [];
    /** @type {Object<string, Object>} name → instance. */
    var byName = Object.create(null);
    /** @type {number} Timestamp of the last user interaction (page-level). */
    var lastInteractionAt = Date.now();
    /** @type {number|null} setTimeout handle for the blocked-reload retry. */
    var retryTimer = null;
    /** @type {number} Consecutive blocked retries, to stop an unbounded 1Hz loop. */
    var blockedRetries = 0;
    /** @type {string|null} Last recorded reason a reload was refused (diagnostics). */
    var lastBlockReason = null;
    /** @type {boolean} One-shot latch: warn about overlapping assetPatterns once. */
    var warnedOverlap = false;
    /** @type {boolean} True once the single createElement wrapper is installed. */
    var interceptorInstalled = false;

    // ─────────────────────────────────────────────────────────────────────────
    // URL versioning helpers (shared, pure)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Does the URL's QUERY STRING already carry a `v=` parameter? A path
     * segment named "v=" is not a parameter, and a fragment is not sent to the
     * server at all — never clobber a caller's own cache-busting;
     * double-versioning is a cache-miss storm.
     * @param {string} url
     * @returns {boolean}
     */
    function hasVersionParam(url) {
        var hashAt = url.indexOf('#');
        var base = hashAt === -1 ? url : url.slice(0, hashAt);
        var qAt = base.indexOf('?');
        var query = qAt === -1 ? '' : base.slice(qAt + 1);
        return !!query && /(^|&)v=/.test(query);
    }

    /**
     * Append `?v=<version>` (or `&v=`), keeping any fragment in place. Callers
     * are responsible for the "should we" checks (hasVersionParam etc.).
     * @param {string} url
     * @param {string} version
     * @returns {string}
     */
    function appendVersion(url, version) {
        var hashAt = url.indexOf('#');
        var base = hashAt === -1 ? url : url.slice(0, hashAt);
        var hash = hashAt === -1 ? '' : url.slice(hashAt);
        var sep = base.indexOf('?') === -1 ? '?' : '&';
        return base + sep + 'v=' + encodeURIComponent(version) + hash;
    }

    /**
     * The PAGE-LEVEL versioning decision, used by the single interceptor (and
     * the manager-level versionedUrl API):
     *   • URLs already carrying v= pass through untouched, always.
     *   • All registered instances' assetPatterns are consulted; the FIRST
     *     REGISTERED instance whose patterns match versions the URL with THAT
     *     instance's resolved version (unresolved → pass through untouched,
     *     same as 1.x before the first fetch).
     *   • If MORE THAN ONE instance matches, first-registered wins and we log
     *     ONE console.warn naming the overlap — the first time it bites, only.
     * @param {string} url
     * @returns {string}
     */
    function versionUrlForPage(url) {
        if (typeof url !== 'string' || !url) return url;
        if (hasVersionParam(url)) return url;
        var matches = null;
        for (var i = 0; i < registry.length; i++) {
            if (registry[i].matchesAssetPattern(url)) {
                if (!matches) matches = [];
                matches.push(registry[i]);
            }
        }
        if (!matches) return url;
        if (matches.length > 1 && !warnedOverlap) {
            warnedOverlap = true;
            safe(function () {
                console.warn(LOG, 'assetPatterns OVERLAP: "' + url + '" matches instances [' +
                    matches.map(function (m) { return m.name; }).join(', ') + ']. ' +
                    'First-registered "' + matches[0].name + '" wins (its version is applied). ' +
                    'Keep patterns disjoint per collection. (Warned once.)');
            });
        }
        var v = matches[0].getBaselineVersion();
        if (!v) return url;
        return appendVersion(url, v);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The single shared interceptor
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Install a per-ELEMENT accessor for `prop` ('src' or 'href') on a freshly
     * created element so that assignment rewrites the URL before the browser
     * ever sees it.
     *
     * Why per-element and not on Element.prototype: patching the prototype
     * changes behaviour for every script/link on the page including Jellyfin's
     * own and any other plugin's, is near-impossible to un-install, and breaks
     * `instanceof`-style feature probes. Per-element means only elements this
     * kit's own createElement wrapper handed out are affected, and any code that
     * builds its element some other way is untouched (a fail-safe default).
     *
     * We delegate storage to the element's real prototype accessor, so
     * getAttribute/setAttribute, resolution to an absolute URL, and load
     * behaviour all stay exactly native.
     *
     * @param {Element} el
     * @param {'src'|'href'} prop
     */
    function interceptUrlProperty(el, prop) {
        var proto = Object.getPrototypeOf(el);
        var native = Object.getOwnPropertyDescriptor(proto, prop);
        // Some very old / exotic engines expose src as an own value property.
        // Without a native accessor pair there is nothing to delegate to.
        if (!native || typeof native.get !== 'function' || typeof native.set !== 'function') return;

        Object.defineProperty(el, prop, {
            configurable: true,
            enumerable: true,
            get: function () { return native.get.call(this); },
            set: function (value) {
                var rewritten = safe(function () {
                    return typeof value === 'string' ? versionUrlForPage(value) : value;
                }, value);
                native.set.call(this, rewritten);
            }
        });
    }

    /**
     * Patch `setAttribute` on the element too. Plenty of code writes
     * `el.setAttribute('src', url)` instead of `el.src = url`, and that path
     * bypasses the property accessor entirely.
     * @param {Element} el
     * @param {'src'|'href'} prop
     */
    function interceptSetAttribute(el, prop) {
        var nativeSetAttribute = el.setAttribute;
        Object.defineProperty(el, 'setAttribute', {
            configurable: true,
            enumerable: false,
            writable: true,
            value: function (name, value) {
                if (typeof name === 'string' && name.toLowerCase() === prop && typeof value === 'string') {
                    value = safe(function () { return versionUrlForPage(value); }, value);
                }
                return nativeSetAttribute.call(this, name, value);
            }
        });
    }

    /**
     * Wrap document.createElement so that <script> and <link> elements come back
     * with the URL interceptors already installed. Installed ONCE per page, by
     * the manager — later kit copies register instances instead of re-wrapping
     * (that is the whole point of the registration contract).
     *
     * This is the whole trick, and it is why the kit works on collections that
     * were never written with cache-busting in mind. KefinTweaks' loader, for
     * example, does exactly this in injector.js:
     *
     *     const script = document.createElement('script');       // line 552
     *     script.src = `${scriptRoot}${filename}${urlSuffix}`;   // line 553
     *     document.head.appendChild(script);                     // line 566
     *
     * ...with `urlSuffix = ''` hardcoded (injector.js line 309 — the cache-buster
     * is commented out on line 310). The assignment on line 553 goes through our
     * accessor and comes out versioned, with zero changes to KefinTweaks.
     * Its loadCSS() does the same for <link href> (lines 516–519).
     *
     * Note we intentionally do NOT patch createElementNS, innerHTML, or
     * document.write. Those are rarer, much more invasive to intercept, and the
     * cost of missing them is only that a given asset stays unversioned.
     */
    function installCreateElementHook() {
        var nativeCreateElement = document.createElement;
        if (typeof nativeCreateElement !== 'function') return;
        // Belt and braces: if a wrapper of ours is somehow already present
        // (manager global failed to install but the hook stuck), never stack a
        // second one.
        if (nativeCreateElement.__jellyfinRefreshKitWrapper) { interceptorInstalled = true; return; }

        var wrapper = function (tagName) {
            var el = nativeCreateElement.apply(this, arguments);
            safe(function () {
                if (typeof tagName !== 'string') return;
                var tag = tagName.toLowerCase();
                if (tag === 'script') {
                    interceptUrlProperty(el, 'src');
                    interceptSetAttribute(el, 'src');
                } else if (tag === 'link') {
                    // Only stylesheets are worth versioning; but `rel` is often
                    // assigned AFTER href, so we cannot filter on it here. The
                    // assetPatterns check is the real filter, and it keeps this
                    // from touching favicons/preconnects that don't match.
                    interceptUrlProperty(el, 'href');
                    interceptSetAttribute(el, 'href');
                }
            });
            return el;
        };
        safe(function () {
            Object.defineProperty(wrapper, '__jellyfinRefreshKitWrapper', { value: true });
        });
        document.createElement = wrapper;
        interceptorInstalled = true;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Shared safety gate
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Does this media element represent a real session we must not destroy?
     * A paused-but-loaded video still holds a playback position and a queue.
     * @param {HTMLMediaElement} el
     * @returns {boolean}
     */
    function hasLiveMedia(el) {
        try {
            var src = el.currentSrc || el.getAttribute('src') || '';
            if (!src) {
                var sourceEl = el.querySelector('source[src]');
                src = sourceEl ? (sourceEl.getAttribute('src') || '') : '';
            }
            if (!src) return false;
            if (el.ended) return false;
            // Not paused → playing. Paused but readyState > 0 → loaded and parked.
            return !el.paused || el.readyState > 0;
        } catch (_) {
            // Unreadable element: assume it is live rather than reload over it.
            return true;
        }
    }

    /**
     * @param {number} idleMs The idle window that must have elapsed (already
     *   floored at MIN_SETTLE_MS by the caller).
     * @returns {string|null} A stable reason key why reloading now is unsafe, or
     *   null when a reload is safe. Order is cheapest-and-most-decisive first.
     */
    function blockReasonFor(idleMs) {
        try {
            if (document.visibilityState === 'hidden') return 'hidden';

            // Jellyfin's own video route. Even before a <video> exists, being on
            // #/video means a session is starting.
            var hash = String(location.hash || '');
            if (hash.indexOf('#/video') === 0 || hash.indexOf('#!/video') === 0) return 'playback_route';

            if (document.fullscreenElement || document.pictureInPictureElement) return 'fullscreen_media';

            // Open modal/dialog: the user is mid-task and probably mid-write.
            var dialogs = document.querySelectorAll(
                '.dialog.opened, .actionSheet.opened, [role="dialog"], [aria-modal="true"]'
            );
            for (var i = 0; i < dialogs.length; i++) {
                // A closed-but-retained dialog stays in the DOM inside an
                // aria-hidden/hidden subtree; only visible ones block.
                if (!dialogs[i].closest('[aria-hidden="true"], [hidden]')) return 'dialog';
            }

            var media = document.querySelectorAll('video, audio');
            for (var j = 0; j < media.length; j++) {
                if (hasLiveMedia(/** @type {HTMLMediaElement} */ (media[j]))) return 'media_element';
            }

            var active = document.activeElement;
            if (active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName || ''))) {
                return 'active_editor';
            }

            if ((Date.now() - lastInteractionAt) < idleMs) return 'not_idle';
            return null;
        } catch (err) {
            // A probe that throws leaves safety unknown — refuse the reload.
            safe(function () { console.debug(LOG, 'safety probe failed:', err); });
            return 'probe_failed';
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Shared reload budget
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * The page-level reload budget: the MINIMUM reloadBudget among all
     * registered instances. A reload nukes every instance's tab, so the most
     * conservative adopter sets the page's ceiling.
     * @returns {number}
     */
    function effectiveReloadBudget() {
        var budget = DEFAULTS.reloadBudget;
        for (var i = 0; i < registry.length; i++) {
            if (registry[i].cfg.reloadBudget < budget || i === 0) budget = registry[i].cfg.reloadBudget;
        }
        return budget;
    }

    /**
     * Read the stamp list from one Storage.
     * @param {Storage} storage
     * @returns {number[]|null} Stamps, [] when absent, null when unreadable/corrupt.
     */
    function readBudget(storage) {
        try {
            var raw = storage.getItem(BUDGET_KEY);
            if (raw === null || raw === undefined) return [];
            var parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return null;
            for (var i = 0; i < parsed.length; i++) {
                if (typeof parsed[i] !== 'number' || !isFinite(parsed[i])) return null;
            }
            return parsed;
        } catch (_) {
            return null;
        }
    }

    /**
     * Write the budget and PROVE it stuck. Some embedded WebViews (and Safari in
     * certain private modes) accept setItem without throwing and then silently
     * drop the value; only a read-after-write match proves this reload was
     * actually counted. An uncounted reload is an infinite reload loop.
     * @param {Storage} storage
     * @param {string} serialized
     * @param {number[]} expected
     * @returns {boolean}
     */
    function writeBudget(storage, serialized, expected) {
        try {
            storage.setItem(BUDGET_KEY, serialized);
        } catch (_) {
            return false;
        }
        var verified = readBudget(storage);
        if (!verified || verified.length !== expected.length) return false;
        for (var i = 0; i < expected.length; i++) {
            if (verified[i] !== expected[i]) return false;
        }
        return true;
    }

    /**
     * @param {'sessionStorage'|'localStorage'} name
     * @returns {Storage|null}
     */
    function safeStorage(name) {
        try {
            var s = window[name];
            // Merely touching the object is what throws in locked-down browsers.
            return (s && typeof s.getItem === 'function' && typeof s.setItem === 'function') ? s : null;
        } catch (_) {
            return null;
        }
    }

    /**
     * Reserve one reload against the rolling budget.
     *
     * FAILS CLOSED: if no storage can be read, or no write can be verified, the
     * reload does NOT happen. A refresh kit that cannot count its own reloads is
     * exactly the thing that reload-loops a user's browser.
     *
     * sessionStorage and localStorage are both used and merged: sessionStorage
     * is per-tab (survives reloads, catches a single tab looping), localStorage
     * is shared (catches every tab reloading at once). Stamps are de-duplicated
     * so mirroring the same reservation into both cannot consume the budget twice.
     *
     * @returns {boolean} True when a reload may proceed.
     */
    function reserveReload() {
        var budget = effectiveReloadBudget();
        var adapters = [];
        var ss = safeStorage('sessionStorage');
        var ls = safeStorage('localStorage');
        if (ss) adapters.push(ss);
        if (ls) adapters.push(ls);

        var readable = [];
        for (var a = 0; a < adapters.length; a++) {
            var history = readBudget(adapters[a]);
            if (history !== null) readable.push({ storage: adapters[a], history: history });
        }
        if (readable.length === 0) return false;

        var now = Date.now();
        var seen = Object.create(null);
        var combined = [];
        for (var r = 0; r < readable.length; r++) {
            var list = readable[r].history;
            for (var i = 0; i < list.length; i++) {
                var stamp = list[i];
                // Keep only live stamps inside the rolling window; drop future
                // stamps entirely (a clock change must not grant free reloads).
                if (stamp < now - BUDGET_WINDOW_MS || stamp > now) continue;
                if (!seen[stamp]) { seen[stamp] = true; combined.push(stamp); }
            }
        }
        combined.sort(function (x, y) { return x - y; });
        combined = combined.slice(-budget);

        if (combined.length >= budget) return false;

        var next = combined.concat([now]);
        var serialized = JSON.stringify(next);
        var persisted = false;
        for (var w = 0; w < readable.length; w++) {
            if (writeBudget(readable[w].storage, serialized, next)) persisted = true;
        }
        return persisted;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Shared reload engine
    // ─────────────────────────────────────────────────────────────────────────

    /** @returns {Array<Object>} Auto-mode instances with a pending update. */
    function pendingInstances() {
        var out = [];
        for (var i = 0; i < registry.length; i++) {
            if (registry[i].updatePending && registry[i].cfg.mode === 'auto') out.push(registry[i]);
        }
        return out;
    }

    /**
     * Idle window used for a page-level reload decision: the STRICTEST (max)
     * idleSeconds among the instances currently wanting a reload — one plugin
     * asking for a calm 30s of idle is not overruled by another asking for 2s.
     * With no pending instances (informational calls), the max over all.
     * @param {Array<Object>} [pending]
     * @returns {number} Milliseconds, floored at MIN_SETTLE_MS.
     */
    function effectiveIdleWindowMs(pending) {
        var list = (pending && pending.length) ? pending : registry;
        var maxIdle = 0;
        for (var i = 0; i < list.length; i++) {
            if (list[i].cfg.idleSeconds > maxIdle) maxIdle = list[i].cfg.idleSeconds;
        }
        return Math.max(maxIdle * 1000, MIN_SETTLE_MS);
    }

    /** Cancel the blocked-reload retry timer. */
    function clearRetry() {
        if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
    }

    /**
     * Schedule one more safety re-evaluation. Bounded so a tab left on a video
     * forever does not tick at 1Hz for eternity — after the cap we simply wait
     * for the next interaction or poll to re-arm.
     */
    function scheduleRetry() {
        clearRetry();
        if (blockedRetries >= MAX_BLOCKED_RETRIES) return;
        blockedRetries++;
        retryTimer = setTimeout(function () {
            retryTimer = null;
            safe(tryReload);
        }, RETRY_MS);
    }

    /**
     * Attempt the shared reload if every gate passes; otherwise arm a retry.
     * Called on: any instance's update detection, every interaction settle, and
     * each retry tick. ONE reload serves every pending instance at once —
     * after it, each instance's assets re-resolve at their own (new or
     * unchanged) versions.
     */
    function tryReload() {
        var pending = pendingInstances();
        if (pending.length === 0) return;

        var reason = blockReasonFor(effectiveIdleWindowMs(pending));
        if (reason) {
            if (reason !== lastBlockReason) {
                lastBlockReason = reason;
                safe(function () { console.debug(LOG, 'reload deferred:', reason); });
            }
            // 'hidden' needs no timer at all — visibilitychange will wake us and
            // burning a 1Hz timer in a background tab is exactly what we promise
            // not to do.
            if (reason !== 'hidden') scheduleRetry();
            return;
        }
        lastBlockReason = null;
        clearRetry();

        if (!reserveReload()) {
            safe(function () {
                console.warn(LOG, 'reload budget exhausted (' + effectiveReloadBudget() + ' per ' +
                    (BUDGET_WINDOW_MS / 1000) + 's) or unverifiable — not reloading. ' +
                    'This is the loop-protection fail-closed path.');
            });
            // Stop trying for this window. The next poll that sees a *different*
            // version, or a manual checkNow(), re-arms.
            for (var i = 0; i < pending.length; i++) pending[i].updatePending = false;
            return;
        }

        safe(function () {
            console.log(LOG, 'reloading to pick up: ' + pending.map(function (p) {
                return p.name + ' ' + p.getBaselineVersion() + ' → ' + p.getLatestVersion();
            }).join(', '));
        });
        for (var j = 0; j < pending.length; j++) pending[j].updatePending = false;
        safe(function () { location.reload(); });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Shared interaction tracking
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Discrete interactions: stamp the idle clock AND re-evaluate the reload —
     * but deferred by one task, so the host page's own handler for this event
     * has already run (and, e.g., opened its dialog) before we probe safety.
     */
    function onDiscreteInteraction() {
        lastInteractionAt = Date.now();
        if (pendingInstances().length === 0) return;
        clearRetry();
        blockedRetries = 0;
        setTimeout(function () {
            // Wait out the remaining idle window from THIS interaction.
            var remaining = Math.max(0,
                lastInteractionAt + effectiveIdleWindowMs(pendingInstances()) - Date.now());
            setTimeout(function () { safe(tryReload); }, remaining);
        }, 0);
    }

    /**
     * Continuous interactions (mousemove/wheel/scroll/touchmove): stamp only.
     * Re-arming a timer per event here would schedule thousands of timers during
     * a single scroll. The 1Hz retry tick already re-evaluates on its own.
     */
    function onContinuousInteraction() {
        lastInteractionAt = Date.now();
    }

    /**
     * Tab became visible again (or regained focus, or came back from bfcache).
     * Catch up every instance immediately — the tab may have been hidden for
     * hours — each instance's own min-gap floor keeps the
     * visibilitychange/focus/pageshow burst at one fetch per instance, not three.
     */
    function onWake() {
        var i;
        if (document.visibilityState === 'hidden') {
            for (i = 0; i < registry.length; i++) registry[i].stopPolling();
            clearRetry();
            return;
        }
        for (i = 0; i < registry.length; i++) registry[i].wake();
        // A pending update that was blocked purely by 'hidden' can now proceed.
        if (pendingInstances().length > 0) { blockedRetries = 0; safe(tryReload); }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Instance factory — everything per-collection lives in this closure
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Create one instance: its own version source + polling + baseline, its own
     * bootstrap entry chain, its own mode/callback. Reloads and interception
     * stay page-level (shared engine / shared wrapper).
     *
     * @param {string} name Resolved unique instance name.
     * @param {RefreshKitConfig} cfg Normalized config.
     * @param {string} sourceKitVersion KIT_VERSION of the registering copy.
     * @returns {Object} Internal instance record.
     */
    function createInstance(name, cfg, sourceKitVersion) {
        /** @type {string|null} First version ever resolved — the build this tab is running (for this instance). */
        var baselineVersion = null;
        /** @type {string|null} Most recent version seen on this instance's server endpoint. */
        var latestVersion = null;
        /** @type {number} Timestamp of the last version fetch attempt. */
        var lastFetchAt = 0;
        /** @type {number|null} setTimeout handle for this instance's poll loop. */
        var pollTimer = null;
        /**
         * Last version we announced (log + onUpdateAvailable). In 'notify' mode
         * nothing ever clears the mismatch, so without this watermark every poll
         * would re-announce the SAME unchanged update — once a minute, forever.
         * @type {string|null}
         */
        var notifiedVersion = null;
        /** @type {boolean} One-shot latch so version-source failures warn exactly once. */
        var warnedFetchFailure = false;
        /** @type {boolean} True when entryScripts are configured (bootstrap mode). */
        var bootstrapMode = cfg.entryScripts.length > 0;
        /** @type {boolean} One-shot latch so the entry chain can only start once. */
        var entriesStarted = false;
        /** @type {boolean} True once every entry has settled (loaded, or failed and skipped). */
        var entriesLoaded = false;
        /** @type {boolean} Did the entries get a ?v= — i.e. did the version resolve in time? */
        var entriesVersioned = false;

        /** Log prefix so N instances' messages stay attributable. */
        var TAG = '[' + name + ']';

        /**
         * Does this URL belong to an asset THIS instance is supposed to version?
         * @param {string} url
         * @returns {boolean}
         */
        function matchesAssetPattern(url) {
            if (!url || typeof url !== 'string') return false;
            for (var i = 0; i < cfg.assetPatterns.length; i++) {
                var p = cfg.assetPatterns[i];
                if (typeof p === 'string') {
                    if (p && url.indexOf(p) !== -1) return true;
                } else if (p instanceof RegExp) {
                    // Reset lastIndex: a /g regex is stateful across .test() calls.
                    p.lastIndex = 0;
                    if (p.test(url)) return true;
                }
            }
            return false;
        }

        /**
         * Instance-scoped versioning: append `?v=<this instance's version>` when
         * — and only when — all of:
         *   • this instance's version is known (before that, pass through),
         *   • the URL matches one of ITS assetPatterns OR `force` is set (entry
         *     scripts are explicitly this instance's own, so they are versioned
         *     whether or not the adopter bothered to list a matching pattern),
         *   • the URL does not already carry a `v=` parameter.
         * @param {string} url
         * @param {boolean} [force] Skip the assetPattern check (bootstrap entries).
         * @returns {string} The versioned URL, or the input unchanged.
         */
        function versionedUrl(url, force) {
            return safe(function () {
                if (typeof url !== 'string' || !url) return url;
                if (!baselineVersion) return url;
                if (!force && !matchesAssetPattern(url)) return url;
                if (hasVersionParam(url)) return url;
                return appendVersion(url, baselineVersion);
            }, url);
        }

        /**
         * Fetch the current version from this instance's configured source.
         *
         * Two layers of cache defeat are needed here, because the version
         * endpoint is the one request that absolutely must not be stale:
         *   • cache: 'no-store'   — tells the HTTP cache not to serve or store it,
         *   • ?_=<timestamp>      — defeats caches that ignore no-store anyway
         *                           (some proxies, some embedded WebViews).
         *
         * @returns {Promise<string>} Resolves to a non-empty version string.
         */
        function fetchVersion() {
            lastFetchAt = Date.now();

            if (cfg.getVersion) {
                return Promise.resolve()
                    .then(function () { return cfg.getVersion(); })
                    .then(function (v) {
                        var s = String(v == null ? '' : v).trim();
                        if (!s) throw new Error('getVersion() returned an empty version');
                        return s;
                    });
            }

            if (!cfg.versionUrl) return Promise.reject(new Error('no versionUrl configured'));

            var url = cfg.versionUrl + (cfg.versionUrl.indexOf('?') === -1 ? '?' : '&') + '_=' + Date.now();
            return fetch(url, { cache: 'no-store', credentials: 'same-origin' })
                .then(function (res) {
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    return res.text();
                })
                .then(function (text) {
                    var value = text;
                    if (cfg.versionJsonField) {
                        var parsed = JSON.parse(text);
                        value = parsed ? parsed[cfg.versionJsonField] : '';
                    }
                    var s = String(value == null ? '' : value).trim();
                    if (!s) throw new Error('empty version response');
                    // Guard against an HTML error page being read as a "version".
                    if (s.length > 200 || s.charAt(0) === '<') throw new Error('version response does not look like a version');
                    return s;
                });
        }

        /**
         * Called with each successfully fetched version for THIS instance.
         * @param {string} version
         */
        function onVersion(version) {
            // First success establishes the baseline: "this is the build this tab
            // is running". It is deliberately NOT the newest version — it is the
            // one whose assets are already in memory.
            if (baselineVersion === null) {
                baselineVersion = version;
                latestVersion = version;
                safe(function () { console.log(LOG, TAG, 'version resolved:', version); });
                return;
            }

            latestVersion = version;
            // Nothing new: same build we are already running, an announcement we
            // already made, or an auto-reload already in flight.
            if (version === baselineVersion || version === notifiedVersion || inst.updatePending) return;
            notifiedVersion = version;

            safe(function () {
                console.log(LOG, TAG, 'update available: ' + baselineVersion + ' → ' + version);
            });

            if (cfg.onUpdateAvailable) {
                safe(function () { cfg.onUpdateAvailable(version, baselineVersion); });
            }

            // 'notify' and 'off' stop here — a notify instance NEVER triggers the
            // shared reload; its callback above already fired.
            if (cfg.mode !== 'auto') return;

            inst.updatePending = true;
            blockedRetries = 0;
            safe(tryReload);
        }

        /**
         * One poll cycle for this instance: fetch, react, reschedule.
         * @param {boolean} [force] Skip the min-gap floor (used by checkNow()).
         * @returns {Promise<void>}
         */
        function poll(force) {
            if (cfg.mode === 'off') return Promise.resolve();
            if (!force && (Date.now() - lastFetchAt) < MIN_FETCH_GAP_MS) return Promise.resolve();

            return fetchVersion().then(function (v) {
                warnedFetchFailure = false;
                safe(function () { onVersion(v); });
            }, function (err) {
                // Version-source failure is NOT an update. Warn once, stay quiet
                // afterwards (a 404'd version.json must not spam the console every
                // minute), never reload, and keep polling — the endpoint may come
                // back after a deploy.
                if (!warnedFetchFailure) {
                    warnedFetchFailure = true;
                    safe(function () { console.warn(LOG, TAG, 'version check failed (further failures silenced):', err && err.message ? err.message : err); });
                }
            });
        }

        /** Stop this instance's poll timer. */
        function stopPolling() {
            if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
        }

        /**
         * (Re)arm this instance's poll loop. Polling only runs while the document
         * is visible: a hidden tab holds ZERO timers, which is the difference
         * between a kit you can ship to 100k users and one that melts laptops in
         * background tabs.
         */
        function startPolling() {
            stopPolling();
            if (cfg.mode === 'off') return;
            if (document.visibilityState === 'hidden') return;
            pollTimer = setTimeout(function () {
                pollTimer = null;
                poll().then(startPolling, startPolling);
            }, cfg.pollSeconds * 1000);
        }

        /** Visibility catch-up for this instance (shared onWake fans out to these). */
        function wake() {
            if (cfg.mode === 'off') return;
            poll().then(startPolling, startPolling);
        }

        // ── Bootstrap mode: loading this instance's own entry files ──────────

        /**
         * Is this URL a stylesheet? Extension test against the PATH only, so
         * `theme.css?v=1` and `theme.css#x` count and `/css/loader.js` does not.
         * @param {string} url
         * @returns {boolean}
         */
        function isStylesheetUrl(url) {
            return /\.css(?:$|[?#])/i.test(String(url).split('#')[0]);
        }

        /**
         * Append ONE entry and resolve when it has settled.
         *
         * The promise resolves on error as well as on success — deliberately. The
         * contract is "order is preserved and the page survives"; a 404 on entry 2
         * must not strand entries 3..n. The failure is logged once, right here,
         * with the URL, because that is the only place that knows which file died.
         *
         * @param {string} url
         * @returns {Promise<void>}
         */
        function appendEntry(url) {
            return new Promise(function (resolve) {
                var settled = false;
                function finish(ok) {
                    if (settled) return;
                    settled = true;
                    if (!ok) {
                        safe(function () {
                            console.warn(LOG, TAG, 'entry failed to load (skipping, remaining entries continue):', url);
                        });
                    }
                    resolve();
                }

                var failed = safe(function () {
                    // Entries are this instance's own by definition, so force the
                    // ?v= with ITS version. If the version never resolved,
                    // versionedUrl() returns the URL untouched and we load
                    // unversioned — the availability path.
                    var finalUrl = versionedUrl(url, true);
                    var isCss = isStylesheetUrl(url);
                    // Note: document.createElement is already the shared wrapper
                    // here, so these elements carry the interceptors too. That is
                    // harmless and intentional — the URL already has v=, so the
                    // page-level matcher sees it and passes through rather than
                    // double-versioning (or cross-versioning by another instance).
                    var el = document.createElement(isCss ? 'link' : 'script');
                    el.onload = function () { finish(true); };
                    el.onerror = function () { finish(false); };
                    if (isCss) {
                        el.rel = 'stylesheet';
                        el.href = finalUrl;
                    } else {
                        // Dynamically-created scripts default to "force async".
                        // Explicitly clearing it keeps document-order execution even
                        // if a caller ever appends several at once; the sequential
                        // chain below is the primary guarantee, this is the backstop.
                        el.async = false;
                        el.src = finalUrl;
                    }
                    (document.head || document.documentElement).appendChild(el);
                    return false;
                }, true);

                // Creating/appending threw (no <head>, CSP, exotic engine): treat it
                // exactly like a load failure so the chain keeps moving.
                if (failed) finish(false);
            });
        }

        /**
         * Load every configured entry, strictly in order, once. (Order holds
         * WITHIN this instance; other instances' chains run concurrently.)
         * @returns {Promise<void>}
         */
        function loadEntries() {
            if (entriesStarted) return Promise.resolve();
            entriesStarted = true;
            entriesVersioned = !!baselineVersion;

            safe(function () {
                console.log(LOG, TAG, 'bootstrap: loading ' + cfg.entryScripts.length + ' entr' +
                    (cfg.entryScripts.length === 1 ? 'y' : 'ies') +
                    (entriesVersioned ? ' at v=' + baselineVersion : ' UNVERSIONED'));
            });

            var chain = Promise.resolve();
            cfg.entryScripts.forEach(function (url) {
                chain = chain.then(function () { return appendEntry(url); });
            });
            return chain.then(function () {
                entriesLoaded = true;
                safe(function () { console.log(LOG, TAG, 'bootstrap: all entries settled'); });
            });
        }

        /**
         * Record — at most once, and at exactly one severity level — that the
         * entries had to go out without a version.
         *
         * Why the warnedFetchFailure latch is shared with poll(): a failed version
         * fetch already warns there. Warning again here would mean two warnings for
         * one root cause, and "how many warnings did you see" is how an operator
         * triages this. So: first message about the version problem is the warning,
         * any follow-up is an informational log.
         *
         * @param {string} why
         */
        function noteUnversionedEntries(why) {
            safe(function () {
                var message = 'entry scripts loading UNVERSIONED — ' + why +
                    '. Availability over freshness; the tab will pick up the new ' +
                    'version once the endpoint recovers.';
                if (!warnedFetchFailure) {
                    warnedFetchFailure = true;
                    console.warn(LOG, TAG, message);
                } else {
                    console.log(LOG, TAG, message);
                }
            });
        }

        /**
         * The one version fetch that gates this instance's entries.
         *
         * mode 'off' disables polling and reloads, but bootstrap mode still needs
         * a version to build URLs with, so in that combination we do a single
         * direct fetch instead of going through poll() (which returns early when
         * off).
         * @returns {Promise<void>}
         */
        function firstVersionAttempt() {
            if (cfg.mode !== 'off') return poll(true);
            return fetchVersion().then(function (v) {
                safe(function () { onVersion(v); });
            }, function () { /* handled by the caller's fallback */ });
        }

        /** Arm this instance's poll loop, unless the caller disabled it. */
        function armPolling() {
            if (cfg.mode !== 'off') safe(startPolling);
        }

        /**
         * Bootstrap boot sequence: resolve the version, then load the entries —
         * but never wait longer than entryTimeoutMs to start loading them.
         *
         * Polling is armed as soon as the version question is settled either way.
         * It deliberately does NOT wait for the entries to finish downloading: a
         * slow (or stuck) entry must not also cost us update detection.
         *
         * @returns {Promise<void>}
         */
        function bootstrapEntries() {
            var timer = setTimeout(function () {
                timer = null;
                if (entriesStarted) return;
                noteUnversionedEntries('version not resolved within ' + cfg.entryTimeoutMs + 'ms');
                safe(loadEntries);
                armPolling();
            }, cfg.entryTimeoutMs);

            function proceed() {
                if (timer !== null) { clearTimeout(timer); timer = null; }
                if (!entriesStarted && !baselineVersion) {
                    noteUnversionedEntries('version source unavailable');
                }
                var done = safe(loadEntries, Promise.resolve());
                armPolling();
                return done;
            }

            return firstVersionAttempt().then(proceed, proceed);
        }

        /** Kick this instance off (called exactly once, at registration). */
        function start() {
            // The first fetch is immediate so the version is known as early as
            // possible — every millisecond before it resolves is a window in
            // which the host bootstrap may create unversioned assets.
            //
            // In bootstrap mode there IS no host bootstrap racing us: nothing of
            // this collection loads until bootstrapEntries() says so, and polling
            // only starts once the entries have been kicked off (their fetches
            // matter more than the next poll).
            if (bootstrapMode) {
                safe(bootstrapEntries);
            } else if (cfg.mode !== 'off') {
                safe(function () { poll(true).then(startPolling, startPolling); });
            } else {
                safe(function () { console.log(LOG, TAG, "mode 'off' — no polling, no reloads"); });
            }
        }

        /**
         * Diagnostic snapshot for this instance. Field-compatible with the
         * 1.1.0 singleton state() so support workflows keep working, plus name /
         * registeredByKitVersion.
         * @returns {Object}
         */
        function state() {
            return {
                kitVersion: KIT_VERSION,
                name: name,
                registeredByKitVersion: sourceKitVersion,
                mode: cfg.mode,
                bootstrapMode: bootstrapMode,
                entriesLoaded: entriesLoaded,
                entriesVersioned: entriesVersioned,
                entryScripts: cfg.entryScripts.slice(),
                version: baselineVersion,
                latestVersion: latestVersion,
                updatePending: inst.updatePending,
                blockReason: cfg.mode === 'auto'
                    ? blockReasonFor(Math.max(cfg.idleSeconds * 1000, MIN_SETTLE_MS))
                    : null,
                lastBlockReason: lastBlockReason,
                idle: (Date.now() - lastInteractionAt) >= Math.max(cfg.idleSeconds * 1000, MIN_SETTLE_MS),
                msSinceInteraction: Date.now() - lastInteractionAt,
                pollSeconds: cfg.pollSeconds,
                idleSeconds: cfg.idleSeconds,
                reloadBudget: cfg.reloadBudget,
                assetPatterns: cfg.assetPatterns.map(String),
                versionUrl: cfg.versionUrl,
                polling: pollTimer !== null,
                lastFetchAt: lastFetchAt
            };
        }

        /**
         * The PUBLIC per-instance handle (returned by manager.get(name) and by
         * __registerInstance). Frozen: it is API surface shared across kit
         * versions.
         */
        var handle = Object.freeze({
            /** @type {string} */
            name: name,
            /** @returns {string|null} The version this tab is running (this instance's baseline). */
            get version() { return baselineVersion; },
            /** @returns {string|null} The newest version seen on this instance's server. */
            get latestVersion() { return latestVersion; },
            /**
             * Version a URL with THIS instance's version/patterns. `force` skips
             * the pattern match (still never clobbers an existing v=).
             * @param {string} url
             * @param {boolean} [force]
             * @returns {string}
             */
            versionedUrl: versionedUrl,
            /**
             * Force an immediate version check for this instance, bypassing the
             * min-gap floor.
             * @returns {Promise<void>}
             */
            checkNow: function () { return safe(function () { return poll(true); }, Promise.resolve()); },
            /** @returns {Object} Snapshot of this instance's state. */
            state: function () { return safe(state, {}); }
        });

        var inst = {
            name: name,
            cfg: cfg,
            /** @type {boolean} True once an update has been detected and the shared engine should act. */
            updatePending: false,
            handle: handle,
            matchesAssetPattern: matchesAssetPattern,
            versionedUrl: versionedUrl,
            getBaselineVersion: function () { return baselineVersion; },
            getLatestVersion: function () { return latestVersion; },
            poll: poll,
            stopPolling: stopPolling,
            wake: wake,
            start: start,
            state: state
        };
        return inst;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Registration (the REGISTRATION CONTRACT implementation)
    // ─────────────────────────────────────────────────────────────────────────

    /** @type {boolean} window.JellyfinRefreshKitConfig applies to the FIRST instance only. */
    var singularConfigApplied = false;

    /**
     * Register one instance from a raw tag-level config. This is what
     * __registerInstance delegates to; the first copy's own registration goes
     * through the very same path, so there is exactly one code path.
     *
     * Merge order (last wins):
     *   defaults < data-* (rawConfig) < window.JellyfinRefreshKitConfig
     *   (first registration only) < window.JellyfinRefreshKitConfigs[name]
     *
     * @param {Object} rawConfig Plain object of tag-level options.
     * @param {string} sourceKitVersion KIT_VERSION of the registering copy.
     * @returns {Object|null} The instance's public handle, or null on failure.
     */
    function registerInstance(rawConfig, sourceKitVersion) {
        var raw = (rawConfig && typeof rawConfig === 'object') ? rawConfig : {};

        /** @type {any} */
        var merged = {};
        var key;
        for (key in raw) { if (Object.prototype.hasOwnProperty.call(raw, key)) merged[key] = raw[key]; }

        // 1.x back-compat: the singular window config configures the FIRST
        // instance registered on the page (which, for a single-plugin page, is
        // exactly the 1.x behaviour: window > data-* > defaults).
        if (!singularConfigApplied && registry.length === 0) {
            singularConfigApplied = true;
            safe(function () {
                var w = window.JellyfinRefreshKitConfig;
                if (w && typeof w === 'object') {
                    for (var k in w) { if (Object.prototype.hasOwnProperty.call(w, k)) merged[k] = w[k]; }
                }
            });
        }

        // Keyed window config: matched by the name the instance would resolve
        // to WITHOUT it (data-name, else derived from versionUrl). The key IS
        // the name, so a keyed entry cannot rename its instance.
        var provisionalName = (typeof merged.name === 'string' && merged.name.trim()) ||
            deriveName(typeof merged.versionUrl === 'string' ? merged.versionUrl : '');
        if (provisionalName) {
            safe(function () {
                var all = window.JellyfinRefreshKitConfigs;
                var entry = (all && typeof all === 'object') ? all[provisionalName] : null;
                if (entry && typeof entry === 'object') {
                    for (var k in entry) {
                        if (Object.prototype.hasOwnProperty.call(entry, k) && k !== 'name') merged[k] = entry[k];
                    }
                }
            });
        }

        var cfg = normalizeConfig(merged);
        var name = cfg.name || deriveName(cfg.versionUrl) || ('instance-' + (registry.length + 1));
        // Stamp the RESOLVED name before the equivalence check, so a duplicate
        // tag that omitted data-name (name derived from versionUrl) still
        // compares equal to the instance it duplicates.
        cfg.name = name;

        // Same name again?
        var existing = byName[name];
        if (existing) {
            if (configsEquivalent(existing.cfg, cfg)) {
                // Identical duplicate registration (double-included tag, or two
                // plugins genuinely shipping the same adoption): silent dedupe.
                return existing.handle;
            }
            var base = name, n = 2;
            while (byName[base + '#' + n]) n++;
            name = base + '#' + n;
            safe(function () {
                console.warn(LOG, 'instance name "' + base + '" already registered with a different ' +
                    'config; registering this one as "' + name + '". Give each adoption a distinct ' +
                    'data-name (or versionUrl) to silence this.');
            });
        }

        cfg.name = name;
        var sourceVersion = String(sourceKitVersion || 'unknown');
        var inst = createInstance(name, cfg, sourceVersion);
        registry.push(inst);
        byName[name] = inst;
        safe(function () {
            console.log(LOG, 'instance registered: "' + name + '" (kit ' + sourceVersion +
                ', manager ' + KIT_VERSION + ', ' + registry.length + ' total)');
        });
        inst.start();
        return inst.handle;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Public API — the manager
    // ─────────────────────────────────────────────────────────────────────────

    /** @returns {Object|null} First-registered instance (the 1.x delegate). */
    function firstInstance() {
        return registry.length > 0 ? registry[0] : null;
    }

    /**
     * The manager. Keeps the whole 1.x surface (version, latestVersion,
     * versionedUrl, checkNow, state) delegating to the sole instance when
     * exactly one exists; with 2+ instances the top-level getters follow a
     * documented rule — version/latestVersion report the FIRST-REGISTERED
     * instance, versionedUrl uses the page-level matcher (all instances),
     * checkNow fans out to every instance. Prefer the explicit surface:
     * get(name) / instances() / state().
     *
     * Frozen: __registerInstance is the cross-version compatibility promise and
     * must not be reassignable by anyone, including a later kit copy.
     */
    var api = Object.freeze({
        /** @type {string} The manager copy's kit version. */
        kitVersion: KIT_VERSION,

        /** @type {number} REGISTRATION CONTRACT revision this manager speaks. */
        __contractVersion: CONTRACT_VERSION,

        /**
         * REGISTRATION CONTRACT clause 3 — the frozen, forward-stable entry
         * point every later-loaded kit copy calls instead of installing its own
         * machinery. Never throws; returns the instance handle or null.
         * @param {Object} config Plain object of tag-level options.
         * @param {string} kitVersion The registering copy's KIT_VERSION.
         * @returns {Object|null}
         */
        __registerInstance: function (config, kitVersion) {
            return safe(function () { return registerInstance(config, kitVersion); }, null) || null;
        },

        /** @returns {string|null} Sole/first instance's running version (1.x compat). */
        get version() {
            var f = firstInstance();
            return f ? f.getBaselineVersion() : null;
        },

        /** @returns {string|null} Sole/first instance's newest seen version (1.x compat). */
        get latestVersion() {
            var f = firstInstance();
            return f ? f.getLatestVersion() : null;
        },

        /**
         * Explicitly version a URL. Useful for code that builds asset URLs
         * outside of createElement (fetch(), import(), CSS url()).
         * Without `force`: the page-level matcher (all instances' patterns,
         * first-registered match wins) — identical to what the interceptor does.
         * With `force`: the FIRST-REGISTERED instance's version is applied
         * regardless of patterns (1.x compat; prefer get(name).versionedUrl).
         * @param {string} url
         * @param {boolean} [force]
         * @returns {string}
         */
        versionedUrl: function (url, force) {
            return safe(function () {
                if (force) {
                    var f = firstInstance();
                    return f ? f.versionedUrl(url, true) : url;
                }
                return versionUrlForPage(url);
            }, url);
        },

        /**
         * Force an immediate version check on EVERY instance, bypassing the
         * min-gap floor.
         * @returns {Promise<void>}
         */
        checkNow: function () {
            return safe(function () {
                return Promise.all(registry.map(function (inst) {
                    return safe(function () { return inst.poll(true); }, Promise.resolve());
                })).then(function () { return undefined; });
            }, Promise.resolve());
        },

        /**
         * @param {string} name
         * @returns {Object|null} The named instance's handle, or null.
         */
        get: function (name) {
            return safe(function () {
                var inst = byName[name];
                return inst ? inst.handle : null;
            }, null) || null;
        },

        /** @returns {string[]} Registered instance names, in registration order. */
        instances: function () {
            return safe(function () {
                return registry.map(function (inst) { return inst.name; });
            }, []) || [];
        },

        /**
         * Aggregate diagnostic snapshot. With exactly one instance the top
         * level is field-compatible with 1.1.0's state() (same names, same
         * semantics) — it just GAINS instanceCount / instances / interceptor /
         * shared. With 2+ instances the top-level scalar fields describe the
         * FIRST-REGISTERED instance; per-instance truth is in .instances.
         * @returns {Object}
         */
        state: function () {
            return safe(function () {
                var f = firstInstance();
                var out = f ? f.state() : { kitVersion: KIT_VERSION };
                out.contractVersion = CONTRACT_VERSION;
                out.instanceCount = registry.length;
                out.instances = {};
                for (var i = 0; i < registry.length; i++) {
                    out.instances[registry[i].name] = registry[i].state();
                }
                out.interceptorInstalled = interceptorInstalled;
                out.interceptorCount = interceptorInstalled ? 1 : 0;
                var pending = pendingInstances();
                out.shared = {
                    pendingInstances: pending.map(function (p) { return p.name; }),
                    blockReason: pending.length > 0 ? blockReasonFor(effectiveIdleWindowMs(pending)) : null,
                    lastBlockReason: lastBlockReason,
                    msSinceInteraction: Date.now() - lastInteractionAt,
                    effectiveIdleWindowMs: effectiveIdleWindowMs(pending),
                    effectiveReloadBudget: effectiveReloadBudget(),
                    budgetKey: BUDGET_KEY,
                    budgetWindowMs: BUDGET_WINDOW_MS
                };
                return out;
            }, { kitVersion: KIT_VERSION });
        }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Boot — manager path
    // ─────────────────────────────────────────────────────────────────────────

    // Install the createElement hook FIRST and synchronously. Any sub-script the
    // host bootstrap creates before this point is unversioned forever, so the
    // kit's <script> tag must come before the bootstrap's in the document.
    safe(installCreateElementHook);

    safe(function () {
        // Capture phase, passive: we only observe. Capture means we see the event
        // even if a handler below calls stopPropagation().
        var opts = { capture: true, passive: true };
        var discrete = ['pointerdown', 'keydown', 'click', 'input', 'change'];
        var continuous = ['pointermove', 'wheel', 'scroll', 'touchmove'];
        var i;
        for (i = 0; i < discrete.length; i++) {
            document.addEventListener(discrete[i], onDiscreteInteraction, opts);
        }
        for (i = 0; i < continuous.length; i++) {
            document.addEventListener(continuous[i], onContinuousInteraction, opts);
        }
        document.addEventListener('visibilitychange', function () { safe(onWake); }, false);
        window.addEventListener('focus', function () { safe(onWake); }, false);
        window.addEventListener('pageshow', function () { safe(onWake); }, false);
    });

    safe(function () {
        Object.defineProperty(window, 'JellyfinRefreshKit', {
            value: api, writable: false, configurable: true, enumerable: true
        });
    });

    // Finally: register THIS copy's own instance from its tag config, through
    // exactly the same contract path a later copy would use.
    safe(function () { api.__registerInstance(tagConfig, KIT_VERSION); });
})();
