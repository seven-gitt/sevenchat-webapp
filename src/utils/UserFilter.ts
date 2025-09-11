/*
Copyright 2024 New Vector Ltd.
Copyright 2020 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {
    type MatrixClient,
    type ISearchResponse,
    type ISearchRequestBody,
    SearchOrderBy,
} from "matrix-js-sdk/src/matrix";

import { SEARCH_LIMIT } from "../Searching";

/**
 * UserFilter class handles filtering messages by user/sender
 * Provides both server-side search and local timeline fallback methods
 */
export class UserFilter {
    private client: MatrixClient;
    private isDesktopApp: boolean;

    constructor(client: MatrixClient) {
        this.client = client;
        this.isDesktopApp = typeof window !== 'undefined' && window.electron !== undefined;
    }

    /**
     * Filter messages by user using server-side search API with fallback
     * @param senderFilter - The user ID to filter by
     * @param roomId - The room ID to search in
     * @param keyword - Optional keyword to filter by
     * @param abortSignal - Optional abort signal
     * @returns Promise with search results
     */
    async filterMessagesByUser(
        senderFilter: string,
        roomId: string,
        keyword: string = "",
        abortSignal?: AbortSignal
    ): Promise<{ response: ISearchResponse; query: ISearchRequestBody }> {
        console.log(`UserFilter: Starting user filter for ${senderFilter} in room ${roomId}`);
        console.log(`UserFilter: Desktop app detected: ${this.isDesktopApp}`);
        console.log(`UserFilter: Keyword: "${keyword}"`);

        // Primary method: Local timeline scan (more reliable for getting all messages)
        try {
            console.log("UserFilter: Using local timeline scan as primary method");
            const localResult = await this.fallbackToLocalTimelineScan(senderFilter, roomId, keyword, abortSignal);
            
            if (localResult?.response?.search_categories?.room_events?.results?.length) {
                const count = localResult.response.search_categories.room_events.results.length;
                console.log(`UserFilter: Local timeline scan found ${count} messages from user ${senderFilter}`);
                return localResult;
            }
        } catch (error) {
            console.log("UserFilter: Local timeline scan failed:", error);
        }

        // Fallback: Server-side search API
        try {
            console.log("UserFilter: Falling back to server-side search");
            const serverSearchResult = await this.fetchAllSenderMessagesServer(
                senderFilter,
                roomId,
                abortSignal,
                keyword
            );

            if (serverSearchResult?.response?.search_categories?.room_events?.results?.length) {
                const count = serverSearchResult.response.search_categories.room_events.results.length;
                console.log(`UserFilter: Server-side search found ${count} messages from user ${senderFilter}`);
                return serverSearchResult;
            }
        } catch (error) {
            console.log("UserFilter: Server-side search failed:", error);
        }

        // Final fallback: Try server-side search with empty keyword
        try {
            console.log("UserFilter: Trying final fallback with empty keyword server search");
            const finalFallbackResult = await this.fetchAllSenderMessagesServer(
                senderFilter,
                roomId,
                abortSignal,
                ""
            );

            if (finalFallbackResult?.response?.search_categories?.room_events?.results?.length) {
                const count = finalFallbackResult.response.search_categories.room_events.results.length;
                console.log(`UserFilter: Final fallback found ${count} messages from user ${senderFilter}`);
                return finalFallbackResult;
            }
        } catch (finalError) {
            console.log("UserFilter: Final fallback also failed:", finalError);
        }

        // Return empty results if all methods fail
        console.log("UserFilter: All search methods failed, returning empty result");
        return this.createEmptyResult();
    }

    /**
     * Fetch all messages of a sender using server-side search API
     */
    private async fetchAllSenderMessagesServer(
        senderId: string,
        roomId: string,
        abortSignal?: AbortSignal,
        keyword?: string
    ): Promise<{ response: ISearchResponse; query: ISearchRequestBody }> {
        // For server search, use empty string instead of wildcard for better compatibility
        const serverSearchTerm = keyword && keyword.trim() ? keyword.trim() : "";
        console.log(`UserFilter: Server search - senderId=${senderId}, keyword="${keyword || ''}", searchTerm="${serverSearchTerm}"`);
        
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
        const MAX_PAGES = 500;
        let firstQuery = baseBody;

        // First page
        try {
            const firstResp = await this.client.search({ body: baseBody }, abortSignal);
            const firstRoom = firstResp.search_categories.room_events;
            if (firstRoom?.results?.length) {
                const uniqueResults = firstRoom.results.filter(r => {
                    const eventId = r.result?.event_id;
                    if (!eventId || seenEventIds.has(eventId)) return false;
                    
                    if (r.result?.unsigned?.redacted_because) return false;
                    
                    seenEventIds.add(eventId);
                    return true;
                });
                allResults.push(...uniqueResults);
            }
            nextBatch = firstRoom?.next_batch;
        } catch (e) {
            console.warn('UserFilter: Server search failed:', e);
            throw e;
        }

        // Loop through all pages
        while (nextBatch && pageCount < MAX_PAGES) {
            if (abortSignal?.aborted) break;
            pageCount++;
            
            try {
                const pageResp = await this.client.search({ body: firstQuery, next_batch: nextBatch }, abortSignal);
                const roomData = pageResp.search_categories.room_events;
                if (roomData?.results?.length) {
                    const uniqueResults = roomData.results.filter(r => {
                        const eventId = r.result?.event_id;
                        if (!eventId || seenEventIds.has(eventId)) return false;
                        
                        if (r.result?.unsigned?.redacted_because) return false;
                        
                        seenEventIds.add(eventId);
                        return true;
                    });
                    allResults.push(...uniqueResults);
                }
                nextBatch = roomData?.next_batch;
            } catch (e) {
                console.warn(`UserFilter: Page ${pageCount} failed:`, e);
                break;
            }
        }

        const response: ISearchResponse = {
            search_categories: {
                room_events: {
                    results: allResults,
                    count: allResults.length,
                    highlights: keyword ? [keyword] : [],
                } as any,
            },
        };

        const query: ISearchRequestBody = {
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

        console.log(`UserFilter: Server search completed - ${allResults.length} results in ${pageCount} pages`);
        return { response, query };
    }

    /**
     * Fallback to local timeline scan when server-side search fails
     */
    private async fallbackToLocalTimelineScan(
        senderFilter: string,
        roomId: string,
        keyword: string,
        abortSignal?: AbortSignal
    ): Promise<{ response: ISearchResponse; query: ISearchRequestBody }> {
        console.log("UserFilter: Starting local timeline scan fallback");
        
        const room = (this.client as any).getRoom?.(roomId);
        const timelineSet = (room as any)?.getUnfilteredTimelineSet?.() || room?.getLiveTimelineSet?.();
        const timeline = timelineSet?.getLiveTimeline?.();
        const results: any[] = [];
        const seenEventIds = new Set<string>();
        
        // Adjust parameters for desktop app
        const PAGE = this.isDesktopApp ? 100 : 500;
        let paginationCount = 0;
        const MAX_PAGINATION = this.isDesktopApp ? 50 : 100;

        const collectFrom = (eventsArr: any[]) => {
            let collected = 0;
            for (let i = eventsArr.length - 1; i >= 0; i--) {
                const ev = eventsArr[i];
                const eventId = ev?.getId?.() || ev?.event_id || ev?.event?.event_id;
                if (!eventId || seenEventIds.has(eventId)) continue;
                
                if (ev.isRedacted?.()) continue;
                
                const type = ev?.getType?.();
                const isMessageLike = type === 'm.room.message' || type === 'm.room.encrypted' || type === 'm.sticker';
                
                if (isMessageLike && ev.getSender?.() === senderFilter) {
                    const bodyText = ev.getContent?.()?.body as string | undefined;
                    // Check keyword if provided - if no keyword, include all messages
                    if (keyword && keyword.trim()) {
                        if (!bodyText || !bodyText.toLowerCase().includes(keyword.toLowerCase())) {
                            continue;
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

        const initialEvents = timeline?.getEvents?.() || [];
        collectFrom(initialEvents);

        // Paginate with retry mechanism
        while (paginationCount < MAX_PAGINATION) {
            const prevSeen = seenEventIds.size;
            const hasMoreToken = !!timeline?.getPaginationToken?.("b");
            const hasOlderNeighbour = !!timeline?.getNeighbouringTimeline?.("b");
            
            if (!hasMoreToken && !hasOlderNeighbour) break;
            
            try {
                paginationCount++;
                
                // Retry mechanism for paginateEventTimeline
                let retryCount = 0;
                const maxRetries = this.isDesktopApp ? 2 : 3;
                let success = false;
                
                while (retryCount < maxRetries && !success) {
                    try {
                        // eslint-disable-next-line @typescript-eslint/await-thenable
                        await (this.client as any).paginateEventTimeline?.(timeline, { backwards: true, limit: PAGE });
                        success = true;
                    } catch (retryError) {
                        retryCount++;
                        if (retryCount < maxRetries) {
                            console.warn(`UserFilter: paginateEventTimeline retry ${retryCount}/${maxRetries} failed:`, retryError);
                            const delay = this.isDesktopApp ? 500 * retryCount : 1000 * retryCount;
                            await new Promise(resolve => setTimeout(resolve, delay));
                        } else {
                            throw retryError;
                        }
                    }
                }
                
                const pageEvents = timeline?.getEvents?.() || [];
                const pageCollected = collectFrom(pageEvents);
                
                if (paginationCount % 10 === 0) {
                    console.log(`UserFilter: Local scan - page ${paginationCount}: ${pageEvents.length} events, +${pageCollected} for ${senderFilter}, total: ${results.length}`);
                }
                
                if (seenEventIds.size === prevSeen) {
                    console.log(`UserFilter: Local scan - no new events collected, stopping`);
                    break;
                }
            } catch (e) {
                console.warn(`UserFilter: paginateEventTimeline failed at page ${paginationCount}:`, e);
                break;
            }
        }

        console.log(`UserFilter: Local timeline scan completed - ${results.length} results in ${paginationCount} pages`);

        const response: ISearchResponse = {
            search_categories: {
                room_events: {
                    results,
                    count: results.length,
                    highlights: keyword ? [keyword] : [],
                } as any,
            },
        };

        const query: ISearchRequestBody = {
            search_categories: {
                room_events: {
                    search_term: keyword || "*",
                    filter: {
                        limit: SEARCH_LIMIT,
                        rooms: [roomId],
                        senders: [senderFilter],
                    },
                    order_by: SearchOrderBy.Recent,
                    event_context: { before_limit: 0, after_limit: 0, include_profile: true },
                },
            },
        };

        return { response, query };
    }

    /**
     * Create empty result when all methods fail
     */
    private createEmptyResult(): { response: ISearchResponse; query: ISearchRequestBody } {
        const response: ISearchResponse = {
            search_categories: {
                room_events: {
                    results: [],
                    count: 0,
                    highlights: [],
                } as any,
            },
        };

        const query: ISearchRequestBody = {
            search_categories: {
                room_events: {
                    search_term: "*",
                    filter: {
                        limit: SEARCH_LIMIT,
                        rooms: [],
                        senders: [],
                    },
                    order_by: SearchOrderBy.Recent,
                    event_context: { before_limit: 0, after_limit: 0, include_profile: true },
                },
            },
        };

        return { response, query };
    }
}

/**
 * Factory function to create UserFilter instance
 */
export function createUserFilter(client: MatrixClient): UserFilter {
    return new UserFilter(client);
}
