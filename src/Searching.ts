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
    type Room,
    KnownMembership,
} from "matrix-js-sdk/src/matrix";

import { type ISearchArgs } from "./indexing/BaseEventIndexManager";
import EventIndexPeg from "./indexing/EventIndexPeg";
import { isNotUndefined } from "./Typeguards";

const SEARCH_LIMIT = 500; // Giảm xuống 500 để cân bằng hiệu suất và kết quả
const FAST_SEARCH_LIMIT = 100; // Limit thấp hơn cho tìm kiếm nhanh
const MAX_SEARCH_STRATEGIES = 5; // Giới hạn số strategies để tránh chậm

// Cache cho search results
const searchCache = new Map<string, { results: any; timestamp: number }>();
const CACHE_DURATION = 5 * 60 * 1000; // 5 phút
const MAX_CACHE_SIZE = 50;

// Debounce timer
let searchDebounceTimer: NodeJS.Timeout | null = null;
const DEBOUNCE_DELAY = 300; // Giảm xuống 300ms để tránh xung đột với RoomView debounce (800ms)

// Temporary debug room ID to avoid linting errors - can be removed in future cleanup
const DEBUG_ROOM_ID = "";

// Dynamic limits based on room size and search complexity
function calculateDynamicLimits(term: string, roomId?: string): { limit: number; maxPages: number; strategies: number } {
    // Tránh search với từ quá ngắn để cải thiện UX
    if (term.length <= 1) {
        return { limit: 10, maxPages: 1, strategies: 1 };
    }
    
    const isSimpleSearch = term.length <= 3 || !term.includes(' ');
    const hasSpecialFilter = term.includes('sender:') || term.includes('http');
    
    if (isSimpleSearch && !hasSpecialFilter) {
        return { limit: FAST_SEARCH_LIMIT, maxPages: 5, strategies: 3 };
    }
    
    if (roomId) {
        // Room-specific search có thể nhanh hơn
        return { limit: SEARCH_LIMIT * 0.7, maxPages: 10, strategies: MAX_SEARCH_STRATEGIES };
    }
    
    return { limit: SEARCH_LIMIT, maxPages: 20, strategies: MAX_SEARCH_STRATEGIES };
}

// Cache management functions
function getCachedResult(key: string): any | null {
    const cached = searchCache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
        return cached.results;
    }
    searchCache.delete(key);
    return null;
}

function setCachedResult(key: string, results: any): void {
    if (searchCache.size >= MAX_CACHE_SIZE) {
        // Remove oldest entries
        const entries = Array.from(searchCache.entries());
        entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
        for (let i = 0; i < 10; i++) {
            searchCache.delete(entries[i][0]);
        }
    }
    searchCache.set(key, { results, timestamp: Date.now() });
}

// Parse "sender:<userId>" token anywhere in the term and return remaining keyword
function extractSenderFilter(rawTerm: string): { senderId?: string; keyword: string } {
    if (!rawTerm) return { keyword: "" };
    const parts = rawTerm.split(/\s+/).filter(Boolean);
    let senderId: string | undefined;
    const rest: string[] = [];
    for (const p of parts) {
        if (!senderId && p.toLowerCase().startsWith("sender:")) {
            senderId = p.substring(7);
        } else {
            rest.push(p);
        }
    }
    return { senderId, keyword: rest.join(" ") };
}

// Collect ALL messages of a sender in a room from Seshat (local index), paginating to exhaustion
async function fetchAllSenderMessagesSeshat(
    client: MatrixClient,
    senderId: string,
    roomId: string,
    keyword?: string,
): Promise<{ response: ISearchResponse; query: ISearchArgs }> {
    // Sử dụng keyword nếu có, nếu không thì dùng wildcard
    const searchTerm = keyword && keyword.trim() ? keyword.trim() : "*";
    console.log(`fetchAllSenderMessagesSeshat: senderId=${senderId}, keyword="${keyword || ''}", searchTerm="${searchTerm}"`);
    
    // Check cache first - include keyword in cache key
    const cacheKey = `seshat_${senderId}_${roomId}_${searchTerm}`;
    const cached = getCachedResult(cacheKey);
    if (cached) {
        console.log("Returning cached Seshat results");
        return cached;
    }

    let eventIndex = EventIndexPeg.get();
    if (!eventIndex) {
        const initialized = await EventIndexPeg.init();
        if (!initialized) throw new Error("EventIndex (Seshat) not available");
        eventIndex = EventIndexPeg.get();
    }

    const dynamicLimits = calculateDynamicLimits(searchTerm, roomId);
    const baseQuery: ISearchArgs = {
        search_term: searchTerm,
        before_limit: 0,
        after_limit: 0,
        limit: dynamicLimits.limit,
        order_by_recency: true,
        room_id: roomId,
    };

    const collected: any[] = [];
    const seenEventIds = new Set<string>();
    let nextBatch: string | undefined;
    let pageCount = 0;
    const MAX_PAGES = dynamicLimits.maxPages; // Sử dụng dynamic limit

    // First page - luôn dùng wildcard search
    let first = await eventIndex!.search(baseQuery);
    if (first?.results) {
        const filtered = first.results.filter(r => {
            const eventId = r.result?.event_id;
            if (!eventId || seenEventIds.has(eventId)) return false;
            if (r.result?.sender === senderId) {
                seenEventIds.add(eventId);
                return true;
            }
            return false;
        });
        collected.push(...filtered);
    }
    nextBatch = first?.next_batch;

    // Loop through all pages to get complete history
    while (nextBatch && pageCount < MAX_PAGES) {
        pageCount++;
        const pageQuery: ISearchArgs = { ...baseQuery, next_batch: nextBatch };
        try {
            const page = await eventIndex!.search(pageQuery);
            if (!page) break;
            
            if (page.results) {
                const filtered = page.results.filter(r => {
                    const eventId = r.result?.event_id;
                    if (!eventId || seenEventIds.has(eventId)) return false;
                    if (r.result?.sender === senderId) {
                        seenEventIds.add(eventId);
                        return true;
                    }
                    return false;
                });
                collected.push(...filtered);
                
            }
            nextBatch = page.next_batch;
        } catch (e) {
            console.warn(`fetchAllSenderMessagesSeshat: page ${pageCount} failed:`, e);
            break;
        }
    }


    const response: ISearchResponse = {
        search_categories: {
            room_events: {
                results: collected,
                count: collected.length,
                highlights: [], // Seshat sẽ được xử lý highlights ở frontend
            } as any,
        },
    };

    const result = { response, query: baseQuery };
    
    // Cache the result
    setCachedResult(cacheKey, result);
    
    return result;
}

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
    
    // Partial word matching - tìm từ chứa search term như "sagua" trong "Saguaro"
    const searchWords = lcSearchTerm.split(/\s+/).filter(word => word.length > 0);
    const contentWords = lcContent.split(/\s+/).filter(word => word.length > 0);
    
    // Kiểm tra exact word match
    const hasExactWordMatch = searchWords.some(searchWord => 
        contentWords.some(contentWord => contentWord === searchWord)
    );
    
    // Kiểm tra partial word match (search word là substring của content word)
    const hasPartialWordMatch = searchWords.some(searchWord => 
        contentWords.some(contentWord => contentWord.includes(searchWord))
    );
    
    // Kiểm tra reverse partial match (content word là substring của search word)
    const hasReversePartialMatch = searchWords.some(searchWord => 
        contentWords.some(contentWord => searchWord.includes(contentWord) && contentWord.length >= 3)
    );
    
    if (hasExactWordMatch) {
        relevanceScore += searchWords.length * 15; // Cao hơn cho exact match
    } else if (hasPartialWordMatch) {
        relevanceScore += searchWords.length * 12; // Điểm cao cho partial match
    } else if (hasReversePartialMatch) {
        relevanceScore += searchWords.length * 8; // Điểm thấp hơn cho reverse match
    }
    
    // Bonus cho partial matching với độ dài phù hợp
    const searchLength = lcSearchTerm.length;
    const contentLength = lcContent.length;
    
    // Tăng điểm cho partial match khi search term đủ dài (>= 4 chars)
    if (searchLength >= 4 && hasPartialWordMatch) {
        relevanceScore += 15;
    }
    
    // Tăng điểm cho search term ngắn nhưng có trong content
    if (searchLength >= 3 && searchLength <= 6 && hasPartialWordMatch) {
        relevanceScore += 10;
    }
    
    // Prefer shorter content for longer searches (more specific)
    if (searchLength > 5 && contentLength < 100) {
        relevanceScore += 20;
    }
    
    // Giảm penalty cho long content nếu có partial match
    if (contentLength > 200 && !lcContent.includes(lcSearchTerm) && !hasPartialWordMatch) {
        relevanceScore -= 10;
    }
    
    // Giảm penalty cho single character matches khi có partial matching
    const matchedWords = searchWords.filter(searchWord => 
        contentWords.some(contentWord => contentWord.includes(searchWord))
    );
    if (matchedWords.length === 1 && matchedWords[0].length <= 2 && !hasPartialWordMatch) {
        relevanceScore -= 30; // Giảm penalty từ 50 xuống 30
    }
    
    // Giảm penalty cho URLs nếu có partial match
    if (content.includes('http') && !lcContent.includes(lcSearchTerm) && !hasPartialWordMatch) {
        relevanceScore -= 20; // Giảm penalty từ 30 xuống 20
    }
    
    return relevanceScore;
}

// Enhanced search with relevance scoring
function enhancedSearchWithRelevance(searchTerm: string, content: string): boolean {
    const relevanceScore = calculateRelevanceScore(searchTerm, content);
    // Giảm threshold để cho phép nhiều partial matches hơn
    const threshold = searchTerm.length >= 4 ? 10 : 15; // Threshold thấp hơn cho search term dài
    return relevanceScore >= threshold;
}

// Timeline search helper function (inspired by spotlight dialog)
function searchInTimeline(
    client: MatrixClient,
    searchTerm: string,
    roomId?: string,
): { found: boolean; message?: string } {
    const lcSearchTerm = searchTerm.toLowerCase();
    
    // Skip search if query is too short - tăng lên 3 để tránh search quá sớm
    if (lcSearchTerm.length < 3) {
        return { found: false };
    }
    
    // Get rooms to search
    let rooms: Room[];
    if (roomId) {
        const room = client.getRoom(roomId);
        rooms = room ? [room] : [];
    } else {
        // Get all rooms the user is in (like spotlight dialog)
        rooms = client.getVisibleRooms().filter(room => 
            room.getMyMembership() === KnownMembership.Join
        );
    }
    
    
    // Process rooms
    for (const room of rooms) {
        try {
            // Get recent messages from the room timeline (like spotlight dialog)
            const timeline = room.getLiveTimeline();
            const events = timeline?.getEvents() || [];
            
            if (events.length === 0) {
                continue;
            }
            
            
            // Process events in reverse order (newest first) for better performance
            for (let i = events.length - 1; i >= 0; i--) {
                const event = events[i];
                
                try {
                    // Bỏ qua tin nhắn đã xóa (redacted messages)
                    if (event.isRedacted?.()) {
                        continue;
                    }
                    
                    if (event.getType() === "m.room.message") {
                        const content = event.getContent();
                        // Only process text messages, skip files, images, etc.
                        if (content && content.body && typeof content.body === 'string' && 
                            content.msgtype === 'm.text' && 
                            !content.url && 
                            !content.info) {
                            const messageText = content.body.toLowerCase();
                            
                            // Check if message contains the query (case insensitive)
                            const hasExactMatch = messageText.includes(lcSearchTerm);
                            
                            // Enhanced word matching with partial support
                            const queryWords = lcSearchTerm.split(/\s+/).filter(word => word.length > 0);
                            const messageWords = messageText.split(/\s+/).filter(word => word.length > 0);
                            
                            const hasExactWordMatch = queryWords.some((queryWord: string) => 
                                messageWords.some((messageWord: string) => messageWord === queryWord)
                            );
                            
                            const hasPartialWordMatch = queryWords.some((queryWord: string) => 
                                messageWords.some((messageWord: string) => messageWord.includes(queryWord))
                            );
                            
                            // Chỉ chấp nhận partial match nếu query đủ dài (>= 3 chars)
                            const isValidPartialMatch = lcSearchTerm.length >= 3 && hasPartialWordMatch;
                            
                            if (hasExactMatch || hasExactWordMatch || isValidPartialMatch) {
                                return { found: true, message: content.body };
                            }
                        }
                    }
                } catch (eventError) {
                    console.error(`Error processing event in room ${room.name}:`, eventError);
                }
            }
            
        } catch (roomError) {
            console.error(`Error processing room ${room.name}:`, roomError);
        }
    }
    
    return { found: false };
}

// Enhanced timeline search function for thorough partial matching
async function enhancedTimelineSearch(
    client: MatrixClient,
    searchTerm: string,
    roomId?: string,
): Promise<{ results: any[] }> {
    const lcSearchTerm = searchTerm.toLowerCase();
    const results: any[] = [];
    
    // Skip search if query is too short - tăng lên để tránh search quá sớm
    if (lcSearchTerm.length < 3) {
        return { results: [] };
    }
    
    console.log(`Enhanced timeline search for: "${searchTerm}"`);
    
    // Get rooms to search
    let rooms: Room[];
    if (roomId) {
        const room = client.getRoom(roomId);
        rooms = room ? [room] : [];
    } else {
        // Get all rooms the user is in
        rooms = client.getVisibleRooms().filter(room => 
            room.getMyMembership() === KnownMembership.Join
        ).slice(0, 20); // Giới hạn 20 phòng để tránh quá chậm
    }
    
    console.log(`Searching in ${rooms.length} rooms`);
    
    // Process rooms with pagination
    for (const room of rooms) {
        try {
            const timeline = room.getLiveTimeline();
            if (!timeline) continue;
            
            const seenEventIds = new Set<string>();
            let paginationCount = 0;
            const MAX_PAGINATION = roomId ? 50 : 10; // Nhiều hơn nếu search trong 1 phòng
            
            const collectMatches = (events: any[]) => {
                for (let i = events.length - 1; i >= 0; i--) {
                    const event = events[i];
                    
                    try {
                        const eventId = event?.getId?.() || event?.event_id;
                        if (!eventId || seenEventIds.has(eventId)) continue;
                        seenEventIds.add(eventId);
                        
                        // Skip redacted messages
                        if (event.isRedacted?.()) continue;
                        
                        if (event.getType() === "m.room.message") {
                            const content = event.getContent();
                            if (content && content.body && typeof content.body === 'string' && 
                                content.msgtype === 'm.text' && !content.url && !content.info) {
                                
                                // Enhanced partial matching
                                const hasPartialMatch = enhancedSearchWithRelevance(searchTerm, content.body);
                                
                                if (hasPartialMatch) {
                                    console.log(`Found partial match in room ${room.name}: "${content.body}"`);
                                    
                                    // Create a proper search result
                                    results.push({
                                        rank: 1,
                                        result: {
                                            event_id: eventId,
                                            origin_server_ts: event.getTs(),
                                            sender: event.getSender(),
                                            content: content,
                                            type: event.getType(),
                                            room_id: room.roomId,
                                        },
                                        context: {
                                            events_before: [],
                                            events_after: [],
                                        },
                                    });
                                    
                                    // Giới hạn kết quả để tránh quá nhiều
                                    if (results.length >= 20) {
                                        console.log(`Enhanced timeline search reached limit of 20 results`);
                                        return { results };
                                    }
                                }
                            }
                        }
                    } catch (eventError) {
                        console.error(`Error processing event in room ${room.name}:`, eventError);
                    }
                }
            };
            
            // Collect from initial events
            const initialEvents = timeline.getEvents() || [];
            collectMatches(initialEvents);
            
            // Paginate backwards for more history
            while (paginationCount < MAX_PAGINATION && results.length < 20) {
                const prevCount = results.length;
                const hasMoreToken = !!timeline.getPaginationToken("b" as any);
                
                if (!hasMoreToken) break;
                
                try {
                    paginationCount++;
                    // eslint-disable-next-line @typescript-eslint/await-thenable
                    await (client as any).paginateEventTimeline?.(timeline, { backwards: true, limit: 100 });
                    const pageEvents = timeline.getEvents() || [];
                    collectMatches(pageEvents);
                    
                    // If no new results after pagination, break
                    if (results.length === prevCount) {
                        break;
                    }
                } catch (e) {
                    console.warn(`Enhanced timeline search pagination failed at page ${paginationCount}:`, e);
                    break;
                }
            }
            
        } catch (roomError) {
            console.error(`Error processing room ${room.name}:`, roomError);
        }
    }
    
    console.log(`Enhanced timeline search found ${results.length} total results`);
    return { results };
}

// Generate related terms for Vietnamese search
function generateRelatedTerms(term: string): string[] {
    const relatedTerms: string[] = [];
    const lowerTerm = term.toLowerCase();
    
    // Thêm các biến thể có dấu và không dấu
    const normalizedTerm = term.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (normalizedTerm !== term) {
        relatedTerms.push(normalizedTerm);
        relatedTerms.push(normalizedTerm.toLowerCase());
        relatedTerms.push(normalizedTerm.toUpperCase());
    }
    
    // Thêm các từ khóa liên quan cho từ "nạp"
    if (lowerTerm.includes('nạp') || lowerTerm.includes('nap')) {
        relatedTerms.push('nạp tiền');
        relatedTerms.push('nap tien');
        relatedTerms.push('nạp');
        relatedTerms.push('nap');
        relatedTerms.push('deposit');
        relatedTerms.push('recharge');
        relatedTerms.push('top up');
        relatedTerms.push('topup');
    }
    
    // Thêm các từ khóa liên quan cho từ "tiền"
    if (lowerTerm.includes('tiền') || lowerTerm.includes('tien')) {
        relatedTerms.push('money');
        relatedTerms.push('cash');
        relatedTerms.push('fund');
        relatedTerms.push('balance');
        relatedTerms.push('số dư');
        relatedTerms.push('so du');
    }
    
    // Thêm các từ khóa liên quan cho từ "tài khoản"
    if (lowerTerm.includes('tài khoản') || lowerTerm.includes('tai khoan') || lowerTerm.includes('tk')) {
        relatedTerms.push('account');
        relatedTerms.push('wallet');
        relatedTerms.push('ví');
        relatedTerms.push('vi');
    }
    
    // Loại bỏ các từ trùng lặp
    return [...new Set(relatedTerms)].filter(t => t !== term);
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

// Fetch all messages of a sender in a room by paginating server search until exhaustion
async function fetchAllSenderMessagesServer(
    client: MatrixClient,
    senderId: string,
    roomId: string,
    abortSignal?: AbortSignal,
    keyword?: string,
): Promise<{ response: ISearchResponse; query: ISearchRequestBody }> {
    // Sử dụng keyword nếu có, nếu không thì dùng wildcard
    const serverSearchTerm = keyword && keyword.trim() ? keyword.trim() : "*";
    console.log(`fetchAllSenderMessagesServer: senderId=${senderId}, keyword="${keyword || ''}", searchTerm="${serverSearchTerm}"`);
    
    const baseBody: ISearchRequestBody = {
        search_categories: {
            room_events: {
                search_term: serverSearchTerm,
                filter: {
                    limit: SEARCH_LIMIT,
                    rooms: [roomId],
                    senders: [senderId],
                },
                order_by: SearchOrderBy.Recent,
                event_context: { before_limit: 0, after_limit: 0, include_profile: true },
            },
        },
    };

    const allResults: any[] = [];
    const seenEventIds = new Set<string>();
    let nextBatch: string | undefined;
    let pageCount = 0;
    const MAX_PAGES = 500; // Giới hạn số trang để tránh vòng lặp vô tận
    let firstQuery = baseBody;

    // First page
    try {
        const firstResp = await client.search({ body: baseBody }, abortSignal);
        const firstRoom = firstResp.search_categories.room_events;
        if (firstRoom?.results?.length) {
            // Lọc duplicate events và tin nhắn đã xóa
            const uniqueResults = firstRoom.results.filter(r => {
                const eventId = r.result?.event_id;
                if (!eventId || seenEventIds.has(eventId)) return false;
                
                // Bỏ qua tin nhắn đã xóa
                if (r.result?.unsigned?.redacted_because) {
                    return false;
                }
                
                seenEventIds.add(eventId);
                return true;
            });
            allResults.push(...uniqueResults);
        }
        nextBatch = firstRoom?.next_batch;
    } catch (e) {
        console.warn('fetchAllSenderMessagesServer: first page failed:', e);
        // Thử với search term rỗng nếu wildcard thất bại
        try {
            const fallbackBody = { ...baseBody };
            fallbackBody.search_categories.room_events.search_term = "";
            const fallbackResp = await client.search({ body: fallbackBody }, abortSignal);
            const fallbackRoom = fallbackResp.search_categories.room_events;
            if (fallbackRoom?.results?.length) {
                const uniqueResults = fallbackRoom.results.filter(r => {
                    const eventId = r.result?.event_id;
                    if (!eventId || seenEventIds.has(eventId)) return false;
                    
                    // Bỏ qua tin nhắn đã xóa
                    if (r.result?.unsigned?.redacted_because) {
                        return false;
                    }
                    
                    seenEventIds.add(eventId);
                    return true;
                });
                allResults.push(...uniqueResults);
            }
            nextBatch = fallbackRoom?.next_batch;
            firstQuery = fallbackBody;
        } catch (fallbackError) {
            console.warn('fetchAllSenderMessagesServer: fallback also failed:', fallbackError);
            throw e; // Throw original error
        }
    }

    // Loop through all pages to get complete history
    while (nextBatch && pageCount < MAX_PAGES) {
        if (abortSignal?.aborted) break;
        pageCount++;
        
        try {
            const pageResp = await client.search({ body: firstQuery, next_batch: nextBatch }, abortSignal);
            const roomData = pageResp.search_categories.room_events;
            if (roomData?.results?.length) {
                // Lọc duplicate events và tin nhắn đã xóa
                const uniqueResults = roomData.results.filter(r => {
                    const eventId = r.result?.event_id;
                    if (!eventId || seenEventIds.has(eventId)) return false;
                    
                    // Bỏ qua tin nhắn đã xóa
                    if (r.result?.unsigned?.redacted_because) {
                        return false;
                    }
                    
                    seenEventIds.add(eventId);
                    return true;
                });
                allResults.push(...uniqueResults);
                
            }
            nextBatch = roomData?.next_batch;
        } catch (e) {
            console.warn(`fetchAllSenderMessagesServer: page ${pageCount} failed:`, e);
            // Thử tiếp tục với các trang khác thay vì dừng hoàn toàn
            if (pageCount < 5) { // Chỉ retry trong 5 trang đầu
                continue;
            }
            break;
        }
    }

    // Tạo highlights từ search term nếu có
    const highlights: string[] = [];
    const querySearchTerm = firstQuery.search_categories.room_events.search_term;
    if (querySearchTerm && querySearchTerm !== "*" && querySearchTerm.trim()) {
        highlights.push(querySearchTerm.trim());
    }

    const response: ISearchResponse = {
        search_categories: {
            room_events: {
                results: allResults,
                count: allResults.length,
                highlights: highlights,
            } as any,
        },
    };

    return { response, query: firstQuery };
}

// Verify coverage by comparing Seshat vs Server results (for diagnostics)
async function debugVerifyCoverage(
    client: MatrixClient,
    senderId: string,
    roomId: string,
    abortSignal?: AbortSignal,
) {
    try {
        const seshat = await fetchAllSenderMessagesSeshat(client, senderId, roomId);
        const server = await fetchAllSenderMessagesServer(client, senderId, roomId, abortSignal);
        const s = new Set<string>();
        const g = new Set<string>();
        const sList = seshat.response.search_categories.room_events.results || [];
        const gList = server.response.search_categories.room_events.results || [];
        for (const r of sList) {
            const ev: any = r?.result as any;
            s.add(ev?.event_id || ev?.event?.event_id);
        }
        for (const r of gList) {
            const ev: any = r?.result as any;
            g.add(ev?.event_id || ev?.event?.event_id);
        }
        const missingInSeshat: string[] = [];
        const missingInServer: string[] = [];
        for (const id of g) if (id && !s.has(id)) missingInSeshat.push(id);
        for (const id of s) if (id && !g.has(id)) missingInServer.push(id);
        console.log(`[Coverage] sender:${senderId} room:${roomId} seshat=${s.size} server=${g.size} missingInSeshat=${missingInSeshat.length} missingInServer=${missingInServer.length}`);
        if (missingInSeshat.length > 0) console.log('[Coverage] missingInSeshat sample:', missingInSeshat.slice(0, 10));
        if (missingInServer.length > 0) console.log('[Coverage] missingInServer sample:', missingInServer.slice(0, 10));
    } catch (e) {
        console.warn('debugVerifyCoverage failed:', e);
    }
}

// Scan full room timeline locally (client) to gather all events of a sender (works for encrypted rooms)
async function scanFullTimelineBySender(
    client: MatrixClient,
    senderId: string,
    roomId: string,
    keyword: string,
    abortSignal?: AbortSignal,
): Promise<{ response: ISearchResponse; query: ISearchRequestBody }> {
    const room = (client as any).getRoom?.(roomId);
    // Use unfiltered timeline set to avoid missing events hidden by filters
    const timelineSet = (room as any)?.getUnfilteredTimelineSet?.() || room?.getLiveTimelineSet?.();
    const timeline = timelineSet?.getLiveTimeline?.();
    const initialEvents = timeline?.getEvents?.() || [];

    const results: any[] = [];
    const seenEventIds = new Set<string>();
    const PAGE = 500; // Tăng kích thước trang để giảm số lần gọi API
    let paginationCount = 0;
    const MAX_PAGINATION = 2000; // Giới hạn số lần phân trang để tránh vòng lặp vô tận

    const collectFrom = (eventsArr: any[]) => {
        let collected = 0;
        for (let i = eventsArr.length - 1; i >= 0; i--) {
            const ev = eventsArr[i];
            const eventId = ev?.getId?.() || ev?.event_id || ev?.event?.event_id;
            if (!eventId || seenEventIds.has(eventId)) continue;
            
            const type = ev?.getType?.();
            const isMessageLike = type === 'm.room.message' || type === 'm.room.encrypted' || type === 'm.sticker';
            
            // Bỏ qua tin nhắn đã xóa (redacted messages)
            if (ev.isRedacted?.()) {
                continue;
            }
            
            if (isMessageLike && ev.getSender?.() === senderId) {
                // Nếu có keyword, kiểm tra nội dung tin nhắn
                if (keyword && keyword.trim()) {
                    const bodyText = ev.getContent?.()?.body as string | undefined;
                    const lowerKeyword = keyword.toLowerCase();
                    if (bodyText && !bodyText.toLowerCase().includes(lowerKeyword)) {
                        // Thử kiểm tra trong các trường khác nếu body không match
                        const formatted = ev.getContent?.()?.formatted_body as string | undefined;
                        const displayName = ev.getSender?.() || '';
                        if (!formatted?.toLowerCase().includes(lowerKeyword) && 
                            !displayName.toLowerCase().includes(lowerKeyword)) {
                            continue;
                        }
                    }
                }
                
                results.push({
                    rank: 1,
                    result: ev.event || ev,
                    context: { events_before: [], events_after: [] },
                });
                seenEventIds.add(eventId);
                collected++;
            }
        }
        return collected;
    };

    // Thu thập từ events ban đầu
    collectFrom(initialEvents);

    // Phân trang ngược để lấy toàn bộ lịch sử
    while (paginationCount < MAX_PAGINATION) {
        if (abortSignal?.aborted) break;
        
        const prevSeen = seenEventIds.size;
        const hasMoreToken = !!timeline?.getPaginationToken?.("b");
        const hasOlderNeighbour = !!timeline?.getNeighbouringTimeline?.("b");
        
        if (!hasMoreToken && !hasOlderNeighbour) {
            break;
        }
        
        try {
            paginationCount++;
            // eslint-disable-next-line @typescript-eslint/await-thenable
            await (client as any).paginateEventTimeline?.(timeline, { backwards: true, limit: PAGE });
            const pageEvents = timeline?.getEvents?.() || [];
            collectFrom(pageEvents);
            
            
            // Nếu không thu thập được thêm events nào sau vài lần thử, có thể đã hết
            if (seenEventIds.size === prevSeen) {
                break;
            }
        } catch (e) {
            console.warn(`scanFullTimelineBySender: paginateEventTimeline failed at page ${paginationCount}:`, e);
            // Thử tiếp tục thay vì dừng ngay lập tức
            if (paginationCount < 5) {
                continue;
            }
            break;
        }
    }

    // Tạo highlights từ keyword nếu có
    const highlights: string[] = [];
    if (keyword && keyword.trim()) {
        highlights.push(keyword.trim());
    }

    const response: ISearchResponse = {
        search_categories: {
            room_events: {
                results,
                count: results.length,
                highlights: highlights,
            } as any,
        },
    };

    const query: ISearchRequestBody = {
        search_categories: {
            room_events: {
                search_term: keyword || '',
                filter: { limit: SEARCH_LIMIT, rooms: [roomId], senders: [senderId] },
                order_by: SearchOrderBy.Recent,
                event_context: { before_limit: 0, after_limit: 0, include_profile: true },
            },
        },
    };

    return { response, query };
}

async function serverSideSearch(
    client: MatrixClient,
    term: string,
    roomId?: string,
    abortSignal?: AbortSignal,
): Promise<{ response: ISearchResponse; query: ISearchRequestBody }> {
    // Check cache first
    const cacheKey = `server_${term}_${roomId || 'all'}`;
    const cached = getCachedResult(cacheKey);
    if (cached) {
        console.log("Returning cached server search results");
        return cached;
    }

    const dynamicLimits = calculateDynamicLimits(term, roomId);
    const filter: IRoomEventFilter = {
        limit: dynamicLimits.limit, // Sử dụng dynamic limit
    };

    if (roomId !== undefined) filter.rooms = [roomId];

    // Hỗ trợ truy vấn kết hợp: tách token sender và phần từ khóa còn lại
    const { senderId: combinedSenderId, keyword: remainingKeyword } = extractSenderFilter(term || "");
    if (combinedSenderId) {
        term = remainingKeyword || ""; // dùng phần keyword còn lại cho nội dung
    }

    // Xử lý tìm kiếm theo người gửi
    if (combinedSenderId) {
        const senderId = combinedSenderId;
        // Nếu đang tìm trong 1 phòng cụ thể, tự dựng kết quả từ timeline phòng để đảm bảo luôn hiển thị được
        if (roomId) {
            try {
                // Ưu tiên gọi server search phân trang để gom toàn bộ tin nhắn của sender trong phòng
                try {
                    console.log(`serverSideSearch: Calling fetchAllSenderMessagesServer with keyword="${term}"`);
                    const full = await fetchAllSenderMessagesServer(client, senderId, roomId, abortSignal, term);
                    const count = full.response?.search_categories?.room_events?.results?.length || 0;
                    if (count > 0) {
                        console.log(`serverSideSearch: fetchAllSenderMessagesServer found ${count} results`);
                        // Diagnostic cross-check for the room created at 2025-08-20
                        await debugVerifyCoverage(client, senderId, roomId, abortSignal);
                        return full;
                    }
                } catch (e) {
                    console.warn('Server paginated sender search failed, fallback to timeline scan:', e);
                }

                // Fallback: quét full timeline để đảm bảo không sót (đặc biệt phòng mã hóa)
                const timelineFull = await scanFullTimelineBySender(client, senderId, roomId, term, abortSignal);
                await debugVerifyCoverage(client, senderId, roomId, abortSignal);
                if (timelineFull?.response?.search_categories?.room_events?.results?.length) {
                    return timelineFull;
                }
                const room = (client as any).getRoom?.(roomId);
                const timeline = room?.getLiveTimeline?.();
                const initialEvents = timeline?.getEvents?.() || [];

                // Thu thập sự kiện khớp sender trên toàn bộ lịch sử bằng phân trang lùi
                // Đếm toàn bộ và đưa toàn bộ kết quả ra danh sách hiển thị
                const results = [] as any[];
                const seenEventIds = new Set<string>();
                let totalCount = 0;
                const PAGE = 250; // kích thước trang khi phân trang

                const collectFrom = (eventsArr: any[]) => {
                    for (let i = eventsArr.length - 1; i >= 0; i--) {
                        const ev = eventsArr[i];
                        const eventId = ev?.getId?.() || ev?.event_id || ev?.event?.event_id;
                        if (!eventId || seenEventIds.has(eventId)) continue; // tránh đếm trùng khi phân trang
                        
                        // Bỏ qua tin nhắn đã xóa (redacted messages)
                        if (ev.isRedacted?.()) {
                            continue;
                        }
                        
                        const type = ev?.getType?.();
                        const isMessageLike = type === 'm.room.message' || type === 'm.room.encrypted' || type === 'm.sticker';
                        if (isMessageLike && ev.getSender?.() === senderId) {
                            const bodyText = ev.getContent?.()?.body as string | undefined;
                            // Chỉ kiểm tra keyword nếu có term và bodyText
                            if (term && term.trim() && bodyText && !bodyText.toLowerCase().includes(term.toLowerCase())) {
                                continue; // không khớp keyword
                            }
                            totalCount += 1;
                            // Không gửi kèm context để tránh hiển thị các tin nhắn lân cận bị mờ
                            const before: any[] = [];
                            const after: any[] = [];
                            results.push({
                                rank: 1,
                                result: ev.event,
                                context: {
                                    events_before: before,
                                    events_after: after,
                                },
                            });
                            seenEventIds.add(eventId);
                        }
                    }
                };

                collectFrom(initialEvents);

                // Phân trang lùi cho đến khi hết token hoặc đạt giới hạn
                while (true) {
                    if (abortSignal?.aborted) {
                        console.warn('sender-only timeline scan aborted');
                        break;
                    }
                    const prevSeen = seenEventIds.size;
                    const hasMoreToken = !!timeline?.getPaginationToken?.("b");
                    const hasOlderNeighbour = !!timeline?.getNeighbouringTimeline?.("b");
                    if (!hasMoreToken && !hasOlderNeighbour) break;
                    try {
                        // eslint-disable-next-line @typescript-eslint/await-thenable
                        await (client as any).paginateEventTimeline?.(timeline, { backwards: true, limit: PAGE });
                        const pageEvents = timeline?.getEvents?.() || [];
                        collectFrom(pageEvents);
                    } catch (e) {
                        console.warn('paginateEventTimeline failed:', e);
                        break;
                    }
                    // Nếu không có event mới nào được thêm, dừng để tránh vòng lặp vô hạn
                    if (seenEventIds.size === prevSeen) {
                        break;
                    }
                }

                const response: ISearchResponse = {
                    search_categories: {
                        room_events: {
                            results,
                            count: totalCount,
                            highlights: [],
                        } as any,
                    },
                };

                const query: ISearchRequestBody = {
                    search_categories: {
                        room_events: {
                            search_term: term || '',
                            filter: { ...filter, rooms: [roomId], senders: [senderId] },
                            order_by: SearchOrderBy.Recent,
                            event_context: { before_limit: 1, after_limit: 1, include_profile: true },
                        },
                    },
                };

                // Trả về kết quả đã dựng sẵn, bỏ qua request lên server
                return { response, query };
            } catch (e) {
                console.warn('Fallback timeline sender search failed, will try server search:', e);
            }
        }

        // Nếu không có roomId hoặc fallback thất bại, dùng server search với wildcard/keyword
        filter.senders = [senderId];
        // Nếu chỉ có sender filter (không có keyword), dùng empty string thay vì "*"
        term = term && term.trim().length > 0 ? term : "";
        console.log("ServerSideSearch: Processing sender filter for:", senderId, "with term:", term || "<empty>");
    } else if (!term) {
        // Nếu từ khóa rỗng và không có sender filter, tìm kiếm tất cả tin nhắn
        term = "";
    }

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
        ].slice(0, dynamicLimits.strategies); // Giới hạn số strategies

        // let bestResponse = null;
        // let bestQuery: ISearchRequestBody | null = null;
        // let bestCount = 0;

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

                    // Kiểm tra nếu signal đã bị abort trước khi thực hiện search
                    if (abortSignal?.aborted) {
                        continue; // Skip this strategy instead of throwing
                    }
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
        // Chạy wildcard strategies sớm hơn, đặc biệt cho terms ngắn
        if (!response || (response.search_categories?.room_events?.results?.length || 0) < 5) {
            const additionalServerStrategies = [
                { term: `*${term}*`, description: "wildcard search" },
                { term: term + '*', description: "prefix wildcard" },
                { term: '*' + term, description: "suffix wildcard" },
                { term: `%${term}%`, description: "SQL-like wildcard" },
                { term: `.*${term}.*`, description: "regex-like search" },
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

                    // Kiểm tra nếu signal đã bị abort trước khi thực hiện search
                    if (abortSignal?.aborted) {
                        continue; // Skip this strategy instead of throwing
                    }
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

    // If no URL-specific results or not a URL search, use original term with enhanced strategies
    if (!response || !query) {
        console.log(`=== SERVER SEARCH DEBUG ===`);
        console.log(`Search term: "${term}"`);
        console.log(`Room ID: ${roomId || 'all rooms'}`);
        
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

        // Kiểm tra nếu signal đã bị abort trước khi thực hiện search
        if (abortSignal?.aborted) {
            // Trả về kết quả rỗng thay vì throw error
            return { 
                response: { 
                    search_categories: { 
                        room_events: { 
                            results: [], 
                            count: 0, 
                            highlights: [] 
                        } 
                    } 
                }, 
                query: body 
            };
        }
        response = await client.search({ body: body }, abortSignal);
        query = body;
        
        // Nếu chỉ có sender filter và kết quả ít, thử approach khác
        const { senderId: checkSenderId } = extractSenderFilter(term || "");
        const currentCount = response?.search_categories?.room_events?.count || 0;
        if (checkSenderId && currentCount < 100) {
            console.log(`ServerSideSearch: Low result count (${currentCount}) for sender-only search, trying alternative approach`);
            try {
                // Thử tìm kiếm với empty term và filter senders
                const altBody: ISearchRequestBody = {
                    search_categories: {
                        room_events: {
                            search_term: "",
                            filter: { ...filter, senders: [checkSenderId] },
                            order_by: SearchOrderBy.Recent,
                            event_context: {
                                before_limit: 1,
                                after_limit: 1,
                                include_profile: true,
                            },
                        },
                    },
                };
                const altResponse = await client.search({ body: altBody }, abortSignal);
                const altCount = altResponse?.search_categories?.room_events?.count || 0;
                if (altCount > currentCount) {
                    console.log(`ServerSideSearch: Found ${altCount} results with empty term`);
                    response = altResponse;
                    query = altBody;
                }
            } catch (e) {
                console.log("ServerSideSearch: Alternative search failed:", e);
            }
        }
    }

    const result = { response, query };
    
    // Cache the result if successful
    if (response && response.search_categories?.room_events?.results && response.search_categories.room_events.results.length > 0) {
        setCachedResult(cacheKey, result);
    }
    
    return result;
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
    const localPromise = localSearch(client, searchTerm);

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
    client: MatrixClient,
    searchTerm: string,
    roomId?: string,
    processResult = true,
): Promise<{ response: IResultRoomEvents; query: ISearchArgs }> {
    // Check cache first
    const cacheKey = `local_${searchTerm}_${roomId || 'all'}`;
    const cached = getCachedResult(cacheKey);
    if (cached) {
        console.log("Returning cached local search results");
        return cached;
    }

    const eventIndex = EventIndexPeg.get();
    
    // Đảm bảo Seshat đã được khởi tạo
    if (!eventIndex) {
        console.log("EventIndex not available, trying to initialize...");
        const initialized = await EventIndexPeg.init();
        if (!initialized) {
            console.log("Failed to initialize EventIndex, falling back to server search only");
            throw new Error("EventIndex not available");
        }
    }
    
    // Helper function để lấy EventIndex hiện tại
    const getCurrentEventIndex = () => EventIndexPeg.get();
    
    // Helper function để thực hiện search an toàn
    const safeSearch = async (args: ISearchArgs) => {
        const currentEventIndex = getCurrentEventIndex();
        if (currentEventIndex) {
            return await currentEventIndex.search(args);
        }
        return null;
    };

    // Xử lý tìm kiếm theo người gửi + keyword kết hợp (hỗ trợ 'sender:<id> <keyword>')
    let actualSearchTerm = searchTerm;
    let senderFilter: string | undefined;
    {
        const { senderId, keyword } = extractSenderFilter(searchTerm || "");
        if (senderId) {
            senderFilter = senderId;
            const kw = (keyword || "").trim();
            // Nếu có keyword sau sender, dùng keyword; nếu không, dùng '*' để tìm tất cả
            actualSearchTerm = kw.length > 0 ? kw : "*";
            console.log("LocalSearch: Processing sender filter for:", senderFilter, "with keyword:", kw || "<any>");
        } else if (!actualSearchTerm) {
            // Nếu từ khóa rỗng và không có sender filter, tìm kiếm tất cả tin nhắn
            actualSearchTerm = "*";
        }
    }

    const dynamicLimits = calculateDynamicLimits(actualSearchTerm, roomId);
    const searchArgs: ISearchArgs = {
        search_term: actualSearchTerm,
        before_limit: 1,
        after_limit: 1,
        limit: dynamicLimits.limit, // Sử dụng dynamic limit
        order_by_recency: true,
        room_id: roomId, // Giới hạn theo phòng hiện tại nếu có
    };

    // Chỉ giới hạn theo roomId nếu được yêu cầu cụ thể
    if (roomId !== undefined) {
        searchArgs.room_id = roomId;
    }

    // Use enhanced search term analysis
    const searchAnalysis = analyzeSearchTerm(actualSearchTerm);
    const { isUrlSearch, isSingleToken, keywords } = searchAnalysis;
    
    let localResult;
    
    // Strategy 1: Try exact search first (for all terms)
    console.log(`=== LOCAL SEARCH DEBUG ===`);
    console.log(`Original search term: "${searchTerm}"`);
    console.log(`Actual search term: "${actualSearchTerm}"`);
    console.log(`Room ID: ${roomId || 'all rooms'}`);
    console.log(`Sender filter: ${senderFilter || 'none'}`);
    
    try {
        localResult = await safeSearch(searchArgs);
        console.log(`Exact search returned ${localResult?.count || 0} results`);
        
        // Early termination if we got good results
        if (localResult?.count && localResult.count >= 10) {
            console.log("Early termination: found sufficient results");
            const result = { response: localResult, query: searchArgs };
            setCachedResult(cacheKey, result);
            return result;
        }
    } catch (error) {
        console.log("Exact search failed:", error);
    }

    // Enhanced search logic for all terms (not just URLs)
    console.log(`Enhanced search for term: "${searchTerm}"`);
    if (keywords.length > 0) {
        console.log(`Extracted keywords: ${keywords.join(', ')}`);
    }
        
    // Strategy 1.5: Try wildcard search for partial matching (for all terms)
    if (!localResult || localResult.count === 0) {
        // Thử wildcard search cho partial matching
        const wildcardTerms = [
            `*${actualSearchTerm}*`, // Tìm kiếm "sagua" trong "Saguaro"
            `${actualSearchTerm}*`,  // Prefix matching
            `*${actualSearchTerm}`,  // Suffix matching
        ];
        
        for (const wildcardTerm of wildcardTerms) {
            const wildcardArgs = { ...searchArgs, search_term: wildcardTerm };
            try {
                const wildcardResult = await safeSearch(wildcardArgs);
                if (wildcardResult?.count && wildcardResult.count > 0) {
                    localResult = wildcardResult;
                    console.log(`Wildcard search returned ${wildcardResult.count} results for "${wildcardTerm}"`);
                    break;
                }
            } catch (error) {
                console.log(`Wildcard search failed for "${wildcardTerm}":`, error);
            }
        }
    }

    // Strategy 1.7: Try broad search with client-side filtering for partial matching
    if (!localResult || localResult.count === 0) {
        console.log(`Trying broad search with client-side filtering for partial matching`);
        
        // Thử search với từ ngắn hơn hoặc wildcard rộng hơn
        const broadSearchTerms = [];
        
        // Nếu term >= 4 chars, thử search với 3 chars đầu
        if (actualSearchTerm.length >= 4) {
            broadSearchTerms.push(actualSearchTerm.substring(0, 3));
        }
        
        // Nếu term >= 5 chars, thử search với 4 chars đầu
        if (actualSearchTerm.length >= 5) {
            broadSearchTerms.push(actualSearchTerm.substring(0, 4));
        }
        
        // Thử search với các từ con
        if (actualSearchTerm.length >= 6) {
            for (let i = 0; i <= actualSearchTerm.length - 3; i++) {
                const substring = actualSearchTerm.substring(i, i + 3);
                if (substring.length >= 3) {
                    broadSearchTerms.push(substring);
                }
            }
        }
        
        // Loại bỏ duplicates và terms quá ngắn
        const uniqueBroadTerms = [...new Set(broadSearchTerms)].filter(t => t.length >= 3);
        
        for (const broadTerm of uniqueBroadTerms.slice(0, 3)) { // Giới hạn chỉ 3 terms
            const broadArgs = { ...searchArgs, search_term: broadTerm };
            try {
                const broadResult = await safeSearch(broadArgs);
                if (broadResult?.count && broadResult.count > 0 && broadResult.results) {
                    // Client-side filtering với enhanced relevance scoring
                    const relevantResults = broadResult.results.filter(result => {
                        const content = result.result.content?.body || '';
                        return enhancedSearchWithRelevance(actualSearchTerm, content);
                    });
                    
                    if (relevantResults.length > 0) {
                        broadResult.results = relevantResults;
                        broadResult.count = relevantResults.length;
                        localResult = broadResult;
                        console.log(`Broad search with client-side filtering returned ${relevantResults.length} results for "${broadTerm}" -> "${actualSearchTerm}"`);
                        break;
                    }
                }
            } catch (error) {
                console.log(`Broad search failed for "${broadTerm}":`, error);
            }
        }
    }

    // Strategy 1.8: Try case variations for partial matching
    if (!localResult || localResult.count === 0) {
        const caseVariations = [
            actualSearchTerm.toLowerCase(),
            actualSearchTerm.toUpperCase(),
            actualSearchTerm.charAt(0).toUpperCase() + actualSearchTerm.slice(1).toLowerCase(),
        ].filter(v => v !== actualSearchTerm); // Loại bỏ trùng lặp
        
        for (const variation of caseVariations) {
            const variationArgs = { ...searchArgs, search_term: variation };
            try {
                const variationResult = await safeSearch(variationArgs);
                if (variationResult?.count && variationResult.count > 0) {
                    // Apply relevance scoring to filter results
                    if (variationResult.results) {
                        const relevantResults = variationResult.results.filter(result => {
                            const content = result.result.content?.body || '';
                            return enhancedSearchWithRelevance(actualSearchTerm, content);
                        });
                        
                        if (relevantResults.length > 0) {
                            variationResult.results = relevantResults;
                            variationResult.count = relevantResults.length;
                            localResult = variationResult;
                            console.log(`Case variation search with relevance scoring returned ${relevantResults.length} results for "${variation}"`);
                            break;
                        }
                    } else {
                        localResult = variationResult;
                        console.log(`Case variation search returned ${variationResult.count} results for "${variation}"`);
                        break;
                    }
                }
            } catch (error) {
                console.log(`Case variation search failed for "${variation}":`, error);
            }
        }
    }

    // Strategy 1.6: Try searching with extracted keywords and relevance scoring (for URL-like terms)
    if ((isUrlSearch || isSingleToken) && (!localResult || localResult.count === 0)) {
        const limitedKeywords = keywords.slice(0, 3); // Giới hạn chỉ 3 keywords đầu tiên
        for (const keyword of limitedKeywords) {
            if (keyword !== searchTerm && keyword.length > 2) {
                const keywordArgs = { ...searchArgs, search_term: keyword };
                try {
                    const keywordResult = await safeSearch(keywordArgs);
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

    // Continue with URL-specific strategies only for URL-like terms
    if (isUrlSearch || isSingleToken) {
        
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

        // Strategy 8: If keyword without TLD, try common domain expansions (limited)
        if ((!localResult || localResult.count === 0) && isSingleToken) {
            const expansions = [
                `${searchTerm}.com`,
                `${searchTerm}.vn`,
                `${searchTerm}.io`,
                `${searchTerm}.app`,
                `https://${searchTerm}.com`,
            ].slice(0, 3); // Giới hạn chỉ 3 expansions đầu tiên
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
        
        // Strategy 10: Try fuzzy matching for single tokens (simplified)
        if (!localResult || localResult.count === 0) {
            if (isSingleToken) {
                // Only try most common variations
                const fuzzyTerms = [
                    searchTerm.toLowerCase(),
                    searchTerm.toUpperCase(),
                ].slice(0, 2); // Chỉ 2 variations đầu tiên
                
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
        
        // Strategy 11: Try word-based search (final fallback)
        if (!localResult || localResult.count === 0) {
            const searchWords = searchTerm.toLowerCase().split(/\s+/).filter(word => word.length > 2);
            
            // Chỉ thử từ đầu tiên
            if (searchWords.length > 0) {
                const word = searchWords[0];
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
                                console.log(`Word search with relevance scoring returned ${relevantResults.length} results for "${word}"`);
                            }
                        } else {
                            localResult = wordResult;
                            console.log(`Word search returned ${wordResult.count} results for "${word}"`);
                        }
                    }
                } catch (error) {
                    console.log(`Word search failed for "${word}":`, error);
                }
            }
        }
    }
    
    // Fallback to normal search if no enhanced results
    if (!localResult) {
        console.log("Falling back to normal search");
        localResult = await safeSearch(searchArgs);
    }

    // Lọc kết quả theo người gửi nếu có senderFilter
    if (senderFilter && localResult?.results) {
        console.log(`=== SENDER FILTERING DEBUG ===`);
        console.log(`LocalSearch: Filtering results by sender: ${senderFilter}`);
        console.log(`LocalSearch: Before filtering: ${localResult.results.length} results`);
        console.log(`LocalSearch: Search term was: "${searchTerm}", actual term: "${actualSearchTerm}"`);
        
        // Debug: Show some sample results before filtering
        if (localResult.results.length > 0) {
            console.log('Sample results before filtering:');
            localResult.results.slice(0, 3).forEach((result, i) => {
                const event = result.result;
                console.log(`  ${i}: sender=${event.sender}, content="${event.content?.body?.substring(0, 50)}..."`);
            });
        }
        
        localResult.results = localResult.results.filter(result => {
            const event = result.result;
            const matches = event.sender === senderFilter;
            if (!matches) {
                console.log(`LocalSearch: Filtering out event from sender: ${event.sender}`);
            }
            return matches;
        });
        localResult.count = localResult.results.length;
        console.log(`LocalSearch: After filtering: ${localResult.count} results from sender ${senderFilter}`);
        
        // Debug: Show some sample results after filtering
        if (localResult.results.length > 0) {
            console.log('Sample results after filtering:');
            localResult.results.slice(0, 3).forEach((result, i) => {
                const event = result.result;
                console.log(`  ${i}: sender=${event.sender}, content="${event.content?.body?.substring(0, 50)}..."`);
            });
        }
        console.log(`=== END SENDER FILTERING DEBUG ===`);
        
        // Nếu chỉ có sender filter (không có keyword) thì QUÉT TOÀN BỘ TIMELINE phòng để lấy tất cả tin nhắn của user
        if (actualSearchTerm === "*" && roomId) {
            try {
                console.log("LocalSearch: Sender-only filter detected, scanning full room timeline for all messages of user");
                const room = (client as any).getRoom?.(roomId);
                // Sử dụng unfiltered timeline set để tránh bỏ sót events bị ẩn bởi filters
                const timelineSet = (room as any)?.getUnfilteredTimelineSet?.() || room?.getLiveTimelineSet?.();
                const timeline = timelineSet?.getLiveTimeline?.();
                const results: any[] = [];
                const seenEventIds = new Set<string>();
                const PAGE = 500; // Tăng kích thước trang
                let paginationCount = 0;
                const MAX_PAGINATION = 1000; // Giới hạn số lần phân trang

                const collectFrom = (eventsArr: any[]) => {
                    let collected = 0;
                    for (let i = eventsArr.length - 1; i >= 0; i--) {
                        const ev = eventsArr[i];
                        const eventId = ev?.getId?.() || ev?.event_id || ev?.event?.event_id;
                        if (!eventId || seenEventIds.has(eventId)) continue;
                        
                        // Bỏ qua tin nhắn đã xóa (redacted messages)
                        if (ev.isRedacted?.()) {
                            continue;
                        }
                        
                        const type = ev?.getType?.();
                        const isMessageLike = type === 'm.room.message' || type === 'm.room.encrypted' || type === 'm.sticker';
                        
                        if (isMessageLike && ev.getSender?.() === senderFilter) {
                            results.push({
                                rank: 1,
                                result: ev.event || ev,
                                context: { events_before: [], events_after: [] },
                            });
                            seenEventIds.add(eventId);
                            collected++;
                        }
                    }
                    return collected;
                };

                const initialEvents = timeline?.getEvents?.() || [];
                collectFrom(initialEvents);

                // Phân trang để lấy toàn bộ lịch sử
                while (paginationCount < MAX_PAGINATION) {
                    const prevSeen = seenEventIds.size;
                    const hasMoreToken = !!timeline?.getPaginationToken?.("b");
                    const hasOlderNeighbour = !!timeline?.getNeighbouringTimeline?.("b");
                    
                    if (!hasMoreToken && !hasOlderNeighbour) {
                        break;
                    }
                    
                    try {
                        paginationCount++;
                        // eslint-disable-next-line @typescript-eslint/await-thenable
                        await (client as any).paginateEventTimeline?.(timeline, { backwards: true, limit: PAGE });
                        const pageEvents = timeline?.getEvents?.() || [];
                        const pageCollected = collectFrom(pageEvents);
                        
                        if (roomId === DEBUG_ROOM_ID && paginationCount % 20 === 0) {
                            console.log(`[Debug ${DEBUG_ROOM_ID}] Local sender scan - page ${paginationCount}: ${pageEvents.length} events, +${pageCollected} for ${senderFilter}, total: ${results.length}`);
                        }
                        
                        // Nếu không thu thập được thêm events nào, có thể đã hết
                        if (seenEventIds.size === prevSeen) {
                            if (roomId === DEBUG_ROOM_ID) {
                                console.log(`[Debug ${DEBUG_ROOM_ID}] Local sender scan - no new events collected, stopping`);
                            }
                            break;
                        }
                    } catch (e) {
                        console.warn(`LocalSearch: paginateEventTimeline failed at page ${paginationCount}:`, e);
                        // Thử tiếp tục thay vì dừng ngay lập tức
                        if (paginationCount < 10) {
                            continue;
                        }
                        break;
                    }
                }

                localResult.results = results;
                localResult.count = results.length;
                console.log(`LocalSearch: Collected ${results.length} messages from user ${senderFilter} via full timeline scan (${paginationCount} pages)`);
                if (roomId === DEBUG_ROOM_ID) {
                    console.log(`[Debug ${DEBUG_ROOM_ID}] Local sender scan - final count: ${results.length}`);
                }
            } catch (e) {
                console.log("LocalSearch: Full timeline sender scan failed:", e);
            }
        }
    }
    
    // Nếu vẫn không có kết quả, thử tìm kiếm với các biến thể khác nhau
    if (!localResult || localResult.count === 0) {
        console.log("Trying alternative search strategies");
        
        // Thử tìm kiếm với từ khóa không phân biệt hoa thường
        const lowerCaseArgs = { ...searchArgs, search_term: searchTerm.toLowerCase() };
        try {
            const lowerResult = await safeSearch(lowerCaseArgs);
            if (lowerResult && lowerResult.count && lowerResult.count > 0) {
                localResult = lowerResult;
                console.log(`Lowercase search found ${lowerResult.count} results`);
            }
        } catch (error) {
            console.log("Lowercase search failed:", error);
        }
        
        // Thử tìm kiếm với từ khóa viết hoa
        if (!localResult || localResult.count === 0) {
            const upperCaseArgs = { ...searchArgs, search_term: searchTerm.toUpperCase() };
            try {
                const upperResult = await safeSearch(upperCaseArgs);
                if (upperResult && upperResult.count && upperResult.count > 0) {
                    localResult = upperResult;
                    console.log(`Uppercase search found ${upperResult.count} results`);
                }
            } catch (error) {
                console.log("Uppercase search failed:", error);
            }
        }
        
        // Thử tìm kiếm với từ khóa có dấu và không dấu (cho tiếng Việt)
        if (!localResult || localResult.count === 0) {
            const normalizedTerm = searchTerm.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            if (normalizedTerm !== searchTerm) {
                const normalizedArgs = { ...searchArgs, search_term: normalizedTerm };
                try {
                    const normalizedResult = await safeSearch(normalizedArgs);
                    if (normalizedResult && normalizedResult.count && normalizedResult.count > 0) {
                        localResult = normalizedResult;
                        console.log(`Normalized search found ${normalizedResult.count} results`);
                    }
                } catch (error) {
                    console.log("Normalized search failed:", error);
                }
            }
        }
        
        // Thử tìm kiếm với các từ khóa liên quan (cho tiếng Việt)
        if (!localResult || localResult.count === 0) {
            const relatedTerms = generateRelatedTerms(searchTerm);
            console.log(`Trying ${relatedTerms.length} related terms for "${searchTerm}"`);
            
            for (const relatedTerm of relatedTerms) {
                const relatedArgs = { ...searchArgs, search_term: relatedTerm };
                try {
                    const relatedResult = await safeSearch(relatedArgs);
                    if (relatedResult && relatedResult.count && relatedResult.count > 0) {
                        localResult = relatedResult;
                        console.log(`Related term search found ${relatedResult.count} results for "${relatedTerm}"`);
                        break;
                    }
                } catch (error) {
                    console.log(`Related term search failed for "${relatedTerm}":`, error);
                }
            }
        }
    }
    
    // Enhanced timeline search as powerful fallback for partial matching
    if (!localResult || localResult.count === 0) {
        console.log("Trying enhanced timeline search for partial matching");
        
        // Try enhanced timeline search that scans more thoroughly
        const enhancedTimelineResult = await enhancedTimelineSearch(client, actualSearchTerm, roomId);
        if (enhancedTimelineResult.results.length > 0) {
            console.log(`Enhanced timeline search found ${enhancedTimelineResult.results.length} messages`);
            localResult = {
                count: enhancedTimelineResult.results.length,
                results: enhancedTimelineResult.results,
                highlights: [actualSearchTerm],
                next_batch: undefined,
            };
        } else {
            console.log("Enhanced timeline search did not find any matches");
            
            // Final fallback: Basic timeline search
            const timelineResult = searchInTimeline(client, searchTerm, roomId);
            if (timelineResult.found) {
                console.log(`Basic timeline search found message: "${timelineResult.message}"`);
                // Create a fake result to indicate success
                localResult = {
                    count: 1,
                    results: [],
                    highlights: [actualSearchTerm],
                    next_batch: undefined,
                };
            } else {
                console.log("Basic timeline search did not find any matches");
            }
        }
    } else {
        console.log(`Local search found ${localResult.count} results, skipping timeline search`);
    }
    
    if (!localResult) {
        throw new Error("Local search failed");
    }

    searchArgs.next_batch = localResult.next_batch;

    const result = {
        response: localResult,
        query: searchArgs,
    };

    // Cache successful results
    if (localResult.count && localResult.count > 0) {
        setCachedResult(cacheKey, result);
    }

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

    const result = await localSearch(client, searchTerm, roomId);

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

    const localResult = await eventIndex!.search(searchResult.seshatQuery!);
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
        // Nếu có filter theo sender trong 1 phòng cụ thể:
        // 1) Ưu tiên kết hợp cả Seshat và Server để đảm bảo lấy đủ nhất
        // 2) Nếu không có Seshat, dùng serverSideSearchProcess (có phân trang) làm fallback
        const { senderId, keyword } = extractSenderFilter(term || "");
        if (senderId) {
            const eventIndex = EventIndexPeg.get();
            if (eventIndex) {
                if (roomId === DEBUG_ROOM_ID) {
                    console.log(`[Debug ${DEBUG_ROOM_ID}] eventIndexSearch -> using combined Seshat+Server for sender:${senderId}, keyword:${keyword}`);
                }
                
                try {
                    // Kết hợp cả Seshat và Server search để đảm bảo lấy đủ
                    const [seshatAll, serverAll] = await Promise.allSettled([
                        fetchAllSenderMessagesSeshat(client, senderId, roomId, keyword),
                        fetchAllSenderMessagesServer(client, senderId, roomId, abortSignal, keyword)
                    ]);
                    
                    const allResults: any[] = [];
                    const seenEventIds = new Set<string>();
                    
                    // Thu thập từ Seshat
                    if (seshatAll.status === 'fulfilled' && seshatAll.value.response.search_categories.room_events.results) {
                        for (const result of seshatAll.value.response.search_categories.room_events.results) {
                            const eventId = result.result?.event_id;
                            if (eventId && !seenEventIds.has(eventId)) {
                                seenEventIds.add(eventId);
                                allResults.push(result);
                            }
                        }
                    }
                    
                    // Thu thập từ Server (bổ sung những gì Seshat thiếu)
                    if (serverAll.status === 'fulfilled' && serverAll.value.response.search_categories.room_events.results) {
                        for (const result of serverAll.value.response.search_categories.room_events.results) {
                            const eventId = result.result?.event_id;
                            if (eventId && !seenEventIds.has(eventId)) {
                                seenEventIds.add(eventId);
                                allResults.push(result);
                            }
                        }
                    }
                    
                    if (roomId === DEBUG_ROOM_ID) {
                        const seshatCount = seshatAll.status === 'fulfilled' ? (seshatAll.value.response.search_categories.room_events.results?.length || 0) : 0;
                        const serverCount = serverAll.status === 'fulfilled' ? (serverAll.value.response.search_categories.room_events.results?.length || 0) : 0;
                        console.log(`[Debug ${DEBUG_ROOM_ID}] Combined search: Seshat=${seshatCount}, Server=${serverCount}, Total unique=${allResults.length}`);
                    }
                    
                    // Kết hợp highlights từ cả hai nguồn
                    const combinedHighlights: string[] = [];
                    if (seshatAll.status === 'fulfilled' && seshatAll.value.response.search_categories.room_events.highlights) {
                        combinedHighlights.push(...seshatAll.value.response.search_categories.room_events.highlights);
                    }
                    if (serverAll.status === 'fulfilled' && serverAll.value.response.search_categories.room_events.highlights) {
                        combinedHighlights.push(...serverAll.value.response.search_categories.room_events.highlights);
                    }
                    
                    // Loại bỏ duplicates và thêm keyword từ search term
                    const uniqueHighlights = Array.from(new Set(combinedHighlights));
                    const senderMatch = term.match(/sender:([^\s]+)(?:\s+(.*))?/);
                    if (senderMatch && senderMatch[2]) {
                        const keyword = senderMatch[2].trim();
                        if (keyword && !uniqueHighlights.includes(keyword)) {
                            uniqueHighlights.push(keyword);
                        }
                    }

                    // Tạo response kết hợp
                    const combinedResponse: ISearchResponse = {
                        search_categories: {
                            room_events: {
                                results: allResults,
                                count: allResults.length,
                                highlights: uniqueHighlights,
                            } as any,
                        },
                    };
                    
                    const base: ISeshatSearchResults = {
                        seshatQuery: seshatAll.status === 'fulfilled' ? seshatAll.value.query : {} as ISearchArgs,
                        results: [],
                        highlights: [],
                    } as ISeshatSearchResults;
                    
                    await debugVerifyCoverage(client, senderId, roomId, abortSignal);
                    return client.processRoomEventsSearch(base, combinedResponse);
                    
                } catch (e) {
                    console.warn(`Combined search failed, falling back to Seshat-only:`, e);
                    // Fallback to Seshat-only
                    const seshatAll = await fetchAllSenderMessagesSeshat(client, senderId, roomId, keyword);
                    const base: ISeshatSearchResults = {
                        seshatQuery: seshatAll.query,
                        results: [],
                        highlights: [],
                    } as ISeshatSearchResults;
                    await debugVerifyCoverage(client, senderId, roomId, abortSignal);
                    return client.processRoomEventsSearch(base, seshatAll.response);
                }
            } else {
                if (roomId === DEBUG_ROOM_ID) {
                    console.log(`[Debug ${DEBUG_ROOM_ID}] eventIndexSearch -> fallback to serverSideSearchProcess for sender:${senderId}`);
                }
                searchPromise = serverSideSearchProcess(client, term, roomId, abortSignal);
                return searchPromise;
            }
        }
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

// Debounced search function
function debouncedEventSearch(
    client: MatrixClient,
    term: string,
    roomId?: string,
    abortSignal?: AbortSignal,
): Promise<ISearchResults> {
    return new Promise((resolve, reject) => {
        if (searchDebounceTimer) {
            clearTimeout(searchDebounceTimer);
        }
        
        searchDebounceTimer = setTimeout(async () => {
            try {
                const result = await eventSearchInternal(client, term, roomId, abortSignal);
                resolve(result);
            } catch (error) {
                reject(error);
            }
        }, DEBOUNCE_DELAY);
    });
}

// Internal search function
async function eventSearchInternal(
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

// Main export - use debounced version for better UX
export default function eventSearch(
    client: MatrixClient,
    term: string,
    roomId?: string,
    abortSignal?: AbortSignal,
): Promise<ISearchResults> {
    // Không search với từ quá ngắn (<=1 char) - trả về kết quả rỗng để tránh mất focus
    if (term.length <= 1) {
        return Promise.resolve({
            results: [],
            highlights: [],
            count: 0,
        } as ISearchResults);
    }
    
    // Skip debouncing khi có abort signal
    if (abortSignal) {
        return eventSearchInternal(client, term, roomId, abortSignal);
    }
    
    // Skip debouncing for terms that look complete (end with space or common punctuation)
    if (term.endsWith(' ') || term.endsWith('.') || term.endsWith(',') || term.endsWith('!') || term.endsWith('?')) {
        return eventSearchInternal(client, term.trim(), roomId, abortSignal);
    }
    
    // Chỉ áp dụng debouncing cho terms từ 2 ký tự trở lên
    return debouncedEventSearch(client, term, roomId, abortSignal);
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
