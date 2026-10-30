/* global pysOptions */


! function ($, options) {
    if (options.debug) {
        console.log('PYS:', options);
    }
    var uniqueId = {};

    let gtm_variables = {};
    let gtm_datalayername = "dynamicVariable";

    // Resolved by cookieDomain() on first use, not here.
    var probedCookieDomain = null;

    /**
     * Domain attribute for cookies we write. Probed once, on first use (not
     * at load) so the probe's own write lands behind whatever consent gate
     * the caller is behind.
     *
     * Not suppressed by options.cookie.disabled_all_cookie: deleting a
     * cookie needs the same domain it was written on, so suppressing here
     * would leave parent-scoped cookies in place while appearing removed.
     *
     * Memoised only after the probe runs, so a disabled_all_cookie or option
     * arriving later over REST is still honored.
     *
     * An answer already reported to PHP in pys_cd is reused, so the probe
     * runs once per visitor, not once per page load.
     */
    function cookieDomain() {
        if (probedCookieDomain !== null) {
            return probedCookieDomain;
        }
        if (!options || !options.hasOwnProperty("track_cookie_for_subdomains")
            || !options.track_cookie_for_subdomains) {
            return '';
        }
        probedCookieDomain = reportedCookieDomain();
        if (probedCookieDomain === null) {
            probedCookieDomain = probeCookieDomain();
        }
        return probedCookieDomain;
    }

    /**
     * The domain an earlier page load verified and stored in pys_cd, or
     * null when there is nothing usable and the probe has to run.
     *
     * The browser sending us pys_cd scoped to that domain is itself proof
     * the scope is accepted, so no probe is needed. The value is checked
     * against the current host on a label boundary; anything else (another
     * site's value, a tampered one) is ignored and the probe decides.
     *
     * A value with the shape of a public suffix (co.uk, github.io) is
     * test-written before it is trusted: the value is not the cookie's own
     * scope, so a sibling subdomain can plant one, and reusing it would
     * make every PYS cookie this visitor gets vanish. PHP validates the
     * same value only for its own writes; this covers ours. The test costs
     * one throwaway write, and only for values of that shape — see
     * suspiciousCookieDomain().
     *
     * 'host-only' is deliberately not reused: it may be a false negative
     * from a full cookie jar, and reportCookieDomain() replaces it once a
     * probe succeeds, so re-probing lets it self-heal. The other false
     * negative — a domain narrower than the registrable one, from the same
     * full jar — is accepted as is: it is reused and stays until pys_cd
     * expires (365 days) or is cleared, because re-probing it would put the
     * throwaway write back on every page load for every visitor.
     */
    function reportedCookieDomain() {
        var reported, host;
        try {
            reported = Cookies.get('pys_cd');
            host = String(location.hostname || '').toLowerCase();
        } catch (e) {
            return null;
        }
        if (!reported || reported === 'host-only') return null;
        reported = String(reported).toLowerCase();
        if (reported.indexOf('.') === -1 || !host) return null;
        if (host !== reported && host.slice(-(reported.length + 1)) !== '.' + reported) {
            return null;
        }
        if (suspiciousCookieDomain(reported) && !cookieDomainAccepted('.' + reported)) {
            return null;
        }
        return '.' + reported;
    }

    /**
     * Whether a reported domain has the shape of a public suffix and so
     * needs a test write before it is reused: two labels that are both
     * short (co.uk, com.au, net.br, ac.jp), or one of the multi-tenant
     * hosts whose registrable part is a subdomain (github.io, vercel.app).
     * A real two-label domain of that shape (hp.com) pays one throwaway
     * write per page load — what every site paid before pys_cd was reused.
     */
    function suspiciousCookieDomain(domain) {
        var labels = String(domain).split('.');
        if (labels.length === 2 && labels[0].length <= 3 && labels[1].length <= 3) {
            return true;
        }
        var known = ['github.io', 'vercel.app', 'pages.dev', 'wpcomstaging.com',
            'appspot.com', 'netlify.app', 'herokuapp.com', 'myshopify.com'];
        return known.indexOf(domain) !== -1;
    }

    /**
     * Find the broadest domain this browser will actually accept a cookie
     * on, walking from the broadest candidate inward.
     *
     * We used to rely on tldjs.getDomain(), but its bundled Public Suffix
     * List predates ~2018 and returns the public suffix itself for newer
     * domains (vercel.app, pages.dev, wpcomstaging.com), so cookies scoped
     * there were silently dropped. Asking the browser instead keeps us in
     * sync with its own current PSL.
     *
     * The probe cookie is written and removed synchronously, carries no
     * data, and never outlives this call. If a consent tool blocks the
     * write, cookieDomainAccepted() reports it rejected and we fall through
     * to host-only — the correct outcome.
     *
     * Returns '' when nothing works (IP/single-label host, or all writes
     * blocked); host-only is never rejected, so it's the safe floor.
     */
    function probeCookieDomain() {
        var host = '';
        try { host = String(location.hostname || ''); } catch (e) { return ''; }

        // No Domain attribute is valid for an IP literal or a dotless host.
        if (!host || host.indexOf('.') === -1) return '';
        if (host.indexOf(':') !== -1) return '';          // IPv6 literal
        if (/^[\d.]+$/.test(host)) return '';             // IPv4 literal

        var labels = host.split('.');
        // Broadest first: last two labels, then three, ... up to the full host.
        for (var take = 2; take <= labels.length; take++) {
            var candidate = '.' + labels.slice(labels.length - take).join('.');
            if (cookieDomainAccepted(candidate)) return candidate;
        }
        return '';
    }

    /**
     * Write a throwaway cookie at $candidate and report whether it stuck.
     * A false negative is possible if the jar is at its per-domain limit;
     * we then fall through to a narrower candidate and ultimately host-only.
     *
     * The name is fixed: consent scanners (Cookiebot and the like) record
     * every write, not the jar afterwards, and a random name made each
     * crawled page a new entry in the site's cookie declaration. The random
     * part lives in the value instead, which still tells this write apart
     * from a stale cookie left behind by an earlier, interrupted probe.
     */
    function cookieDomainAccepted(candidate) {
        var name = 'pys_dt';
        var value = String(Math.floor(Math.random() * 1e9));
        var accepted = false;
        try {
            document.cookie = name + '=' + value + '; path=/; domain=' + candidate + '; SameSite=Lax';
            accepted = ('; ' + document.cookie + ';').indexOf('; ' + name + '=' + value + ';') !== -1;
        } catch (e) {
            return false;
        } finally {
            // Remove either way; deleting an unset cookie is a no-op.
            try {
                document.cookie = name + '=; path=/; domain=' + candidate + '; max-age=0';
            } catch (e) {}
        }
        return accepted;
    }

    /**
     * Hand PHP the cookie domain that probeCookieDomain() verified, since
     * PHP has no Public Suffix List and guesses wrong on hosts like
     * shop.example.co.uk or mysite.github.io — scoping its cookies to a
     * public suffix the browser then drops.
     *
     * Value is the site's registrable domain (no PII, same for every
     * visitor); PHP validates it against the request host before use (see
     * pys_cookie_domain_resolve).
     *
     * Written from manageCookies() under the same consent gates as every
     * other cookie, not unconditionally.
     *
     * No domain at all is an answer too — see reportHostOnlyCookieDomain().
     */
    function reportCookieDomain(resolved) {
        var bare = resolved ? String(resolved).replace(/^\./, '') : '';
        if (!bare || bare.indexOf('.') === -1) {
            reportHostOnlyCookieDomain();
            return;
        }
        try {
            if (Cookies.get('pys_cd') === bare) return; // already reported
            // A 'host-only' answer from an earlier load is a separate jar
            // entry (no Domain attribute), and PHP reads whichever the
            // browser sends first — so it is removed, not outranked.
            Cookies.remove('pys_cd', { path: '/', domain: '' });
            Cookies.set('pys_cd', bare, {
                expires: 365,
                path: '/',
                domain: resolved,
                sameSite: 'Lax'
            });
        } catch (e) {}
    }

    /**
     * Tell PHP that host-only is the scope in use: the option asks for a
     * Domain attribute, but probeCookieDomain() found none this browser
     * accepts (a public-suffix host such as example.github.io, or every
     * candidate write refused). Without this PHP cannot tell "not answered
     * yet" from "never will", and withholds its own cookies for ever.
     *
     * Only with the option on: off, PHP writes host-only already and waits
     * for nothing. Never overwrites an existing report — a domain accepted
     * on an earlier load outranks a probe that failed on this one (a full
     * cookie jar gives a false negative).
     */
    function reportHostOnlyCookieDomain() {
        if (!options || !options.track_cookie_for_subdomains) return;
        try {
            if (Cookies.get('pys_cd') !== undefined) return; // an answer exists
            Cookies.set('pys_cd', 'host-only', {
                expires: 365,
                path: '/',
                sameSite: 'Lax'
            });
        } catch (e) {}
    }

    // Per-page referrer for Facebook CAPI events. Captured once per script
    // load so SPA-style navigations within the same HTML document do not
    // overwrite it. Internal/external is NOT filtered — Meta expects this
    // field to describe the URL of the previous page for THIS event.
    var pageReferrer = '';
    try {
        pageReferrer = stripUrlQuery((document.referrer || '').toString());
    } catch (e) {}

    // Session-entry referrer (fallback). Captured at session start the first
    // time the visitor lands from an EXTERNAL site, mirrored to a session
    // cookie so PHP can read it for orphan events (async/cron) that arrive
    // without a per-page payload. Never the primary source.
    var PYS_SESSION_ENTRY_REFERRER_KEY = 'pys_session_entry_referrer';
    function stripUrlQuery(url) {
        if (!url) return '';
        var clean = String(url);
        var q = clean.indexOf('?');
        if (q !== -1) clean = clean.substring(0, q);
        var h = clean.indexOf('#');
        if (h !== -1) clean = clean.substring(0, h);
        return clean;
    }
    var sessionEntryReferrer = '';
    function getOrInitSessionEntryReferrer(consentGranted) {
        var value = '';
        try {
            if (typeof window.sessionStorage !== 'undefined') {
                value = window.sessionStorage.getItem(PYS_SESSION_ENTRY_REFERRER_KEY) || '';
            }
        } catch (e) {}

        if (!value) {
            var cookieValue = Cookies.get(PYS_SESSION_ENTRY_REFERRER_KEY);
            if (cookieValue && cookieValue !== 'undefined') {
                value = cookieValue;
                try {
                    if (typeof window.sessionStorage !== 'undefined') {
                        window.sessionStorage.setItem(PYS_SESSION_ENTRY_REFERRER_KEY, value);
                    }
                } catch (e) {}
            }
        }

        if (!value) {
            var raw = '';
            try {
                raw = stripUrlQuery((document.referrer || '').toString());
            } catch (e) {}
            if (raw) {
                var refHost = '';
                try {
                    refHost = new URL(raw).hostname;
                } catch (e) {}
                if (refHost && refHost !== window.location.hostname) {
                    value = raw;
                    try {
                        if (typeof window.sessionStorage !== 'undefined') {
                            window.sessionStorage.setItem(PYS_SESSION_ENTRY_REFERRER_KEY, value);
                        }
                    } catch (e) {}
                }
            }
        }

        // Mirror to a session cookie only once consent is given. The cookie
        // is session-scoped (no expires) and dies with the browser, just
        // like the sessionStorage entry.
        if (value && consentGranted && options && options.cookie
            && !options.cookie.disabled_all_cookie) {
            var existingCookie = Cookies.get(PYS_SESSION_ENTRY_REFERRER_KEY);
            if (!existingCookie || existingCookie === 'undefined') {
                Cookies.set(PYS_SESSION_ENTRY_REFERRER_KEY, value, { path: '/', domain: cookieDomain() });
            }
        }

        sessionEntryReferrer = value;
        return value;
    }

    // Populate sessionStorage / sessionEntryReferrer immediately. Cookie
    // mirroring is deferred to the consent-gated path in Facebook.loadPixel().
    getOrInitSessionEntryReferrer(false);

    // Per-page event referrer (session cookie). Snapshot of document.referrer
    // for the CURRENT page, refreshed on every page load. Read server-side
    // by saveFbTagsInOrder() to capture the buyer's checkout-page referrer
    // for orphan CAPI events (APT, gateway webhooks, manual status changes).
    // Internal URLs are intentionally NOT filtered — the goal is the page
    // that led the buyer to checkout, which is usually internal.
    // If document.referrer is empty (direct navigation), the previous value
    // is preserved so a session that began with an external referrer keeps
    // it across same-tab navigations.
    var PYS_EVENT_REFERRER_KEY = 'pys_event_referrer';
    function writeEventReferrerCookie() {
        if (!pageReferrer) {
            return;
        }
        if (!options || !options.cookie || options.cookie.disabled_all_cookie) {
            return;
        }
        try {
            Cookies.set(PYS_EVENT_REFERRER_KEY, pageReferrer, { path: '/', domain: cookieDomain() });
        } catch (e) {}
    }
    /**
     * Resolve parameter value based on mode (static or dynamic)
     *
     * @param {Object|string} param - Parameter object with { value, selector } or string value
     * @param {string} key - Parameter key name
     * @returns {string|null} - Resolved value
     */
    function resolveParamValue(param, key = '') {
        // 1️⃣ null / undefined - skip this parameter
        if (param === null || param === undefined) {
            return null;
        }

        // 2️⃣ Handle primitive types (string, number, boolean)
        if (typeof param !== 'object') {
            return param;
        }

        // 3️⃣ Handle arrays - process each element recursively
        if (Array.isArray(param)) {
            return param.map(item => resolveParamValue(item, key));
        }

        // 4️⃣ Check if this is a configuration object (has value/selector/dynamic/input_type)
        const isConfigObject =
            ('value' in param || 'selector' in param || 'dynamic' in param || 'input_type' in param) &&
            Object.keys(param).every(k =>
                ['value', 'selector', 'dynamic', 'input_type', 'name'].includes(k)
            );

        if (isConfigObject) {
            // STATIC MODE: selector is empty or dynamic is false
            const isStatic =
                (!param.dynamic || param.dynamic === false) ||
                (!param.selector || param.selector.trim() === '');

            if (isStatic) {
                let value = param.value ?? null;

                // Apply numeric conversion if needed
                if (param.input_type === "float" || param.input_type === "int") {
                    value = extractNumericValue(value, param.input_type === "int");
                }

                return value;
            }

            // DYNAMIC MODE: selector is present
            try {
                const el = document.querySelector(param.selector);
                if (!el) {
                    return null;
                }

                let value =
                    el.value ||
                    el.innerText ||
                    el.textContent ||
                    el.getAttribute("content") ||
                    el.getAttribute("data-value") ||
                    null;

                // Apply numeric conversion if needed
                if (param.input_type === "float" || param.input_type === "int") {
                    value = extractNumericValue(value, param.input_type === "int");
                }

                return value;
            } catch (e) {
                return null;
            }
        }

        // 5️⃣ Plain object (like ecommerce data) - recursively process nested values
        return Object.fromEntries(
            Object.entries(param)
                .map(([k, v]) => [k, resolveParamValue(v, k)])
                .filter(([k, v]) => v !== null && v !== undefined)
        );
    }

    function extractNumericValue(value, isInt = false) {
        if (value === null || value === undefined) {
            return null;
        }
        if (isInt) {
            return parseInt(value);
        }
        return parseFloat(value);
    }
    var dummyPinterest = function () {

        /**
         * Public API
         */
        return {
            // Must mirror the real module's surface. Utils.fireEventForAllPixel()
            // calls tag() on every pixel unconditionally, so a stand-in without it
            // throws "Pinterest.tag is not a function" whenever the add-on is not
            // installed and this dummy stays in place.
            tag: function () {
                return "pinterest";
            },
            isEnabled: function () {},
            disable: function () {},
            loadPixel: function () {},
            fireEvent: function (name, data) {
                return false;
            },
            onAdSenseEvent: function (event) {},
            onClickEvent: function (params) {},
            onWatchVideo: function (params) {},
            onCommentEvent: function () {},
            onDownloadEvent: function (params) {},
            onFormEvent: function (params) {},
            onWooAddToCartOnButtonEvent: function (product_id) {},
            onWooAddToCartOnSingleEvent: function (product_id, qty, is_variable, is_external, $form) {},
            onWooRemoveFromCartEvent: function (cart_item_hash) {},
            onWooAffiliateEvent: function (product_id) {},
            onWooPayPalEvent: function (event) {},
            onEddAddToCartOnButtonEvent: function (download_id, price_index, qty) {},
            onEddRemoveFromCartEvent: function (item) {},
            onPageScroll: function (event) {},
            onTime: function (event) {},

        }

    }();

    var dummyBing = function () {

        /**
         * Public API
         */
        return {
            // See dummyPinterest: tag() is required by Utils.fireEventForAllPixel().
            tag: function () {
                return "bing";
            },
            isEnabled: function () {},
            disable: function () {},
            loadPixel: function () {},
            fireEvent: function (name, data) {
                return false;
            },
            onAdSenseEvent: function () {},
            onClickEvent: function (params) {},
            onWatchVideo: function (params) {},
            onCommentEvent: function () {},
            onFormEvent: function (params) {},
            onDownloadEvent: function (params) {},
            onWooAddToCartOnButtonEvent: function (product_id) {},
            onWooAddToCartOnSingleEvent: function (product_id, qty, is_variable, is_external, $form) {},
            onWooRemoveFromCartEvent: function (cart_item_hash) {},
            onWooAffiliateEvent: function (product_id) {},
            onWooPayPalEvent: function () {},
            onEddAddToCartOnButtonEvent: function (download_id, price_index, qty) {},
            onEddRemoveFromCartEvent: function (item) {},
            onPageScroll: function (event) {},
            onTime: function (event) {},
        }

    }();

	var dummyReddit = function () {
		/**
		 * Public API
		 */
		return {
			tag: function () {
				return "reddit";
			},
			isEnabled: function () {},
			disable: function () {},
			loadPixel: function () {},
			fireEvent: function ( name, data ) {
				return false;
			},
			onAdSenseEvent: function ( event ) {},
			onClickEvent: function ( params ) {},
			onWatchVideo: function ( params ) {},
			onCommentEvent: function ( event ) {},
			onFormEvent: function ( params ) {},
			onDownloadEvent: function ( params ) {},
			onWooAddToCartOnButtonEvent: function ( product_id ) {},
			onWooAddToCartOnSingleEvent: function ( product_id, qty, product_type, is_external, $form ) {},
			onWooRemoveFromCartEvent: function ( cart_item_hash ) {},
			onWooAffiliateEvent: function ( product_id ) {},
			onWooPayPalEvent: function ( event ) {},
			onEddAddToCartOnButtonEvent: function ( download_id, price_index, qty ) {},
			onEddRemoveFromCartEvent: function ( item ) {},
			onPageScroll: function ( event ) {},
			onTime: function ( event ) {},
		}
	}();


	var Utils = function (options) {

        var Pinterest = dummyPinterest;

        var Bing = dummyBing;

		var Reddit = dummyReddit;

        var gtag_loaded = false;

        var gtm_loaded = false;

        // The GTM container's consent state is sent once per page load. Two code
        // paths reach it (loadGTMScript() and the gtm_just_data_layer branch of
        // GTM.loadPixel(), which can both run for the same page), and Consent Mode
        // expects a single transition, not a stream of them.
        var gtm_consent_state_pushed = false;

        let isNewSession = checkSession();

        // In-flight pys_get_pbid request. Several code paths call manageCookies()
        // before the first reply lands; one request is enough for all of them.
        var pbidRequest = null;
        // True once a pixel has waited for that reply (or given up on it), so
        // the hold in holdForIdentity() happens at most once per page.
        var pbidSettled = false;
        var PBID_WAIT_MS = 1000;
        // A pys_get_pbid reply that arrived before options.cookie was known
        // (REST mode fills it in, and a consent plugin may call loadPixel()
        // before that). Applied by the next requestPbid() call instead of
        // asking the server again.
        var pbidPendingReply = null;

        var utmTerms = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

        var utmId = ['fbadid', 'gadid', 'padid', 'bingid'];

        let dataLayerName = 'dataLayerPYS';

        let GTMdataLayerName = 'dataLayer';

        function validateEmail(email) {
            var re = /^(([^<>()[\]\\.,;:\s@\"]+(\.[^<>()[\]\\.,;:\s@\"]+)*)|(\".+\"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
            return re.test(email);
        }
        function getDomain(url) {

            url = url.replace(/(https?:\/\/)?(www.)?/i, '');

            if (url.indexOf('/') !== -1) {
                return url.split('/')[0];
            }

            return url;
        }
        function loadPixels() {

            Utils.refreshAddonPixels();

            if (!options.gdpr.all_disabled_by_api) {

                if (!options.gdpr.facebook_disabled_by_api) {
                    Facebook.loadPixel();
                }

                if (!options.gdpr.analytics_disabled_by_api) {
                    Analytics.loadPixel();
                }

                if (!options.gdpr.analytics_disabled_by_api) {
                    GTM.loadPixel();
                }

                if (!options.gdpr.pinterest_disabled_by_api) {
                    Pinterest.loadPixel();
                }

                if (!options.gdpr.bing_disabled_by_api) {
                    Bing.loadPixel();
                }

                if (!options.gdpr.openai_disabled_by_api) {
                    OpenAI.loadPixel();
                }

	            if (!options.gdpr.reddit_disabled_by_api) {
		            Reddit.loadPixel();
	            }
            }
            if (options.gdpr.consent_magic_integration_enabled && typeof CS_Data !== "undefined") {
                if (typeof CS_Data.cs_google_analytics_consent_mode !== "undefined" && CS_Data.cs_google_analytics_consent_mode == 1) {
                    Analytics.loadPixel();
                }
            }

        }

        function checkSession() {
            if( Cookies.get('pys_start_session') === undefined ||
                Cookies.get('pys_session_limit') === undefined) {
                firstVisit = true;
                return true
            }
            return false

        }

        function getTrafficSource() {

            try {

                let referrer = stripUrlQuery(document.referrer.toString()),
                    source;

                let direct = referrer.length === 0;
                let internal = direct ? false : referrer.indexOf(options.siteUrl) === 0;
                let external = !direct && !internal;

                if (external === false) {
                    source = 'direct';
                } else {
                    source = referrer;
                }

                if (source !== 'direct') {
                    // leave only domain (Issue #70)
                    return getDomain(source);
                } else {
                    return source;
                }

            } catch (e) {
                console.error(e);
                return 'direct';
            }

        }

        /**
         * Return query variables object with where property name is query variable
         * and property value is query variable value.
         */
        function getQueryVars() {

            try {

                var result = {},
                    tmp = [];

                window.location.search
                    .substr(1)
                    .split("&")
                    .forEach(function (item) {

                        tmp = item.split('=');

                        if (tmp.length > 1) {
                            result[tmp[0]] = tmp[1];
                        }

                    });

                return result;

            } catch (e) {
                console.error(e);
                return {};
            }

        }


        /**
         * @param useCurrentUrlFallback Pass false where an empty value is better
         *        than a guess, because a more reliable fallback exists downstream.
         */
        function getLandingPageValue(useCurrentUrlFallback = true) {
            let name = "pys_landing_page"
            if(options.visit_data_model === "last_visit") {
                name = "last_pys_landing_page"
            }
            if(Cookies.get(name) && Cookies.get(name) !== "undefined") {
                return Cookies.get(name);
            }
            // No cookie of our own. The dynamic-options endpoint may still know:
            // it answers per visitor and is never cached, so it is allowed to carry
            // the PHP session copy — which is all a visitor whose cookies a consent
            // manager has blocked ever has. In the HTML this value is always empty,
            // and an empty value means "nothing to say", so this branch is simply
            // skipped unless the endpoint filled it in.
            if ( options.hasOwnProperty( "tracking_analytics" )
                && options.tracking_analytics
                && options.tracking_analytics.TrafficLanding ) {
                return options.tracking_analytics.TrafficLanding;
            }

            // Nobody knows better than the current URL: it is what the cookie would
            // have been set to a moment ago.
            return useCurrentUrlFallback ? window.location.href : "";
        }
        function getTrafficSourceValue() {
            let name = "pysTrafficSource"
            if(options.visit_data_model === "last_visit") {
                name = "last_pysTrafficSource"
            }
            if(Cookies.get(name) && Cookies.get(name) !== "undefined") {
                return Cookies.get(name);
            }
            // See getLandingPageValue(): filled by the dynamic-options endpoint only.
            if ( options.hasOwnProperty( "tracking_analytics" )
                && options.tracking_analytics
                && options.tracking_analytics.TrafficSource ) {
                return options.tracking_analytics.TrafficSource;
            }
            return "";
        }

        function getUTMId(useLast = false) {
            try {
                let cookiePrefix = 'pys_'
                let terms = [];
                if (useLast) {
                    cookiePrefix = 'last_pys_'
                }
                // Fall back to this request's own query string, not to the server
                // options: cached HTML carries whatever the visitor who generated
                // the cache entry arrived with.
                let queryVars = getQueryVars();
                $.each(utmId, function (index, name) {
                    if (Cookies.get(cookiePrefix + name)) {
                        terms[name] = Cookies.get(cookiePrefix + name)
                    }
                    else if(options.hasOwnProperty("tracking_analytics")
                        && options.tracking_analytics
                        && options.tracking_analytics.TrafficUtmsId
                        && options.tracking_analytics.TrafficUtmsId[name]) {
                        terms[name] = filterEmails(options.tracking_analytics.TrafficUtmsId[name])
                    }
                    else if(queryVars.hasOwnProperty(name)) {
                        terms[name] = filterEmails(queryVars[name])
                    }
                });
                return terms;
            } catch (e) {
                console.error(e);
                return [];
            }
        }
        /**
         * Return UTM terms from request query variables or from cookies.
         */
        function getUTMs(useLast = false) {

            try {
                let cookiePrefix = 'pys_'
                if(useLast) {
                    cookiePrefix = 'last_pys_'
                }
                let terms = [];
                // See getUTMId(): the query string, never the server options.
                let queryVars = getQueryVars();
                $.each(utmTerms, function (index, name) {
                    if (Cookies.get(cookiePrefix + name)) {
                        let value = Cookies.get(cookiePrefix + name);
                        terms[name] = filterEmails(value); // do not allow email in request params (Issue #70)
                    }
                    else if(options.hasOwnProperty("tracking_analytics")
                        && options.tracking_analytics
                        && options.tracking_analytics.TrafficUtms
                        && options.tracking_analytics.TrafficUtms[name]) {
                        terms[name] = filterEmails(options.tracking_analytics.TrafficUtms[name])
                    }
                    else if(queryVars.hasOwnProperty(name)) {
                        terms[name] = filterEmails(queryVars[name])
                    }
                });

                return terms;

            } catch (e) {
                console.error(e);
                return [];
            }

        }

        function getDateTime() {
            var dateTime = new Array();
            var date = new Date(),
                days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
                months = ['January', 'February', 'March', 'April', 'May', 'June',
                    'July', 'August', 'September', 'October', 'November', 'December'
                ],
                hours = ['00-01', '01-02', '02-03', '03-04', '04-05', '05-06', '06-07', '07-08',
                    '08-09', '09-10', '10-11', '11-12', '12-13', '13-14', '14-15', '15-16', '16-17',
                    '17-18', '18-19', '19-20', '20-21', '21-22', '22-23', '23-24'
                ];
            dateTime.push(hours[date.getHours()]);
            dateTime.push(days[date.getDay()]);
            dateTime.push(months[date.getMonth()]);
            return dateTime;
        }

        function filterEmails(value) {
            return validateEmail(value) ? undefined : value;
        }

        /**
         * PUBLIC API
         */
        return {
            PRODUCT_SIMPLE : 0,
            PRODUCT_VARIABLE : 1,
            PRODUCT_BUNDLE : 2,
            PRODUCT_GROUPED : 3,
            utmTerms : utmTerms,
            utmId : utmId,
            fireEventForAllPixel:function(functionName,events){
                Utils.refreshAddonPixels();

                if (events.hasOwnProperty(Facebook.tag()))
                    Facebook[functionName](events[Facebook.tag()]);
                if (events.hasOwnProperty(Analytics.tag()))
                    Analytics[functionName](events[Analytics.tag()]);
                if (events.hasOwnProperty(Pinterest.tag()))
                    Pinterest[functionName](events[Pinterest.tag()]);
                if (events.hasOwnProperty(Bing.tag()))
                    Bing[functionName](events[Bing.tag()]);
	            if (events.hasOwnProperty(Reddit.tag()))
		            Reddit[functionName](events[Reddit.tag()]);

                if (events.hasOwnProperty(GTM.tag()))
                    GTM[functionName](events[GTM.tag()]);
            },

            /**
             * Re-read the pixels that live in separate plugins.
             */
            refreshAddonPixels: function () {
                Pinterest = Utils.setupPinterestObject();
                Bing = Utils.setupBingObject();
                Reddit = Utils.setupRedditObject();
            },

            /**
             * Is one of ConsentMagic's switches actually on?
             */
            csModeEnabled: function ( value ) {
                return Number( value ) === 1;
            },

            setupPinterestObject: function () {
                Pinterest = window.pys.Pinterest || Pinterest;
                return Pinterest;
            },

            setupBingObject: function () {
                Bing = window.pys.Bing || Bing;
                return Bing;
            },

	        setupRedditObject: function () {
		        Reddit = window.pys.Reddit || Reddit;
		        return Reddit;
	        },

            // Clone all object members to another and return it
            copyProperties: function (from, to) {
                for (var key in from) {
                    if("function" == typeof from[key]) {
                        continue;
                    }
                    to[key] = from[key];
                }
                return to;
            },

            /**
             * Ask PHP for this browser's external_id (single-flight).
             *
             * The cookie keeps the id across a network change, so it is
             * requested whenever external_id is on -- not only when server
             * events go over AJAX. Returns the in-flight jqXHR, or null when no
             * request is warranted (feature off, cookie already there, no
             * Meta pixel).
             */
            requestPbid: function () {
                if (!options.send_external_id || Cookies.get('pbid') || !Facebook.isEnabled()) {
                    return null;
                }

                if (!pbidRequest) {
                    var deferred = jQuery.Deferred();

                    var applyReply = function (res) {
                        if (typeof options.cookie === 'undefined') {
                            pbidPendingReply = res;
                            return;
                        }
                        pbidPendingReply = null;
                        if (res && res.success && res.data && res.data.pbid) {
                            if(!(options.cookie.disabled_all_cookie || options.cookie.externalID_disabled_by_api)){
                                var expires = parseInt(options.external_id_expire || 180);
                                Cookies.set('pbid', res.data.pbid, { expires: expires, path: '/',domain: cookieDomain() });
                            }

                            if(options.hasOwnProperty('facebook')) {
                                options.facebook.advancedMatching = {
                                    ...options.facebook.advancedMatching,  // spread current advancedMatching values
                                    external_id: res.data.pbid
                                };
                            }
                        }
                    };

                    var settle = function (res) {
                        try {
                            applyReply(res);
                        } catch (e) {
                            if (options.debug) console.warn('[PYS] pbid reply:', e);
                        }
                        deferred.resolve(res);
                    };

                    var viaAjax = function () {
                        jQuery.ajax({
                            url: options.ajaxUrl,
                            dataType: 'json',
                            data: {
                                action: 'pys_get_pbid'
                            }
                        }).done(settle).fail(function () {
                            deferred.reject();
                        });
                    };

                    // The head snippet (EventsManager::outputPbidPrefetch()) may
                    // have started this request before public.js was even
                    // downloaded; reuse its reply, and only make our own request
                    // when there is none or it failed.
                    var prefetch = window.pysPbidPrefetch;
                    window.pysPbidPrefetch = null;

                    if (pbidPendingReply && typeof options.cookie !== 'undefined') {
                        applyReply(pbidPendingReply);
                        if (Cookies.get('pbid')) {
                            return null;
                        }
                    }

                    if (prefetch && typeof prefetch.then === 'function') {
                        prefetch.then(settle, viaAjax);
                    } else {
                        viaAjax();
                    }

                    pbidRequest = deferred.promise();
                    pbidRequest.always(function () {
                        pbidRequest = null;
                    });
                }

                return pbidRequest;
            },

            /**
             * Defer `fn` until this browser's external_id is known, or until a
             * short ceiling passes. Returns true when `fn` was deferred (it will
             * be called back), false when the caller may go ahead right now.
             *
             * Pixels read external_id when they initialise. On a first visit the
             * cookie does not exist yet, and the inline value in the page may
             * belong to whoever rendered a cached copy of it; the reply to
             * pys_get_pbid is never cached and names this browser, so the first
             * PageView waits for it. Sites that fetch identity over REST already
             * have the right value by now and do not wait again.
             */
            holdForIdentity: function (fn) {
                if (pbidSettled || !options.send_external_id || Cookies.get('pbid')) {
                    return false;
                }

                if (options.dynamicDataUrl && options.facebook && options.facebook.advancedMatching
                    && options.facebook.advancedMatching.external_id) {
                    return false;
                }

                var request = Utils.requestPbid();
                if (!request) {
                    return false;
                }

                var done = false;
                var finish = function () {
                    if (done) {
                        return;
                    }
                    done = true;
                    pbidSettled = true;
                    fn();
                };

                request.always(finish);
                setTimeout(finish, PBID_WAIT_MS);

                return true;
            },

            manageCookies: function () {

                if ( typeof options.cookie === 'undefined' ) {
                    return;
                }

                if (options.gdpr.cookiebot_integration_enabled && typeof Cookiebot !== 'undefined') {
                    if (Cookiebot.consented === false && !Cookiebot.consent['marketing'] && !Cookiebot.consent['statistics']) {
                        return;
                    }
                }
                let cm_consent_not_expressed = false;
                if ( options.gdpr.consent_magic_integration_enabled && window.CS_Data !== undefined && window.CS_Data.cs_refresh_after_consent == 1 ) {
                    if ( Cookies.get( 'cs_viewed_cookie_policy' ) === undefined ) {
                        cm_consent_not_expressed = true;
                    }
                }

                // Hand PHP the browser-verified cookie domain, under the same
                // consent gates as every cookie written below it.
                if( !cm_consent_not_expressed && !options.cookie.disabled_all_cookie ) {
                    reportCookieDomain(cookieDomain());
                }

                if( !cm_consent_not_expressed && isNewSession && !options.cookie.disabled_all_cookie && !options.cookie.disabled_start_session_cookie) {
                    let duration = options.last_visit_duration * 60000
                    var now = new Date();
                    now.setTime(now.getTime() + duration);
                    Cookies.set('pys_session_limit', true,{ expires: now, path: '/',domain: cookieDomain() })
                    Cookies.set('pys_start_session', true,{path: '/',domain: cookieDomain()});
                }

                if (!Cookies.get('pbid')) {
                    Utils.requestPbid();
                } else if (Facebook.isEnabled()){
                    if(Facebook.advancedMatching() && Facebook.advancedMatching().external_id && !(options.cookie.disabled_all_cookie || options.cookie.externalID_disabled_by_api)){
                        let expires = parseInt(options.external_id_expire || 180);
                        Cookies.set('pbid', Facebook.advancedMatching().external_id, { expires: expires, path: '/',domain: cookieDomain() });
                    }
                }

                let expires = parseInt(options.cookie_duration); //  days
                let queryVars = getQueryVars();
                let landing = window.location.href.split('?')[0];
                try {
                    // save data for first visit
                    if(Cookies.get('pys_first_visit') === undefined && (!options.cookie.disabled_all_cookie)) {

                        if(!options.cookie.disabled_first_visit_cookie)
                        {
                            Cookies.set('pys_first_visit', true, { expires: expires, path: '/',domain: cookieDomain() });
                        }
                        else {
                            Cookies.remove('pys_first_visit', { path: '/',domain: cookieDomain() })
                        }

                        if(!options.cookie.disabled_trafficsource_cookie)
                        {
                            Cookies.set('pysTrafficSource', getTrafficSource(), { expires: expires,path: '/',domain: cookieDomain() });
                        }
                        else {
                            Cookies.remove('pysTrafficSource', { path: '/',domain: cookieDomain() })
                        }

                        if(!options.cookie.disabled_landing_page_cookie)
                        {
                            Cookies.set('pys_landing_page',landing,{ expires: expires,path: '/',domain: cookieDomain() });
                        }
                        else {
                            Cookies.remove('pys_landing_page', { path: '/',domain: cookieDomain() })
                        }

                        if(!options.cookie.disabled_utmTerms_cookie)
                        {
                            $.each(utmTerms, function (index, name) {
                                if (queryVars.hasOwnProperty(name)) {
                                    Cookies.set('pys_' + name, queryVars[name], { expires: expires,path: '/',domain: cookieDomain() });
                                } else {
                                    Cookies.remove('pys_' + name, { path: '/',domain: cookieDomain() })
                                }
                            });
                        }
                        else {
                            $.each(utmTerms, function (index, name) {
                                Cookies.remove('pys_' + name, { path: '/',domain: cookieDomain() })
                            });
                        }

                        if(!options.cookie.disabled_utmId_cookie)
                        {
                            $.each(utmId,function(index,name) {
                                if (queryVars.hasOwnProperty(name)) {
                                    Cookies.set('pys_' + name, queryVars[name], { expires: expires,path: '/',domain: cookieDomain() });
                                } else {
                                    Cookies.remove('pys_' + name, { path: '/',domain: cookieDomain() })
                                }
                            })
                        }
                        else {
                            $.each(utmId, function (index, name) {
                                Cookies.remove('pys_' + name, { path: '/',domain: cookieDomain() })
                            });
                        }
                    }

                    // save data for last visit if it new session
                    if(isNewSession && (!options.cookie.disabled_all_cookie)) {
                        if(!options.cookie.disabled_trafficsource_cookie)
                        {
                            Cookies.set('last_pysTrafficSource', getTrafficSource(), { expires: expires,path: '/',domain: cookieDomain() });
                        }
                        else {
                            Cookies.remove('last_pysTrafficSource', { path: '/',domain: cookieDomain() })
                        }

                        if(!options.cookie.disabled_landing_page_cookie)
                        {
                            Cookies.set('last_pys_landing_page',landing,{ expires: expires,path: '/',domain: cookieDomain() });
                        }
                        else {
                            Cookies.remove('last_pys_landing_page', { path: '/',domain: cookieDomain() })
                        }

                        if(!options.cookie.disabled_utmTerms_cookie)
                        {
                            $.each(utmTerms, function (index, name) {
                                if (queryVars.hasOwnProperty(name)) {
                                    Cookies.set('last_pys_' + name, queryVars[name], { expires: expires,path: '/',domain: cookieDomain() });
                                } else {
                                    Cookies.remove('last_pys_' + name, { path: '/',domain: cookieDomain() })
                                }
                            });
                        }
                        else {
                            $.each(utmTerms, function (index, name) {
                                Cookies.remove('last_pys_' + name, { path: '/',domain: cookieDomain() })
                            });
                        }

                        if(!options.cookie.disabled_utmId_cookie)
                        {
                            $.each(utmId,function(index,name) {
                                if (queryVars.hasOwnProperty(name)) {
                                    Cookies.set('last_pys_' + name, queryVars[name], { expires: expires,path: '/',domain: cookieDomain() });
                                } else {
                                    Cookies.remove('last_pys_' + name, { path: '/',domain: cookieDomain() })
                                }
                            })
                        }
                        else {
                            $.each(utmId, function (index, name) {
                                Cookies.remove('last_pys_' + name, { path: '/',domain: cookieDomain() })
                            });
                        }

                    }
                    if(options.cookie.disabled_start_session_cookie) {
                        Cookies.remove('pys_start_session', { path: '/',domain: cookieDomain() })
                        Cookies.remove('pys_session_limit', { path: '/',domain: cookieDomain() })
                    }
                    if(options.cookie.disabled_all_cookie)
                    {
                        Cookies.remove('pys_first_visit', { path: '/',domain: cookieDomain() })
                        Cookies.remove('pysTrafficSource', { path: '/',domain: cookieDomain() })
                        Cookies.remove('pys_landing_page', { path: '/',domain: cookieDomain() })
                        Cookies.remove('last_pys_landing_page', { path: '/',domain: cookieDomain() })
                        Cookies.remove('last_pysTrafficSource', { path: '/',domain: cookieDomain() })
                        Cookies.remove('pys_start_session', { path: '/',domain: cookieDomain() })
                        Cookies.remove('pys_session_limit', { path: '/',domain: cookieDomain() })
                        $.each(Utils.utmTerms, function (index, name) {
                            Cookies.remove('pys_' + name, { path: '/',domain: cookieDomain() })
                        });
                        $.each(Utils.utmId,function(index,name) {
                            Cookies.remove('pys_' + name, { path: '/',domain: cookieDomain() })
                        })
                        $.each(Utils.utmTerms, function (index, name) {
                            Cookies.remove('last_pys_' + name, { path: '/',domain: cookieDomain() })
                        });
                        $.each(Utils.utmId,function(index,name) {
                            Cookies.remove('last_pys_' + name, { path: '/',domain: cookieDomain() })
                        });
                    }
                } catch (e) {
                    console.error(e);
                }
            },
            /**
             * Is this Meta pixel opted into Meta-Enabled Conversion API?
             */
            isMetaEnabledCapiPixel: function (pixelId) {
                var pixels = options.facebook && options.facebook.metaEnabledCapiPixels;
                return Array.isArray(pixels) && pixels.indexOf(pixelId) !== -1;
            },
            /**
             * Generate unique ID
             */
            generateUniqueId : function (event) {
                if(event.eventID.length == 0 || (event.type == "static" && options.ajaxForServerStaticEvent) || (event.type !== "static" && options.ajaxForServerEvent)) {
                    let idKey = event.hasOwnProperty('custom_event_post_id') ? event.custom_event_post_id : event.e_id;
                    if (!uniqueId.hasOwnProperty(idKey)) {
                        uniqueId[idKey] = pys_generate_token();
                    }
                    return uniqueId[idKey];
                }
                else if(event.eventID.length !== 0)
                {
                    return event.eventID;
                }
            },

            // Flatten object for sendBeacon compatibility
            flattenObject: function (obj, prefix = '', res = {}) {
                for (const [key, value] of Object.entries(obj)) {
                    const prefixedKey = prefix
                        ? (Array.isArray(obj) ? `${prefix}[${key}]` : `${prefix}[${key}]`)
                        : key;
                    if (value !== null && typeof value === 'object' && !(value instanceof File)) {
                        this.flattenObject(value, prefixedKey, res);
                    } else {
                        res[prefixedKey] = value;
                    }
                }
                return res;
            },

            sendServerAjaxRequest : function(url, data) {
                if (data.action === 'pys_api_event' && data.pixel === 'facebook' && window.pysFacebookRest) {
                    // Use Facebook REST API
                    this.sendRestAPIRequest(data, 'facebook');
                    return;
                }

                if (data.action === 'pys_openai_api_event' && window.pysOpenAIRest) {
                    this.sendRestAPIRequest(data, 'openai');
                    return;
                }

                // Check if sendBeacon is enabled and supported
                if (options.useSendBeacon && navigator.sendBeacon) {
                    try {
                        // Flatten the data object for sendBeacon compatibility
                        const flattenedData = this.flattenObject(data);
                        const formData = new URLSearchParams();

                        // Convert flattened data to URLSearchParams
                        for (const [key, value] of Object.entries(flattenedData)) {
                            if (value !== null && value !== undefined) {
                                formData.append(key, value);
                            }
                        }

                        // Try to send using sendBeacon
                        const success = navigator.sendBeacon(url, formData);
                        if (success) {
                            return; // Successfully sent via sendBeacon
                        }
                    } catch (e) {
                        // If sendBeacon fails, fall back to jQuery.ajax
                        if (options.debug) {
                            console.log('PYS: sendBeacon failed, falling back to jQuery.ajax:', e);
                        }
                    }
                }

                // Fallback to jQuery.ajax
                jQuery.ajax( {
                    type: 'POST',
                    url: url,
                    data: data,
                    headers: {
                        'Cache-Control': 'no-cache'
                    },
                    success: function () {
                    },
                } );
            },

            sendRestAPIRequest: function (data, platform) {
                let restApiUrl;

                // Get platform-specific REST API configuration
                switch (platform) {
                    case 'facebook':
                        restApiUrl = window.pysFacebookRest ? window.pysFacebookRest.restApiUrl : '/wp-json/pys-facebook/v1/event';
                        break;
                    case 'openai':
                        restApiUrl = window.pysOpenAIRest ? window.pysOpenAIRest.restApiUrl : '/wp-json/pys-openai/v1/event';
                        break;
                    default:
                        console.error('PYS: Unknown platform for REST API:', platform);
                        this.sendAjaxFallback(data);
                        return;
                }

                // Prepare data for REST API
                const restApiData = {
                    event: data.event,
                    event_slug: data.event_slug || '',
                    data: JSON.stringify(data.data || {}),
                    ids: JSON.stringify(data.ids || []),
                    eventID: data.event_id || data.eventID || '',
                    woo_order: data.woo_order || '0',
                    edd_order: data.edd_order || '0',
                    order_key: data.order_key || ''
                };

                const forwardedReferrer = data.referrer_url || pageReferrer;
                if (forwardedReferrer) {
                    restApiData.referrer_url = forwardedReferrer;
                }

                // Variant A: send the actual page URL where the event happened
                // so the server sets event_source_url to this page, not the
                // REST endpoint. PHP applies enable_remove_source_url_params.
                restApiData.event_source_url = data.url || window.location.href;

                // Try to send using sendBeacon first (if enabled)
                if (options.useSendBeacon && navigator.sendBeacon) {
                    try {
                        const formData = new URLSearchParams();
                        for (const [key, value] of Object.entries(restApiData)) {
                            formData.append(key, value);
                        }

                        if (navigator.sendBeacon(restApiUrl, formData)) {
                            return;
                        }
                    } catch (e) {
                        // sendBeacon failed, continue to fetch
                    }
                }

                // Try to send using fetch with REST API
                if (window.fetch) {
                    const headers = {
                        'Content-Type': 'application/json'
                    };

                    fetch(restApiUrl, {
                        method: 'POST',
                        headers: headers,
                        body: JSON.stringify(restApiData)
                    })
                        .then(response => {
                            if (!response.ok) {
                                throw new Error(platform + ' REST API request failed: ' + response.status);
                            }
                        })
                        .catch(error => {
                            // Fallback to AJAX if REST API fails
                            if (options.debug) {
                                console.log('PYS: ' + platform + ' REST API failed, falling back to AJAX:', error);
                            }
                            this.sendAjaxFallback(data);
                        });
                } else {
                    // Fallback to AJAX if fetch is not supported
                    this.sendAjaxFallback(data);
                }
            },



            // Fallback AJAX method
            sendAjaxFallback: function (data) {
                jQuery.ajax({
                    type: 'POST',
                    url: options.ajaxUrl,
                    data: data,
                    headers: {
                        'Cache-Control': 'no-cache'
                    },
                    success: function () {
                    },
                });
            },
            // clone object
            clone: function(obj) {
                var copy;

                // Handle the 3 simple types, and null or undefined
                if (null == obj || "object" != typeof obj) return obj;

                // Handle Date
                if (obj instanceof Date) {
                    copy = new Date();
                    copy.setTime(obj.getTime());
                    return copy;
                }

                // Handle Array
                if (obj instanceof Array) {
                    copy = [];
                    for (var i = 0, len = obj.length; i < len; i++) {
                        if("function" == typeof obj[i]) {
                            continue;
                        }
                        copy[i] = Utils.clone(obj[i]);
                    }
                    return copy;
                }

                // Handle Object
                if (obj instanceof Object) {
                    copy = {};
                    for (var attr in obj) {
                        if (obj.hasOwnProperty(attr)) {
                            if("function" == typeof obj[attr]) {
                                continue;
                            }
                            copy[attr] = Utils.clone(obj[attr]);
                        }
                    }
                    return copy;
                }

                return obj;
            },

            // Returns array of elements with given tag name
            getTagsAsArray: function (tag) {
                return [].slice.call(document.getElementsByTagName(tag));
            },

            getRequestParams: function () {
                return [];
            },

            /**
             * CUSTOM EVENTS
             */

            setupMouseOverClickEvents: function (eventId, triggers) {

                // Non-default binding used to avoid situations when some code in external js
                // stopping events propagation, eg. returns false, and our handler will never called
                document.addEventListener('mouseover', function(event) {
                    var matchedElements = Array.from(document.querySelectorAll(triggers));
                    var clickedElement = event.target;
                    var closestMatch = clickedElement.closest(triggers);
                    if (matchedElements.includes(clickedElement) || closestMatch){
                        if (event.target.classList.contains('pys-mouse-over-' + eventId)) {
                            return true;
                        } else {
                            event.target.classList.add('pys-mouse-over-' + eventId);
                        }

                        Utils.fireTriggerEvent(eventId);
                    }
                });

            },

            setupCSSClickEvents: function (eventId, triggers) {
                // Non-default binding used to avoid situations when some code in external js
                // stopping events propagation, eg. returns false, and our handler will never called
                document.addEventListener('click', function(event) {
                    let matchedElements = Array.from(document.querySelectorAll(triggers)),
                        clickedElement = event.target,
                        closestMatch = clickedElement.closest(triggers);

                    if (matchedElements.includes(clickedElement) || closestMatch){
                        Utils.fireTriggerEvent(eventId);
                    }
                }, true);
            },

            setupURLClickEvents: function () {

                if( !options.triggerEventTypes.hasOwnProperty('url_click') ) {
                    return;
                }
                // Non-default binding used to avoid situations when some code in external js
                // stopping events propagation, eg. returns false, and our handler will never called
                $('a[data-pys-event-id]').onFirst('click', function (evt) {

                    $(this).attr('data-pys-event-id').split(',').forEach(function (eventId) {

                        eventId = parseInt(eventId);

                        if (isNaN(eventId) === false) {
                            Utils.fireTriggerEvent(eventId);
                        }

                    });

                });


            },

            setupScrollPosEvents: function (eventId, triggers) {

                var scrollPosThresholds = {},
                    docHeight = $(document).height() - $(window).height();

                // convert % to absolute positions
                $.each(triggers, function (index, scrollPos) {

                    // convert % to pixels
                    scrollPos = docHeight * scrollPos / 100;
                    scrollPos = Math.round(scrollPos);

                    scrollPosThresholds[scrollPos] = eventId;

                });

                $(document).on("scroll",function () {

                    var scrollPos = $(window).scrollTop();

                    $.each(scrollPosThresholds, function (threshold, eventId) {

                        // position has not reached yes
                        if (scrollPos <= threshold) {
                            return true;
                        }

                        // fire event only once
                        if (eventId === null) {
                            return true;
                        } else {
                            scrollPosThresholds[threshold] = null;
                        }

                        Utils.fireTriggerEvent(eventId);

                    });

                });


            },
            setupCommentEvents : function (eventId,triggers) {
                $('form.comment-form').on("submit",function () {
                    Utils.fireTriggerEvent(eventId);
                });
            },

            /**
             * Events
             */

            fireTriggerEvent: function (eventId) {

                if (!options.triggerEvents.hasOwnProperty(eventId)) {
                    return;
                }

                var event = {};
                var events = options.triggerEvents[eventId];

                if (events.hasOwnProperty('facebook')) {
                    event = Utils.getFormFilledData(events.facebook);
                    Facebook.fireEvent(event.name, event);
                }

                if (events.hasOwnProperty('ga')) {
                    event = Utils.getFormFilledData(events.ga);
                    Analytics.fireEvent(event.name, event);
                }

                if (events.hasOwnProperty('pinterest')) {
                    event = Utils.getFormFilledData(events.pinterest);
                    Pinterest.fireEvent(event.name, event);
                }

                if (events.hasOwnProperty('bing')) {
                    event = Utils.getFormFilledData(events.bing);
                    Bing.fireEvent(event.name, event);
                }

	            if (events.hasOwnProperty('reddit')) {
                    event = Utils.getFormFilledData(events.reddit);
                    Reddit.fireEvent(event.name, event);
	            }

                if (events.hasOwnProperty('openai')) {
                    event = Utils.getFormFilledData(events.openai);
                    OpenAI.fireEvent(event.name, event);
                }

                if (events.hasOwnProperty('gtm')) {
                    event = Utils.getFormFilledData(events.gtm);
                    GTM.fireEvent(event.name, event);
                }
            },

            fireStaticEvents: function (pixel) {

                Utils.refreshAddonPixels();

                if (options.staticEvents.hasOwnProperty(pixel)) {

                    $.each(options.staticEvents[pixel], function (eventName, events) {
                        $.each(events, function (index, eventData) {

                            eventData.fired = eventData.fired || false;

                            if (!eventData.fired) {
                                eventData = Utils.getFormFilledData(eventData);
                                var fired = false;

                                // fire event
                                if ('facebook' === pixel) {
                                    fired = Facebook.fireEvent(eventData.name, eventData);
                                } else if ('ga' === pixel) {
                                    fired = Analytics.fireEvent(eventData.name, eventData);
                                } else if ('pinterest' === pixel) {
                                    fired = Pinterest.fireEvent(eventData.name, eventData);
                                } else if ('bing' === pixel) {
                                    fired = Bing.fireEvent(eventData.name, eventData);
                                } else if ('gtm' === pixel) {
                                    fired = GTM.fireEvent(eventData.name, eventData);
                                } else if ('reddit' === pixel) {
	                                fired = Reddit.fireEvent(eventData.name, eventData);
                                } else if ('openai' === pixel) {
                                    fired = OpenAI.fireEvent(eventData.name, eventData);
                                }

                                // prevent event double event firing
                                eventData.fired = fired;

                            }

                        });
                    });

                }

            },

            /**
             * Load tag's JS
             *
             * @link: https://developers.google.com/analytics/devguides/collection/gtagjs/
             * @link: https://developers.google.com/analytics/devguides/collection/gtagjs/custom-dims-mets
             */
            loadGoogleTag: function (id) {

                if (!gtag_loaded) {
                    let dataLayerName = this.resolveGaDataLayerName();
                    this.dataLayerName = dataLayerName;
                    (function (window, document, src) {
                        var a = document.createElement('script'),
                            m = document.getElementsByTagName('script')[0];
                        a.async = 1;
                        a.src = src;
                        m.parentNode.insertBefore(a, m);
                    })(window, document, '//www.googletagmanager.com/gtag/js?id=' + id+'&l='+this.dataLayerName);

                    window[dataLayerName] = window[dataLayerName] || [];
                    // Published only so custom client code and third-party snippets
                    // have a gtag() to call. PYS itself must never route through it:
                    // the `||` means an earlier definition (Site Kit, a theme, the
                    // GTM bootstrap) keeps ownership and would point at its own data
                    // layer. Use Utils.gtagPush() instead.
                    window.gtag = window.gtag || function gtag() {
                        window[dataLayerName].push(arguments);
                    };

                    if ( options.google_consent_mode ) {
                        let data = this.resolveConsentValues();

                        // Normally this data layer is ours alone and still empty, so a
                        // `default` is what belongs here. But the GA and GTM scopes
                        // collapse into one layer when their names resolve to the same
                        // value (gtm_dataLayer_name left at 'dataLayerPYS', or the GA
                        // layer set to "Disable name transformation"), and then the GTM
                        // <head> snippet has already written a strict `denied` default
                        // here. Repeating `default` would leave GA denied; `update` is
                        // the documented transition once a default exists.
                        this.pushConsent( dataLayerName, this.layerHasConsentDefault( dataLayerName ) ? 'update' : 'default', data );
                    }

                    Utils.gtagPush('js', new Date());
                    gtag_loaded = true;

                }

            },

            /**
             * Name of the data layer gtag.js is loaded with, see loadGoogleTag().
             * Pure, so it can be resolved before the tag is loaded.
             */
            resolveGaDataLayerName: function () {
                if ( options.hasOwnProperty( 'GATags' ) ) {
                    switch ( options.GATags.ga_datalayer_type ) {
                        case 'default':
                            return 'dataLayerPYS';
                        case 'custom':
                            return options.GATags.ga_datalayer_name;
                        default:
                            return 'dataLayer';
                    }
                }
                return this.dataLayerName || 'dataLayer';
            },

            /**
             * Name of the GTM container's data layer. Mirrors GTM::pys_wp_header_top()
             * in modules/google_gtm/gtm.php — the two must agree, or the <head> consent
             * default and the footer consent update land in different layers. `??`
             * alone is not enough: the option can be saved as an empty string, and
             * window[''] is a silent dead end.
             */
            resolveGtmDataLayerName: function () {
                var name = options.hasOwnProperty( 'gtm' ) ? options.gtm.gtm_dataLayer_name : '';
                return ( typeof name === 'string' && name.length ) ? name : 'dataLayer';
            },

            /**
             * Sends a gtag command (js/config/set/event/consent) to the GA data layer.
             *
             * Deliberately does NOT call window.gtag. That global is created with
             * `window.gtag = window.gtag || ...`, so whoever defined it first owns it:
             * if a theme, Site Kit or the GTM bootstrap got there first, our config
             * and event commands would silently land in their data layer while the
             * gtag.js instance we loaded (&l=<GA layer>) never receives a config —
             * Tag Assistant then reports "Some hits will only be sent after a config
             * command is issued". Pushing the arguments object is exactly what gtag()
             * does internally, so the payload is identical.
             */
            gtagPush: function () {
                var name = this.dataLayerName || this.resolveGaDataLayerName();
                window[ name ] = window[ name ] || [];
                window[ name ].push( arguments );
            },

            /**
             * Whether a send_to value actually points at a destination.
             *
             * gtag('event', name, { send_to: '' }) has no destination, so gtag.js
             * parks the hit until a matching config command appears. Tag Assistant
             * reports that as "Some hits will only be sent after a config command
             * is issued via gtag('config')". Callers must skip the event instead.
             */
            hasSendToTarget: function (target) {
                if (Array.isArray(target)) {
                    return target.length > 0;
                }
                return typeof target === 'string' && target !== '';
            },

            /**
             * Back-compat alias of the old GA-scope consent sender. Exposed through
             * window.pys.Utils, so custom client code may call it. New code uses
             * pushConsent() with an explicit data layer name.
             */
            loadDefaultConsent: function() {
                this.gtagPush.apply( this, arguments );
            },

            /**
             * Sends one Consent Mode command ('default' or 'update') to a named data
             * layer. The single place that writes consent commands.
             *
             * The IIFE is not decoration: gtag() pushes its own `arguments` object,
             * and gtag.js / GTM read the command by index off that object. Pushing a
             * plain array works today but is not what the tag emits, so we reproduce
             * the exact shape — same reason gtm.php builds its <head> command this way.
             */
            pushConsent: function ( layerName, command, values ) {
                if ( !layerName ) {
                    return;
                }
                window[ layerName ] = window[ layerName ] || [];
                ( function () {
                    window[ layerName ].push( arguments );
                } )( 'consent', command, values );
            },

            /**
             * Whether a Consent Mode `default` has already been written to this data
             * layer — by our own <head> snippet, by a consent plugin, or by a third
             * party (Site Kit, a theme). Decides `default` vs `update`: Consent Mode
             * documents exactly one `default` per layer, and a repeated one is not a
             * defined transition. Consent Magic reads the layer the same way
             * (cs-public.js, CS_Consent_Mode.setDefaultConsent).
             */
            layerHasConsentDefault: function ( layerName ) {
                var layer = window[ layerName ];
                if ( !layer || typeof layer.length !== 'number' ) {
                    return false;
                }
                for ( var i = 0; i < layer.length; i++ ) {
                    var item = layer[ i ];
                    // Entries pushed by other integrations are plain objects; indexing
                    // them just yields undefined.
                    if ( item && item[ 0 ] === 'consent' && item[ 1 ] === 'default' ) {
                        return true;
                    }
                }
                return false;
            },

            /**
             * The four Consent Mode signals as PYS currently resolves them. `enabled`
             * is false when consent mode is off for that signal, in which case Google's
             * absence of a value means granted anyway — say so explicitly.
             */
            resolveConsentValues: function () {
                return {
                    'analytics_storage':  options.gdpr.analytics_storage.enabled  ? options.gdpr.analytics_storage.value  : 'granted',
                    'ad_storage':         options.gdpr.ad_storage.enabled         ? options.gdpr.ad_storage.value         : 'granted',
                    'ad_user_data':       options.gdpr.ad_user_data.enabled       ? options.gdpr.ad_user_data.value       : 'granted',
                    'ad_personalization': options.gdpr.ad_personalization.enabled ? options.gdpr.ad_personalization.value : 'granted',
                };
            },

            loadGTMScript: function (id = '') {
                // Strip trailing slash to allow both "domain.com" and "domain.com/" inputs.
                const domain = ( options.gtm.gtm_container_domain ?? 'www.googletagmanager.com' ).replace( /\/$/, '' );
                const loader = options.gtm.gtm_container_identifier ?? 'gtm';
                const gtm_auth = options.gtm.gtm_auth ?? '';
                const gtm_preview = options.gtm.gtm_preview ?? '';
                const datalayer_name = this.resolveGtmDataLayerName();

                window[ datalayer_name ] = window[ datalayer_name ] || [];
                window.gtag = window.gtag || function gtag() {
                    window[ datalayer_name ].push( arguments );
                };

                // Send the consent state synchronously before the GTM script tag is
                // inserted, so it is in the dataLayer before GTM processes any events.
                this.pushGTMConsentState( datalayer_name );

                (function(w, d, s, l, i) {
                    w[l] = w[l] || [];
                    w[l].push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
                    const f = d.getElementsByTagName(s)[0];
                    const j = d.createElement(s);
                    const dl = l !== 'dataLayer' ? '&l=' + l : '';
                    j.async = true;

                    // Detect domain format: bare hostname (legacy) vs full URL / relative path (new).
                    // Legacy "www.googletagmanager.com" → prepend https:// and append .js.
                    // New format "/metrics" or "https://custom.com" → use as-is.
                    //   Identifier with extension (e.g. "gtm.js")  → file:   domain/gtm.js?id=
                    //   Identifier without extension (e.g. "g4h25o") → path: domain/g4h25o/?id=
                    const isNewFormat = domain.startsWith( 'http://' )
                                     || domain.startsWith( 'https:///' )
                                     || domain.startsWith( '/' );

                    if ( !isNewFormat ) {
                        j.src = 'https://' + domain + '/' + loader + '.js?id=' + i + dl;
                    } else {
                        const hasExtension = loader.includes( '.' );
                        j.src = domain + '/' + loader + ( hasExtension ? '?' : '/?' ) + 'id=' + i + dl;
                    }

                    if (gtm_auth && gtm_preview) {
                        j.src += '&gtm_auth=' + gtm_auth + '&gtm_preview=' + gtm_preview + '&gtm_cookies_win=x';
                    }
                    f.parentNode.insertBefore(j, f);
                })(window, document, 'script', datalayer_name, id);

            },

            /**
             * Back-compat aliases. Both are reachable as window.pys.Utils.* and may be
             * called by custom client code, so they keep working; internally everything
             * goes through pushConsent() / pushGTMConsentState() with an explicit layer
             * name instead of the implicit this.GTMdataLayerName state.
             */
            loadDefaultGTMConsent: function() {
                window[ this.GTMdataLayerName ] = window[ this.GTMdataLayerName ] || [];
                window[ this.GTMdataLayerName ].push( arguments );
            },
            pushGTMConsentDefaults: function( datalayer_name ) {
                this.pushGTMConsentState( datalayer_name );
            },

            /**
             * Sends the GTM container's consent state, once per page load.
             *
             * Called from loadGTMScript() (PYS loads the container itself) and from
             * GTM.loadPixel() when gtm_just_data_layer is on, so the state is sent
             * whichever path runs — and only once when both do.
             *
             * Emits `update`, not a second `default`, whenever a default already sits
             * in the layer. modules/google_gtm/gtm.php writes a strict all-denied
             * default with wait_for_update:500 in <head>, before the container boots;
             * that is correct Consent Mode practice, and it is what makes PYS's own
             * prior-consent gate work — this function runs downstream of
             * Utils.consentGiven('analytics'), so nothing is granted until consent
             * actually exists. What was missing is the other half of the contract:
             * the update that resolves the wait_for_update window. A repeated
             * `default` is not a defined transition and left GTM-managed tags denied.
             */
            pushGTMConsentState: function( datalayer_name ) {
                if ( !options.google_consent_mode || gtm_consent_state_pushed ) {
                    return;
                }

                // A consent management plugin owns the transition: it issues its own
                // update from the user's live choice, while ours carries whatever the
                // cookies said when the page was rendered. Consent Magic diffs against
                // the last consent values in the layer, so a late push from us either
                // suppresses its update or overwrites the choice the user just made.
                // The <head> default already carries the CMP's resolved values.
                if ( options.consent_mode_cmp_active ) {
                    return;
                }

                gtm_consent_state_pushed = true;
                // Kept in sync for the loadDefaultGTMConsent() back-compat alias.
                this.GTMdataLayerName = datalayer_name;
                this.pushConsent(
                    datalayer_name,
                    this.layerHasConsentDefault( datalayer_name ) ? 'update' : 'default',
                    this.resolveConsentValues()
                );
            },

            /**
             * GDPR
             */

            loadPixels: function () {

                if (options.gdpr.ajax_enabled && !options.gdpr.consent_magic_integration_enabled) {

                    // retrieves actual PYS GDPR filters values which allow to avoid cache issues
                    $.get({
                        url: options.ajaxUrl,
                        dataType: 'json',
                        data: {
                            action: 'pys_get_gdpr_filters_values'
                        },
                        success: function (res) {

                            if (res.success) {

                                options.gdpr.all_disabled_by_api = res.data.all_disabled_by_api;
                                options.gdpr.facebook_disabled_by_api = res.data.facebook_disabled_by_api;
                                options.gdpr.analytics_disabled_by_api = res.data.analytics_disabled_by_api;
                                options.gdpr.google_ads_disabled_by_api = res.data.google_ads_disabled_by_api;
                                options.gdpr.pinterest_disabled_by_api = res.data.pinterest_disabled_by_api;
                                options.gdpr.bing_disabled_by_api = res.data.bing_disabled_by_api;
	                            options.gdpr.reddit_disabled_by_api = res.data.reddit_disabled_by_api;
                                options.gdpr.openai_disabled_by_api = res.data.openai_disabled_by_api;

                                options.cookie.externalID_disabled_by_api = res.data.externalID_disabled_by_api;
                                options.cookie.disabled_all_cookie = res.data.disabled_all_cookie;
                                options.cookie.disabled_advanced_form_data_cookie = res.data.disabled_advanced_form_data_cookie;
                                options.cookie.disabled_landing_page_cookie = res.data.disabled_landing_page_cookie;
                                options.cookie.disabled_first_visit_cookie = res.data.disabled_first_visit_cookie;
                                options.cookie.disabled_trafficsource_cookie = res.data.disabled_trafficsource_cookie;
                                options.cookie.disabled_utmTerms_cookie = res.data.disabled_utmTerms_cookie;
                                options.cookie.disabled_utmId_cookie = res.data.disabled_utmId_cookie;
                            }

                            loadPixels();

                        },

                        // Without an answer the values rendered into the page still hold

                        // (the same ones used when this request is switched off); waiting

                        // for it forever used to leave every pixel unloaded, silently.

                        error: function (xhr, status) {

                            if (options.debug) {

                                console.warn('[PYS] pys_get_gdpr_filters_values failed (' + status + '), using page values');

                            }

                            loadPixels();

                        }
                    });

                } else {
                    loadPixels();
                }

            },

            consentGiven: function (pixel) {

                /**
                 * ConsentMagic
                 */
                if ( options.gdpr.consent_magic_integration_enabled && typeof CS_Data !== "undefined" ) {

                    let test_prefix = CS_Data.test_prefix;
                    if (
                        ( Utils.csModeEnabled( CS_Data.cs_google_consent_mode_enabled ) && ( pixel == 'analytics' || pixel == 'google_ads' ) )
                        || ( Utils.csModeEnabled( CS_Data.cs_meta_ldu_mode ) && pixel == 'facebook' )
                        || ( Utils.csModeEnabled( CS_Data.cs_reddit_ldu_mode ) && pixel == 'reddit' )
                        || ( Utils.csModeEnabled( CS_Data.cs_openai_opt_out_mode ) && pixel == 'openai' )
                        || ( Utils.csModeEnabled( CS_Data.cs_bing_consent_mode?.ad_storage?.enabled ) && pixel == 'bing' )
                    ) {
                        if ( Number( CS_Data.cs_cache_enabled ) === 0
                            || ( Utils.csModeEnabled( CS_Data.cs_cache_enabled ) && window.CS_Cache && window.CS_Cache.check_status ) ) {
                            return true;
                        } else {
                            return false;
                        }
                    }

                    if( pixel == 'facebook' && ( CS_Data.cs_script_cat.facebook == 0 || CS_Data.cs_script_cat.facebook == CS_Data.cs_necessary_cat_id ) ) {
                        return true;
                    } else if( pixel == 'bing' && ( CS_Data.cs_script_cat.bing == 0 || CS_Data.cs_script_cat.bing == CS_Data.cs_necessary_cat_id ) ) {
                        return true;
                    } else if( pixel == 'analytics' && ( CS_Data.cs_script_cat.analytics == 0 || CS_Data.cs_script_cat.analytics == CS_Data.cs_necessary_cat_id ) ) {
                        return true;
                    } else if( pixel == 'google_ads' && ( CS_Data.cs_script_cat.gads == 0 || CS_Data.cs_script_cat.gads == CS_Data.cs_necessary_cat_id ) ) {
                        return true;
                    } else if( pixel == 'pinterest' && ( CS_Data.cs_script_cat.pinterest == 0 || CS_Data.cs_script_cat.pinterest == CS_Data.cs_necessary_cat_id ) ) {
                        return true;
                    } else if( pixel == 'tiktok' && ( CS_Data.cs_script_cat.tiktok == 0 || CS_Data.cs_script_cat.tiktok == CS_Data.cs_necessary_cat_id ) ) {
                        return true;
		            } else if( pixel == 'reddit' && ( CS_Data.cs_script_cat?.reddit == 0 || CS_Data.cs_script_cat?.reddit == CS_Data.cs_necessary_cat_id ) ) {
		                return true;
		            } else if( pixel == 'openai' && ( CS_Data.cs_script_cat?.openai == 0 || CS_Data.cs_script_cat?.openai == CS_Data.cs_necessary_cat_id ) ) {
		                return true;
		            }

                    let substring = "cs_enabled_cookie_term",
                        theCookies = document.cookie.split( ';' );

                    for ( let i = 1; i <= theCookies.length; i++ ) {
                        if ( theCookies[ i - 1 ].indexOf( substring ) !== -1 ) {
                            let categoryCookie = theCookies[ i - 1 ].replace( 'cs_enabled_cookie_term' + test_prefix + '_', '' );
                            categoryCookie = Number( categoryCookie.replace( /\D+/g, "" ) );
                            let cs_cookie_val = Cookies.get( 'cs_enabled_cookie_term' + test_prefix + '_' + categoryCookie );

                            if ( categoryCookie === CS_Data.cs_script_cat.facebook && pixel == 'facebook' ) {
                                return cs_cookie_val == 'yes';
                            } else if ( categoryCookie === CS_Data.cs_script_cat.bing && pixel == 'bing' ) {
                                return cs_cookie_val == 'yes';
                            } else if ( categoryCookie === CS_Data.cs_script_cat.analytics && pixel == 'analytics' ) {
                                return cs_cookie_val == 'yes';
                            } else if ( categoryCookie === CS_Data.cs_script_cat.gads && pixel == 'google_ads' ) {
                                return cs_cookie_val == 'yes';
                            } else if ( categoryCookie === CS_Data.cs_script_cat.pinterest && pixel == 'pinterest' ) {
                                return cs_cookie_val == 'yes';
                            } else if ( categoryCookie === CS_Data.cs_script_cat.tiktok && pixel == 'tiktok' ) {
                                return cs_cookie_val == 'yes';
                            } else if ( categoryCookie === CS_Data.cs_script_cat?.reddit && pixel == 'reddit' ) {
	                            return cs_cookie_val == 'yes';
                            } else if ( categoryCookie === CS_Data.cs_script_cat?.openai && pixel == 'openai' ) {
                                return cs_cookie_val == 'yes';
                            }
                        }
                    }

                    return false;
                }

                /**
                 * Real Cookie Banner
                 */
                if(options.gdpr.real_cookie_banner_integration_enabled) {
                    var consentApi = window.consentApi;
                    if (consentApi) {
                        switch (pixel) {
                            case "analytics":
                                return consentApi.consentSync("http", "_ga", "*").cookieOptIn;
                            case "facebook":
                                return consentApi.consentSync("http", "_fbp", "*").cookieOptIn;
                            case "pinterest":
                                return consentApi.consentSync("http", "_pinterest_sess", ".pinterest.com").cookieOptIn;
                            default:
                                return true;
                        }
                    }
                }

                /**
                 * Cookiebot
                 */
                if (options.gdpr.cookiebot_integration_enabled && typeof Cookiebot !== 'undefined') {

                    var cookiebot_consent_category = options.gdpr['cookiebot_' + pixel + '_consent_category'];

                    if (options.gdpr[pixel + '_prior_consent_enabled']) {
                        if (Cookiebot.consented === true || Cookiebot.consent[cookiebot_consent_category]) {
                            return true;
                        }
                    } else {
                        if (Cookiebot.consent[cookiebot_consent_category]) {
                            return true;
                        }
                    }

                    return false;

                }

                /**
                 * Cookie Notice
                 */
                if (options.gdpr.cookie_notice_integration_enabled && typeof cnArgs !== 'undefined') {

                    var cn_cookie = Cookies.get(cnArgs.cookieName);

                    if (options.gdpr[pixel + '_prior_consent_enabled']) {
                        if (typeof cn_cookie === 'undefined' || cn_cookie === 'true') {
                            return true;
                        }
                    } else {
                        if (cn_cookie === 'true') {
                            return true;
                        }
                    }

                    return false;

                }

                /**
                 * Cookie Law Info
                 */
                if (options.gdpr.cookie_law_info_integration_enabled) {
                    var cli_cookie = Cookies.get('cookieyes-consent') ?? Cookies.get('wt_consent') ?? Cookies.get('viewed_cookie_policy');
                    if (options.gdpr[pixel + '_prior_consent_enabled']) {
                        if (typeof cli_cookie === 'undefined') return true;
                        if (
                            cli_cookie &&
                            (cli_cookie === Cookies.get('cookieyes-consent') || cli_cookie === Cookies.get('wt_consent'))
                        ) {
                            if (getCookieYes('analytics') === 'yes') {
                                return true;
                            }
                        } else if (cli_cookie && cli_cookie === Cookies.get('viewed_cookie_policy')) {
                            if (Cookies.get('viewed_cookie_policy') === 'yes') {
                                return true;
                            }
                        }
                    } else {
                        if (
                            cli_cookie &&
                            (cli_cookie === Cookies.get('cookieyes-consent') || cli_cookie === Cookies.get('wt_consent'))
                        ) {
                            if (getCookieYes('analytics') === 'yes') {
                                return true;
                            }
                        } else if (cli_cookie && cli_cookie === Cookies.get('viewed_cookie_policy')) {
                            if (Cookies.get('viewed_cookie_policy') === 'yes') {
                                return true;
                            }
                        }
                    }
                    return false;
                }

                return true;

            },

            setupGdprCallbacks: function () {
                /**
                 * ConsentMagic
                 */
                if (options.gdpr.consent_magic_integration_enabled && typeof CS_Data !== "undefined") {
                    let test_prefix = CS_Data.test_prefix,
                        cs_refresh_after_consent = false,
                        substring = "cs_enabled_cookie_term";

                    if (CS_Data.cs_refresh_after_consent == 1) {
                        cs_refresh_after_consent = CS_Data.cs_refresh_after_consent;
                    }

                    let consent_actions = function () {
                        let theCookies = document.cookie.split( ';' );

                        let consent = {
                            facebook: true,
                            ga: true,
                            google_ads: true,
                            tiktok: true,
                            bing: true,
                            pinterest: true,
                            gtm: true,
	                        reddit: true,
                        };

                        for (let i = 1 ; i <= theCookies.length; i++) {
                            if (theCookies[i-1].indexOf(substring) !== -1) {
                                let categoryCookie = theCookies[i-1].replace('cs_enabled_cookie_term'+test_prefix+'_','');
                                categoryCookie = Number(categoryCookie.replace(/\D+/g,""));
                                let cs_cookie_val = Cookies.get('cs_enabled_cookie_term'+test_prefix+'_'+categoryCookie);
                                if(cs_cookie_val == 'yes') {
                                    if ( ( categoryCookie === CS_Data.cs_script_cat.facebook ) || Utils.csModeEnabled( CS_Data.cs_meta_ldu_mode ) ) {
                                        Facebook.loadPixel();
                                    }

                                    if ( categoryCookie === CS_Data.cs_script_cat.bing || Utils.csModeEnabled( CS_Data.cs_bing_consent_mode?.ad_storage?.enabled ) ) {
                                        Bing.loadPixel();
                                    }

                                    if (categoryCookie === CS_Data.cs_script_cat.analytics || (typeof CS_Data.cs_google_analytics_consent_mode !== "undefined" && CS_Data.cs_google_analytics_consent_mode == 1)) {

                                        Analytics.loadPixel();
                                    }

                                    if (categoryCookie === CS_Data.cs_script_cat.pinterest) {
                                        Pinterest.loadPixel();
                                    }

	                                if ( ( categoryCookie === CS_Data.cs_script_cat.reddit ) || Utils.csModeEnabled( CS_Data.cs_reddit_ldu_mode ) ) {
		                                Reddit.loadPixel();
	                                }

	                                if ( ( categoryCookie === CS_Data.cs_script_cat.openai ) || Utils.csModeEnabled( CS_Data.cs_openai_opt_out_mode ) ) {
		                                OpenAI.loadPixel();
	                                }
                                } else {
                                    if ( ( categoryCookie === CS_Data.cs_script_cat.facebook ) && ! Utils.csModeEnabled( CS_Data.cs_meta_ldu_mode ) ) {
                                        Facebook.disable();
                                        consent.facebook = false;
                                    }

                                    if ( categoryCookie === CS_Data.cs_script_cat.bing && ! Utils.csModeEnabled( CS_Data.cs_bing_consent_mode?.ad_storage?.enabled ) ) {
                                        Bing.disable();
                                        consent.bing = false;
                                    }
                                    if (categoryCookie === CS_Data.cs_script_cat.analytics && (typeof CS_Data.cs_google_analytics_consent_mode == "undefined" || CS_Data.cs_google_analytics_consent_mode == 0)) {
                                        Analytics.disable();
                                        consent.ga = false;
                                        consent.gtm = false;
                                    }

                                    if (categoryCookie === CS_Data.cs_script_cat.pinterest) {
                                        Pinterest.disable();
                                        consent.pinterest = false;
                                    }

	                                if ( ( categoryCookie === CS_Data.cs_script_cat.reddit ) && ! Utils.csModeEnabled( CS_Data.cs_reddit_ldu_mode ) ) {
		                                Reddit.disable();
		                                consent.reddit = false;
	                                }

	                                if ( ( categoryCookie === CS_Data.cs_script_cat.openai ) && ! Utils.csModeEnabled( CS_Data.cs_openai_opt_out_mode ) ) {
		                                OpenAI.disable();
		                                consent.openai = false;
	                                }

                                    if ( categoryCookie === CS_Data.cs_script_cat?.openai ) {
                                        OpenAI.disable();
                                        consent.openai = false;
                                    }
                                }
                                if (Cookies.get('cs_enabled_advanced_matching') == 'yes') {
                                    Facebook.loadPixel();
                                }
                            }
                        }
                        Utils.setupGDPRData( consent );
                    }

                    if (!cs_refresh_after_consent) {
                        consent_actions();

                        $(document).on('click','.cs_action_btn',function(e) {
                            e.preventDefault();

                            let consent = {
                                facebook: true,
                                ga: true,
                                bing: true,
                                pinterest: true,
                                gtm: true,
	                            reddit: true,
                            };

                            let elm = $(this),
                                button_action = elm.attr('data-cs_action');

                            if(button_action === 'allow_all') {
                                Facebook.loadPixel();
                                Bing.loadPixel();
                                Analytics.loadPixel();
                                Pinterest.loadPixel();
	                            Reddit.loadPixel();

                                consent.facebook = true;
                                consent.bing = true;
                                consent.ga = true;
                                consent.pinterest = true;
	                            consent.reddit = true;
                                consent.gtm = true;

                                Utils.setupGDPRData( consent );
                            } else if ( button_action === 'disable_all' ) {
                                if ( ! Utils.csModeEnabled( CS_Data.cs_meta_ldu_mode ) ) {
                                    Facebook.disable();
                                    consent.facebook = false;
                                }

                                if ( ! Utils.csModeEnabled( CS_Data.cs_bing_consent_mode?.ad_storage?.enabled ) ) {
                                    Bing.disable();
                                    consent.bing = false;
                                }

                                if ( CS_Data.cs_google_analytics_consent_mode == 0 || typeof CS_Data.cs_google_analytics_consent_mode == "undefined" ) {
                                    Analytics.disable();
                                    consent.ga = false;
                                    consent.gtm = false;
                                }

	                            if ( ! Utils.csModeEnabled( CS_Data.cs_reddit_ldu_mode ) ) {
		                            Reddit.disable();
		                            consent.reddit = false;
	                            }

                                Pinterest.disable();
                                consent.pinterest = false;
                                OpenAI.disable();
                                consent.openai = false;
                                Utils.setupGDPRData( consent );
                            } else if ( button_action === 'cs_confirm' ) {
                                consent_actions();
                            }
                        });
                    }
                }
                /**
                 * Real Cookie Banner
                 */
                if(options.gdpr.real_cookie_banner_integration_enabled) {
                    let consentApi = window.consentApi;
                    if (consentApi) {
                        consentApi.consent("http", "_ga", "*")
                            .then(Analytics.loadPixel.bind(Analytics), Analytics.disable.bind(Analytics));
                        consentApi.consent("http", "_fbp", "*")
                            .then(Facebook.loadPixel.bind(Facebook), Facebook.disable.bind(Facebook));
                        consentApi.consent("http", "_pinterest_sess", ".pinterest.com")
                            .then(Pinterest.loadPixel.bind(Pinterest), Pinterest.disable.bind(Pinterest));
                        consentApi.consent("http", "_uetsid", "*")
                            .then(Bing.loadPixel.bind(Bing), Bing.disable.bind(Bing));

                        let consent = {
                            facebook: true,
                            ga: true,
                            bing: true,
                            pinterest: true,
                            gtm: true,
                        };

                        if (!consentApi.consentSync("http", "_ga", "*").cookieOptIn) {
                            consent.ga = false;
                            consent.gtm = false;
                        }
                        if (!consentApi.consentSync("http", "_fbp", "*").cookieOptIn) {
                            consent.facebook = false;
                        }
                        if (!consentApi.consentSync("http", "_pinterest_sess", ".pinterest.com").cookieOptIn) {
                            consent.pinterest = false;
                        }
                        if (!consentApi.consentSync("http", "_uetsid", "*").cookieOptIn) {
                            consent.bing = false;
                        }
                        Utils.setupGDPRData( consent );
                    }
                }
                /**
                 * Cookiebot
                 */
                if (options.gdpr.cookiebot_integration_enabled && typeof Cookiebot !== 'undefined') {

                    window.addEventListener("CookiebotOnConsentReady", function() {

                        let consent = {
                            facebook: true,
                            ga: true,
                            bing: true,
                            pinterest: true,
                            gtm: true,
                        };

                        Utils.manageCookies();
                        if (Cookiebot.consent.marketing) {
                            Facebook.loadPixel();
                            Bing.loadPixel();
                            Pinterest.loadPixel();

                            consent.facebook = true;
                            consent.bing = true;
                            consent.pinterest = true;
                        }
                        if (Cookiebot.consent.statistics) {
                            Analytics.loadPixel();

                            consent.ga = true;
                            consent.gtm = true;
                        }
                        if (!Cookiebot.consent.marketing) {
                            Facebook.disable();
                            Pinterest.disable();
                            Bing.disable();

                            consent.facebook = false;
                            consent.bing = false;
                            consent.pinterest = false;
                        }
                        if (!Cookiebot.consent.statistics) {
                            Analytics.disable();

                            consent.ga = false;
                            consent.gtm = false;
                        }

                        Utils.setupGDPRData( consent );
                    });

                }

                /**
                 * Cookie Notice
                 */
                if (options.gdpr.cookie_notice_integration_enabled) {

                    $(document).onFirst('click', '.cn-set-cookie', function () {

                        let consent = {};

                        if ($(this).data('cookie-set') === 'accept') {
                            Facebook.loadPixel();
                            Analytics.loadPixel();
                            Pinterest.loadPixel();
                            Bing.loadPixel();

                            consent = {
                                facebook: true,
                                ga: true,
                                bing: true,
                                pinterest: true,
                                gtm: true,
                            };
                        } else {
                            Facebook.disable();
                            Analytics.disable();
                            Pinterest.disable();
                            Bing.disable();

                            consent = {
                                facebook: false,
                                ga: false,
                                bing: false,
                                pinterest: false,
                                gtm: false,
                            };
                        }

                        Utils.setupGDPRData( consent );
                    });

                    $(document).onFirst('click', '.cn-revoke-cookie', function () {
                        Facebook.disable();
                        Analytics.disable();
                        Pinterest.disable();
                        Bing.disable();

                        let consent = {
                            facebook: false,
                            ga: false,
                            bing: false,
                            pinterest: false,
                            gtm: false,
                        };
                        Utils.setupGDPRData( consent );

                    });

                }

                /**
                 * Cookie Law Info
                 */
                if (options.gdpr.cookie_law_info_integration_enabled) {

                    $(document).onFirst('click', '#wt-cli-accept-all-btn,#cookie_action_close_header, .cky-btn-accept', function () {
                        setTimeout(function (){
                            let cli_cookie = Cookies.get('cookieyes-consent') ?? Cookies.get('wt_consent') ?? Cookies.get('viewed_cookie_policy');
                            if (typeof cli_cookie !== 'undefined') {
                                if (cli_cookie === Cookies.get('cookieyes-consent') || cli_cookie === Cookies.get('wt_consent')) {
                                    if (getCookieYes('analytics') === 'yes') {
                                        Utils.manageCookies();
                                    }
                                } else if (cli_cookie === Cookies.get('viewed_cookie_policy') && cli_cookie == 'yes') {
                                    Utils.manageCookies();
                                }
                            }
                        },1000)
                        Facebook.loadPixel();
                        Analytics.loadPixel();
                        Pinterest.loadPixel();
                        Bing.loadPixel();

                        let consent = {
                            facebook: true,
                            ga: true,
                            bing: true,
                            pinterest: true,
                            gtm: true,
                        };
                        Utils.setupGDPRData( consent );
                    });

                    $(document).onFirst('click', '#cookie_action_close_header_reject, .cky-btn-reject', function () {
                        Facebook.disable();
                        Analytics.disable();
                        Pinterest.disable();
                        Bing.disable();

                        let consent = {
                            facebook: false,
                            ga: false,
                            bing: false,
                            pinterest: false,
                            gtm: false,
                        };
                        Utils.setupGDPRData( consent );
                    });

                }

            },

            setupGDPRData: function ( consent ) {
                consent = window.btoa( JSON.stringify( consent ) );
                Cookies.set( 'pys_consent', consent, { expires: 365, path: '/', domain: cookieDomain() } );
            },

            /**
             * DOWNLOAD DOCS
             */

            getLinkExtension: function (link) {

                // Remove anchor, query string and everything before last slash
                link = link.substring(0, (link.indexOf("#") === -1) ? link.length : link.indexOf("#"));
                link = link.substring(0, (link.indexOf("?") === -1) ? link.length : link.indexOf("?"));
                link = link.substring(link.lastIndexOf("/") + 1, link.length);

                // If there's a period left in the URL, then there's a extension
                if (link.length > 0 && link.indexOf('.') !== -1) {
                    link = link.substring(link.indexOf(".") + 1); // Remove everything but what's after the first period
                    return link;
                } else {
                    return "";
                }
            },

            getLinkFilename: function (link) {

                // Remove anchor, query string and everything before last slash
                link = link.substring(0, (link.indexOf("#") === -1) ? link.length : link.indexOf("#"));
                link = link.substring(0, (link.indexOf("?") === -1) ? link.length : link.indexOf("?"));
                link = link.substring(link.lastIndexOf("/") + 1, link.length);

                // If there's a period left in the URL, then there's a extension
                if (link.length > 0 && link.indexOf('.') !== -1) {
                    return link;
                } else {
                    return "";
                }
            },
            /**
             * Enrich
             */
            isCheckoutPage: function () {
                return $('body').hasClass('woocommerce-checkout') || document.querySelector('.woocommerce-checkout') ||
                    $('body').hasClass('edd-checkout');
            },
            addCheckoutFields : function() {
                var utm = "";
                var utms = getUTMs()

                $.each(utmTerms, function (index, name) {
                    if(index > 0) {
                        utm+="|";
                    }
                    utm+=name+":"+utms[name];
                });
                var utmIdList = "";
                var utmsIds = getUTMId()
                $.each(utmId, function (index, name) {
                    if(index > 0) {
                        utmIdList+="|";
                    }
                    utmIdList+=name+":"+utmsIds[name];
                });
                var utmIdListLast = "";
                var utmsIdsLast = getUTMId(true)
                $.each(utmId, function (index, name) {
                    if(index > 0) {
                        utmIdListLast+="|";
                    }
                    utmIdListLast+=name+":"+utmsIdsLast[name];
                });


                var utmLast = "";
                var utmsLast = getUTMs(true)
                $.each(utmTerms, function (index, name) {
                    if(index > 0) {
                        utmLast+="|";
                    }
                    utmLast+=name+":"+utmsLast[name];
                });

                var dateTime = getDateTime();
                // No current-URL fallback here: an empty field lets
                // EnrichOrder::getRequestValue() use its own server-side default,
                // which is the visit data from the PHP session — more reliable than
                // the checkout URL. The checkout page is never HTML-cached, so
                // reading the session there is safe.
                var landing = getLandingPageValue(false);
                var lastLanding = getLandingPageValue(false);
                var trafic = getTrafficSourceValue();
                var lastTrafic = getTrafficSourceValue();

                var $form = null;
                if($('body').hasClass('woocommerce-checkout')) {
                    $form = $("form.woocommerce-checkout");
                } else {
                    $form = $("#edd_purchase_form");
                }
                var inputs = {'pys_utm':utm,
                    'pys_utm_id':utmIdList,
                    'pys_browser_time':dateTime.join("|"),
                    'pys_landing':landing,
                    'pys_source':trafic,
                    'pys_order_type': $(".wcf-optin-form").length > 0 ? "wcf-optin" : "normal",

                    'last_pys_landing':lastLanding,
                    'last_pys_source':lastTrafic,
                    'last_pys_utm':utmLast,
                    'last_pys_utm_id':utmIdListLast,
                }

                Object.keys(inputs).forEach(function(key,index) {
                    $form.append("<input type='hidden' name='"+key+"' value='"+inputs[key]+"' /> ");
                });


            },
            getAdvancedFormData: function () {
                let dataStr = Cookies.get("pys_advanced_form_data");
                if(dataStr === undefined) {
                    return {'first_name':"",'last_name':"",'email':"",'phone':""};
                } else {
                    return JSON.parse(dataStr);
                }
            },

            /**
             * Advanced Matching that the server is no longer allowed to render.
             *
             * Page HTML can be served out of a shared cache, so the server
             * leaves the visitor's own email, phone and name out of pysOptions.
             * The values are on this device in pys_advanced_form_data, so the
             * browser puts them back just before each pixel initialises.
             * Normalisation mirrors the PHP side field for field -- if one
             * moves, both move.
             */
            AdvancedMatching: {

                normalizeEmail: function (value) {
                    if (typeof value !== 'string') {
                        return '';
                    }
                    var email = value.trim().toLowerCase();
                    if (email.length === 0 || email.length > 254) {
                        return '';
                    }
                    return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email) ? email : '';
                },

                normalizePhone: function (value) {
                    if (typeof value !== 'string') {
                        return '';
                    }
                    var digits = value.replace(/[^0-9]/g, '');
                    return digits.length > 0 ? digits : '';
                },

                normalizeName: function (value) {
                    if (typeof value !== 'string' || value.length > 1024) {
                        return '';
                    }
                    return value.trim().toLowerCase();
                },

                /**
                 * The identity this device carries, normalised and possibly
                 * all-empty. Never throws when the cookie is absent or corrupt.
                 */
                cookieIdentity: function () {
                    var data;
                    try {
                        data = Utils.getAdvancedFormData() || {};
                    } catch (e) {
                        data = {};
                    }
                    return {
                        email: this.normalizeEmail(data.email || ''),
                        phone: this.normalizePhone(data.phone || ''),
                        first_name: this.normalizeName(data.first_name || ''),
                        last_name: this.normalizeName(data.last_name || '')
                    };
                },

                /**
                 * @param {object} target      The pixel's advanced matching object, edited in place.
                 * @param {object} mapping     {targetKey: {field, hash}}
                 * @param {object} identity    Optional; defaults to cookieIdentity().
                 * @param {string} persistency Optional; defaults to options.data_persistency.
                 */
                merge: function (target, mapping, identity, persistency) {

                    if (!target || !mapping) {
                        return target;
                    }

                    identity = identity || this.cookieIdentity();

                    if (typeof persistency === 'undefined') {
                        persistency = typeof options !== 'undefined' ? options.data_persistency : '';
                    }

                    var keepData = persistency === 'keep_data';

                    Object.keys(mapping).forEach(function (targetKey) {

                        var rule = mapping[targetKey];
                        var value = identity[rule.field];

                        if (typeof value !== 'string' || value.length === 0) {
                            return;
                        }

                        var hasServerValue = typeof target[targetKey] === 'string'
                            && target[targetKey].length > 0;

                        if (hasServerValue && !keepData) {
                            return;
                        }

                        if (rule.hash) {
                            if (typeof sha256 !== 'function') {
                                return;
                            }
                            target[targetKey] = sha256(value);
                        } else {
                            target[targetKey] = value;
                        }
                    });

                    return target;
                }
            },

            getFormFilledData: function ( event ) {
                // First, resolve static/dynamic parameters
                if (event.params && Object.keys(event.params).length > 0) {
                    Object.entries(event.params).forEach(([key, value]) => {
                        // Resolve parameter value (static or dynamic)
                        const resolvedValue = resolveParamValue(value, key);
                        if (resolvedValue !== null) {
                            event.params[key] = resolvedValue;
                        }
                        else {
                            delete event.params[key];
                        }
                    });
                }
                return event;
            }
        };

    }(options);

    var Facebook = function (options) {


        var defaultEventTypes = [
            'PageView',
            'ViewContent',
            'Search',
            'AddToCart',
            'AddToWishlist',
            'InitiateCheckout',
            'AddPaymentInfo',
            'Purchase',
            'Lead',

            'Subscribe',
            'CustomizeProduct',
            'FindLocation',
            'StartTrial',
            'SubmitApplication',
            'Schedule',
            'Contact',
            'Donate'
        ];

        var initialized = false;
        /**
         * The `version.subdomainIndex.` prefix Meta's format calls for.
         * subdomainIndex is how many labels the cookie's domain has below
         * the public suffix (com=0, example.com=1, www.example.com=2), so it
         * must track cookieDomain()/probeCookieDomain() rather than a
         * hardcoded `fb.1.`. Only new values are affected — an existing
         * cookie is returned untouched.
         */
        var fbValuePrefix = function (){
            var resolved = cookieDomain();
            var scope = resolved ? String(resolved).replace(/^\./, '') : '';
            if (!scope) {
                try { scope = String(location.hostname || ''); } catch (e) { scope = ''; }
            }
            var dots = scope ? scope.split('.').length - 1 : 0;
            return 'fb.' + dots + '.' + Date.now() + '.';
        };
        // Meta's keep-or-replace rule for an _fbp the browser already holds,
        // as ParamBuilder 1.3.2 applies it: four dot-separated parts are kept
        // as they are, a fifth only if it is a valid appendix token. Nothing is
        // appended. PHP twins: pys_fb_valid_appendix() / pys_fbp_is_valid() in
        // includes/functions-fb-cookies.php.
        var pysFbValidAppendix = function (suffix) {
            suffix = String(suffix);
            var tokens = ['AQ', 'Ag', 'Aw', 'BA', 'BQ', 'Bg'];

            if (suffix.length === 2) {
                return tokens.indexOf(suffix) !== -1;
            }
            if (suffix.length !== 8 || !/^[A-Za-z0-9_-]+$/.test(suffix)) {
                return false;
            }

            var decoded;
            try {
                decoded = atob(suffix.replace(/-/g, '+').replace(/_/g, '/'));
            } catch (e) {
                return false;
            }

            return decoded.length === 6
                && decoded.charCodeAt(0) === 1
                && decoded.charCodeAt(1) >= 1
                && decoded.charCodeAt(1) <= tokens.length;
        };
        var pysFbpIsValid = function (v) {
            if (!v) return false;
            var p = String(v).split('.');
            if (p.length === 4) return true;
            if (p.length === 5) return pysFbValidAppendix(p[4]);
            return false;
        };
        var genereateFbp = function (){
            var existing = Cookies.get('_fbp');
            return pysFbpIsValid(existing) ? existing : fbValuePrefix()+Math.floor(Math.random() * 2147483648);
        };
        var genereateFbc = function (){
            return getUrlParameter('fbclid') ? fbValuePrefix()+getUrlParameter('fbclid') : ''
        };

        // The click id inside an _fbc value: segment 4 of
        // fb.<subdomain_index>.<creation_time>.<fbclid>[.<appendix>], indexed
        // from the front so an appendix is never taken for the click id.
        // PHP twin: pys_fbc_click_id() in includes/functions-fb-cookies.php.
        var fbcClickId = function (value) {
            var parts = String(value || '').split('.');

            return parts.length >= 4 && parts[0] === 'fb' ? parts[3] : '';
        };
        // fire server side event gdpr plugin installed
        var isApiDisabled = options.gdpr.all_disabled_by_api ||
            options.gdpr.facebook_disabled_by_api ||
            options.gdpr.cookiebot_integration_enabled ||
            options.gdpr.consent_magic_integration_enabled ||
            options.gdpr.cookie_notice_integration_enabled ||
            options.gdpr.cookie_law_info_integration_enabled;

        /**
         *
         * @param allData
         * @param params
         * @returns {string | null}
         */
        function sendFbServerEvent(allData,name,params) {
            let eventId = null;
            // sendEventId is true when the token-based Conversion API is on OR
            // when Meta-Enabled CAPI is on: in both cases Meta receives a second,
            // API-side copy of this event and dedupes it by eventID.
            // Only the token-based API needs an actual request from us, so the
            // hook/AJAX branches below stay gated on serverApiEnabled.
            if(options.facebook.sendEventId) {

                var isAtcFromHook = options.woo
                    && options.woo.addToCartCatchMethod === "add_cart_hook";

                if(options.facebook.serverApiEnabled && allData.e_id === "woo_remove_from_cart") {// server event will sended from hook
                    Facebook.updateEventId(allData.name);
                    allData.eventID = Facebook.getEventId(allData.name);
                } else if(options.facebook.serverApiEnabled && allData.e_id === "woo_add_to_cart_on_button_click" && isAtcFromHook) {
                    // Server event was already sent from the PHP hook
                    // (trackWooAddToCartEvent -> FacebookServer()->sendEventsNow).
                    // Keep the shared eventID PHP put on the event so the browser
                    // pixel dedupes against that server copy — do NOT re-send here,
                    // and do NOT regenerate the eventID.
                } else {
                    // send event from server if they was bloc by gdpr or need send with delay
                    allData.eventID = Utils.generateUniqueId(allData);

                    if(pysFbpIsValid(Cookies.get('_fbp'))){
                        params._fbp = Cookies.get('_fbp');
                    }
                    if(Cookies.get('_fbc')){
                        params._fbc = Cookies.get('_fbc');
                    }

                    if( options.facebook.serverApiEnabled && ( options.ajaxForServerEvent || isApiDisabled ) ){
                        var json = {
                            action: 'pys_api_event',
                            pixel: 'facebook',
                            event: name,
                            event_slug: allData.e_id,
                            data:params,
                            ids:options.facebook.pixelIds,
                            eventID:allData.eventID,
                            url:window.location.href,
                            ajax_event:options.ajax_event
                        };
                        if(allData.hasOwnProperty('woo_order')) {
                            json['woo_order'] = allData.woo_order;
                        }
                        if(allData.hasOwnProperty('edd_order')) {
                            json['edd_order'] = allData.edd_order;
                        }
                        if(allData.hasOwnProperty('order_key') && allData.order_key) {
                            json['order_key'] = allData.order_key;
                        }
                        if (pageReferrer) {
                            json.referrer_url = pageReferrer;
                        }

                        if (allData.e_id === "automatic_event_internal_link" || allData.e_id === "automatic_event_outbound_link") {
                            setTimeout(() => Utils.sendServerAjaxRequest(options.ajaxUrl, json), 500);
                        } else if (allData.type != 'static') {
                            Utils.sendServerAjaxRequest(options.ajaxUrl, json);
                        }

                        if ( ( allData.type == 'static' && options.ajaxForServerStaticEvent ) || ( allData.hasOwnProperty( 'ajaxFire' ) && allData.ajaxFire ) ) {
                            Utils.sendServerAjaxRequest( options.ajaxUrl, json );
                        }
                    }
                }
                delete params._fbp;
                delete params._fbc;
                eventId = allData.eventID
            }
            return eventId;
        }

        function fireEvent(name, allData) {

            if(typeof window.pys_disable_event_filter === "function" && window.pys_disable_event_filter(name,'facebook')) {
                return;
            }

            var actionType = defaultEventTypes.includes(name) ? 'track' : 'trackCustom';
            var data = allData.params;
            var params = {};
            var arg = {};
            Utils.copyProperties(data, params);
            let eventId = sendFbServerEvent(allData,name,params)


            if("hCR" === name) {
                return;
            }

            if (options.debug) {
                console.log('[Facebook] ' + name, params,"eventID",eventId);
            }

            if(eventId != null) {
                arg.eventID = eventId;
            }

            fbq(actionType, name, params, arg);

        }

        /**
         * Public API
         */
        return {
            tag: function() {
                return "facebook";
            },
            isEnabled: function () {
                return options.hasOwnProperty('facebook');
            },

            disable: function () {
                initialized = false;
            },
            advancedMatching: function () {
                if(options.facebook.advancedMatchingEnabled) {
                    let advancedMatching = {};
                    if(Object.keys(options.facebook.advancedMatching).length > 0) {
                        advancedMatching = options.facebook.advancedMatching;
                    }

                    Utils.AdvancedMatching.merge(advancedMatching, {
                        em: { field: 'email',      hash: false },
                        ph: { field: 'phone',      hash: false },
                        fn: { field: 'first_name', hash: false },
                        ln: { field: 'last_name',  hash: false }
                    });

                    if(!advancedMatching.hasOwnProperty("external_id")){
                        if (Cookies.get('pbid') || (options.hasOwnProperty('pbid') && options.pbid)) {
                            advancedMatching["external_id"] = Cookies.get('pbid') ? Cookies.get('pbid') : options.pbid;
                        }
                    }
                    else if(advancedMatching.external_id != Cookies.get('pbid'))
                    {
                        advancedMatching["external_id"] = Cookies.get('pbid') ? Cookies.get('pbid') : advancedMatching.external_id;
                    }
                    if(Object.keys(advancedMatching).length > 0) {
                        return advancedMatching;
                    }
                }
                return false
            },
            /**
             * Load pixel's JS
             */
            loadPixel: function () {

                if (initialized || !this.isEnabled() || !Utils.consentGiven('facebook')) {
                    return;
                }

                // First visit: wait (briefly) for this browser's external_id, so
                // the very first PageView is not sent under the inline value.
                if (Utils.holdForIdentity(function () { Facebook.loadPixel(); })) {
                    return;
                }

                !function (f, b, e, v, n, t, s) {
                    if (f.fbq) return;
                    n = f.fbq = function () {
                        n.callMethod ?
                            n.callMethod.apply(n, arguments) : n.queue.push(arguments)
                    };
                    if (!f._fbq) f._fbq = n;
                    n.push = n;
                    n.loaded = !0;
                    n.version = '2.0';
                    n.agent = 'dvpixelyoursite';
                    n.queue = [];
                    t = b.createElement(e);
                    t.async = !0;
                    t.src = v;
                    s = b.getElementsByTagName(e)[0];
                    s.parentNode.insertBefore(t, s)
                }(window,
                    document, 'script', '../connect.facebook.net/en_US/fbevents.js');

                // Report the cookie domain here too, not just from
                // manageCookies(): this runs under the `facebook` pixel's own
                // consent, which can differ from and outlast the `pys`
                // script's consent (e.g. under ConsentMagic's separate
                // category assignments), so PHP might otherwise never learn
                // the scope for a visitor who only accepted this pixel.
                //
                // `pys_cd` only ever appears here alongside a cookie we are
                // already writing at that scope, so it can never be the first
                // cookie a visitor receives. disabled_all_cookie is still
                // honoured, matching the call in manageCookies().
                if (!options.cookie || !options.cookie.disabled_all_cookie) {
                    reportCookieDomain(cookieDomain());
                }

                // Meta's cookies keep their own lifetime: cookie_duration is the
                // "First Visit" attribution window and defaults to 7 days, which
                // would mint a new browser identity every week. PHP twin:
                // pys_fb_cookie_lifetime(). The fallback covers a page cached
                // before the option existed.
                let expires = parseInt(options.fb_cookie_duration) || 90;
                if(!pysFbpIsValid(Cookies.get('_fbp'))) {
                    Cookies.set('_fbp',genereateFbp(),  { expires: expires,path: '/',domain: cookieDomain() });
                }

                // A new click replaces the stored value, so a returning visitor
                // is reported under the ad they just clicked. The same click id
                // does not: rewriting would move creation_time and tell Meta the
                // click just happened. PHP twin: pys_fbc_needs_refresh().
                var urlFbclid = getUrlParameter('fbclid');

                if (urlFbclid && fbcClickId(Cookies.get('_fbc')) !== urlFbclid) {
                    Cookies.set('_fbc',genereateFbc(),  { expires: expires,path: '/',domain: cookieDomain() });
                }

                // Now that Facebook consent is confirmed, mirror the session
                // entry referrer (if any) into the session cookie so PHP can
                // use it as a fallback for orphan server-only events.
                getOrInitSessionEntryReferrer(true);

                // Refresh the per-page event referrer cookie so checkout
                // hooks can snapshot the buyer's prior page.
                writeEventReferrerCookie();

                // initialize pixel
                options.facebook.pixelIds.forEach(function (pixelId) {
                    if (options.facebook.removeMetadata) {
                        fbq('set', 'autoConfig', false, pixelId);
                    }
                    let advancedMatching = Facebook.advancedMatching();

                    if ( +options.facebook.meta_ldu === 1  ) {
                        fbq( 'dataProcessingOptions', [ 'LDU' ], 0, 0 );
                    }

                    // Meta-Enabled Conversion API: let Meta build its own API
                    // events out of this pixel's data. Must run right before init.
                    if (Utils.isMetaEnabledCapiPixel(pixelId)) {
                        fbq('optinMetaEnabledCapi', pixelId);
                    }

                    if (options.gdpr.consent_magic_integration_enabled && typeof CS_Data !== "undefined") {
                        if(!advancedMatching) {
                            fbq('init', pixelId);
                        } else {
                            var test_prefix = CS_Data.test_prefix;
                            var cs_advanced_matching = Cookies.get('cs_enabled_advanced_matching'+test_prefix);
                            if (jQuery('#cs_enabled_advanced_matching'+test_prefix).length > 0) {
                                if (cs_advanced_matching == 'yes') {
                                    fbq('init', pixelId, advancedMatching);
                                } else {
                                    fbq('init', pixelId);
                                }
                            } else {
                                fbq('init', pixelId, advancedMatching);
                            }
                        }
                    } else {
                        if(!advancedMatching) {
                            fbq('init', pixelId);
                        }  else {
                            fbq('init', pixelId, advancedMatching);
                        }
                    }
                });

                initialized = true;

                Utils.fireStaticEvents('facebook');

            },

            fireEvent: function (name, data) {

                if (!initialized || !this.isEnabled()) {
                    return false;
                }

                data.delay = data.delay || 0;
                data.params = data.params || {};

                if (data.delay === 0) {

                    fireEvent(name, data);

                } else {

                    setTimeout(function (name, params) {
                        fireEvent(name, params);
                    }, data.delay * 1000, name, data);

                }

                return true;

            },

            onCommentEvent: function (event) {
                this.fireEvent(event.name, event);
            },

            onDownloadEvent: function (event) {
                this.fireEvent(event.name, event);
            },

            onFormEvent: function (event) {

                this.fireEvent(event.name, event);

            },

            onWooAddToCartOnButtonEvent: function (product_id) {

                if(!options.dynamicEvents.woo_add_to_cart_on_button_click.hasOwnProperty(this.tag()))
                    return;
                var event = options.dynamicEvents.woo_add_to_cart_on_button_click[this.tag()];
                window.pysWooProductData = window.pysWooProductData || {};
                if (window.pysWooProductData.hasOwnProperty(product_id)) {
                    if (window.pysWooProductData[product_id].hasOwnProperty('facebook')) {
                        event = Utils.copyProperties(event, {})
                        Utils.copyProperties(window.pysWooProductData[product_id]['facebook'].params, event.params)
                        this.fireEvent(event.name, event);
                    }
                }
            },

            onWooAddToCartOnSingleEvent: function (product_id, qty, product_type, $form) {

                window.pysWooProductData = window.pysWooProductData || {};
                if(!options.dynamicEvents.woo_add_to_cart_on_button_click.hasOwnProperty(this.tag()))
                    return;
                var event = Utils.clone(options.dynamicEvents.woo_add_to_cart_on_button_click[this.tag()]);

                if (product_type === Utils.PRODUCT_VARIABLE && !options.facebook.wooVariableAsSimple) {
                    product_id = parseInt($form.find('input[name="variation_id"]').val());
                }

                if (window.pysWooProductData.hasOwnProperty(product_id)) {
                    if (window.pysWooProductData[product_id].hasOwnProperty('facebook')) {


                        Utils.copyProperties(window.pysWooProductData[product_id]['facebook'].params, event.params);

                        var groupValue = 0;
                        if(product_type === Utils.PRODUCT_GROUPED ) {
                            $form.find(".woocommerce-grouped-product-list .qty").each(function(index){
                                var childId = $(this).attr('name').replaceAll("quantity[","").replaceAll("]","");
                                var quantity = parseInt($(this).val());
                                if(isNaN(quantity)) {
                                    quantity = 0;
                                }
                                var childItem = window.pysWooProductData[product_id]['facebook'].grouped[childId];

                                if(quantity == 0) {
                                    event.params.content_ids.forEach(function(el,index,array) {
                                        if(el == childItem.content_id) {
                                            array.splice(index, 1);
                                        }
                                    });
                                }

                                if(event.params.hasOwnProperty('contents')) {
                                    event.params.contents.forEach(function(el,index,array) {
                                        if(el.id == childItem.content_id) {
                                            if(quantity > 0){
                                                el.quantity = quantity;
                                            } else {
                                                array.splice(index, 1);
                                            }
                                        }
                                    });
                                }


                                groupValue += childItem.price * quantity;
                            });
                            if(groupValue == 0) return; // skip if no items selected
                        }

                        // maybe customize value option
                        if (options.woo.addToCartOnButtonValueEnabled && options.woo.addToCartOnButtonValueOption !== 'global') {

                            if(product_type === Utils.PRODUCT_GROUPED) {
                                event.params.value = groupValue;
                            } else if(product_type === Utils.PRODUCT_BUNDLE) {
                                var data = $(".bundle_form .bundle_data").data("bundle_form_data");
                                var items_sum = getBundlePriceOnSingleProduct(data);
                                event.params.value = (parseInt(data.base_price) + items_sum )* qty;
                            } else {
                                event.params.value = event.params.value * qty;
                            }
                        }

                        // only when non Facebook for WooCommerce logic used
                        if (event.params.hasOwnProperty('contents') && product_type !== Utils.PRODUCT_GROUPED) {
                            event.params.contents[0].quantity = qty;
                        }

                        this.fireEvent(event.name, event);

                    }
                }
            },

            onWooRemoveFromCartEvent: function (event) {
                this.fireEvent(event.name, event);
            },

            onEddAddToCartOnButtonEvent: function (download_id, price_index, qty) {

                if(!options.dynamicEvents.edd_add_to_cart_on_button_click.hasOwnProperty(this.tag()))
                    return;
                var event = Utils.clone(options.dynamicEvents.edd_add_to_cart_on_button_click[this.tag()]);

                if (window.pysEddProductData && window.pysEddProductData.hasOwnProperty(download_id)) {

                    var index;

                    if (price_index) {
                        index = download_id + '_' + price_index;
                    } else {
                        index = download_id;
                    }

                    if (window.pysEddProductData[download_id].hasOwnProperty(index)) {
                        if (window.pysEddProductData[download_id][index].hasOwnProperty('facebook')) {


                            Utils.copyProperties(window.pysEddProductData[download_id][index]['facebook']["params"], event.params)

                            // maybe customize value option
                            if (options.edd.addToCartOnButtonValueEnabled && options.edd.addToCartOnButtonValueOption !== 'global') {
                                event.params.value = event.params.value * qty;
                            }

                            // update contents qty param
                            var contents = event.params.contents;
                            contents[0].quantity = qty;
                            event.params.contents = contents;

                            this.fireEvent(event.name,event);

                        }
                    }

                }

            },

            onEddRemoveFromCartEvent: function (event) {
                this.fireEvent(event.name, event);
            },
            onPageScroll: function (event) {
                this.fireEvent(event.name, event);
            },
            onTime: function (event) {
                this.fireEvent(event.name, event);
            },
            initEventIdCookies: function (key) {
                var ids = {};
                ids[key] = pys_generate_token(36)
                Cookies.set('pys_fb_event_id', JSON.stringify(ids));
            },
            updateEventId:function(key) {
                var cooData = Cookies.get("pys_fb_event_id")
                if(cooData === undefined) {
                    this.initEventIdCookies(key);
                } else {
                    var data = JSON.parse(cooData);
                    data[key] = pys_generate_token(36);
                    Cookies.set('pys_fb_event_id', JSON.stringify(data) );
                }
            },

            getEventId:function (key) {
                var data = Cookies.get("pys_fb_event_id");
                if(data === undefined) {
                    this.initEventIdCookies(key);
                    data = Cookies.get("pys_fb_event_id");
                }
                return JSON.parse(data)[key];
            },

            sendFacebookRestAPIRequest: function(allData, name, params) {
                if (typeof window.pysFacebookRest === 'undefined' || !window.pysFacebookRest.restApiUrl) {
                    return;
                }

                const restApiData = {
                    event: name,
                    data: JSON.stringify(params),
                    ids: allData.pixelIds || options.facebook.pixelIds,
                    eventID: allData.eventID,
                    woo_order: allData.woo_order || 0,
                    edd_order: allData.edd_order || 0,
                    order_key: allData.order_key || ''
                };

                if (pageReferrer) {
                    restApiData.referrer_url = pageReferrer;
                }

                // Variant A: send the actual page URL where the event happened
                // so the server sets event_source_url to this page, not the
                // REST endpoint. PHP applies enable_remove_source_url_params.
                restApiData.event_source_url = window.location.href;

                // Try sendBeacon first
                if (navigator.sendBeacon) {
                    const formData = new FormData();
                    Object.keys(restApiData).forEach(key => {
                        if (Array.isArray(restApiData[key])) {
                            restApiData[key].forEach(value => {
                                formData.append(key + '[]', value);
                            });
                        } else {
                            formData.append(key, restApiData[key]);
                        }
                    });

                    if (navigator.sendBeacon(window.pysFacebookRest.restApiUrl, formData)) {
                        return;
                    }
                }

                // Fallback to fetch
                fetch(window.pysFacebookRest.restApiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    body: new URLSearchParams(restApiData)
                }).catch(() => {
                    // Fallback to AJAX if fetch fails
                    this.sendAjaxFallback(allData, name, params);
                });
            },

            sendAjaxFallback: function(allData, name, params) {
                var json = {
                    action: 'pys_api_event',
                    pixel: 'facebook',
                    event: name,
                    data: params,
                    ids: allData.pixelIds || options.facebook.pixelIds,
                    eventID: allData.eventID,
                    url: window.location.href,
                    ajax_event: options.ajax_event
                };
                if (allData.hasOwnProperty('woo_order')) {
                    json['woo_order'] = allData.woo_order;
                }
                if (allData.hasOwnProperty('edd_order')) {
                    json['edd_order'] = allData.edd_order;
                }
                if (allData.hasOwnProperty('order_key') && allData.order_key) {
                    json['order_key'] = allData.order_key;
                }
                if (pageReferrer) {
                    json.referrer_url = pageReferrer;
                }

                Utils.sendServerAjaxRequest(options.ajaxUrl, json);
            },
        };

    }(options);

    var Analytics = function (options) {

        var initialized = false;

        /**
         * Fires event
         *
         * @link: https://developers.google.com/analytics/devguides/collection/gtagjs/sending-data
         * @link: https://developers.google.com/analytics/devguides/collection/gtagjs/events
         * @link: https://developers.google.com/gtagjs/reference/event
         * @link: https://developers.google.com/gtagjs/reference/parameter
         *
         * @link: https://developers.google.com/analytics/devguides/collection/gtagjs/custom-dims-mets
         *
         * @param name
         * @param data
         */
        function fireEvent(name, data) {

            if(typeof window.pys_disable_event_filter === "function" && window.pys_disable_event_filter(name,'ga')) {
                return;
            }

            var eventParams = Utils.copyProperties(data, {});
            var _fireEvent = function (tracking_id,name,params) {

                // Firing without a destination would park the hit inside gtag.js
                // instead of sending it, which Tag Assistant reports as a missing
                // config command. Skip, but keep the reason visible in debug mode.
                if (!Utils.hasSendToTarget(tracking_id)) {
                    if (options.debug) {
                        console.warn('[Google Analytics] ' + name + ' skipped: empty tracking ID', {
                            trackingIds: options.ga.trackingIds
                        });
                    }
                    return;
                }

                params['send_to'] = tracking_id;

                if (options.debug) {
                    console.log('[Google Analytics #' + tracking_id + '] ' + name, params);
                }

                Utils.gtagPush('event', name, params);

            };
            options.ga.trackingIds.forEach(function (tracking_id) {
                var copyParams = Utils.copyProperties(eventParams, {}); // copy params because mapParamsTov4 can modify it
                var params = mapParamsTov4(tracking_id,name,copyParams)
                _fireEvent(tracking_id,name,params);
            });

        }
        function mapParamsTov4(tag,name,param) {
            //GA4 automatically collects a number of parameters for all events
            delete param.landing_page;
            // end
            if(isv4(tag)) {
                delete param.traffic_source;
                delete param.event_category;
                delete param.event_label;
                delete param.ecomm_prodid;
                delete param.ecomm_pagetype;
                delete param.ecomm_totalvalue;
                if(name === 'search') {
                    param['search'] = param.search_term;
                    delete param.search_term;
                    delete param.dynx_itemid;
                    delete param.dynx_pagetype;
                    delete param.dynx_totalvalue;
                }
            }
            return param;
        }

        function isv4(tag) {
            return tag.indexOf('G') === 0;
        }

        /**
         * Public API
         */
        return {
            tag: function() {
                return "ga";
            },
            isEnabled: function () {
                return options.hasOwnProperty('ga');
            },

            disable: function () {
                initialized = false;
            },

            loadPixel: function () {

                if (initialized || !this.isEnabled() || !Utils.consentGiven('analytics')) {
                    return;
                }

                Utils.loadGoogleTag(options.ga.trackingIds[0]);
                var config = {};
                // Cross-Domain tracking
                if (options.ga.crossDomainEnabled) {
                    config.linker = {
                        accept_incoming: options.ga.crossDomainAcceptIncoming,
                        domains: options.ga.crossDomainDomains
                    };
                }
                var ids = options.ga.trackingIds;
                // configure tracking ids
                ids.forEach(function (trackingId,index) {
                    var obj = options.ga.isDebugEnabled;
                    var searchValue = "index_"+index;
                    var config_for_tag = Object.assign({}, options.config);
                    config_for_tag.debug_mode = false;
                    config_for_tag.send_page_view = !options.ga.custom_page_view_event;
                    for (var key in obj) {
                        if (obj.hasOwnProperty(key) && obj[key] === searchValue) {
                            config_for_tag.debug_mode = true;
                            break;
                        }
                    }
                    if(!config_for_tag.debug_mode)
                    {
                        delete config_for_tag.debug_mode;
                    }
                    if(isv4(trackingId)) {
                        if(options.ga.disableAdvertisingFeatures) {
                            config_for_tag.allow_google_signals = false
                        }
                        if(options.ga.disableAdvertisingPersonalization) {
                            config_for_tag.allow_ad_personalization_signals = false
                        }
                    }
                    if(options.ga.hasOwnProperty('additionalConfig')){
                        if(options.ga.additionalConfig.hasOwnProperty(trackingId) && options.ga.additionalConfig[trackingId]){
                            config_for_tag.first_party_collection = options.ga.additionalConfig[trackingId].first_party_collection;
                        }

                    }
                    if(options.ga.hasOwnProperty('serverContainerUrls')){
                        if(options.ga.serverContainerUrls.hasOwnProperty(trackingId) && options.ga.serverContainerUrls[trackingId].enable_server_container != false){
                            if(options.ga.serverContainerUrls[trackingId].server_container_url != ''){
                                config_for_tag.server_container_url = options.ga.serverContainerUrls[trackingId].server_container_url;
                            }
                            if(options.ga.serverContainerUrls[trackingId].transport_url != ''){
                                config_for_tag.transport_url = options.ga.serverContainerUrls[trackingId].transport_url;
                            }
                        }
                    }
                    if (options.gdpr.cookiebot_integration_enabled && typeof Cookiebot !== 'undefined') {

                        var cookiebot_consent_category = options.gdpr['cookiebot_analytics_consent_category'];
                        if (options.gdpr['analytics_prior_consent_enabled']) {
                            if (Cookiebot.consented === true && Cookiebot.consent[cookiebot_consent_category]) {
                                Utils.gtagPush('config', trackingId, config_for_tag);
                            }
                        } else {
                            if (Cookiebot.consent[cookiebot_consent_category]) {
                                Utils.gtagPush('config', trackingId, config_for_tag);
                            }
                        }
                    }
                    else
                    {
                        Utils.gtagPush('config', trackingId, config_for_tag);
                    }
                });

                initialized = true;

                Utils.fireStaticEvents('ga');

            },

            fireEvent: function (name, data) {

                if (!initialized || !this.isEnabled()) {
                    return false;
                }

                data.delay = data.delay || 0;
                data.params = data.params || {};
                data.params.eventID = Utils.generateUniqueId(data);
                if (data.delay === 0) {

                    fireEvent(name, data.params);

                } else {

                    setTimeout(function (name, params) {
                        fireEvent(name, params);
                    }, data.delay * 1000, name, data.params);

                }

                return true;

            },

            onCommentEvent: function (event) {
                this.fireEvent(event.name, event);
            },

            onDownloadEvent: function (event) {
                this.fireEvent(event.name, event);
            },

            onFormEvent: function (event) {
                this.fireEvent(event.name, event);
            },

            onWooAddToCartOnButtonEvent: function (product_id) {

                if(!options.dynamicEvents.woo_add_to_cart_on_button_click.hasOwnProperty(this.tag()))
                    return;
                var event = Utils.clone(options.dynamicEvents.woo_add_to_cart_on_button_click[this.tag()]);

                if (window.pysWooProductData.hasOwnProperty(product_id)) {
                    if (window.pysWooProductData[product_id].hasOwnProperty('ga')) {
                        Utils.copyProperties(window.pysWooProductData[product_id]['ga'].params, event.params)
                        this.fireEvent(event.name, event);
                    }
                }


            },

            onWooAddToCartOnSingleEvent: function (product_id, qty, product_type, $form) {

                window.pysWooProductData = window.pysWooProductData || {};

                if(!options.dynamicEvents.woo_add_to_cart_on_button_click.hasOwnProperty(this.tag()))
                    return;
                var event = Utils.clone(options.dynamicEvents.woo_add_to_cart_on_button_click[this.tag()]);

                if (product_type === Utils.PRODUCT_VARIABLE && !options.ga.wooVariableAsSimple) {
                    product_id = parseInt($form.find('input[name="variation_id"]').val());
                }

                if (window.pysWooProductData.hasOwnProperty(product_id)) {
                    if (window.pysWooProductData[product_id].hasOwnProperty('ga')) {

                        Utils.copyProperties(window.pysWooProductData[product_id]['ga'].params, event.params);
                        if(product_type === Utils.PRODUCT_GROUPED ) {
                            var groupValue = 0;
                            $form.find(".woocommerce-grouped-product-list .qty").each(function(index){
                                var childId = $(this).attr('name').replaceAll("quantity[","").replaceAll("]","");
                                var quantity = parseInt($(this).val());
                                if(isNaN(quantity)) {
                                    quantity = 0;
                                }
                                var childItem = window.pysWooProductData[product_id]['ga'].grouped[childId];
                                // update quantity
                                event.params.items.forEach(function(el,index,array) {
                                    if(el.id == childItem.content_id) {
                                        if(quantity > 0){
                                            el.quantity = quantity;
                                        } else {
                                            array.splice(index, 1);
                                        }
                                    }
                                });
                                groupValue += childItem.price * quantity;
                            });
                            if(options.woo.addToCartOnButtonValueEnabled &&
                                options.woo.addToCartOnButtonValueOption !== 'global' &&
                                event.params.hasOwnProperty('ecomm_totalvalue')) {
                                event.params.ecomm_totalvalue = groupValue;
                            }

                            if(groupValue == 0) return; // skip if no items selected
                        } else {
                            // update items qty param
                            event.params.items[0].quantity = qty;
                        }

                        // maybe customize value option
                        if (options.woo.addToCartOnButtonValueEnabled &&
                            options.woo.addToCartOnButtonValueOption !== 'global' &&
                            product_type !== Utils.PRODUCT_GROUPED)
                        {
                            if(event.params.hasOwnProperty('ecomm_totalvalue')) {
                                event.params.ecomm_totalvalue = event.params.items[0].price * qty;
                            }

                        }


                        this.fireEvent(event.name, event);
                    }
                }

            },

            onWooRemoveFromCartEvent: function (event) {

                this.fireEvent(event.name, event);

            },

            onEddAddToCartOnButtonEvent: function (download_id, price_index, qty) {

                if(!options.dynamicEvents.edd_add_to_cart_on_button_click.hasOwnProperty(this.tag()))
                    return;
                var event = Utils.clone(options.dynamicEvents.edd_add_to_cart_on_button_click[this.tag()]);


                if (window.pysEddProductData && window.pysEddProductData.hasOwnProperty(download_id)) {

                    var index;

                    if (price_index) {
                        index = download_id + '_' + price_index;
                    } else {
                        index = download_id;
                    }

                    if (window.pysEddProductData[download_id].hasOwnProperty(index)) {
                        if (window.pysEddProductData[download_id][index].hasOwnProperty('ga')) {

                            Utils.copyProperties(window.pysEddProductData[download_id][index]['ga'].params, event.params);

                            // update items qty param
                            event.params.items[0].quantity = qty;

                            this.fireEvent(event.name,event);

                        }
                    }

                }

            },

            onEddRemoveFromCartEvent: function (event) {
                this.fireEvent(event.name, event);
            },
            onPageScroll: function (event) {
                this.fireEvent(event.name, event);
            },
            onTime: function (event) {
                this.fireEvent(event.name, event);
            },

        };

    }(options);

    var GTM = function (options) {
        var initialized = false;

        var datalayer_name = 'dataLayer';
        /*
         * @param name
         * @param data
         */
        function fireEvent(name, event) {
            if(typeof window.pys_disable_event_filter === "function" && window.pys_disable_event_filter(name,'gtm')) {
                return;
            }


            var eventParams = event.params;
            var data = event.params;
            var valuesArray = Object.values(event.trackingIds);
            var ids = valuesArray;
            Utils.copyProperties(Utils.getRequestParams(), eventParams);
            var _fireEvent = function (tracking_id,name,params, event=null) {
                var eventData = {};
                var ContainerCodeHasTag = !options.gtm.gtm_just_data_layer && tracking_id.length > 0;
                if(ContainerCodeHasTag) {
                    params['send_to'] = tracking_id;
                }
                else if(!options.gtm.gtm_just_data_layer){
                    return
                }

                if (params.hasOwnProperty('ecommerce')) {
                    eventData.ecommerce = params.ecommerce;
                    delete params.ecommerce;
                }

                var automatedParams = { ...params };
                [params['manualName'], 'manualName', 'triggerType'].forEach(key => delete automatedParams[key]);
                if(event && (!event.hasOwnProperty('hasAutoParam') || (event.hasOwnProperty('hasAutoParam') && event.hasAutoParam))) {
                    eventData.automatedParameters = automatedParams;
                }

// Move custom parameters to eventData

                if (params.hasOwnProperty(params['manualName'])) {
                    eventData[params['manualName']] = params[params['manualName']];
                    delete params[params['manualName']];
                }

                ['manualName','triggerType'].forEach(key => {
                    if (params.hasOwnProperty(key)) {
                        eventData[key] = params[key];
                        delete params[key];
                    }
                });

                eventData.manualDataLayer = Utils.resolveGtmDataLayerName();

                eventData.event = name;

                if (options.debug) {
                    if (ContainerCodeHasTag){
                        console.log('[Google GTM #' + tracking_id + '] ' + name, eventData);
                    }
                    else {
                        console.log('[Google GTM push to "'+datalayer_name+'"] ' + name, eventData);
                    }
                }
                window[datalayer_name].push(eventData);

            };

            var copyParams = Utils.copyProperties(eventParams, {}); // copy params because mapParamsToGTM can modify it

            var params = mapParamsToGTM(ids,name,copyParams)

            params.event_id = Utils.generateUniqueId(event);

            _fireEvent(ids, name, params, event);
        }

        function normalizeEventName(eventName) {

            var matches = {
                ViewContent: 'view_item',
                AddToCart: 'add_to_cart',
                AddToWishList: 'add_to_wishlist',
                InitiateCheckout: 'begin_checkout',
                Purchase: 'purchase',
                Lead: 'generate_lead',
                CompleteRegistration: 'sign_up',
                AddPaymentInfo: 'set_checkout_option'
            };

            return matches.hasOwnProperty(eventName) ? matches[eventName] : eventName;

        }

        function mapParamsToGTM(tag,name,param) {
            //GA4 automatically collects a number of parameters for all events
            var hasGTM = false;

            // end
            if (Array.isArray(tag)) {
                hasGTM = tag.some(function (element) {
                    return isGTM(element);
                });
            } else if(isGTM(tag)) {
                // tag is a string and matches GTM
                hasGTM = true;
            }
            if(hasGTM) {
                delete param.event_category;
                delete param.event_label;

                delete param.analytics_storage;
                delete param.ad_storage;
                delete param.ad_user_data;
                delete param.ad_personalization;

                if(name === 'search') {
                    param['search'] = param.search_term;
                    delete param.search_term;
                    delete param.dynx_itemid;
                    delete param.dynx_pagetype;
                    delete param.dynx_totalvalue;
                }
            }
            return param;
        }

        function isGTM(tag) {
            return tag.indexOf('GTM') === 0;
        }
        /**
         * Public API
         */
        return {
            tag: function() {
                return "gtm";
            },
            isEnabled: function () {
                return options.hasOwnProperty('gtm');
            },
            disable: function () {
                initialized = false;
            },
            updateEnhancedConversionData : function () {
                if (!initialized || !this.isEnabled()) {
                    return;
                }
                if(options.hasOwnProperty("tracking_analytics") && options.tracking_analytics.hasOwnProperty("userDataEnable") && options.tracking_analytics.userDataEnable) {
                    var advanced = Utils.getAdvancedFormData();
                    if (Object.keys(advanced).length > 0) {
                        window[datalayer_name].push({'user_data' : advanced});
                    }
                }
            },
            loadPixel: function () {

                if (initialized || !this.isEnabled() || !Utils.consentGiven('analytics')) {
                    return;
                }
                datalayer_name = Utils.resolveGtmDataLayerName();

                for (var i = 0; i < options.gtm.trackingIds.length; i++) {
                    var trackingId = options.gtm.trackingIds[i];
                    if (!options.gtm.gtm_just_data_layer) {
                        console.log('[PYS] Google Tag Manager container code loaded');
                        Utils.loadGTMScript(trackingId);
                        break;
                    }
                }
                if(options.gtm.gtm_just_data_layer) {
                    console.warn && console.warn("[PYS] Google Tag Manager container code placement set to OFF !!!");
                    console.warn && console.warn("[PYS] Data layer codes are active but GTM container must be loaded using custom coding !!!");
                    // Send the consent state even when GTM script loading is handled
                    // externally: gtm_just_data_layer with tracking IDs configured skips
                    // loadGTMScript() entirely. When trackingIds is empty, loadGTMScript()
                    // below runs too and would reach this again — pushGTMConsentState()
                    // is idempotent per page load, so the container still sees one command.
                    Utils.pushGTMConsentState( datalayer_name );
                    if(options.gtm.trackingIds.length == 0){
                        Utils.loadGTMScript();
                    }
                }

                if(options.hasOwnProperty("tracking_analytics") && options.tracking_analytics.hasOwnProperty("userDataEnable") && options.tracking_analytics.userDataEnable){
                    var advanced = Utils.getAdvancedFormData();
                    if(Object.keys(advanced).length > 0){
                        window[datalayer_name].push({'user_data' : advanced});
                    }
                }


                var config = {};

                if(options.user_id && options.user_id != 0) {
                    config.user_id = options.user_id;
                }

                // Cross-Domain tracking

                var ids = options.gtm.trackingIds;


                initialized = true;

                Utils.fireStaticEvents('gtm');
            },

            fireEvent: function (name, data) {

                if (!initialized || !this.isEnabled()) {
                    return false;
                }

                data.delay = data.delay || 0;
                data.params = data.params || {};

                if (data.delay === 0) {

                    fireEvent(name, data);

                } else {

                    setTimeout(function (name, params) {
                        fireEvent(name, params);
                    }, data.delay * 1000, name, data);

                }

                return true;

            },

            onCommentEvent: function (event) {
                this.fireEvent(event.name, event);
            },

            onDownloadEvent: function (event) {
                this.fireEvent(event.name, event);
            },

            onFormEvent: function (event) {
                this.fireEvent(event.name, event);
            },

            onWooAddToCartOnButtonEvent: function (product_id, prod_info = null) {
                if(!options.dynamicEvents.woo_add_to_cart_on_button_click.hasOwnProperty(this.tag()))
                    return;
                var event = Utils.clone(options.dynamicEvents.woo_add_to_cart_on_button_click[this.tag()]);

                if (window.pysWooProductData.hasOwnProperty(product_id)) {
                    if (window.pysWooProductData[product_id].hasOwnProperty('gtm')) {
                        Utils.copyProperties(window.pysWooProductData[product_id]['gtm'].params, event.params)
                        this.fireEvent(event.name, event);
                    }
                }

            },

            onWooAddToCartOnSingleEvent: function (product_id, qty, product_type, $form) {
                window.pysWooProductData = window.pysWooProductData || {};

                if(!options.dynamicEvents.woo_add_to_cart_on_button_click.hasOwnProperty(this.tag()))
                    return;
                var event = Utils.clone(options.dynamicEvents.woo_add_to_cart_on_button_click[this.tag()]);

                if (product_type === Utils.PRODUCT_VARIABLE && !options.gtm.wooVariableAsSimple) {
                    product_id = parseInt($form.find('input[name="variation_id"]').val());
                }

                if (window.pysWooProductData.hasOwnProperty(product_id)) {
                    if (window.pysWooProductData[product_id].hasOwnProperty('gtm')) {

                        Utils.copyProperties(window.pysWooProductData[product_id]['gtm'].params, event.params);

                        params = event.params.hasOwnProperty('ecommerce') ? event.params.ecommerce : event.params;

                        if(product_type === Utils.PRODUCT_GROUPED ) {
                            var groupValue = 0;
                            $form.find(".woocommerce-grouped-product-list .qty").each(function(index){
                                var childId = $(this).attr('name').replaceAll("quantity[","").replaceAll("]","");
                                var quantity = parseInt($(this).val());
                                if(isNaN(quantity)) {
                                    quantity = 0;
                                }
                                var childItem = window.pysWooProductData[product_id]['gtm'].grouped[childId];
                                params.items.forEach(function(el,index,array) {
                                    if(el.id == childItem.content_id) {
                                        if(quantity > 0){
                                            el.quantity = quantity;
                                            el.price = childItem.price;
                                        } else {
                                            array.splice(index, 1);
                                        }
                                    }
                                });
                                groupValue += childItem.price * quantity;
                            });

                            if(options.woo.addToCartOnButtonValueEnabled &&
                                options.woo.addToCartOnButtonValueOption !== 'global' &&
                                params.hasOwnProperty('value')) {
                                params.value = groupValue;
                            }

                            if(groupValue == 0) return; // skip if no items selected
                        } else {
                            // update items qty param
                            params.items[0].quantity = qty;
                        }

                        // maybe customize value option
                        if (options.woo.addToCartOnButtonValueEnabled &&
                            options.woo.addToCartOnButtonValueOption !== 'global' &&
                            product_type !== Utils.PRODUCT_GROUPED)
                        {
                            if(params.hasOwnProperty('value')) {
                                params.value = params.items[0].price * qty;
                            }

                        }


                        this.fireEvent(event.name, event);
                    }
                }

            },

            onWooRemoveFromCartEvent: function (event) {

                this.fireEvent(event.name, event);

            },

            onEddAddToCartOnButtonEvent: function (download_id, price_index, qty) {
                if(!options.dynamicEvents.edd_add_to_cart_on_button_click.hasOwnProperty(this.tag()))
                    return;
                var event = Utils.clone(options.dynamicEvents.edd_add_to_cart_on_button_click[this.tag()]);


                if (window.pysEddProductData && window.pysEddProductData.hasOwnProperty(download_id)) {

                    var index;

                    if (price_index) {
                        index = download_id + '_' + price_index;
                    } else {
                        index = download_id;
                    }

                    if (window.pysEddProductData[download_id].hasOwnProperty(index)) {
                        if (window.pysEddProductData[download_id][index].hasOwnProperty('gtm')) {

                            Utils.copyProperties(window.pysEddProductData[download_id][index]['gtm'].params, event.params);
                            item = event.params.hasOwnProperty('ecommerce') ? event.params.ecommerce.items[0] : event.params.items[0];
                            // update items qty param
                            item.quantity = qty;

                            this.fireEvent(event.name,event);

                        }
                    }

                }

            },

            onEddRemoveFromCartEvent: function (event) {
                this.fireEvent(event.name, event);
            },
            onPageScroll: function (event) {
                this.fireEvent(event.name, event);
            },
            onTime: function (event) {
                this.fireEvent(event.name, event);
            },
        };

    }(options);


    var OpenAI = function (options) {

        let initialized = false,
            sentIdentity = null,
            identityWaitTimer = null,
            identityWaitExpired = false;

        /**
         * Send the server copy of an event.
         *
         */
        function sendOpenAIServerEvent(name, allData, data, eventId) {

            if (!options.hasOwnProperty('openai') || !options.openai.serverApiEnabled) {
                return;
            }

            let isApiDisabled = options.gdpr.all_disabled_by_api ||
                options.gdpr.openai_disabled_by_api ||
                options.gdpr.cookiebot_integration_enabled ||
                options.gdpr.consent_magic_integration_enabled ||
                options.gdpr.cookie_notice_integration_enabled ||
                options.gdpr.cookie_law_info_integration_enabled;

            if (!(options.ajaxForServerEvent || isApiDisabled)) {
                return;
            }

            let isStatic = allData.type === 'static' || allData.type === undefined,
                delay = allData.delay || 0;

            // PHP never collects a dynamic event, and it collects only delay == 0.
            let phpSkipped = !isStatic || delay > 0;

            // A static event is PHP's, unless the site is set to send static
            // events over AJAX — which is exactly when PHP steps aside.
            if (!phpSkipped
                && !options.ajaxForServerStaticEvent
                && !(allData.hasOwnProperty('ajaxFire') && allData.ajaxFire)) {
                return;
            }

            let params = {data: data};

            if (allData.params && allData.params.custom_event_name) {
                params.custom_event_name = allData.params.custom_event_name;
            }

            let json = {
                action: 'pys_openai_api_event',
                pixel: 'openai',
                event: name,
                event_slug: allData.e_id || '',
                ids: allData.pixelIds || options.openai.pixelIds,
                data: params,
                url: window.location.href,
                eventID: eventId,
                ajax_event: options.ajax_event
            };

            if (allData.hasOwnProperty('woo_order')) {
                json['woo_order'] = allData.woo_order;
            }

            if (allData.hasOwnProperty('edd_order')) {
                json['edd_order'] = allData.edd_order;
            }

            if (allData.hasOwnProperty('order_key') && allData.order_key) {
                json['order_key'] = allData.order_key;
            }

            let wait = name === 'page_viewed' ? 500 : 0;

            setTimeout(function () {
                Utils.sendServerAjaxRequest(options.ajaxUrl, json);
            }, wait);
        }

        /**
         * Is the pixel in OpenAI's restricted mode?
         *
         */
        function optOutMode() {

            if ( options.openai && options.openai.opt_out ) {
                return true;
            }

            return !! ( options.gdpr
                && options.gdpr.consent_magic_integration_enabled
                && typeof CS_Data !== 'undefined'
                && Utils.csModeEnabled( CS_Data.cs_openai_opt_out_mode ) );
        }

        const SDK_DATA_FIELDS = {
            contents: ['type', 'amount', 'currency', 'contents'],
            custom: ['type', 'plan_id', 'amount', 'currency', 'contents'],
            customer_action: ['type', 'amount', 'currency'],
            plan_enrollment: ['type', 'plan_id', 'amount', 'currency', 'contents']
        };

        const SDK_ITEM_FIELDS = ['id', 'name', 'content_type', 'quantity', 'amount', 'currency'];

        function sdkInteger(value) {
            let number = typeof value === 'string' ? Number(value.trim()) : value;

            return typeof number === 'number' && isFinite(number) ? Math.round(number) : null;
        }

        function sdkCurrency(value) {
            return typeof value === 'string' && /^[A-Za-z]{3}$/.test(value) ? value : null;
        }

        function sdkText(value) {
            if (typeof value === 'string') {
                return value === '' ? null : value;
            }

            return typeof value === 'number' && isFinite(value) ? String(value) : null;
        }

        /**
         * One contents[] item, with only the keys the SDK documents.
         *
         * @param item              the item as configured or collected
         * @param eventHasCurrency  true when data.currency is set: an item amount
         *                          needs a currency, its own or the event's
         */
        function sdkSafeItem(item, eventHasCurrency) {

            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                return null;
            }

            let safe = {};

            SDK_ITEM_FIELDS.forEach(function (field) {
                if (item[field] === undefined || item[field] === null || item[field] === '') {
                    return;
                }

                if (field === 'quantity' || field === 'amount') {
                    let number = sdkInteger(item[field]);

                    if (number !== null) {
                        safe[field] = number;
                    }

                    return;
                }

                if (field === 'currency') {
                    let currency = sdkCurrency(item.currency);

                    if (currency !== null) {
                        safe.currency = currency;
                    }

                    return;
                }

                let text = sdkText(item[field]);

                if (text !== null) {
                    safe[field] = text;
                }
            });

            if (safe.hasOwnProperty('amount') && !safe.hasOwnProperty('currency') && !eventHasCurrency) {
                delete safe.amount;
            }

            return Object.keys(safe).length ? safe : null;
        }

        /**
         * The event data, with only the fields the SDK documents for its shape.
         */
        function sdkSafeData(data) {

            if (!data || typeof data !== 'object') {
                return {};
            }

            let allowed = SDK_DATA_FIELDS[data.type];

            if (!allowed) {
                // An undocumented shape is the module's own bug, not the
                // payload's: hand it over untouched rather than empty it.
                return data;
            }

            let safe = {};

            allowed.forEach(function (field) {
                if (data[field] !== undefined && data[field] !== null && data[field] !== '') {
                    safe[field] = data[field];
                }
            });

            if (safe.hasOwnProperty('plan_id')) {
                let planId = sdkText(safe.plan_id);

                if (planId === null) {
                    delete safe.plan_id;
                } else {
                    safe.plan_id = planId;
                }
            }

            if (safe.hasOwnProperty('currency')) {
                let currency = sdkCurrency(safe.currency);

                if (currency === null) {
                    delete safe.currency;
                } else {
                    safe.currency = currency;
                }
            }

            if (safe.hasOwnProperty('amount')) {
                let amount = sdkInteger(safe.amount);

                // The SDK refuses an amount with no currency beside it.
                if (amount === null || !safe.hasOwnProperty('currency')) {
                    delete safe.amount;
                } else {
                    safe.amount = amount;
                }
            }

            if (safe.hasOwnProperty('contents')) {
                let items = Array.isArray(safe.contents)
                    ? safe.contents
                        .map(function (item) { return sdkSafeItem(item, safe.hasOwnProperty('currency')); })
                        .filter(function (item) { return item !== null; })
                    : [];

                if (items.length) {
                    safe.contents = items;
                } else {
                    delete safe.contents;
                }
            }

            return safe;
        }

        function fireEvent(name, allData) {

            if (typeof window.pys_disable_event_filter === "function" && window.pys_disable_event_filter(name, 'openai')) {
                return;
            }

            if (typeof window.oaiq !== 'function') {
                return;
            }

            let ids = (allData && allData.pixelIds && allData.pixelIds.length)
                ? allData.pixelIds
                : options.openai.pixelIds;

            if (!ids || ids.length === 0) {
                return;
            }

            let data = (allData.params && allData.params.data) ? Utils.clone(allData.params.data) : {};

            let eventOptions = {},
                eventId = Utils.generateUniqueId(allData);

            if (eventId) {
                eventOptions.event_id = eventId;
            }

            if (allData.params && allData.params.custom_event_name) {
                eventOptions.custom_event_name = allData.params.custom_event_name;
            }

            sendOpenAIServerEvent(name, allData, data, eventId);

            let browserData = sdkSafeData(data);

            if (optOutMode()) {
                eventOptions.opt_out = true;
            }

	        if (options.debug) {
                console.log('[OpenAI] ' + name, browserData, eventOptions, 'pixel_ids', ids);
            }

            ids.forEach(function (pixelId) {
                oaiq('measureSingle', pixelId, name, browserData, eventOptions);
            });

            let customEvent = new CustomEvent('openai_event_sent', {
                detail: {
                    eventName: name,
                    data: data,
                    options: eventOptions,
                    pixel_ids: ids
                }
            });
            window.dispatchEvent(customEvent);
        }

        /**
         * True while the visitor's identity is still in flight.
         */
        function identityPending() {
            return ! identityWaitExpired
                && ! options.dynamicDataApplied
                && !! options.dynamicDataUrl;
        }

        const OPENAI_USER_FIELDS = [
            'email_sha256',
            'phone_number_sha256',
            'external_id_sha256',
            'first_name_sha256',
            'last_name_sha256',
            'country',
            'city',
            'region',
            'postal_code'
        ];

        /**
         * OpenAI normalises more aggressively than the other pixels: the phone
         * is reduced to its national digit form (leading +, 00 and zeros
         * stripped, then length-validated), and names lose every punctuation
         * and whitespace character. Mirrors pys_openai_normalize_* in
         * modules/openai/function-helpers.php.
         */
        function openaiCookieIdentity() {

            let raw;

            try {
                raw = Utils.getAdvancedFormData() || {};
            } catch (e) {
                raw = {};
            }

            let phone = typeof raw.phone === 'string'
                ? raw.phone.trim().replace(/[\s().-]+/g, '')
                : '';

            if (!/^\+?[0-9]+$/.test(phone) || phone.indexOf('+0') === 0) {
                phone = '';
            } else {
                let international = phone.indexOf('+') === 0 || phone.indexOf('00') === 0;
                let national = phone.replace(/^\+?0*/, '');

                if (international && national.indexOf('1') === 0 && national.length !== 11) {
                    national = '';
                }

                phone = /^[1-9][0-9]{7,14}$/.test(national) ? national : '';
            }

            let normalizeName = function (value) {
                if (typeof value !== 'string' || value.length > 1024) {
                    return '';
                }
                let stripped = value.replace(/[!-\/:-@\[-`{-~\s]+/g, '').toLowerCase();
                return /\D/u.test(stripped) ? stripped : '';
            };

            return {
                email: Utils.AdvancedMatching.normalizeEmail(raw.email || ''),
                phone: phone,
                first_name: normalizeName(raw.first_name || ''),
                last_name: normalizeName(raw.last_name || '')
            };
        }

        /**
         * The identity to hand the SDK, built from whatever is known right now.
         */
        function buildAdvancedMatchingUser() {

            let user = {};

            if (options.openai.hasOwnProperty('advanced_matching')) {

                let matching = options.openai.advanced_matching;

                OPENAI_USER_FIELDS.forEach(function (field) {
                    let value = matching[field];

                    if (typeof value === 'string' && value.length > 0) {
                        user[field] = value;
                    }
                });
            }

            Utils.AdvancedMatching.merge(user, {
                email_sha256:        { field: 'email',      hash: true },
                phone_number_sha256: { field: 'phone',      hash: true },
                first_name_sha256:   { field: 'first_name', hash: true },
                last_name_sha256:    { field: 'last_name',  hash: true }
            }, openaiCookieIdentity());

            let externalIdAllowed = options.send_external_id
                && ! ( options.gdpr && options.gdpr.externalID_disabled_by_api )
                && ! ( options.cookie
                    && ( options.cookie.disabled_all_cookie
                        || options.cookie.externalID_disabled_by_api ) );

            if (!user.hasOwnProperty('external_id_sha256')
                && externalIdAllowed
                && typeof sha256 === 'function'
                && Cookies.get('pbid')) {
                user.external_id_sha256 = sha256(Cookies.get('pbid'));
            }

            return user;
        }

        /**
         * Public API
         */
        return {
            tag: function () {
                return "openai";
            },
            isEnabled: function () {
                return options.hasOwnProperty('openai');
            },
            disable: function () {
                initialized = false;

                if (typeof window.oaiq === 'function') {
                    oaiq('consent', false);
                }
            },

            loadPixel: function () {

                if (initialized || !this.isEnabled() || !Utils.consentGiven('openai')) {
                    return;
                }

                let ids = options.openai.pixelIds;

                if (!ids || ids.length === 0) {
                    return;
                }

                if (identityPending()) {

                    if (identityWaitTimer === null) {
                        identityWaitTimer = setTimeout(function () {
                            identityWaitExpired = true;

                            if (window.pys && window.pys.OpenAI) {
                                window.pys.OpenAI.loadPixel();
                            }
                        }, 3000);
                    }

                    return;
                }

                if (identityWaitTimer !== null) {
                    clearTimeout(identityWaitTimer);
                    identityWaitTimer = null;
                }

                !function (w, d, s, u) {
                    if (w.oaiq) return;
                    var q = function () {
                        q.q.push(arguments);
                    };
                    q.q = [];
                    w.oaiq = q;
                    var js = d.createElement(s);
                    js.async = true;
                    js.src = u;
                    var f = d.getElementsByTagName(s)[0];
                    f.parentNode.insertBefore(js, f);
                }(window, document, 'script', '../bzrcdn.openai.com/sdk/oaiq.min.js');

                let user = buildAdvancedMatchingUser();

                if (Object.keys(user).length > 0) {
                    sentIdentity = JSON.stringify(user);
                }

                ids.forEach(function (pixelId) {
                    let initOptions = {
                        pixelId: pixelId
                    };

                    if (options.openai.debug) {
                        initOptions.debug = true;
                    }

                    if (Object.keys(user).length > 0) {
                        initOptions.user = user;
                    }

                    oaiq('init', initOptions);
                });

                oaiq('consent', true);

                initialized = true;

                Utils.fireStaticEvents('openai');
            },

            /**
             * Hand the SDK an identity that arrived after the pixel was already initialised.
             */
            refreshAdvancedMatching: function () {

                if (!initialized || !this.isEnabled() || typeof window.oaiq !== 'function') {
                    return;
                }

                let user = buildAdvancedMatchingUser();

                if (Object.keys(user).length === 0) {
                    return;
                }

                let identity = JSON.stringify(user);

                if (identity === sentIdentity) {
                    return;
                }

                sentIdentity = identity;

                let ids = options.openai.pixelIds || [];

                ids.forEach(function (pixelId) {
                    oaiq('init', {pixelId: pixelId, user: user});
                });
            },

            fireEvent: function (name, data) {

                if (!initialized || !this.isEnabled()) {
                    return false;
                }

                fireEvent(name, data);

                return true;
            },

            /**
             * Add to cart from a listing button. The event is registered once with
             * a placeholder payload; the real one is substituted here from the
             * per-product data the server printed.
             */
            onWooAddToCartOnButtonEvent: function (product_id) {

                if (!options.dynamicEvents.woo_add_to_cart_on_button_click.hasOwnProperty(this.tag())) {
                    return;
                }
                if (!window.pysWooProductData || !window.pysWooProductData.hasOwnProperty(product_id)) {
                    return;
                }
                if (!window.pysWooProductData[product_id].hasOwnProperty(this.tag())) {
                    return;
                }

                let productData = window.pysWooProductData[product_id][this.tag()];
                let event = Utils.clone(options.dynamicEvents.woo_add_to_cart_on_button_click[this.tag()]);

                Utils.copyProperties(productData['params'], event.params);

                if (productData.hasOwnProperty('pixelIds')) {
                    event.pixelIds = productData['pixelIds'];
                }

                this.fireEvent(event.name, event);
            },

            /**
             * Add to cart from a single product page, where the visitor picks the
             * quantity.
             */
            onWooAddToCartOnSingleEvent: function (product_id, qty, product_type, is_external, $form) {

                if (!options.dynamicEvents.woo_add_to_cart_on_button_click.hasOwnProperty(this.tag())) {
                    return;
                }
                // The click handler passes the parent id from input[name="add-to-cart"];
                // the selected variation lives in its own hidden input. Without this swap
                // OpenAI reported the parent while facebook, ga and gtm all reported the
                // variation, even though wooVariableAsSimple was off.
                if (product_type === Utils.PRODUCT_VARIABLE && !options.openai.wooVariableAsSimple) {
                    product_id = parseInt($form.find('input[name="variation_id"]').val());
                }
                if (!window.pysWooProductData || !window.pysWooProductData.hasOwnProperty(product_id)) {
                    return;
                }
                if (!window.pysWooProductData[product_id].hasOwnProperty(this.tag())) {
                    return;
                }

                let event = Utils.clone(options.dynamicEvents.woo_add_to_cart_on_button_click[this.tag()]);

                Utils.copyProperties(window.pysWooProductData[product_id][this.tag()]['params'], event.params);

                if (qty && event.params && event.params.data && Array.isArray(event.params.data.contents)) {
                    event.params.data.contents.forEach(function (item) {
                        item.quantity = qty;
                    });
                }

                this.fireEvent(event.name, event);
            },

            /**
             * Add to cart from an EDD button. Downloads with price variations are
             * keyed as "<download_id>_<price_index>".
             */
            onEddAddToCartOnButtonEvent: function (download_id, price_index, qty) {

                if (!options.dynamicEvents.edd_add_to_cart_on_button_click.hasOwnProperty(this.tag())) {
                    return;
                }
                if (!window.pysEddProductData || !window.pysEddProductData.hasOwnProperty(download_id)) {
                    return;
                }

                let index = price_index ? download_id + '_' + price_index : download_id;

                if (!window.pysEddProductData[download_id].hasOwnProperty(index)) {
                    return;
                }
                if (!window.pysEddProductData[download_id][index].hasOwnProperty(this.tag())) {
                    return;
                }

                let event = Utils.clone(options.dynamicEvents.edd_add_to_cart_on_button_click[this.tag()]);

                Utils.copyProperties(window.pysEddProductData[download_id][index][this.tag()].params, event.params);

                if (qty && event.params && event.params.data && Array.isArray(event.params.data.contents)) {
                    event.params.data.contents.forEach(function (item) {
                        item.quantity = qty;
                    });
                }

                this.fireEvent(event.name, event);
            },
        };

    }(options);

    var getPixelBySlag = function getPixelBySlag(slug) {
        switch (slug) {
            case "facebook": return window.pys.Facebook;
            case "ga": return window.pys.Analytics;
            case "gtm": return window.pys.GTM;
            case "bing": return window.pys.Bing;
            case "pinterest": return window.pys.Pinterest;
	        case "reddit": return window.pys.Reddit;
	        case "openai": return window.pys.OpenAI;
        }
    }

    window.pys = window.pys || {};
    window.pys.Facebook = Facebook;
    window.pys.Analytics = Analytics;
    window.pys.GTM = GTM;
    window.pys.OpenAI = OpenAI;
    window.pys.Utils = Utils;
    window.pys.getPixelBySlag = getPixelBySlag;

    // Allow external scripts (e.g. generatePixelCode fragments) to refresh
    // the uniqueId cache for a given event key, so that each new add_to_cart
    // action gets a fresh shared ID across all pixels.
    window.pys.setEventUniqueId = function(idKey, newId) {
        uniqueId[idKey] = newId;
    };

    // Export getPixelBySlag globally for backward compatibility
    window.getPixelBySlag = getPixelBySlag;


    function pysNormalInit() {

        if($("#pys_late_event").length > 0) {
            var dirAttr = $("#pys_late_event").attr("dir");
            if (dirAttr) {
                try {
                    var events = JSON.parse(dirAttr);
                } catch (e) {
                    console.warn("Invalid JSON in pys_late_event dir attribute:", e);
                }
            } else {
                console.warn("pys_late_event dir attribute is undefined or empty");
            }
            if (events) {
                for (var key in events) {
                    var event = {};
                    event[events[key].e_id] = [events[key]];
                    if (options.staticEvents.hasOwnProperty(key)) {
                        Object.assign(options.staticEvents[key], event);
                    } else {
                        options.staticEvents[key] = event;
                    }
                }
            }
        }

        var Pinterest = Utils.setupPinterestObject();
        var Bing = Utils.setupBingObject();
	    var Reddit = Utils.setupRedditObject();

        if(options.hasOwnProperty('cookie'))
        {
            if(options.cookie.externalID_disabled_by_api || options.cookie.disabled_all_cookie)
            {
                Cookies.remove('pbid', { path: '/',domain: cookieDomain() })
            }
            if(options.cookie.disabled_advanced_form_data_cookie || options.cookie.disabled_all_cookie)
            {
                // Removed twice on purpose: PHP writes this cookie host-only
                // until pys_cd is reported (or permanently, on a site whose
                // front end never reaches manageCookies()), while this script
                // writes/deletes it at cookieDomain(). A host-only cookie and
                // a domain-scoped one of the same name are separate jar
                // entries, and a delete only matches the scope it names — so
                // both scopes are cleared rather than guessed at.
                // `domain: ''` is deliberate: js-cookie 2.1.3 treats a falsy
                // Domain as "omit the attribute" (host-only delete), so it's
                // written explicitly rather than left off.
                // In Free this matters more than in Pro: there is no JS
                // writer for this cookie at all, so PHP is its only writer
                // and the host-only copy is the only copy a pending site
                // ever has.
                Cookies.remove('pys_advanced_form_data', { path: '/',domain: cookieDomain() })
                Cookies.remove('pys_advanced_form_data', { path: '/',domain: '' })
            }
            if(options.cookie.disabled_landing_page_cookie || options.cookie.disabled_all_cookie)
            {
                Cookies.remove('pys_landing_page', { path: '/',domain: cookieDomain() })
                Cookies.remove('last_pys_landing_page', { path: '/',domain: cookieDomain() })
            }
            if(options.cookie.disabled_trafficsource_cookie || options.cookie.disabled_all_cookie)
            {
                Cookies.remove('pysTrafficSource', { path: '/',domain: cookieDomain() })
                Cookies.remove('last_pysTrafficSource', { path: '/',domain: cookieDomain() })
            }
            if(options.cookie.disabled_first_visit_cookie || options.cookie.disabled_all_cookie)
            {
                Cookies.remove('pys_first_visit', { path: '/',domain: cookieDomain() })

            }
            if(options.cookie.disabled_utmTerms_cookie || options.cookie.disabled_all_cookie)
            {
                $.each(Utils.utmTerms, function (index, name) {
                    Cookies.remove('pys_' + name, { path: '/',domain: cookieDomain() })
                });
                $.each(Utils.utmTerms, function (index, name) {
                    Cookies.remove('last_pys_' + name, { path: '/',domain: cookieDomain() })
                });
            }
            if(options.cookie.disabled_utmId_cookie || options.cookie.disabled_all_cookie)
            {
                $.each(Utils.utmId,function(index,name) {
                    Cookies.remove('pys_' + name, { path: '/',domain: cookieDomain() })
                })
                $.each(Utils.utmId,function(index,name) {
                    Cookies.remove('last_pys_' + name, { path: '/',domain: cookieDomain() })
                });
            }
        }


        // Exactly one manageCookies() per init, and under a consent
        // integration only once consent is on record. The old fall-through
        // ran it a second time under CookieYes, racing two pbid requests, and
        // ran it before any consent when no CookieYes cookie existed yet.
        // external_id itself does not depend on this: the visitor key is
        // computed server-side without a cookie.
        var cookiesManaged = false;

        if (options.gdpr.cookie_law_info_integration_enabled) {
            var cli_cookie = Cookies.get('cookieyes-consent') ?? Cookies.get('viewed_cookie_policy');

            if (typeof cli_cookie !== 'undefined') {
                if (cli_cookie === Cookies.get('cookieyes-consent') && getCookieYes('analytics') == 'yes') {
                    Utils.manageCookies();
                    cookiesManaged = true;
                } else if (cli_cookie === Cookies.get('viewed_cookie_policy') && cli_cookie == 'yes') {
                    Utils.manageCookies();
                    cookiesManaged = true;
                }
            }
        }

        if ( ! cookiesManaged ) {
            if ( options.gdpr.consent_magic_integration_enabled && typeof CS_Data !== "undefined" ) {
                if ( CS_Data.cs_script_cat.pys == CS_Data.cs_necessary_cat_id || CS_Data.cs_script_cat.pys == 0 ) {
                    Utils.manageCookies();
                } else if ( Cookies.get( 'cs_enabled_cookie_term' + CS_Data.test_prefix + '_' + CS_Data.cs_script_cat.pys ) == 'yes' ) {
                    Utils.manageCookies();
                }
            } else if ( ! options.gdpr.cookie_law_info_integration_enabled ) {
                Utils.manageCookies();
            }
        }

        Utils.setupGdprCallbacks();
        // page scroll event
        if ( options.dynamicEvents.hasOwnProperty("automatic_event_scroll")
        ) {

            var singlePageScroll = function () {


                var docHeight = $(document).height() - $(window).height();
                var isFired = false;

                if (options.dynamicEvents.hasOwnProperty("automatic_event_scroll")) {
                    var pixels = Object.keys(options.dynamicEvents.automatic_event_scroll);
                    for(var i = 0;i<pixels.length;i++) {
                        var event = Utils.clone(options.dynamicEvents.automatic_event_scroll[pixels[i]]);
                        var scroll = Math.round(docHeight * event.scroll_percent / 100)// convert % to absolute positions

                        if(scroll < $(window).scrollTop()) {
	                        if ( pixels[i] !== 'reddit') {
		                        Utils.copyProperties( Utils.getRequestParams(), event.params );
	                        }
	                        getPixelBySlag( pixels[ i ] ).onPageScroll( event );
                            isFired = true
                        }
                    }
                }
                if(isFired) {
                    $(document).off("scroll",singlePageScroll);
                }
            }
            $(document).on("scroll",singlePageScroll);
        }


        if (options.dynamicEvents.hasOwnProperty("automatic_event_time_on_page")) {
            var pixels = Object.keys(options.dynamicEvents.automatic_event_time_on_page);
            var time = options.dynamicEvents.automatic_event_time_on_page[pixels[0]].time_on_page; // the same for all pixel
            setTimeout(function(){
                for(var i = 0;i<pixels.length;i++) {
                    var event = Utils.clone(options.dynamicEvents.automatic_event_time_on_page[pixels[i]]);

	                if ( pixels[i] !== 'reddit') {
		                Utils.copyProperties(Utils.getRequestParams(), event.params);
	                }
                    getPixelBySlag(pixels[i]).onTime(event);
                }
            },time*1000);
        }

        // setup Click Event
        if (options.dynamicEvents.hasOwnProperty("automatic_event_download")) {

            $(document).onFirst('click', 'a, button, input[type="button"], input[type="submit"]', function (e) {

                var $elem = $(this);

                // Download
                if(options.dynamicEvents.hasOwnProperty("automatic_event_download")
                ) {
                    var isFired = false;
                    if ($elem.is('a')) {
                        var href = $elem.attr('href');
                        if (typeof href !== "string") {
                            return;
                        }
                        href = href.trim();
                        var extension = Utils.getLinkExtension(href);
                        var track_download = false;

                        if (extension.length > 0) {

                            if(options.dynamicEvents.hasOwnProperty("automatic_event_download") ) {
                                var pixels = Object.keys(options.dynamicEvents.automatic_event_download);
                                for (var i = 0; i < pixels.length; i++) {
                                    var event = Utils.clone(options.dynamicEvents.automatic_event_download[pixels[i]]);
                                    var extensions = event.extensions;
                                    if (extensions.includes(extension)) {

                                        if( pixels[i] == "tiktok" || pixels[i] == "reddit" ) {
                                            getPixelBySlag(pixels[i]).fireEvent(tikEvent.name, event);
                                        } else {
                                            if (options.enable_remove_download_url_param) {
                                                href = stripUrlQuery(href);
                                            }
                                            event.params.download_url = href;
                                            event.params.download_type = extension;
                                            event.params.download_name = Utils.getLinkFilename(href);
                                            getPixelBySlag(pixels[i]).onDownloadEvent(event);
                                        }

                                        isFired = true;
                                    }
                                }
                            }
                        }
                    }
                    if(isFired) { // prevent duplicate events on the same element
                        return;
                    }
                }
            });
        }


        // setup Dynamic events
        $.each(options.triggerEventTypes, function (triggerType, events) {

            $.each(events, function (eventId, triggers) {

                switch (triggerType) {
                    case 'url_click':
                        //@see: Utils.setupURLClickEvents()
                        break;

                    case 'css_click':
                        Utils.setupCSSClickEvents(eventId, triggers);
                        break;

                    case 'css_mouseover':
                        Utils.setupMouseOverClickEvents(eventId, triggers);
                        break;

                    case 'scroll_pos':
                        Utils.setupScrollPosEvents(eventId, triggers);
                        break;
                    case 'comment':
                        Utils.setupCommentEvents(eventId, triggers);
                        break;
                }

            });

        });
        // setup WooCommerce events
        if (options.woo.enabled) {

            // WooCommerce AddToCart
            if (options.dynamicEvents.hasOwnProperty("woo_add_to_cart_on_button_click")
                && options.woo.hasOwnProperty("addToCartCatchMethod")
                && options.woo.addToCartCatchMethod === "add_cart_js"
            ) {

                // Loop, any kind of "simple" product, except external
                $('.add_to_cart_button:not(.product_type_variable,.product_type_bundle,.single_add_to_cart_button)').on("click",function (e) {

                    var product_id = $(this).data('product_id');
                    if (typeof product_id !== 'undefined') {
                        if (options.dynamicEvents.hasOwnProperty("woo_add_to_cart_on_button_click")) {
                            var tmpEventID = pys_generate_token();
                            $.each(options.dynamicEvents.woo_add_to_cart_on_button_click, function (i, tag) {
                                tag.eventID = tmpEventID;
                                // Also refresh the uniqueId cache so server-API path
                                // (ajaxForServerStaticEvent) gets the same fresh ID.
                                var idKey = tag.hasOwnProperty('custom_event_post_id') ? tag.custom_event_post_id : tag.e_id;
                                uniqueId[idKey] = tmpEventID;
                            });
                        }
                        if (typeof product_id !== 'undefined') {
                            Facebook.onWooAddToCartOnButtonEvent(product_id);
                            Analytics.onWooAddToCartOnButtonEvent(product_id);
                            GTM.onWooAddToCartOnButtonEvent(product_id);
                            Pinterest.onWooAddToCartOnButtonEvent(product_id);
                            Bing.onWooAddToCartOnButtonEvent(product_id);
	                        Reddit.onWooAddToCartOnButtonEvent(product_id);
                            OpenAI.onWooAddToCartOnButtonEvent(product_id);
                        }
                    }
                });

                // Single Product
                // tap try to https://stackoverflow.com/questions/30990967/on-tap-click-event-firing-twice-how-to-avoid-it
                //  $(document) not work
                $('body').onFirst('click','button.single_add_to_cart_button,.single_add_to_cart_button',function (e) {

                    var $button = $(this);

                    if ($button.hasClass('disabled')) {
                        return;
                    }

                    var $form = $button.closest('form');

                    var product_type = Utils.PRODUCT_SIMPLE;

                    if ($form.length === 0) {
                        return ;
                    } else if ($form.hasClass('variations_form')) {
                        product_type = Utils.PRODUCT_VARIABLE;
                    } else if($form.hasClass('bundle_form')) {
                        product_type = Utils.PRODUCT_BUNDLE;
                    } else if($form.hasClass('grouped_form')) {
                        product_type = Utils.PRODUCT_GROUPED;
                    }




                    var product_id;
                    var qty;

                    if (product_type === Utils.PRODUCT_GROUPED) {
                        qty = 1;
                        product_id = parseInt($form.find('*[name="add-to-cart"]').val());
                    } else if (product_type === Utils.PRODUCT_VARIABLE) {
                        product_id = parseInt($form.find('*[name="add-to-cart"]').val());
                        var qtyTag = $form.find('input[name="quantity"]');
                        if(qtyTag.length <= 0) {
                            qtyTag = $form.find('select[name="quantity"]');
                        }
                        qty = parseInt(qtyTag.val());
                    } else {
                        product_id = parseInt($form.find('*[name="add-to-cart"]').val());
                        var qtyTag = $form.find('input[name="quantity"]');
                        if(qtyTag.length <= 0) {
                            qtyTag = $form.find('select[name="quantity"]');
                        }
                        qty = parseInt(qtyTag.val());
                    }

                    if(options.dynamicEvents.hasOwnProperty("woo_add_to_cart_on_button_click")){
                        var tmpEventID = pys_generate_token();
                        $.each(options.dynamicEvents.woo_add_to_cart_on_button_click, function (i, tag) {
                            tag.eventID = tmpEventID;
                            // Also refresh the uniqueId cache so server-API path
                            // (ajaxForServerStaticEvent) gets the same fresh ID.
                            var idKey = tag.hasOwnProperty('custom_event_post_id') ? tag.custom_event_post_id : tag.e_id;
                            uniqueId[idKey] = tmpEventID;
                        });
                    }

                    Facebook.onWooAddToCartOnSingleEvent(product_id, qty, product_type, $form);
                    Analytics.onWooAddToCartOnSingleEvent(product_id, qty, product_type, $form);

                    GTM.onWooAddToCartOnSingleEvent(product_id, qty, product_type, $form);

                    Pinterest.onWooAddToCartOnSingleEvent(product_id, qty, product_type, false, $form);
                    Bing.onWooAddToCartOnSingleEvent(product_id, qty, product_type, false, $form);
	                Reddit.onWooAddToCartOnSingleEvent(product_id, qty, product_type, false, $form);
                    OpenAI.onWooAddToCartOnSingleEvent(product_id, qty, product_type, false, $form);

                });

            }

            // WooCommerce RemoveFromCart
            if (options.dynamicEvents.hasOwnProperty("woo_remove_from_cart")) {

                $('body').on('click', options.woo.removeFromCartSelector, function (e) {

                    var $a = $(e.currentTarget),
                        href = $a.attr('href');

                    // extract cart item hash from remove button URL
                    var regex = new RegExp("[\\?&]remove_item=([^&#]*)"),
                        results = regex.exec(href);

                    if (results !== null) {

                        var item_hash = results[1];

                        if (options.dynamicEvents["woo_remove_from_cart"].hasOwnProperty(item_hash)) {
                            var events = options.dynamicEvents["woo_remove_from_cart"][item_hash];
                            Utils.fireEventForAllPixel("onWooRemoveFromCartEvent",events)
                        }

                    }

                });
            }
        }

        // setup EDD events
        if (options.edd.enabled) {

            // EDD AddToCart
            if (options.dynamicEvents.hasOwnProperty("edd_add_to_cart_on_button_click")) {

                $('form.edd_download_purchase_form .edd-add-to-cart').on("click",function (e) {

                    var $button = $(this);
                    var $form = $button.closest('form');
                    var variable_price = $button.data('variablePrice'); // yes/no
                    var price_mode = $button.data('priceMode'); // single/multi
                    var ids = [];
                    var quantities = [];
                    var qty;
                    var id;

                    if (variable_price === 'yes' && price_mode === 'multi') {

                        id = $form.find('input[name="download_id"]').val();

                        // get selected variants
                        $.each($form.find('input[name="edd_options[price_id][]"]:checked'), function (i, el) {
                            ids.push(id + '_' + $(el).val());
                        });

                        // get qty for selected variants
                        $.each(ids, function (i, variant_id) {

                            var variant_index = variant_id.split('_', 2);
                            qty = $form.find('input[name="edd_download_quantity_' + variant_index[1] + '"]').val();

                            if (typeof qty !== 'undefined') {
                                quantities.push(qty);
                            } else {
                                quantities.push(1);
                            }

                        });

                    } else if (variable_price === 'yes' && price_mode === 'single') {

                        id = $form.find('input[name="download_id"]').val();
                        ids.push(id + '_' + $form.find('input[name="edd_options[price_id][]"]:checked').val());

                        qty = $form.find('input[name="edd_download_quantity"]').val();

                        if (typeof qty !== 'undefined') {
                            quantities.push(qty);
                        } else {
                            quantities.push(1);
                        }

                    } else {

                        ids.push($button.data('downloadId'));

                        qty = $form.find('input[name="edd_download_quantity"]').val();

                        if (typeof qty !== 'undefined') {
                            quantities.push(qty);
                        } else {
                            quantities.push(1);
                        }
                    }

                    // fire event for each download/variant
                    $.each(ids, function (i, download_id) {

                        var q = parseInt(quantities[i]);
                        var variant_index = download_id.toString().split('_', 2);
                        var price_index;

                        if (variant_index.length === 2) {
                            download_id = variant_index[0];
                            price_index = variant_index[1];
                        }

                        Facebook.onEddAddToCartOnButtonEvent(download_id, price_index, q);
                        Analytics.onEddAddToCartOnButtonEvent(download_id, price_index, q);
                        GTM.onEddAddToCartOnButtonEvent(download_id, price_index, q);
                        Pinterest.onEddAddToCartOnButtonEvent(download_id, price_index, q);
                        Bing.onEddAddToCartOnButtonEvent(download_id, price_index, q);
	                    Reddit.onEddAddToCartOnButtonEvent(download_id, price_index, q);
                        OpenAI.onEddAddToCartOnButtonEvent(download_id, price_index, q);
                    });

                });

            }


            // EDD RemoveFromCart
            if (options.dynamicEvents.hasOwnProperty("edd_remove_from_cart") ) {

                $('form#edd_checkout_cart_form .edd_cart_remove_item_btn').on("click",function (e) {

                    var href = $(this).attr('href');
                    if(href) {
                        var key = href.substring(href.indexOf('=') + 1).charAt(0);
                        if (options.dynamicEvents.edd_remove_from_cart.hasOwnProperty(key)) {
                            var events = options.dynamicEvents.edd_remove_from_cart[key];
                            Utils.fireEventForAllPixel("onEddRemoveFromCartEvent",events)
                        }
                    }
                });

            }

        }

        // setup Comment Event
        if (options.dynamicEvents.hasOwnProperty("automatic_event_comment")
        ) {

            $('form.comment-form').on("submit",function () {
                if (options.dynamicEvents.hasOwnProperty("automatic_event_comment")) {
                    var pixels = Object.keys(options.dynamicEvents.automatic_event_comment);
                    for (var i = 0; i < pixels.length; i++) {
	                    var event = Utils.clone(options.dynamicEvents.automatic_event_comment[pixels[i]]);
	                    if ( pixels[i] !== 'reddit') {
		                    Utils.copyProperties(Utils.getRequestParams(), event.params);
	                    }
                        getPixelBySlag(pixels[i]).onCommentEvent(event);
                    }
                }
            });

        }


        // setup Form Event
        if ( options.dynamicEvents.hasOwnProperty("automatic_event_form")) {

            $(document).onFirst('submit', 'form', function (e) {

                var $form = $(this);

                // exclude WP forms
                const formClass = $form.attr('class') || '';
                const formRole = ($form.attr('role') || '').toLowerCase();
                const formId = $form.attr('id');

                if (
                    $form.hasClass('comment-form') ||
                    $form.hasClass('search-form') ||
                    $form.hasClass('woocommerce-ordering') ||
                    formClass.toLowerCase().includes('search') || formClass.toLowerCase().includes('add-to-cart') ||
                    formRole === 'search' ||
                    formId === 'adminbarsearch'
                ) {
                    return;
                }

                // exclude Woo forms
                if ($form.hasClass('woocommerce-product-search') || $form.hasClass('cart') || $form.hasClass('woocommerce-cart-form') ||
                    $form.hasClass('woocommerce-shipping-calculator') || $form.hasClass('checkout') || $form.hasClass('checkout_coupon')) {
                    return;
                }

                // exclude EDD forms
                if ($form.hasClass('edd_form') || $form.hasClass('edd_download_purchase_form')) {
                    return;
                }
// exclude CF7 forms
                if ($form.hasClass('wpcf7-form')) {
                    return;
                }
                // exclude Forminator forms
                if ($form.hasClass('forminator-custom-form') || $form.hasClass('forminator_ajax')) {
                    return;
                }
                // exclude WPforms forms
                if ($form.hasClass('wpforms-form') || $form.hasClass('wpforms-ajax-form')) {
                    return;
                }
                // exclude Formidable forms
                /*if ($form.hasClass('frm-show-form')) {
                    return;
                }*/
                // exclude Ninja Forms forms
                if ($form.parent().hasClass('nf-form-layout')) {
                    return;
                }
                // exclude Fluent forms
                if ($form.hasClass('frm-fluent-form')) {
                    return;
                }
                if(!options.enable_success_send_form) {
                    var params = {
                        form_id: $form.attr('id'),
                        form_class: $form.attr('class'),
                        text: $form.find('[type="submit"]').is('input') ?
                            $form.find('[type="submit"]').val() : $form.find('[type="submit"]').text()
                    };

                    if (options.dynamicEvents.hasOwnProperty("automatic_event_form")) {
                        var pixels = Object.keys(options.dynamicEvents.automatic_event_form);
                        for (var i = 0; i < pixels.length; i++) {
                            var event = Utils.clone(options.dynamicEvents.automatic_event_form[pixels[i]]);

	                        if (pixels[i] === "tiktok" || pixels[i] === "reddit") {
                                getPixelBySlag(pixels[i]).fireEvent(event.name, event);
                            } else {
                                Utils.copyProperties(params, event.params,)
                                Utils.copyProperties(Utils.getRequestParams(), event.params);
                                getPixelBySlag(pixels[i]).onFormEvent(event);
                            }
                        }
                    }
                }
            });

            document.addEventListener( 'wpcf7mailsent', function( event ) {
                var form_id = event.detail.contactFormId;
                sendFormAction($(event.target), form_id);
            }, false );
            //Forminator
            $(document).on( 'forminator:form:submit:success', function( event ){
                var form_id = $(event.target).find('input[name="form_id"]').val();
                sendFormAction($(event.target), form_id);
            });

            //WPForm
            $('form.wpforms-form').on('wpformsAjaxSubmitSuccess', (event) => {
                var form_id = $(event.target).attr('data-formid');
                sendFormAction($(event.target), form_id);
            })
            $(document).on( 'frmFormComplete', function( event, form, response ) {
                const form_id = $(form).find('input[name="form_id"]').val();
                sendFormAction($(event.target), form_id);
            });
            // Ninja Forms
            $(document).onFirst('nfFormSubmitResponse', function (event, data) {
                const form_id = data.response.data.form_id;
                sendFormAction($(event.target), form_id);
            });

            var fluentForms = $('form.frm-fluent-form');
            fluentForms.each(function() {
                var $form = $(this);
                $form.on('fluentform_submission_success', function(event) {
                    var $formItem = $(this);
                    var form_id = $formItem.attr('data-form_id');
                    sendFormAction($(event.target), form_id);
                });
            });

        }


        // load pixel APIs
        Utils.loadPixels();
        // setup Enrich content
        if(Utils.isCheckoutPage()) {
            Utils.addCheckoutFields();
        }
    }

    $(document).ready(function () {
        if ( options.dynamicDataUrl ) {
            fetch( options.dynamicDataUrl, {
                method: 'GET',
                credentials: 'same-origin',
                cache: 'no-store',
                headers: { 'Accept': 'application/json' }
            } )
                .then( function(r) { return r.ok ? r.json() : Promise.reject(r.status); } )
                .then( function(dynamic) {
                    // An empty reply ([] for bots, and in Pro for user roles the
                    // plugin is disabled for) means "do not track this visitor".
                    // Going on would set options.cookie to undefined and throw in
                    // pysNormalInit().
                    if ( ! dynamic || ! dynamic.cookie ) {
                        options.dynamicDataApplied = true;
                        if ( options.debug ) console.warn( '[PYS] dynamic-options: tracking is disabled for this visitor.' );
                        return;
                    }

                    options.ajax_event         = dynamic.ajax_event;
                    options.cache_bypass       = dynamic.cache_bypass;
                    options.tracking_analytics = dynamic.tracking_analytics;
                    if ( dynamic.gdpr_dynamic && options.gdpr ) {
                        Object.assign( options.gdpr, dynamic.gdpr_dynamic );
                        if ( dynamic.gdpr_dynamic.analytics_storage_value !== null )
                            options.gdpr.analytics_storage.value = dynamic.gdpr_dynamic.analytics_storage_value;
                        if ( dynamic.gdpr_dynamic.ad_storage_value !== null )
                            options.gdpr.ad_storage.value = dynamic.gdpr_dynamic.ad_storage_value;
                        if ( dynamic.gdpr_dynamic.ad_user_data_value !== null )
                            options.gdpr.ad_user_data.value = dynamic.gdpr_dynamic.ad_user_data_value;
                        if ( dynamic.gdpr_dynamic.ad_personalization_value !== null )
                            options.gdpr.ad_personalization.value = dynamic.gdpr_dynamic.ad_personalization_value;
                    }
                    options.cookie = dynamic.cookie;

                    // Per-pixel user data (advanced matching) that was emptied out of
                    // the cached HTML. An inline value that still holds something wins:
                    // on pages we never strip (order received / EDD success) the HTML
                    // carries the order's own data, which beats the account-level data
                    // this endpoint can see.
                    if ( dynamic.pixels ) {
                        for ( var slug in dynamic.pixels ) {
                            if ( ! dynamic.pixels.hasOwnProperty( slug ) || ! options[ slug ] ) continue;
                            for ( var key in dynamic.pixels[ slug ] ) {
                                if ( ! dynamic.pixels[ slug ].hasOwnProperty( key ) ) continue;
                                var inline = options[ slug ][ key ];
                                if ( ! inline || Object.keys( inline ).length === 0 ) {
                                    options[ slug ][ key ] = dynamic.pixels[ slug ][ key ];
                                }
                            }
                        }
                    }

                    options.dynamicDataApplied = true;

                    if ( window.pys && window.pys.OpenAI
                        && typeof window.pys.OpenAI.refreshAdvancedMatching === 'function' ) {
                        window.pys.OpenAI.refreshAdvancedMatching();
                    }

                    pysNormalInit();
                } )
                .catch( function(err) {
                    if ( options.debug ) console.warn( '[PYS] dynamic-options fetch failed:', err );
                    options.dynamicDataApplied = true;
                    pysNormalInit();
                } );
        } else {
            pysNormalInit();
        }
    });

    var sendFormAction = function (form_target, formId){
        var params = {
            form_id: formId,
            text: form_target.find('[type="submit"]').is('input') ? form_target.find('[type="submit"]').val() :
                form_target.find('.forminator-button-submit').text() != '' ? form_target.find('.forminator-button-submit').text() :
                    form_target.find('[type="submit"]').text()
        };

        if (options.dynamicEvents.hasOwnProperty("automatic_event_form")) {
            var pixels = Object.keys(options.dynamicEvents.automatic_event_form);
            for (var i = 0; i < pixels.length; i++) {
                var event = options.dynamicEvents.automatic_event_form[pixels[i]];
                if (pixels[i] === "tiktok" || pixels[i] === "reddit") {
                    getPixelBySlag(pixels[i]).fireEvent(event.name, event);
                } else {
                    Utils.copyProperties(params, event.params)
                    Utils.copyProperties(Utils.getRequestParams(), event.params);
                    getPixelBySlag(pixels[i]).onFormEvent(event);
                }
            }
        }
    }

}(jQuery, pysOptions);

function pys_generate_token() {
    return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
    );
}

function getBundlePriceOnSingleProduct(data) {
    var items_sum = 0;
    jQuery(".bundle_form .bundled_product").each(function(index){
        var id = jQuery(this).find(".cart").data("bundled_item_id");
        var item_price = data.prices[id];
        var item_quantity = jQuery(this).find(".bundled_qty").val();
        if(!jQuery(this).hasClass("bundled_item_optional") ||
            jQuery(this).find(".bundled_product_optional_checkbox input").prop('checked')) {
            items_sum += item_price*item_quantity;
        }
    });
    return items_sum;
}
function getUrlParameter(sParam) {
    var sPageURL = window.location.search.substring(1),
        sURLVariables = sPageURL.split('&'),
        sParameterName,
        i;

    for (i = 0; i < sURLVariables.length; i++) {
        sParameterName = sURLVariables[i].split('=');

        if (sParameterName[0] === sParam) {
            // Twin of ServerEventHelper::getUrlParameter(). A parameter with
            // no '=' has no value; skip it rather than inventing one, so
            // ?fbclid&fbclid=REAL still finds the real one.
            if (sParameterName[1] === undefined) {
                continue;
            }
            try {
                return decodeURIComponent(sParameterName[1]);
            } catch (e) {
                // decodeURIComponent throws on a malformed escape ("%",
                // "%zz", "a%2"). Return the raw value instead of throwing,
                // matching PHP's urldecode(), which is lenient about it.
                return sParameterName[1];
            }
        }
    }
    return false;
};
function getCookieYes(key) {
    const cookiesObj = document.cookie
        .split(";")
        .reduce((ac, cv) => {
            const [k, v] = cv.split("=");
            if (k && v) ac[k.trim()] = v;
            return ac;
        }, {});
    const consentCookie = cookiesObj["cookieyes-consent"] || cookiesObj["wt_consent"];
    if (!consentCookie) return undefined;
    const { [key]: value } = consentCookie
        .split(",")
        .reduce((obj, pair) => {
            const [k, v] = pair.split(":");
            if (k && v) obj[k] = v;
            return obj;
        }, {});
    return value;
}
function getRootDomain(useSubdomain = false) {
    const hostname = window.location.hostname; // Get the current hostname
    // Check if tldjs is defined before using it
    if (typeof tldjs === "undefined") {
        console.warn("tldjs is not defined");
        return hostname; // Return hostname as a fallback
    }

    const rootDomain = tldjs.getDomain(hostname); // Use tldjs to extract the root domain

    // Return the root domain with or without a leading dot based on useSubdomain
    return rootDomain ? (useSubdomain ? '.' + rootDomain : rootDomain) : hostname;
}