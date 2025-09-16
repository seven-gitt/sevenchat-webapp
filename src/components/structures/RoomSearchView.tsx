/*
Copyright 2024 New Vector Ltd.
Copyright 2015-2023 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX, type Ref, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
    type ISearchResults,
    type IThreadBundledRelationship,
    type MatrixEvent,
    type MatrixClient,
    THREAD_RELATION_TYPE,
} from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import ScrollPanel from "./ScrollPanel";
import Spinner from "../views/elements/Spinner";
import { _t } from "../../languageHandler";
import { haveRendererForEvent } from "../../events/EventTileFactory";
import SearchResultTile from "../views/rooms/SearchResultTile";
import { searchPagination, SearchScope } from "../../Searching";
import type ResizeNotifier from "../../utils/ResizeNotifier";
import MatrixClientContext from "../../contexts/MatrixClientContext";
import { RoomPermalinkCreator } from "../../utils/permalinks/Permalinks";
import { useScopedRoomContext } from "../../contexts/ScopedRoomContext";

// Helper function để lấy display name của user trong room
function getUserDisplayName(client: MatrixClient, userId: string, room: any): string {
    if (!room || !client || !userId) {
        return userId;
    }
    
    // Thử lấy từ room member trước
    const member = room.getMember(userId);
    if (member) {
        // Ưu tiên rawDisplayName trước vì nó là tên gốc user đặt
        return member.rawDisplayName || member.name || userId;
    }
    
    // Fallback: thử lấy từ client profile
    try {
        const user = client.getUser(userId);
        if (user?.rawDisplayName) {
            return user.rawDisplayName;
        }
        if (user?.displayName) {
            return user.displayName;
        }
    } catch (e) {
        // Ignore error, fallback to userId
    }
    
    return userId;
}

const DEBUG = false;
let debuglog = function (msg: string): void {};

/* istanbul ignore next */
if (DEBUG) {
    // using bind means that we get to keep useful line numbers in the console
    debuglog = logger.log.bind(console);
}

interface Props {
    term: string;
    scope: SearchScope;
    inProgress: boolean;
    promise: Promise<ISearchResults>;
    abortController?: AbortController;
    resizeNotifier: ResizeNotifier;
    className: string;
    onUpdate(inProgress: boolean, results: ISearchResults | null, error: Error | null): void;
    ref?: Ref<ScrollPanel>;
    // Props cho việc lọc theo người gửi
    selectedSender?: string;
}

// XXX: todo: merge overlapping results somehow?
// XXX: why doesn't searching on name work?
export const RoomSearchView = ({
    term,
    scope,
    promise,
    abortController,
    resizeNotifier,
    className,
    onUpdate,
    inProgress,
    ref,
    selectedSender = "all",
}: Props): JSX.Element => {
    const client = useContext(MatrixClientContext);
    const roomContext = useScopedRoomContext("showHiddenEvents", "room");
    const [highlights, setHighlights] = useState<string[] | null>(null);
    const [results, setResults] = useState<ISearchResults | null>(null);
    const aborted = useRef(false);
    // A map from room ID to permalink creator
    const permalinkCreators = useMemo(() => new Map<string, RoomPermalinkCreator>(), []);
    const innerRef = useRef<ScrollPanel>(null);

    useEffect(() => {
        return () => {
            permalinkCreators.forEach((pc) => pc.stop());
            permalinkCreators.clear();
        };
    }, [permalinkCreators]);

    const handleSearchResult = useCallback(
        (searchPromise: Promise<ISearchResults>): Promise<boolean> => {
            onUpdate(true, null, null);

            return searchPromise.then(
                async (results): Promise<boolean> => {
                    debuglog("search complete");
                    if (aborted.current) {
                        logger.error("Discarding stale search results");
                        return false;
                    }

                    // postgres on synapse returns us precise details of the strings
                    // which actually got matched for highlighting.
                    //
                    // In either case, we want to highlight the literal search term
                    // whether it was used by the search engine or not.

                    let highlights = results.highlights;
                    
                    // Xử lý highlight cho tìm kiếm kết hợp sender + keyword
                    const senderMatch = term.match(/sender:([^\s]+)(?:\s+(.*))?/);
                    if (senderMatch && senderMatch[2]) {
                        // Có keyword sau sender filter
                        const keyword = senderMatch[2].trim();
                        if (keyword && !highlights.includes(keyword)) {
                            highlights = highlights.concat(keyword);
                        }
                    } else if (term && !term.startsWith('sender:')) {
                        // Tìm kiếm thông thường, không có sender filter
                        if (!highlights.includes(term)) {
                            highlights = highlights.concat(term);
                        }
                    }

                    // For overlapping highlights,
                    // favour longer (more specific) terms first
                    highlights = highlights.sort(function (a, b) {
                        return b.length - a.length;
                    });

                    for (const result of results.results) {
                        for (const event of result.context.getTimeline()) {
                            const bundledRelationship = event.getServerAggregatedRelation<IThreadBundledRelationship>(
                                THREAD_RELATION_TYPE.name,
                            );
                            if (!bundledRelationship || event.getThread()) continue;
                            const room = client.getRoom(event.getRoomId());
                            const thread = room?.findThreadForEvent(event);
                            if (thread) {
                                event.setThread(thread);
                            } else {
                                room?.createThread(event.getId()!, event, [], true);
                            }
                        }
                    }

                    setHighlights(highlights);
                    setResults({ ...results }); // copy to force a refresh
                    onUpdate(false, results, null);
                    return false;
                },
                (error) => {
                    if (aborted.current) {
                        logger.error("Discarding stale search results");
                        return false;
                    }
                    
                    // Kiểm tra nếu lỗi là do AbortSignal
                    if (error?.name === 'AbortError' || error?.message?.includes('aborted')) {
                        logger.log("Search was aborted by user or component unmount");
                        onUpdate(false, null, null); // Không truyền error cho abort
                        return false;
                    }
                    
                    logger.error("Search failed", error);
                    onUpdate(false, null, error);
                    return false;
                },
            );
        },
        [client, term, onUpdate],
    );

    // ✅ CẢI THIỆN: Lọc kết quả theo người gửi được chọn - đảm bảo không bỏ sót kết quả
    const filteredResults = useMemo(() => {
        if (!results?.results) {
            return [];
        }
        
        console.log(`[RoomSearchView] Filtering results: total=${results.results.length}, selectedSender=${selectedSender}, term="${term}"`);
        
        // ✅ CẢI THIỆN: Nếu đang sử dụng từ khóa sender:, kết quả đã được lọc ở backend
        // Nhưng vẫn cần kiểm tra để đảm bảo không bỏ sót
        if (term.startsWith('sender:')) {
            console.log(`[RoomSearchView] Using backend-filtered results (sender: prefix found)`);
            
            // ✅ CẢI THIỆN: Vẫn kiểm tra nếu có selectedSender khác "all"
            if (selectedSender !== "all") {
                const filtered = results.results.filter(r => {
                    const sender = r.context.getEvent().getSender();
                    return sender === selectedSender;
                });
                console.log(`[RoomSearchView] Additional frontend filtering for sender: ${results.results.length} -> ${filtered.length}`);
                return filtered;
            }
            
            return results.results;
        }
        
        // ✅ CẢI THIỆN: Chỉ lọc khi selectedSender khác "all" và không phải từ khóa sender:
        if (selectedSender === "all") {
            console.log(`[RoomSearchView] Showing all results (selectedSender=all)`);
            return results.results;
        }
        
        // ✅ CẢI THIỆN: Lọc kết quả nhưng đảm bảo không bỏ sót
        const filtered = results.results.filter(r => {
            try {
                const sender = r.context.getEvent().getSender();
                return sender === selectedSender;
            } catch (error) {
                // ✅ CẢI THIỆN: Nếu có lỗi khi lấy sender, vẫn giữ kết quả để không bỏ sót
                console.warn(`[RoomSearchView] Error getting sender for result:`, error);
                return true;
            }
        });
        
        console.log(`[RoomSearchView] Frontend filtering: ${results.results.length} -> ${filtered.length} (selectedSender=${selectedSender})`);
        
        // ✅ CẢI THIỆN: Debug: Log some sender info để kiểm tra
        const senders = new Set();
        results.results.forEach(r => {
            try {
                const sender = r.context.getEvent().getSender();
                senders.add(sender);
            } catch (error) {
                console.warn(`[RoomSearchView] Error getting sender for debug:`, error);
            }
        });
        console.log(`[RoomSearchView] Available senders in results:`, Array.from(senders));
        
        // ✅ CẢI THIỆN: Nếu filtered quá ít, có thể có vấn đề với filtering logic
        if (filtered.length === 0 && results.results.length > 0) {
            console.warn(`[RoomSearchView] Warning: All results filtered out! This might indicate a filtering issue.`);
            console.warn(`[RoomSearchView] Term: "${term}", SelectedSender: "${selectedSender}"`);
        }
        
        return filtered;
    }, [results, selectedSender, term]);

    // Mount & unmount effect
    useEffect(() => {
        aborted.current = false;
        handleSearchResult(promise).catch((error) => {
            // Xử lý lỗi từ promise một cách graceful
            if (error?.name === 'AbortError' || error?.message?.includes('aborted')) {
                return;
            }
            console.error("Search promise failed:", error);
        });
        return () => {
            aborted.current = true;
            // Không abort nếu component đã unmount để tránh lỗi "signal is aborted without reason"
            // Promise sẽ tự động cleanup khi component unmount
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // show searching spinner
    if (results === null) {
        return (
            <div
                className="mx_RoomView_messagePanel mx_RoomView_messagePanelSearchSpinner"
                data-testid="messagePanelSearchSpinner"
            >
                <li className="mx_RoomView_scrollheader" />
            </div>
        );
    }

    // Nếu không có kết quả tìm kiếm, hiển thị thông báo
    if (!results?.results?.length) {
        let message = "Không tìm thấy kết quả";
        
        // Kiểm tra xem có phải tìm kiếm theo sender không
        const senderMatch = term.match(/sender:([^\s]+)(?:\s+(.*))?/);
        if (senderMatch) {
            const senderId = senderMatch[1];
            const keyword = senderMatch[2]?.trim();
            
            // Lấy tên hiển thị của sender
            const senderName = getUserDisplayName(client, senderId, roomContext?.room);
            
            if (keyword) {
                message = `Không tìm thấy tin nhắn nào từ ${senderName} chứa "${keyword}"`;
            } else {
                message = `Không tìm thấy tin nhắn nào từ ${senderName}`;
            }
        } else if (term) {
            message = `Không tìm thấy tin nhắn nào chứa "${term}"`;
        }
            
        return (
            <div className="mx_RoomView_messagePanel">
                <li className="mx_RoomView_scrollheader" />
                <li key="no-results">
                    <h2 className="mx_RoomView_topMarker">
                        {message}
                    </h2>
                </li>
            </div>
        );
    }

    const onSearchResultsFillRequest = async (_backwards: boolean): Promise<boolean> => {
        // For search results, keep paginating as long as the server indicates
        // more pages, regardless of scroll direction.
        if (!results.next_batch) {
            debuglog("no more search results");
            return false;
        }

        debuglog("requesting more search results (search view)");
        // Fetch the next page and compute hasMore from the resolved payload to
        // avoid relying on async state updates.
        const pagePromise = searchPagination(client, results);
        const next = await pagePromise;
        await handleSearchResult(Promise.resolve(next));

        // If filtering by a specific sender, aggressively prefetch subsequent
        // pages so the list becomes fully scrollable even when many pages don't
        // contain matching events. This avoids the UX trap where the viewport
        // appears to “stop” at a certain day until the panel width changes.
        if (selectedSender && selectedSender !== "all") {
            let loops = 0;
            // hard safety cap: 50 pages per fill request
            while (results.next_batch && loops < 50) {
                const more = await searchPagination(client, results);
                await handleSearchResult(Promise.resolve(more));
                loops++;
            }
        }

        return !!results.next_batch;
    };

    const ret: JSX.Element[] = [];

    if (inProgress) {
        ret.push(
            <li key="search-spinner">
                <Spinner />
            </li>,
        );
    }

    if (!results.next_batch) {
        if (!results?.results?.length) {
            ret.push(
                <li key="search-top-marker">
                    <h2 className="mx_RoomView_topMarker">{_t("common|no_results")}</h2>
                </li>,
            );
        } else {
            ret.push(
                <li key="search-top-marker">
                    <h2 className="mx_RoomView_topMarker">Không còn kết quả nào khác</h2>
                </li>,
            );
        }
    }

    const onRef = (e: ScrollPanel | null): void => {
        if (typeof ref === "function") {
            ref(e);
        } else if (!!ref) {
            ref.current = e;
        }
        innerRef.current = e;
    };

    let lastRoomId: string | undefined;
    let mergedTimeline: MatrixEvent[] = [];
    let ourEventsIndexes: number[] = [];

    // Sử dụng filteredResults để hiển thị kết quả đã lọc
    const searchResults = filteredResults;
    
    // Render newest first: iterate from start to end (server already returns
    // newest-first, so we keep that order instead of reversing it).
    for (let i = 0; i < (searchResults.length || 0); i++) {
        const result = searchResults[i];

        const mxEv = result.context.getEvent();
        const roomId = mxEv.getRoomId()!;
        const room = client.getRoom(roomId);
        if (!room) {
            // if we do not have the room in js-sdk stores then hide it as we cannot easily show it
            // As per the spec, an all rooms search can create this condition,
            // it happens with Seshat but not Synapse.
            // It will make the result count not match the displayed count.
            logger.log("Hiding search result from an unknown room", roomId);
            continue;
        }

        if (!haveRendererForEvent(mxEv, client, roomContext.showHiddenEvents)) {
            // XXX: can this ever happen? It will make the result count
            // not match the displayed count.
            continue;
        }

        if (scope === SearchScope.All) {
            if (roomId !== lastRoomId) {
                ret.push(
                    <li key={mxEv.getId() + "-room"}>
                        <h2>
                            {_t("common|room")}: {room.name}
                        </h2>
                    </li>,
                );
                lastRoomId = roomId;
            }
        }

        const resultLink = "#/room/" + roomId + "/" + mxEv.getId();

        // merging two successive search result if the query is present in both of them
        const currentTimeline = result.context.getTimeline();
        const nextTimeline = i < (searchResults.length || 0) - 1 ? searchResults[i + 1].context.getTimeline() : [];

        if (i < (searchResults.length || 0) - 1 && currentTimeline[currentTimeline.length - 1].getId() == nextTimeline[0].getId()) {
            // if this is the first searchResult we merge then add all values of the current searchResult
            if (mergedTimeline.length == 0) {
                for (let j = mergedTimeline.length == 0 ? 0 : 1; j < result.context.getTimeline().length; j++) {
                    mergedTimeline.push(currentTimeline[j]);
                }
                ourEventsIndexes.push(result.context.getOurEventIndex());
            }

            // merge the events of the next searchResult
            for (let j = 1; j < nextTimeline.length; j++) {
                mergedTimeline.push(nextTimeline[j]);
            }

            // add the index of the matching event of the next searchResult
            ourEventsIndexes.push(
                ourEventsIndexes[ourEventsIndexes.length - 1] + searchResults[i + 1].context.getOurEventIndex() + 1,
            );

            continue;
        }

        if (mergedTimeline.length == 0) {
            mergedTimeline = result.context.getTimeline();
            ourEventsIndexes = [];
            ourEventsIndexes.push(result.context.getOurEventIndex());
        }

        let permalinkCreator = permalinkCreators.get(roomId);
        if (!permalinkCreator) {
            permalinkCreator = new RoomPermalinkCreator(room);
            permalinkCreator.start();
            permalinkCreators.set(roomId, permalinkCreator);
        }

        ret.push(
            <SearchResultTile
                key={mxEv.getId()}
                timeline={mergedTimeline}
                ourEventsIndexes={ourEventsIndexes}
                searchHighlights={highlights ?? []}
                resultLink={resultLink}
                permalinkCreator={permalinkCreator}
            />,
        );

        ourEventsIndexes = [];
        mergedTimeline = [];
    }

    return (
        <ScrollPanel
            ref={onRef}
            className={"mx_RoomView_searchResultsPanel " + className}
            onFillRequest={onSearchResultsFillRequest}
            resizeNotifier={resizeNotifier}
            stickyBottom={false}
            startAtBottom={false}
        >
            <li className="mx_RoomView_scrollheader" />
            {ret}
        </ScrollPanel>
    );
};
