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

// Enhanced search patterns for better URL and domain matching
const ENHANCED_SEARCH_PATTERNS = {
    // URL patterns
    FULL_URL: /^https?:\/\/[^\s]+$/i,
    DOMAIN_WITH_PATH: /^[^\s]+\.[^\s]+\/[^\s]*$/i,
    DOMAIN_ONLY: /^[^\s]+\.[^\s]+$/i,
    IP_ADDRESS: /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
    LOCALHOST: /^localhost(:\d+)?(\/.*)?$/i,
    
    // Enhanced patterns for better matching
    SUBDOMAIN: /^[a-z0-9]+\./i,
    PATH_SEGMENT: /^[a-z0-9-_]+$/i,
    QUERY_PARAM: /^[a-z0-9_]+$/i,
    
    // New patterns for better keyword extraction
    SINGLE_WORD: /^[a-z0-9]+$/i,
    MULTI_WORD: /^[a-z0-9\s]+$/i,
    SPECIAL_CHARS: /[^a-z0-9\s]/i,
};

// Enhanced keyword extraction function
function extractKeywordsFromUrl(url: string): string[] {
    const keywords: string[] = [];
    
    try {
        // Parse URL
        const urlObj = new URL(url);
        
        // Extract domain parts
        const domainParts = urlObj.hostname.split('.');
        keywords.push(...domainParts.filter(part => part.length > 1));
        
        // Extract path segments
        const pathSegments = urlObj.pathname.split('/').filter(segment => segment.length > 0);
        keywords.push(...pathSegments);
        
        // Extract query parameters
        urlObj.searchParams.forEach((value, key) => {
            if (key.length > 1) keywords.push(key);
            if (value.length > 1) keywords.push(value);
        });
        
        // Extract common TLDs and subdomains
        const commonTlds = ['com', 'org', 'net', 'io', 'app', 'co', 'vn'];
        const commonSubdomains = ['www', 'app', 'api', 'docs', 'blog'];
        
        domainParts.forEach(part => {
            if (!commonTlds.includes(part) && !commonSubdomains.includes(part)) {
                keywords.push(part);
            }
        });
        
    } catch (error) {
        // Fallback: simple text extraction
        const words = url.toLowerCase()
            .replace(/[^\w\s]/g, ' ')
            .split(/\s+/)
            .filter(word => word.length > 1);
        keywords.push(...words);
    }
    
    return [...new Set(keywords)]; // Remove duplicates
}

// Function to generate search variations for better matching
function generateSearchVariations(term: string): string[] {
    const variations: string[] = [];
    
    // Basic variations
    variations.push(term);
    variations.push(term.toLowerCase());
    variations.push(term.toUpperCase());
    variations.push(term.charAt(0).toUpperCase() + term.slice(1).toLowerCase());
    
    // Common domain variations
    const domainVariations = [
        `${term}.com`,
        `${term}.org`,
        `${term}.net`,
        `${term}.io`,
        `${term}.app`,
        `www.${term}.com`,
        `app.${term}.com`,
        `https://${term}.com`,
        `http://${term}.com`,
    ];
    variations.push(...domainVariations);
    
    // Substring variations (for partial matching)
    if (term.length > 3) {
        variations.push(`*${term}*`);
        variations.push(`%${term}%`);
        variations.push(`.*${term}.*`);
    }
    
    // Common service variations
    const serviceVariations = [
        `${term}app`,
        `${term}web`,
        `${term}site`,
        `${term}page`,
        `${term}link`,
        `${term}url`,
    ];
    variations.push(...serviceVariations);
    
    return [...new Set(variations)]; // Remove duplicates
}

// Enhanced relevance scoring function inspired by spotlight dialog
function calculateRelevanceScore(searchTerm: string, content: string): number {
    const lcSearchTerm = searchTerm.toLowerCase();
    const lcContent = content.toLowerCase();
    
    let relevanceScore = 0;
    
    // Exact match gets highest score
    if (lcContent.includes(lcSearchTerm)) {
        relevanceScore += 100;
    }
    
    // Word-based matching
    const searchWords = lcSearchTerm.split(/\s+/).filter(word => word.length > 0);
    const contentWords = lcContent.split(/\s+/).filter(word => word.length > 0);
    
    const hasWordMatch = searchWords.some(searchWord => 
        contentWords.some(contentWord => contentWord.includes(searchWord))
    );
    
    if (hasWordMatch) {
        relevanceScore += searchWords.length * 10;
    }
    
    // Additional relevance factors
    const searchLength = lcSearchTerm.length;
    const contentLength = lcContent.length;
    
    // Prefer shorter content for longer searches (more specific)
    if (searchLength > 5 && contentLength < 100) {
        relevanceScore += 20;
    }
    
    // Penalize very long content unless it has exact match
    if (contentLength > 200 && !lcContent.includes(lcSearchTerm)) {
        relevanceScore -= 10;
    }
    
    // Heavy penalty for single character matches
    const matchedWords = searchWords.filter(searchWord => 
        contentWords.some(contentWord => contentWord.includes(searchWord))
    );
    if (matchedWords.length === 1 && matchedWords[0].length <= 2) {
        relevanceScore -= 50;
    }
    
    // Penalize content with URLs unless it has exact match
    if (content.includes('http') && !lcContent.includes(lcSearchTerm)) {
        relevanceScore -= 30;
    }
    
    return relevanceScore;
}

// Enhanced search with relevance scoring
function enhancedSearchWithRelevance(searchTerm: string, content: string): boolean {
    const relevanceScore = calculateRelevanceScore(searchTerm, content);
    return relevanceScore >= 20; // Minimum threshold for relevance
}

// Enhanced search term analysis
function analyzeSearchTerm(term: string): {
    isUrlSearch: boolean;
    isUrl: boolean;
    isDomain: boolean;
    isSingleToken: boolean;
    keywords: string[];
    potentialDomains: string[];
} {
    const isUrl = Object.values(ENHANCED_SEARCH_PATTERNS).some(pattern => pattern.test(term)) ||
                  term.includes('.') || 
                  term.includes('://') || 
                  term.includes('/') ||
                  term.includes('?');
    
    const isSingleToken = ENHANCED_SEARCH_PATTERNS.SINGLE_WORD.test(term);
    const isDomain = term.includes('.') && !term.includes('://') && !term.includes('/');
    
    // Enhanced URL search detection
    const isUrlSearch = isUrl || isSingleToken || isDomain || term.includes('.') || term.includes('/');
    
    // Extract keywords from the term itself
    const keywords = extractKeywordsFromUrl(term);
    
    // Generate potential domains for single tokens
    const potentialDomains = isSingleToken ? [
        `${term}.com`,
        `${term}.vn`,
        `${term}.net`,
        `${term}.org`,
        `${term}.io`,
        `${term}.app`,
        `www.${term}.com`,
        `app.${term}.com`,
        `https://${term}.com`,
        `http://${term}.com`,
        `https://app.${term}.com`,
        `https://www.${term}.com`,
        `${term}.co`,
        `${term}.dev`,
        `${term}.me`,
    ] : [];
    
    return {
        isUrlSearch,
        isUrl,
        isDomain,
        isSingleToken,
        keywords,
        potentialDomains,
    };
}

async function serverSideSearch(
    client: MatrixClient,
    term: string,
    roomId?: string,
    abortSignal?: AbortSignal,
): Promise<{ response: ISearchResponse; query: ISearchRequestBody }> {
    const filter: IRoomEventFilter = {
        limit: SEARCH_LIMIT,
    };

    if (roomId !== undefined) filter.rooms = [roomId];

    // Use enhanced search term analysis
    const searchAnalysis = analyzeSearchTerm(term);
    const { isUrlSearch, isSingleToken, keywords, potentialDomains } = searchAnalysis;

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
        console.log(`Extracted keywords: ${keywords.join(', ')}`);
        
        // Try multiple search strategies for URLs or domain-like keywords
        const base = term;
        const withoutProtocol = term.replace(/^https?:\/\//, '');
        const domainOnly = term.match(/(?:https?:\/\/)?([^\/\s?#]+)/)?.[1] || term;
        const pathOnly = term.match(/(?:https?:\/\/[^\/]+)?(\/[^\s?#]*)/)?.[1] || term;
        const queryParam = term.match(/[?&]([^=]+)=([^&\s]+)/)?.[2] || term;
        const fragment = term.match(/#([^\s]+)/)?.[1] || term;

        // Use extracted keywords, potential domains, and search variations
        const searchVariations = generateSearchVariations(term);
        const searchTerms = [
            base,
            ...keywords.filter(k => k !== base && k.length > 1),
            ...potentialDomains,
            ...searchVariations.filter(v => v !== base && v !== term)
        ];

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

        const searchStrategies = [
            { term: base, description: "exact" },
            { term: withoutProtocol, description: "without protocol" },
            { term: domainOnly, description: "domain only" },
            { term: pathOnly, description: "path only" },
            { term: queryParam, description: "query parameter" },
            { term: fragment, description: "fragment" },
            ...searchTerms.map((t: string) => ({ term: t, description: "keyword/domain search" })),
            ...additionalStrategies,
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
                        // Apply relevance scoring to filter results
                        const relevantResults = results.filter(result => {
                            const content = result.result.content?.body || '';
                            return enhancedSearchWithRelevance(term, content);
                        });
                        
                        if (relevantResults.length > 0) {
                            strategyResponse.search_categories.room_events.results = relevantResults;
                            strategyResponse.search_categories.room_events.count = relevantResults.length;
                            console.log(`Server-side ${strategy.description} search with relevance scoring returned ${relevantResults.length} results`);
                            response = strategyResponse;
                            query = body;
                            break;
                        } else {
                            console.log(`Server-side ${strategy.description} search returned ${results.length} results but none were relevant`);
                        }
                    } else {
                        console.log(`Server-side ${strategy.description} search returned ${results?.length || 0} results`);
                    }
                } catch (error) {
                    console.log(`Server-side ${strategy.description} search failed:`, error);
                }
            }
        }
        
        // Additional server-side strategies for better partial matching
        if (!response) {
            const additionalServerStrategies = [
                { term: `*${term}*`, description: "wildcard search" },
                { term: `%${term}%`, description: "SQL-like wildcard" },
                { term: `.*${term}.*`, description: "regex-like search" },
                { term: term + '*', description: "prefix wildcard" },
                { term: '*' + term, description: "suffix wildcard" },
            ];
            
            for (const strategy of additionalServerStrategies) {
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

        response = await client.search({ body: body }, abortSignal);
        query = body;
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
    // Create two promises, one for the local search, one for the
    // server-side search.
    const serverSidePromise = serverSideSearch(client, searchTerm, undefined, abortSignal);
    const localPromise = localSearch(searchTerm);

    // Wait for both promises to resolve.
    await Promise.all([serverSidePromise, localPromise]);

    // Get both search results.
    const localResult = await localPromise;
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

    // Use enhanced search term analysis
    const searchAnalysis = analyzeSearchTerm(searchTerm);
    const { isUrlSearch, isSingleToken, keywords, potentialDomains } = searchAnalysis;
    
    let localResult;
    
    // Always try enhanced search for single tokens or URL-like terms
    if (isUrlSearch || isSingleToken) {
        console.log(`Enhanced search detected for term: "${searchTerm}"`);
        console.log(`Extracted keywords: ${keywords.join(', ')}`);
        
        // Strategy 1: Try exact search first
        try {
            localResult = await eventIndex!.search(searchArgs);
            console.log(`Exact search returned ${localResult?.count || 0} results`);
        } catch (error) {
            console.log("Exact search failed:", error);
        }
        
        // Strategy 1.5: Try searching with extracted keywords and relevance scoring
        if (!localResult || localResult.count === 0) {
            for (const keyword of keywords) {
                if (keyword !== searchTerm && keyword.length > 2) {
                    const keywordArgs = { ...searchArgs, search_term: keyword };
                    try {
                        const keywordResult = await eventIndex!.search(keywordArgs);
                        if (keywordResult?.count && keywordResult.count > 0) {
                            // Apply relevance scoring to filter results
                            if (keywordResult.results) {
                                const relevantResults = keywordResult.results.filter(result => {
                                    const content = result.result.content?.body || '';
                                    return enhancedSearchWithRelevance(searchTerm, content);
                                });
                                
                                if (relevantResults.length > 0) {
                                    keywordResult.results = relevantResults;
                                    keywordResult.count = relevantResults.length;
                                    localResult = keywordResult;
                                    console.log(`Keyword search with relevance scoring returned ${relevantResults.length} results for "${keyword}"`);
                                    break;
                                }
                            } else {
                                localResult = keywordResult;
                                console.log(`Keyword search returned ${keywordResult.count} results for "${keyword}"`);
                                break;
                            }
                        }
                    } catch (error) {
                        console.log(`Keyword search failed for "${keyword}":`, error);
                    }
                }
            }
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
        
        // Strategy 3: Try domain-only and subdomain searches
        if (!localResult || localResult.count === 0) {
            // First try domain-only search
            const domainMatch = searchTerm.match(/(?:https?:\/\/)?([^\/\s?#]+)/);
            if (domainMatch && domainMatch[1]) {
                // Try exact domain match
                const domainArgs = { ...searchArgs, search_term: domainMatch[1] };
                try {
                    localResult = await eventIndex!.search(domainArgs);
                    console.log(`Domain-only search returned ${localResult?.count || 0} results`);
                } catch (error) {
                    console.log("Domain-only search failed:", error);
                }

                // Try each subdomain segment separately
                if (!localResult || localResult.count === 0) {
                    const domainParts = domainMatch[1].split('.');
                    for (const part of domainParts) {
                        if (part !== 'com' && part !== 'org' && part !== 'net' && part !== 'io' && part !== 'www') {
                            const subdomainArgs = { ...searchArgs, search_term: part };
                            try {
                                const subResult = await eventIndex!.search(subdomainArgs);
                                if (subResult?.count && subResult.count > 0) {
                                    localResult = subResult;
                                    console.log(`Subdomain search returned ${subResult.count} results for "${part}"`);
                                    break;
                                }
                            } catch (error) {
                                console.log(`Subdomain search failed for "${part}":`, error);
                            }
                        }
                    }
                }
            }
        }
        
        // Strategy 4: Try path and individual path segments search
        if (!localResult || localResult.count === 0) {
            // First try the full path
            const pathMatch = searchTerm.match(/(?:https?:\/\/[^\/]+)?(\/[^\s?#]*)/);
            if (pathMatch && pathMatch[1]) {
                const pathArgs = { ...searchArgs, search_term: pathMatch[1] };
                try {
                    localResult = await eventIndex!.search(pathArgs);
                    console.log(`Full path search returned ${localResult?.count || 0} results`);
                } catch (error) {
                    console.log("Full path search failed:", error);
                }

                // If no results, try individual path segments
                if (!localResult?.count || localResult.count === 0) {
                    const pathSegments = pathMatch[1].split('/').filter(s => s.length > 0);
                    for (const segment of pathSegments) {
                        if (segment && !/^(v\d+|api|rest|docs?|www)$/i.test(segment)) {
                            const segmentArgs = { ...searchArgs, search_term: segment };
                            try {
                                const segResult = await eventIndex!.search(segmentArgs);
                                if (segResult?.count && segResult.count > 0) {
                                    localResult = segResult;
                                    console.log(`Path segment search returned ${segResult.count} results for "${segment}"`);
                                    break;
                                }
                            } catch (error) {
                                console.log(`Path segment search failed for "${segment}":`, error);
                            }
                        }
                    }
                }
            }
        }
        
        // Strategy 5: Try query parameter search
        if (!localResult || localResult.count === 0) {
            // Try searching for query parameter names and values
            const queryParams = searchTerm.includes('?') ? 
                new URLSearchParams(searchTerm.split('?')[1]) : 
                new URLSearchParams(searchTerm);

            for (const [key, value] of queryParams.entries()) {
                // Skip common technical parameters
                if (!/^(v\d+|format|version|api|type|callback|jsonp)$/i.test(key)) {
                    // Try the parameter name
                    const keyArgs = { ...searchArgs, search_term: key };
                    try {
                        const keyResult = await eventIndex!.search(keyArgs);
                        if (keyResult?.count && keyResult.count > 0) {
                            localResult = keyResult;
                            console.log(`Query parameter key search returned ${keyResult.count} results for "${key}"`);
                            break;
                        }
                    } catch (error) {
                        console.log(`Query parameter key search failed for "${key}":`, error);
                    }

                    // Try the parameter value if it's meaningful
                    if (value && value.length > 2 && !/^(true|false|null|undefined|\d+)$/i.test(value)) {
                        const valueArgs = { ...searchArgs, search_term: value };
                        try {
                            const valueResult = await eventIndex!.search(valueArgs);
                            if (valueResult?.count && valueResult.count > 0) {
                                localResult = valueResult;
                                console.log(`Query parameter value search returned ${valueResult.count} results for "${value}"`);
                                break;
                            }
                        } catch (error) {
                            console.log(`Query parameter value search failed for "${value}":`, error);
                        }
                    }
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
        
        // Strategy 10: Try fuzzy matching for single tokens
        if (!localResult || localResult.count === 0) {
            if (isSingleToken) {
                // Try partial matches and common variations
                const fuzzyTerms = [
                    searchTerm.toLowerCase(),
                    searchTerm.toUpperCase(),
                    searchTerm.charAt(0).toUpperCase() + searchTerm.slice(1),
                    searchTerm + 'app',
                    searchTerm + 'web',
                    searchTerm + 'site',
                    searchTerm + 'page',
                ];
                
                for (const fuzzyTerm of fuzzyTerms) {
                    const fuzzyArgs = { ...searchArgs, search_term: fuzzyTerm };
                    try {
                        const fuzzyResult = await eventIndex!.search(fuzzyArgs);
                        if (fuzzyResult?.count && fuzzyResult.count > 0) {
                            localResult = fuzzyResult;
                            console.log(`Fuzzy search returned ${fuzzyResult.count} results for "${fuzzyTerm}"`);
                            break;
                        }
                    } catch (error) {
                        console.log(`Fuzzy search failed for "${fuzzyTerm}":`, error);
                    }
                }
            }
        }
        
        // Strategy 11: Try substring search for better partial matching
        if (!localResult || localResult.count === 0) {
            // Try searching with wildcard-like patterns
            const substringPatterns = [
                `*${searchTerm}*`,
                `%${searchTerm}%`,
                `.*${searchTerm}.*`,
                searchTerm + '*',
                '*' + searchTerm,
            ];
            
            for (const pattern of substringPatterns) {
                const patternArgs = { ...searchArgs, search_term: pattern };
                try {
                    const patternResult = await eventIndex!.search(patternArgs);
                    if (patternResult?.count && patternResult.count > 0) {
                        localResult = patternResult;
                        console.log(`Substring pattern search returned ${patternResult.count} results for "${pattern}"`);
                        break;
                    }
                } catch (error) {
                    console.log(`Substring pattern search failed for "${pattern}":`, error);
                }
            }
        }
        
        // Strategy 12: Try searching with common URL patterns that might contain the term
        if (!localResult || localResult.count === 0) {
            const urlPatterns = [
                `https://*${searchTerm}*`,
                `http://*${searchTerm}*`,
                `*${searchTerm}*.com`,
                `*${searchTerm}*.org`,
                `*${searchTerm}*.net`,
                `*${searchTerm}*.io`,
                `*${searchTerm}*.app`,
            ];
            
            for (const urlPattern of urlPatterns) {
                const urlArgs = { ...searchArgs, search_term: urlPattern };
                try {
                    const urlResult = await eventIndex!.search(urlArgs);
                    if (urlResult?.count && urlResult.count > 0) {
                        localResult = urlResult;
                        console.log(`URL pattern search returned ${urlResult.count} results for "${urlPattern}"`);
                        break;
                    }
                } catch (error) {
                    console.log(`URL pattern search failed for "${urlPattern}":`, error);
                }
            }
        }
        
        // Strategy 13: Try searching with all generated variations
        if (!localResult || localResult.count === 0) {
            const allVariations = generateSearchVariations(searchTerm);
            console.log(`Trying ${allVariations.length} search variations for "${searchTerm}"`);
            
            for (const variation of allVariations) {
                if (variation !== searchTerm) {
                    const variationArgs = { ...searchArgs, search_term: variation };
                    try {
                        const variationResult = await eventIndex!.search(variationArgs);
                        if (variationResult?.count && variationResult.count > 0) {
                            localResult = variationResult;
                            console.log(`Variation search returned ${variationResult.count} results for "${variation}"`);
                            break;
                        }
                    } catch (error) {
                        console.log(`Variation search failed for "${variation}":`, error);
                    }
                }
            }
        }
        
        // Strategy 14: Try fuzzy matching with word-based search (inspired by spotlight dialog)
        if (!localResult || localResult.count === 0) {
            const searchWords = searchTerm.toLowerCase().split(/\s+/).filter(word => word.length > 1);
            
            for (const word of searchWords) {
                if (word.length >= 2) {
                    const wordArgs = { ...searchArgs, search_term: word };
                    try {
                        const wordResult = await eventIndex!.search(wordArgs);
                        if (wordResult?.count && wordResult.count > 0) {
                            // Apply relevance scoring to filter results
                            if (wordResult.results) {
                                const relevantResults = wordResult.results.filter(result => {
                                    const content = result.result.content?.body || '';
                                    return enhancedSearchWithRelevance(searchTerm, content);
                                });
                                
                                if (relevantResults.length > 0) {
                                    wordResult.results = relevantResults;
                                    wordResult.count = relevantResults.length;
                                    localResult = wordResult;
                                    console.log(`Fuzzy word search with relevance scoring returned ${relevantResults.length} results for "${word}"`);
                                    break;
                                }
                            } else {
                                localResult = wordResult;
                                console.log(`Fuzzy word search returned ${wordResult.count} results for "${word}"`);
                                break;
                            }
                        }
                    } catch (error) {
                        console.log(`Fuzzy word search failed for "${word}":`, error);
                    }
                }
            }
        }
        
        // Strategy 15: Try broad search with lower relevance threshold (fallback)
        if (!localResult || localResult.count === 0) {
            console.log(`Trying broad search with lower relevance threshold for "${searchTerm}"`);
            
            // Try with a broader search term
            const broadTerms = [
                searchTerm.substring(0, Math.max(3, Math.floor(searchTerm.length * 0.7))), // 70% of original term
                searchTerm.substring(0, Math.max(2, Math.floor(searchTerm.length * 0.5))), // 50% of original term
            ];
            
            for (const broadTerm of broadTerms) {
                if (broadTerm.length >= 2 && broadTerm !== searchTerm) {
                    const broadArgs = { ...searchArgs, search_term: broadTerm };
                    try {
                        const broadResult = await eventIndex!.search(broadArgs);
                        if (broadResult?.count && broadResult.count > 0) {
                            // Apply lower relevance threshold for broad search
                            if (broadResult.results) {
                                const relevantResults = broadResult.results.filter(result => {
                                    const content = result.result.content?.body || '';
                                    const relevanceScore = calculateRelevanceScore(searchTerm, content);
                                    return relevanceScore >= 10; // Lower threshold for broad search
                                });
                                
                                if (relevantResults.length > 0) {
                                    broadResult.results = relevantResults;
                                    broadResult.count = relevantResults.length;
                                    localResult = broadResult;
                                    console.log(`Broad search with lower threshold returned ${relevantResults.length} results for "${broadTerm}"`);
                                    break;
                                }
                            } else {
                                localResult = broadResult;
                                console.log(`Broad search returned ${broadResult.count} results for "${broadTerm}"`);
                                break;
                            }
                        }
                    } catch (error) {
                        console.log(`Broad search failed for "${broadTerm}":`, error);
                    }
                }
            }
        }
    }
    
    // Fallback to normal search if no enhanced results
    if (!localResult) {
        console.log("Falling back to normal search");
        localResult = await eventIndex!.search(searchArgs);
    }
    
    if (!localResult) {
        throw new Error("Local search failed");
    }

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
    let searchPromise: Promise<ISearchResults>;

    if (roomId !== undefined) {
        if (await client.getCrypto()?.isEncryptionEnabledInRoom(roomId)) {
            // The search is for a single encrypted room, use our local
            // search method.
            searchPromise = localSearchProcess(client, term, roomId);
        } else {
            // The search is for a single non-encrypted room, use the
            // server-side search.
            searchPromise = serverSideSearchProcess(client, term, roomId, abortSignal);
        }
    } else {
        // Search across all rooms, combine a server side search and a
        // local search.
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
    const eventIndex = EventIndexPeg.get();

    if (eventIndex === null) {
        return serverSideSearchProcess(client, term, roomId, abortSignal);
    } else {
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
