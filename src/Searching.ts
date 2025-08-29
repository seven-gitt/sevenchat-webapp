/*
Copyright 2024 New Vector Ltd.
Copyright 2019-2021 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {
    type IResultRoomEvents,
    type ISearchRequestBody,
    type ISearchResponse,
    type ISearchResult,
    type ISearchResults,
    SearchOrderBy,
    type IRoomEventFilter,
    EventType,
    type MatrixClient,
    type SearchResult,
} from "matrix-js-sdk/src/matrix";

import { type ISearchArgs } from "./indexing/BaseEventIndexManager";
import EventIndexPeg from "./indexing/EventIndexPeg";
import { isNotUndefined } from "./Typeguards";

const SEARCH_LIMIT = 10;

async function serverSideSearch(
    client: MatrixClient,
    term: string,
    roomId?: string,
    abortSignal?: AbortSignal,
): Promise<{ response: ISearchResponse; query: ISearchRequestBody }> {
    console.log(`🌐 Server-side search called with term: "${term}"`);
    
    const filter: IRoomEventFilter = {
        limit: SEARCH_LIMIT,
    };

    if (roomId !== undefined) filter.rooms = [roomId];

    // Enhanced URL detection patterns
    const URL_PATTERNS = {
        FULL_URL: /^https?:\/\/[^\s]+$/i,
        DOMAIN_WITH_PATH: /^[^\s]+\.[^\s]+\/[^\s]*$/i,
        DOMAIN_ONLY: /^[^\s]+\.[^\s]+$/i,
        IP_ADDRESS: /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
        LOCALHOST: /^localhost(:\d+)?(\/.*)?$/i,
    };

    // Check if search term looks like a URL pattern
    // Also treat single-token keywords as potential URL/domain fragments (e.g. "imagecolorpicker", "fortraders", "trading", "products")
    const isSingleToken = /^[a-z0-9]+$/i.test(term);
    const isUrlSearch = Object.values(URL_PATTERNS).some(pattern => pattern.test(term)) ||
                       term.includes('.') || 
                       term.includes('://') || 
                       term.includes('/') ||
                       term.includes('?') ||
                       term.includes('&') ||
                       term.includes('=') ||
                       isSingleToken;

    let response;
    let query: ISearchRequestBody = {
        search_categories: {
            room_events: {
                search_term: term,
                filter: filter,
                order_by: SearchOrderBy.Recent,
                event_context: {
                    before_limit: 1,
                    after_limit: 1,
                    include_profile: true,
                },
            },
        },
    };

    if (isUrlSearch || isSingleToken) {
        console.log(`Server-side enhanced search detected for term: "${term}"`);
        
        // Try multiple search strategies for URLs or domain-like keywords
        const base = term;
        const withoutProtocol = term.replace(/^https?:\/\//, '');
        const domainOnly = term.match(/(?:https?:\/\/)?([^\/\s?#]+)/)?.[1] || term;
        const pathOnly = term.match(/(?:https?:\/\/[^\/]+)?(\/[^\s?#]*)/)?.[1] || term;
        const queryParam = term.match(/[?&]([^=]+)=([^&\s]+)/)?.[2] || term;
        const fragment = term.match(/#([^\s]+)/)?.[1] || term;
        
        // Extract query parameter names and values
        const queryParams = [];
        const queryMatches = term.matchAll(/[?&]([^=]+)=([^&\s]+)/g);
        for (const match of queryMatches) {
            queryParams.push(match[1]); // parameter name
            queryParams.push(match[2]); // parameter value
        }
        
        // Extract path segments
        const pathSegments = [];
        const pathMatch = term.match(/(?:https?:\/\/[^\/]+)?(\/[^\s?#]*)/);
        if (pathMatch && pathMatch[1]) {
            const segments = pathMatch[1].split('/').filter(segment => segment.length > 0);
            pathSegments.push(...segments);
        }

        // Enhanced domain expansions for single tokens
        const domainExpansions: string[] = isSingleToken
            ? [
                  `${base}.com`,
                  `${base}.vn`,
                  `${base}.net`,
                  `${base}.org`,
                  `${base}.io`,
                  `${base}.app`,
                  `www.${base}.com`,
                  `app.${base}.com`,
                  `https://${base}.com`,
                  `http://${base}.com`,
                  `https://app.${base}.com`,
                  `https://www.${base}.com`,
              ]
            : [];

        // Additional strategies for complex URLs
        const additionalStrategies = [];
        if (term.includes('.')) {
            // Extract subdomain and main domain parts
            const domainParts = term.replace(/^https?:\/\//, '').split('.');
            if (domainParts.length >= 2) {
                const mainDomain = domainParts.slice(-2).join('.');
                const subdomain = domainParts[0];
                additionalStrategies.push(
                    { term: mainDomain, description: "main domain" },
                    { term: subdomain, description: "subdomain" },
                    { term: `${subdomain}.${mainDomain}`, description: "subdomain.main" }
                );
            }
        }
        
        // Additional strategies for single tokens that might be subdomains, paths, or query params
        if (isSingleToken) {
            // Generic subdomain patterns - any single token could be a subdomain
            additionalStrategies.push(
                { term: `${term}.com`, description: "generic subdomain expansion" },
                { term: `${term}.net`, description: "generic subdomain .net" },
                { term: `${term}.org`, description: "generic subdomain .org" },
                { term: `${term}.io`, description: "generic subdomain .io" },
                { term: `https://${term}.com`, description: "generic subdomain with https" },
                { term: `http://${term}.com`, description: "generic subdomain with http" }
            );
            
            // Generic path patterns - any single token could be a path segment
            additionalStrategies.push(
                { term: `/${term}`, description: "generic path segment" },
                { term: `/${term}/`, description: "generic path segment with slash" },
                { term: `https://example.com/${term}`, description: "generic path with domain" },
                { term: `https://www.example.com/${term}`, description: "generic path with www domain" }
            );
            
            // Generic query parameter patterns - any single token could be a query param
            additionalStrategies.push(
                { term: `?${term}=`, description: "generic query parameter" },
                { term: `&${term}=`, description: "generic query parameter with ampersand" },
                { term: `https://example.com/?${term}=`, description: "generic query with domain" }
            );
            
            // Common subdomain patterns for better matching
            const commonSubdomains = ['app', 'api', 'docs', 'www', 'beta', 'staging', 'dev', 'test', 'admin', 'cdn', 'static', 'assets', 'media', 'blog', 'shop', 'store', 'support', 'help', 'forum', 'community'];
            if (commonSubdomains.includes(term.toLowerCase())) {
                additionalStrategies.push(
                    { term: `${term}.example.com`, description: "common subdomain expansion" },
                    { term: `https://${term}.example.com`, description: "common subdomain with https" }
                );
            }
            
            // Common path patterns for better matching
            const commonPaths = ['trading', 'products', 'questions', 'docs', 'api', 'rest', 'v1', 'v2', 'user', 'users', 'profile', 'settings', 'admin', 'dashboard', 'login', 'register', 'search', 'help', 'about', 'contact', 'blog', 'news', 'article', 'post', 'category', 'tag', 'archive', 'download', 'upload', 'file', 'image', 'video', 'audio', 'document', 'pdf', 'zip', 'rar'];
            if (commonPaths.includes(term.toLowerCase())) {
                additionalStrategies.push(
                    { term: `https://example.com/${term}`, description: "common path with domain" },
                    { term: `https://www.example.com/${term}`, description: "common path with www domain" }
                );
            }
            
            // Common query parameter patterns for better matching
            const commonQueryParams = ['affiliateCode', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'category', 'brand', 'model', 'color', 'storage', 'price_min', 'price_max', 'k', 'q', 'query', 'search', 'ref', 'rh', 'qid', 'rnid', 'include', 'format', 'date', 'time', 'sort', 'order', 'limit', 'offset', 'page', 'size', 'filter', 'type', 'status', 'id', 'user', 'author', 'tag', 'lang', 'locale', 'currency', 'country', 'region', 'city'];
            if (commonQueryParams.includes(term.toLowerCase())) {
                additionalStrategies.push(
                    { term: `https://example.com/?${term}=`, description: "common query parameter with domain" },
                    { term: `https://www.example.com/?${term}=`, description: "common query parameter with www domain" }
                );
            }
        }

        const searchStrategies = [
            { term: base, description: "exact" },
            { term: withoutProtocol, description: "without protocol" },
            { term: domainOnly, description: "domain only" },
            { term: pathOnly, description: "path only" },
            { term: queryParam, description: "query parameter" },
            { term: fragment, description: "fragment" },
            ...domainExpansions.map((t) => ({ term: t, description: "keyword domain expansion" })),
            ...additionalStrategies,
            // Add query parameter names and values
            ...queryParams.map((param) => ({ term: param, description: "query parameter name/value" })),
            // Add path segments
            ...pathSegments.map((segment) => ({ term: segment, description: "path segment" })),
        ];

        let bestResponse = null;
        let bestQuery: ISearchRequestBody | null = null;
        let bestCount = 0;

        for (const strategy of searchStrategies) {
            if (strategy.term && strategy.term !== term) {
                try {
                    const body: ISearchRequestBody = {
                        search_categories: {
                            room_events: {
                                search_term: strategy.term,
                                filter: filter,
                                order_by: SearchOrderBy.Recent,
                                event_context: {
                                    before_limit: 1,
                                    after_limit: 1,
                                    include_profile: true,
                                },
                            },
                        },
                    };

                    const strategyResponse = await client.search({ body: body }, abortSignal);
                    
                    // Check if we got meaningful results
                    const results = strategyResponse.search_categories?.room_events?.results;
                    if (results && results.length > 0) {
                        console.log(`Server-side ${strategy.description} search returned ${results.length} results`);
                        response = strategyResponse;
                        query = body;
                        break;
                    }
                } catch (error) {
                    console.log(`Server-side ${strategy.description} search failed:`, error);
                }
            }
        }
    }

    // If no URL-specific results or not a URL search, use original term
    if (!response || !query) {
        console.log("🔄 Using original search term for server-side search");
        const body: ISearchRequestBody = {
            search_categories: {
                room_events: {
                    search_term: term,
                    filter: filter,
                    order_by: SearchOrderBy.Recent,
                    event_context: {
                        before_limit: 1,
                        after_limit: 1,
                        include_profile: true,
                    },
                },
            },
        };

        try {
            response = await client.search({ body: body }, abortSignal);
            query = body;
            console.log(`🌐 Server-side search completed with ${response.search_categories?.room_events?.results?.length || 0} results`);
        } catch (error) {
            console.error("❌ Server-side search failed:", error);
            throw error;
        }
    }

    return { response, query };
}

async function serverSideSearchProcess(
    client: MatrixClient,
    term: string,
    roomId?: string,
    abortSignal?: AbortSignal,
): Promise<ISearchResults> {
    const result = await serverSideSearch(client, term, roomId, abortSignal);

    // The js-sdk method backPaginateRoomEventsSearch() uses _query internally
    // so we're reusing the concept here since we want to delegate the
    // pagination back to backPaginateRoomEventsSearch() in some cases.
    const searchResults: ISearchResults = {
        abortSignal,
        _query: result.query,
        results: [],
        highlights: [],
    };

    return client.processRoomEventsSearch(searchResults, result.response);
}

function compareEvents(a: ISearchResult, b: ISearchResult): number {
    const aEvent = a.result;
    const bEvent = b.result;

    if (aEvent.origin_server_ts > bEvent.origin_server_ts) return -1;
    if (aEvent.origin_server_ts < bEvent.origin_server_ts) return 1;

    return 0;
}

async function combinedSearch(
    client: MatrixClient,
    searchTerm: string,
    abortSignal?: AbortSignal,
): Promise<ISearchResults> {
    console.log(`🔄 combinedSearch called with term: "${searchTerm}"`);
    
    // Create two promises, one for the local search, one for the
    // server-side search.
    const serverSidePromise = serverSideSearch(client, searchTerm, undefined, abortSignal);
    
    // Wrap local search in try-catch to handle EventIndex not available
    let localPromise: Promise<{ response: IResultRoomEvents; query: ISearchArgs }>;
    try {
        localPromise = localSearch(searchTerm);
    } catch (error) {
        console.log("⚠️ Local search not available, using server-side only");
        localPromise = Promise.resolve({
            response: { results: [], highlights: [], count: 0 },
            query: { 
                search_term: searchTerm,
                before_limit: 1,
                after_limit: 1,
                limit: SEARCH_LIMIT,
                order_by_recency: true
            }
        });
    }

    // Wait for both promises to resolve.
    await Promise.all([serverSidePromise, localPromise]);

    // Get both search results.
    let localResult;
    try {
        localResult = await localPromise;
    } catch (error) {
        console.log("⚠️ Local search failed, using server-side only");
        localResult = {
            response: { results: [], highlights: [], count: 0 },
            query: { 
                search_term: searchTerm,
                before_limit: 1,
                after_limit: 1,
                limit: SEARCH_LIMIT,
                order_by_recency: true
            }
        };
    }
    
    const serverSideResult = await serverSidePromise;

    const serverQuery = serverSideResult.query;
    const serverResponse = serverSideResult.response;

    const localQuery = localResult.query;
    const localResponse = localResult.response;

    // Store our queries for later on so we can support pagination.
    //
    // We're reusing _query here again to not introduce separate code paths and
    // concepts for our different pagination methods. We're storing the
    // server-side next batch separately since the query is the json body of
    // the request and next_batch needs to be a query parameter.
    //
    // We can't put it in the final result that _processRoomEventsSearch()
    // returns since that one can be either a server-side one, a local one or a
    // fake one to fetch the remaining cached events. See the docs for
    // combineEvents() for an explanation why we need to cache events.
    const emptyResult: ISeshatSearchResults = {
        seshatQuery: localQuery,
        _query: serverQuery,
        serverSideNextBatch: serverResponse.search_categories.room_events.next_batch,
        cachedEvents: [],
        oldestEventFrom: "server",
        results: [],
        highlights: [],
    };

    // Combine our results.
    const combinedResult = combineResponses(emptyResult, localResponse, serverResponse.search_categories.room_events);

    // Let the client process the combined result.
    const response: ISearchResponse = {
        search_categories: {
            room_events: combinedResult,
        },
    };

    const result = client.processRoomEventsSearch(emptyResult, response);

    // Restore our encryption info so we can properly re-verify the events.
    restoreEncryptionInfo(result.results);

    return result;
}

async function localSearch(
    searchTerm: string,
    roomId?: string,
    processResult = true,
): Promise<{ response: IResultRoomEvents; query: ISearchArgs }> {
    const eventIndex = EventIndexPeg.get();
    
    // Debug logging
    console.log(`🔍 Local search called with term: "${searchTerm}"`);
    console.log(`📊 EventIndex available: ${eventIndex !== null}`);
    
    if (!eventIndex) {
        console.log("❌ EventIndex is null - falling back to server-side search only");
        throw new Error("EventIndex not available");
    }

    const searchArgs: ISearchArgs = {
        search_term: searchTerm,
        before_limit: 1,
        after_limit: 1,
        limit: SEARCH_LIMIT,
        order_by_recency: true,
        room_id: undefined,
    };

    if (roomId !== undefined) {
        searchArgs.room_id = roomId;
    }

    // Enhanced URL detection patterns
    const URL_PATTERNS = {
        FULL_URL: /^https?:\/\/[^\s]+$/i,
        DOMAIN_WITH_PATH: /^[^\s]+\.[^\s]+\/[^\s]*$/i,
        DOMAIN_ONLY: /^[^\s]+\.[^\s]+$/i,
        IP_ADDRESS: /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
        LOCALHOST: /^localhost(:\d+)?(\/.*)?$/i,
    };

    // Check if search term looks like a URL pattern
    // Also treat single-token keywords as potential URL/domain fragments (e.g. "imagecolorpicker", "fortraders", "trading", "products")
    const isSingleToken = /^[a-z0-9]+$/i.test(searchTerm);
    const isUrlSearch = Object.values(URL_PATTERNS).some(pattern => pattern.test(searchTerm)) ||
                       searchTerm.includes('.') || 
                       searchTerm.includes('://') || 
                       searchTerm.includes('/') ||
                       searchTerm.includes('?') ||
                       searchTerm.includes('&') ||
                       searchTerm.includes('=') ||
                       isSingleToken;
    
    let localResult;
    
    // Always try enhanced search for single tokens or URL-like terms
    if (isUrlSearch || isSingleToken) {
        console.log(`Enhanced search detected for term: "${searchTerm}"`);
        
        // Strategy 1: Try exact search first
        try {
            localResult = await eventIndex!.search(searchArgs);
            console.log(`Exact search returned ${localResult?.count || 0} results`);
        } catch (error) {
            console.log("Exact search failed:", error);
        }
        
        // Strategy 2: If no results, try without protocol
        if (!localResult || localResult.count === 0) {
            const urlWithoutProtocol = searchTerm.replace(/^https?:\/\//, '');
            if (urlWithoutProtocol !== searchTerm) {
                const alternativeArgs = { ...searchArgs, search_term: urlWithoutProtocol };
                try {
                    localResult = await eventIndex!.search(alternativeArgs);
                    console.log(`Protocol-removed search returned ${localResult?.count || 0} results`);
                } catch (error) {
                    console.log("Protocol-removed search failed:", error);
                }
            }
        }
        
        // Strategy 3: Try domain-only search
        if (!localResult || localResult.count === 0) {
            const domainMatch = searchTerm.match(/(?:https?:\/\/)?([^\/\s?#]+)/);
            if (domainMatch && domainMatch[1]) {
                const domainArgs = { ...searchArgs, search_term: domainMatch[1] };
                try {
                    localResult = await eventIndex!.search(domainArgs);
                    console.log(`Domain-only search returned ${localResult?.count || 0} results`);
                } catch (error) {
                    console.log("Domain-only search failed:", error);
                }
            }
        }
        
        // Strategy 4: Try path-only search (for URLs with paths)
        if (!localResult || localResult.count === 0) {
            const pathMatch = searchTerm.match(/(?:https?:\/\/[^\/]+)?(\/[^\s?#]*)/);
            if (pathMatch && pathMatch[1]) {
                const pathArgs = { ...searchArgs, search_term: pathMatch[1] };
                try {
                    localResult = await eventIndex!.search(pathArgs);
                    console.log(`Path-only search returned ${localResult?.count || 0} results`);
                } catch (error) {
                    console.log("Path-only search failed:", error);
                }
            }
        }
        
        // Strategy 4.1: Try path segment search (for individual path segments)
        if (!localResult || localResult.count === 0) {
            const pathMatch = searchTerm.match(/(?:https?:\/\/[^\/]+)?(\/[^\s?#]*)/);
            if (pathMatch && pathMatch[1]) {
                const segments = pathMatch[1].split('/').filter(segment => segment.length > 0);
                for (const segment of segments) {
                    const segmentArgs = { ...searchArgs, search_term: segment };
                    try {
                        const segmentResult = await eventIndex!.search(segmentArgs);
                        if (segmentResult && segmentResult.count && segmentResult.count > 0) {
                            localResult = segmentResult;
                            console.log(`Path segment search returned ${segmentResult.count} results for segment: ${segment}`);
                            break;
                        }
                    } catch (error) {
                        console.log("Path segment search failed:", error);
                    }
                }
            }
        }
        
        // Strategy 5: Try query parameter search
        if (!localResult || localResult.count === 0) {
            const queryMatch = searchTerm.match(/[?&]([^=]+)=([^&\s]+)/);
            if (queryMatch) {
                const queryArgs = { ...searchArgs, search_term: queryMatch[2] };
                try {
                    localResult = await eventIndex!.search(queryArgs);
                    console.log(`Query parameter search returned ${localResult?.count || 0} results`);
                } catch (error) {
                    console.log("Query parameter search failed:", error);
                }
            }
        }
        
        // Strategy 5.1: Try query parameter name search
        if (!localResult || localResult.count === 0) {
            const queryNameMatch = searchTerm.match(/[?&]([^=]+)=/);
            if (queryNameMatch) {
                const queryNameArgs = { ...searchArgs, search_term: queryNameMatch[1] };
                try {
                    localResult = await eventIndex!.search(queryNameArgs);
                    console.log(`Query parameter name search returned ${localResult?.count || 0} results`);
                } catch (error) {
                    console.log("Query parameter name search failed:", error);
                }
            }
        }
        
        // Strategy 6: Try fragment search
        if (!localResult || localResult.count === 0) {
            const fragmentMatch = searchTerm.match(/#([^\s]+)/);
            if (fragmentMatch) {
                const fragmentArgs = { ...searchArgs, search_term: fragmentMatch[1] };
                try {
                    localResult = await eventIndex!.search(fragmentArgs);
                    console.log(`Fragment search returned ${localResult?.count || 0} results`);
                } catch (error) {
                    console.log("Fragment search failed:", error);
                }
            }
        }
        
        // Strategy 7: Try partial domain search (for subdomains)
        if (!localResult || localResult.count === 0) {
            const domainParts = searchTerm.replace(/^https?:\/\//, '').split('.');
            if (domainParts.length > 1) {
                // Try with main domain
                const mainDomain = domainParts.slice(-2).join('.');
                const mainDomainArgs = { ...searchArgs, search_term: mainDomain };
                try {
                    localResult = await eventIndex!.search(mainDomainArgs);
                    console.log(`Main domain search returned ${localResult?.count || 0} results`);
                } catch (error) {
                    console.log("Main domain search failed:", error);
                }
            }
        }

        // Strategy 8: If keyword without TLD, try common domain expansions
        if ((!localResult || localResult.count === 0) && isSingleToken) {
            const expansions = [
                `${searchTerm}.com`,
                `${searchTerm}.vn`,
                `${searchTerm}.net`,
                `${searchTerm}.org`,
                `${searchTerm}.io`,
                `${searchTerm}.app`,
                `www.${searchTerm}.com`,
                `app.${searchTerm}.com`,
                `https://${searchTerm}.com`,
                `http://${searchTerm}.com`,
                `https://app.${searchTerm}.com`,
                `https://www.${searchTerm}.com`,
            ];
            for (const exp of expansions) {
                const args = { ...searchArgs, search_term: exp };
                try {
                    const r = await eventIndex!.search(args);
                    if (r && r.count && r.count > 0) {
                        localResult = r;
                        console.log(`Keyword domain expansion search returned ${r.count} results for ${exp}`);
                        break;
                    }
                } catch (error) {
                    console.log("Keyword domain expansion search failed:", error);
                }
            }
        }
        
        // Strategy 8.1: Try generic and common patterns for single tokens
        if ((!localResult || localResult.count === 0) && isSingleToken) {
            // Generic expansions for any single token
            const genericExpansions = [
                // Generic subdomain patterns
                `${searchTerm}.com`,
                `${searchTerm}.net`,
                `${searchTerm}.org`,
                `${searchTerm}.io`,
                `https://${searchTerm}.com`,
                `http://${searchTerm}.com`,
                
                // Generic path patterns
                `/${searchTerm}`,
                `/${searchTerm}/`,
                `https://example.com/${searchTerm}`,
                `https://www.example.com/${searchTerm}`,
                
                // Generic query parameter patterns
                `?${searchTerm}=`,
                `&${searchTerm}=`,
                `https://example.com/?${searchTerm}=`,
                `https://www.example.com/?${searchTerm}=`
            ];
            
            for (const exp of genericExpansions) {
                const args = { ...searchArgs, search_term: exp };
                try {
                    const r = await eventIndex!.search(args);
                    if (r && r.count && r.count > 0) {
                        localResult = r;
                        console.log(`Generic expansion search returned ${r.count} results for ${exp}`);
                        break;
                    }
                } catch (error) {
                    console.log("Generic expansion search failed:", error);
                }
            }
            
            // Common subdomain patterns for better matching
            const commonSubdomains = ['app', 'api', 'docs', 'www', 'beta', 'staging', 'dev', 'test', 'admin', 'cdn', 'static', 'assets', 'media', 'blog', 'shop', 'store', 'support', 'help', 'forum', 'community'];
            if (commonSubdomains.includes(searchTerm.toLowerCase())) {
                const subdomainExpansions = [
                    `${searchTerm}.example.com`,
                    `https://${searchTerm}.example.com`,
                    `https://${searchTerm}.com`,
                    `https://www.${searchTerm}.com`
                ];
                for (const exp of subdomainExpansions) {
                    const args = { ...searchArgs, search_term: exp };
                    try {
                        const r = await eventIndex!.search(args);
                        if (r && r.count && r.count > 0) {
                            localResult = r;
                            console.log(`Common subdomain expansion search returned ${r.count} results for ${exp}`);
                            break;
                        }
                    } catch (error) {
                        console.log("Common subdomain expansion search failed:", error);
                    }
                }
            }
            
            // Common path patterns for better matching
            const commonPaths = ['trading', 'products', 'questions', 'docs', 'api', 'rest', 'v1', 'v2', 'user', 'users', 'profile', 'settings', 'admin', 'dashboard', 'login', 'register', 'search', 'help', 'about', 'contact', 'blog', 'news', 'article', 'post', 'category', 'tag', 'archive', 'download', 'upload', 'file', 'image', 'video', 'audio', 'document', 'pdf', 'zip', 'rar'];
            if (commonPaths.includes(searchTerm.toLowerCase())) {
                const pathExpansions = [
                    `https://example.com/${searchTerm}`,
                    `https://www.example.com/${searchTerm}`,
                    `https://api.example.com/${searchTerm}`,
                    `https://app.example.com/${searchTerm}`
                ];
                for (const exp of pathExpansions) {
                    const args = { ...searchArgs, search_term: exp };
                    try {
                        const r = await eventIndex!.search(args);
                        if (r && r.count && r.count > 0) {
                            localResult = r;
                            console.log(`Common path expansion search returned ${r.count} results for ${exp}`);
                            break;
                        }
                    } catch (error) {
                        console.log("Common path expansion search failed:", error);
                    }
                }
            }
            
            // Common query parameter patterns for better matching
            const commonQueryParams = ['affiliateCode', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'category', 'brand', 'model', 'color', 'storage', 'price_min', 'price_max', 'k', 'q', 'query', 'search', 'ref', 'rh', 'qid', 'rnid', 'include', 'format', 'date', 'time', 'sort', 'order', 'limit', 'offset', 'page', 'size', 'filter', 'type', 'status', 'id', 'user', 'author', 'tag', 'lang', 'locale', 'currency', 'country', 'region', 'city'];
            if (commonQueryParams.includes(searchTerm.toLowerCase())) {
                const queryExpansions = [
                    `https://example.com/?${searchTerm}=`,
                    `https://www.example.com/?${searchTerm}=`,
                    `https://shop.example.com/?${searchTerm}=`,
                    `https://api.example.com/?${searchTerm}=`
                ];
                for (const exp of queryExpansions) {
                    const args = { ...searchArgs, search_term: exp };
                    try {
                        const r = await eventIndex!.search(args);
                        if (r && r.count && r.count > 0) {
                            localResult = r;
                            console.log(`Common query parameter expansion search returned ${r.count} results for ${exp}`);
                            break;
                        }
                    } catch (error) {
                        console.log("Common query parameter expansion search failed:", error);
                    }
                }
            }
        }

        // Strategy 9: Try subdomain extraction for complex URLs
        if (!localResult || localResult.count === 0) {
            if (searchTerm.includes('.')) {
                const domainParts = searchTerm.replace(/^https?:\/\//, '').split('.');
                if (domainParts.length >= 2) {
                    const mainDomain = domainParts.slice(-2).join('.');
                    const subdomain = domainParts[0];
                    
                    // Try main domain
                    const mainDomainArgs = { ...searchArgs, search_term: mainDomain };
                    try {
                        const r = await eventIndex!.search(mainDomainArgs);
                        if (r && r.count && r.count > 0) {
                            localResult = r;
                            console.log(`Main domain extraction search returned ${r.count} results for ${mainDomain}`);
                        }
                    } catch (error) {
                        console.log("Main domain extraction search failed:", error);
                    }

                    // Try subdomain if main domain didn't work
                    if (!localResult || localResult.count === 0) {
                        const subdomainArgs = { ...searchArgs, search_term: subdomain };
                        try {
                            const r = await eventIndex!.search(subdomainArgs);
                            if (r && r.count && r.count > 0) {
                                localResult = r;
                                console.log(`Subdomain extraction search returned ${r.count} results for ${subdomain}`);
                            }
                        } catch (error) {
                            console.log("Subdomain extraction search failed:", error);
                        }
                    }
                }
            }
        }
        
        // Strategy 10: Try exact match for single tokens that might be exact matches in URLs
        if ((!localResult || localResult.count === 0) && isSingleToken) {
            // For single tokens, try to find exact matches in URLs
            // This helps with cases like "laptop", "trading", "products", etc.
            try {
                const exactArgs = { ...searchArgs, search_term: searchTerm };
                const r = await eventIndex!.search(exactArgs);
                if (r && r.count && r.count > 0) {
                    localResult = r;
                    console.log(`Exact single token search returned ${r.count} results for "${searchTerm}"`);
                }
            } catch (error) {
                console.log("Exact single token search failed:", error);
            }
        }
        
        // Strategy 11: Try partial matching for any token (fallback for complex cases)
        if (!localResult || localResult.count === 0) {
            // Try partial matching by splitting the search term into smaller parts
            const words = searchTerm.split(/[\s\-_\.]+/).filter(word => word.length > 1);
            for (const word of words) {
                if (word !== searchTerm) { // Skip if it's the same as original
                    const partialArgs = { ...searchArgs, search_term: word };
                    try {
                        const r = await eventIndex!.search(partialArgs);
                        if (r && r.count && r.count > 0) {
                            localResult = r;
                            console.log(`Partial matching search returned ${r.count} results for "${word}"`);
                            break;
                        }
                    } catch (error) {
                        console.log("Partial matching search failed:", error);
                    }
                }
            }
        }
        
        // Strategy 12: Try case-insensitive variations
        if (!localResult || localResult.count === 0) {
            const variations = [
                searchTerm.toLowerCase(),
                searchTerm.toUpperCase(),
                searchTerm.charAt(0).toUpperCase() + searchTerm.slice(1).toLowerCase(),
            ];
            
            for (const variation of variations) {
                if (variation !== searchTerm) {
                    const variationArgs = { ...searchArgs, search_term: variation };
                    try {
                        const r = await eventIndex!.search(variationArgs);
                        if (r && r.count && r.count > 0) {
                            localResult = r;
                            console.log(`Case variation search returned ${r.count} results for "${variation}"`);
                            break;
                        }
                    } catch (error) {
                        console.log("Case variation search failed:", error);
                    }
                }
            }
        }
    }
    
    // Fallback to normal search if no enhanced results
    if (!localResult) {
        console.log("🔄 Falling back to normal search");
        try {
            localResult = await eventIndex!.search(searchArgs);
            console.log(`📈 Normal search returned: ${localResult?.count || 0} results`);
        } catch (error) {
            console.error("❌ Normal search failed:", error);
            throw error;
        }
    }
    
    if (!localResult) {
        console.error("❌ No search results returned");
        throw new Error("Local search failed");
    }
    
    console.log(`✅ Final search result: ${localResult.count} results found`);

    searchArgs.next_batch = localResult.next_batch;

    const result = {
        response: localResult,
        query: searchArgs,
    };

    return result;
}

export interface ISeshatSearchResults extends ISearchResults {
    seshatQuery?: ISearchArgs;
    cachedEvents?: ISearchResult[];
    oldestEventFrom?: "local" | "server";
    serverSideNextBatch?: string;
}

async function localSearchProcess(
    client: MatrixClient,
    searchTerm: string,
    roomId?: string,
): Promise<ISeshatSearchResults> {
    const emptyResult = {
        results: [],
        highlights: [],
    } as ISeshatSearchResults;

    if (searchTerm === "") return emptyResult;

    const result = await localSearch(searchTerm, roomId);

    emptyResult.seshatQuery = result.query;

    const response: ISearchResponse = {
        search_categories: {
            room_events: result.response,
        },
    };

    const processedResult = client.processRoomEventsSearch(emptyResult, response);
    // Restore our encryption info so we can properly re-verify the events.
    restoreEncryptionInfo(processedResult.results);

    return processedResult;
}

async function localPagination(
    client: MatrixClient,
    searchResult: ISeshatSearchResults,
): Promise<ISeshatSearchResults> {
    const eventIndex = EventIndexPeg.get();

    if (!searchResult.seshatQuery) {
        throw new Error("localSearchProcess must be called first");
    }

    const localResult = await eventIndex!.search(searchResult.seshatQuery);
    if (!localResult) {
        throw new Error("Local search pagination failed");
    }

    searchResult.seshatQuery.next_batch = localResult.next_batch;

    // We only need to restore the encryption state for the new results, so
    // remember how many of them we got.
    const newResultCount = localResult.results?.length ?? 0;

    const response = {
        search_categories: {
            room_events: localResult,
        },
    };

    const result = client.processRoomEventsSearch(searchResult, response);

    // Restore our encryption info so we can properly re-verify the events.
    const newSlice = result.results.slice(Math.max(result.results.length - newResultCount, 0));
    restoreEncryptionInfo(newSlice);

    searchResult.pendingRequest = undefined;

    return result;
}

function compareOldestEvents(firstResults: ISearchResult[], secondResults: ISearchResult[]): number {
    try {
        const oldestFirstEvent = firstResults[firstResults.length - 1].result;
        const oldestSecondEvent = secondResults[secondResults.length - 1].result;

        if (oldestFirstEvent.origin_server_ts <= oldestSecondEvent.origin_server_ts) {
            return -1;
        } else {
            return 1;
        }
    } catch {
        return 0;
    }
}

function combineEventSources(
    previousSearchResult: ISeshatSearchResults,
    response: IResultRoomEvents,
    a: ISearchResult[],
    b: ISearchResult[],
): void {
    // Merge event sources and sort the events.
    const combinedEvents = a.concat(b).sort(compareEvents);
    // Put half of the events in the response, and cache the other half.
    response.results = combinedEvents.slice(0, SEARCH_LIMIT);
    previousSearchResult.cachedEvents = combinedEvents.slice(SEARCH_LIMIT);
}

/**
 * Combine the events from our event sources into a sorted result
 *
 * This method will first be called from the combinedSearch() method. In this
 * case we will fetch SEARCH_LIMIT events from the server and the local index.
 *
 * The method will put the SEARCH_LIMIT newest events from the server and the
 * local index in the results part of the response, the rest will be put in the
 * cachedEvents field of the previousSearchResult (in this case an empty search
 * result).
 *
 * Every subsequent call will be made from the combinedPagination() method, in
 * this case we will combine the cachedEvents and the next SEARCH_LIMIT events
 * from either the server or the local index.
 *
 * Since we have two event sources and we need to sort the results by date we
 * need keep on looking for the oldest event. We are implementing a variation of
 * a sliding window.
 *
 * The event sources are here represented as two sorted lists where the smallest
 * number represents the newest event. The two lists need to be merged in a way
 * that preserves the sorted property so they can be shown as one search result.
 * We first fetch SEARCH_LIMIT events from both sources.
 *
 * If we set SEARCH_LIMIT to 3:
 *
 *  Server events [01, 02, 04, 06, 07, 08, 11, 13]
 *                |01, 02, 04|
 *  Local events  [03, 05, 09, 10, 12, 14, 15, 16]
 *                |03, 05, 09|
 *
 *  We note that the oldest event is from the local index, and we combine the
 *  results:
 *
 *  Server window [01, 02, 04]
 *  Local window  [03, 05, 09]
 *
 *  Combined events [01, 02, 03, 04, 05, 09]
 *
 *  We split the combined result in the part that we want to present and a part
 *  that will be cached.
 *
 *  Presented events [01, 02, 03]
 *  Cached events    [04, 05, 09]
 *
 *  We slide the window for the server since the oldest event is from the local
 *  index.
 *
 *  Server events [01, 02, 04, 06, 07, 08, 11, 13]
 *                            |06, 07, 08|
 *  Local events  [03, 05, 09, 10, 12, 14, 15, 16]
 *                |XX, XX, XX|
 *  Cached events [04, 05, 09]
 *
 *  We note that the oldest event is from the server and we combine the new
 *  server events with the cached ones.
 *
 *  Cached events [04, 05, 09]
 *  Server events [06, 07, 08]
 *
 *  Combined events [04, 05, 06, 07, 08, 09]
 *
 *  We split again.
 *
 *  Presented events [04, 05, 06]
 *  Cached events    [07, 08, 09]
 *
 *  We slide the local window, the oldest event is on the server.
 *
 *  Server events [01, 02, 04, 06, 07, 08, 11, 13]
 *                            |XX, XX, XX|
 *  Local events  [03, 05, 09, 10, 12, 14, 15, 16]
 *                            |10, 12, 14|
 *
 *  Cached events [07, 08, 09]
 *  Local events  [10, 12, 14]
 *  Combined events [07, 08, 09, 10, 12, 14]
 *
 *  Presented events [07, 08, 09]
 *  Cached events    [10, 12, 14]
 *
 *  Next up we slide the server window again.
 *
 *  Server events [01, 02, 04, 06, 07, 08, 11, 13]
 *                                        |11, 13|
 *  Local events  [03, 05, 09, 10, 12, 14, 15, 16]
 *                            |XX, XX, XX|
 *
 *  Cached events [10, 12, 14]
 *  Server events [11, 13]
 *  Combined events [10, 11, 12, 13, 14]
 *
 *  Presented events [10, 11, 12]
 *  Cached events    [13, 14]
 *
 *  We have one source exhausted, we fetch the rest of our events from the other
 *  source and combine it with our cached events.
 *
 *
 * @param {object} previousSearchResult A search result from a previous search
 * call.
 * @param {object} localEvents An unprocessed search result from the event
 * index.
 * @param {object} serverEvents An unprocessed search result from the server.
 *
 * @return {object} A response object that combines the events from the
 * different event sources.
 *
 */
function combineEvents(
    previousSearchResult: ISeshatSearchResults,
    localEvents?: IResultRoomEvents,
    serverEvents?: IResultRoomEvents,
): IResultRoomEvents {
    const response = {} as IResultRoomEvents;

    const cachedEvents = previousSearchResult.cachedEvents ?? [];
    let oldestEventFrom = previousSearchResult.oldestEventFrom;
    response.highlights = previousSearchResult.highlights;

    if (localEvents && serverEvents && serverEvents.results) {
        // This is a first search call, combine the events from the server and
        // the local index. Note where our oldest event came from, we shall
        // fetch the next batch of events from the other source.
        if (compareOldestEvents(localEvents.results ?? [], serverEvents.results) < 0) {
            oldestEventFrom = "local";
        }

        combineEventSources(previousSearchResult, response, localEvents.results ?? [], serverEvents.results);
        response.highlights = (localEvents.highlights ?? []).concat(serverEvents.highlights ?? []);
    } else if (localEvents) {
        // This is a pagination call fetching more events from the local index,
        // meaning that our oldest event was on the server.
        // Change the source of the oldest event if our local event is older
        // than the cached one.
        if (compareOldestEvents(localEvents.results ?? [], cachedEvents) < 0) {
            oldestEventFrom = "local";
        }
        combineEventSources(previousSearchResult, response, localEvents.results ?? [], cachedEvents);
    } else if (serverEvents && serverEvents.results) {
        // This is a pagination call fetching more events from the server,
        // meaning that our oldest event was in the local index.
        // Change the source of the oldest event if our server event is older
        // than the cached one.
        if (compareOldestEvents(serverEvents.results, cachedEvents) < 0) {
            oldestEventFrom = "server";
        }
        combineEventSources(previousSearchResult, response, serverEvents.results, cachedEvents);
    } else {
        // This is a pagination call where we exhausted both of our event
        // sources, let's push the remaining cached events.
        response.results = cachedEvents;
        previousSearchResult.cachedEvents = [];
    }

    previousSearchResult.oldestEventFrom = oldestEventFrom;

    return response;
}

/**
 * Combine the local and server search responses
 *
 * @param {object} previousSearchResult A search result from a previous search
 * call.
 * @param {object} localEvents An unprocessed search result from the event
 * index.
 * @param {object} serverEvents An unprocessed search result from the server.
 *
 * @return {object} A response object that combines the events from the
 * different event sources.
 */
function combineResponses(
    previousSearchResult: ISeshatSearchResults,
    localEvents?: IResultRoomEvents,
    serverEvents?: IResultRoomEvents,
): IResultRoomEvents {
    // Combine our events first.
    const response = combineEvents(previousSearchResult, localEvents, serverEvents);

    // Our first search will contain counts from both sources, subsequent
    // pagination requests will fetch responses only from one of the sources, so
    // reuse the first count when we're paginating.
    if (previousSearchResult.count) {
        response.count = previousSearchResult.count;
    } else {
        const localEventCount = localEvents?.count ?? 0;
        const serverEventCount = serverEvents?.count ?? 0;

        response.count = localEventCount + serverEventCount;
    }

    // Update our next batch tokens for the given search sources.
    if (localEvents && isNotUndefined(previousSearchResult.seshatQuery)) {
        previousSearchResult.seshatQuery.next_batch = localEvents.next_batch;
    }
    if (serverEvents) {
        previousSearchResult.serverSideNextBatch = serverEvents.next_batch;
    }

    // Set the response next batch token to one of the tokens from the sources,
    // this makes sure that if we exhaust one of the sources we continue with
    // the other one.
    if (previousSearchResult.seshatQuery?.next_batch) {
        response.next_batch = previousSearchResult.seshatQuery.next_batch;
    } else if (previousSearchResult.serverSideNextBatch) {
        response.next_batch = previousSearchResult.serverSideNextBatch;
    }

    // We collected all search results from the server as well as from Seshat,
    // we still have some events cached that we'll want to display on the next
    // pagination request.
    //
    // Provide a fake next batch token for that case.
    if (
        !response.next_batch &&
        isNotUndefined(previousSearchResult.cachedEvents) &&
        previousSearchResult.cachedEvents.length > 0
    ) {
        response.next_batch = "cached";
    }

    return response;
}

interface IEncryptedSeshatEvent {
    curve25519Key?: string;
    ed25519Key?: string;
    algorithm?: string;
    forwardingCurve25519KeyChain?: string[];
}

function restoreEncryptionInfo(searchResultSlice: SearchResult[] = []): void {
    for (const result of searchResultSlice) {
        const timeline = result.context.getTimeline();

        for (const mxEv of timeline) {
            const ev = mxEv.event as IEncryptedSeshatEvent;

            if (ev.curve25519Key) {
                mxEv.makeEncrypted(
                    EventType.RoomMessageEncrypted,
                    { algorithm: ev.algorithm },
                    ev.curve25519Key,
                    ev.ed25519Key!,
                );
                // @ts-ignore
                mxEv.forwardingCurve25519KeyChain = ev.forwardingCurve25519KeyChain;

                delete ev.curve25519Key;
                delete ev.ed25519Key;
                delete ev.algorithm;
                delete ev.forwardingCurve25519KeyChain;
            }
        }
    }
}

async function combinedPagination(
    client: MatrixClient,
    searchResult: ISeshatSearchResults,
): Promise<ISeshatSearchResults> {
    const eventIndex = EventIndexPeg.get();

    const searchArgs = searchResult.seshatQuery;
    const oldestEventFrom = searchResult.oldestEventFrom;

    let localResult: IResultRoomEvents | undefined;
    let serverSideResult: ISearchResponse | undefined;

    // Fetch events from the local index if we have a token for it and if it's
    // the local indexes turn or the server has exhausted its results.
    if (searchArgs?.next_batch && (!searchResult.serverSideNextBatch || oldestEventFrom === "server")) {
        localResult = await eventIndex!.search(searchArgs);
    }

    // Fetch events from the server if we have a token for it and if it's the
    // local indexes turn or the local index has exhausted its results.
    if (searchResult.serverSideNextBatch && (oldestEventFrom === "local" || !searchArgs?.next_batch)) {
        const body = { body: searchResult._query!, next_batch: searchResult.serverSideNextBatch };
        serverSideResult = await client.search(body);
    }

    const serverEvents: IResultRoomEvents | undefined = serverSideResult?.search_categories.room_events;

    // Combine our events.
    const combinedResult = combineResponses(searchResult, localResult, serverEvents);

    const response = {
        search_categories: {
            room_events: combinedResult,
        },
    };

    const oldResultCount = searchResult.results ? searchResult.results.length : 0;

    // Let the client process the combined result.
    const result = client.processRoomEventsSearch(searchResult, response);

    // Restore our encryption info so we can properly re-verify the events.
    const newResultCount = result.results.length - oldResultCount;
    const newSlice = result.results.slice(Math.max(result.results.length - newResultCount, 0));
    restoreEncryptionInfo(newSlice);

    searchResult.pendingRequest = undefined;

    return result;
}

async function eventIndexSearch(
    client: MatrixClient,
    term: string,
    roomId?: string,
    abortSignal?: AbortSignal,
): Promise<ISearchResults> {
    console.log(`🔍 eventIndexSearch called with term: "${term}", roomId: ${roomId || 'all'}`);
    
    let searchPromise: Promise<ISearchResults>;

    if (roomId !== undefined) {
        if (await client.getCrypto()?.isEncryptionEnabledInRoom(roomId)) {
            // The search is for a single encrypted room, use our local
            // search method.
            console.log("🔐 Using local search for encrypted room");
            searchPromise = localSearchProcess(client, term, roomId);
        } else {
            // The search is for a single non-encrypted room, use the
            // server-side search.
            console.log("🌐 Using server-side search for non-encrypted room");
            searchPromise = serverSideSearchProcess(client, term, roomId, abortSignal);
        }
    } else {
        // Search across all rooms, combine a server side search and a
        // local search.
        console.log("🔍 Using combined search across all rooms");
        searchPromise = combinedSearch(client, term, abortSignal);
    }

    return searchPromise;
}

function eventIndexSearchPagination(
    client: MatrixClient,
    searchResult: ISeshatSearchResults,
): Promise<ISeshatSearchResults> {
    const seshatQuery = searchResult.seshatQuery;
    const serverQuery = searchResult._query;

    if (!seshatQuery) {
        // This is a search in a non-encrypted room. Do the normal server-side
        // pagination.
        return client.backPaginateRoomEventsSearch(searchResult);
    } else if (!serverQuery) {
        // This is a search in a encrypted room. Do a local pagination.
        const promise = localPagination(client, searchResult);
        searchResult.pendingRequest = promise;

        return promise;
    } else {
        // We have both queries around, this is a search across all rooms so a
        // combined pagination needs to be done.
        const promise = combinedPagination(client, searchResult);
        searchResult.pendingRequest = promise;

        return promise;
    }
}

export function searchPagination(client: MatrixClient, searchResult: ISearchResults): Promise<ISearchResults> {
    const eventIndex = EventIndexPeg.get();

    if (searchResult.pendingRequest) return searchResult.pendingRequest;

    if (eventIndex === null) return client.backPaginateRoomEventsSearch(searchResult);
    else return eventIndexSearchPagination(client, searchResult);
}

export default function eventSearch(
    client: MatrixClient,
    term: string,
    roomId?: string,
    abortSignal?: AbortSignal,
): Promise<ISearchResults> {
    console.log(`🚀 eventSearch called with term: "${term}", roomId: ${roomId || 'all'}`);
    
    const eventIndex = EventIndexPeg.get();
    console.log(`📊 EventIndex available: ${eventIndex !== null}`);

    if (eventIndex === null) {
        console.log("🌐 Using server-side search only (no EventIndex)");
        return serverSideSearchProcess(client, term, roomId, abortSignal);
    } else {
        console.log("🔍 Using combined search (EventIndex + server-side)");
        return eventIndexSearch(client, term, roomId, abortSignal);
    }
}

/**
 * The scope for a message search, either in the current room or across all rooms.
 */
export enum SearchScope {
    Room = "Room",
    All = "All",
}

/**
 * Information about a message search in progress.
 */
export interface SearchInfo {
    /**
     * Opaque ID for this search.
     */
    searchId: number;
    /**
     * The room ID being searched, or undefined if searching all rooms.
     */
    roomId?: string;
    /**
     * The search term.
     */
    term: string;
    /**
     * The scope of the search.
     */
    scope: SearchScope;
    /**
     * The promise for the search results.
     */
    promise: Promise<ISearchResults>;
    /**
     * Controller for aborting the search.
     */
    abortController?: AbortController;
    /**
     * Whether the search is currently awaiting data from the backend.
     */
    inProgress?: boolean;
    /**
     * The total count of matching results as returned by the backend.
     */
    count?: number;
    /**
     * Describe the error if any occured.
     */
    error?: Error;
}
