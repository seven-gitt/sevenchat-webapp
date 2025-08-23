/*
Copyright 2024 New Vector Ltd.
Copyright 2021-2023 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { type WebSearch as WebSearchEvent } from "@matrix-org/analytics-events/types/typescript/WebSearch";
import classNames from "classnames";
import { capitalize, sum } from "lodash";
import {
    type IPublicRoomsChunkRoom,
    type MatrixClient,
    RoomMember,
    RoomType,
    type Room,
    type HierarchyRoom,
    JoinRule,
} from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { normalize } from "matrix-js-sdk/src/utils";
import React, {
    type JSX,
    type ChangeEvent,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import sanitizeHtml from "sanitize-html";

import { KeyBindingAction } from "../../../../accessibility/KeyboardShortcuts";
import {
    findSiblingElement,
    RovingTabIndexContext,
    RovingTabIndexProvider,
    Type,
} from "../../../../accessibility/RovingTabIndex";
import { mediaFromMxc } from "../../../../customisations/Media";
import { Action } from "../../../../dispatcher/actions";
import defaultDispatcher from "../../../../dispatcher/dispatcher";
import { type ViewRoomPayload } from "../../../../dispatcher/payloads/ViewRoomPayload";
import { useDebouncedCallback } from "../../../../hooks/spotlight/useDebouncedCallback";
import { useRecentSearches } from "../../../../hooks/spotlight/useRecentSearches";
import { useProfileInfo } from "../../../../hooks/useProfileInfo";
import { usePublicRoomDirectory } from "../../../../hooks/usePublicRoomDirectory";
import { useSpaceResults } from "../../../../hooks/useSpaceResults";
import { useUserDirectory } from "../../../../hooks/useUserDirectory";
import { getKeyBindingsManager } from "../../../../KeyBindingsManager";
import { _t } from "../../../../languageHandler";
import { MatrixClientPeg } from "../../../../MatrixClientPeg";
import { PosthogAnalytics } from "../../../../PosthogAnalytics";
import { getCachedRoomIDForAlias } from "../../../../RoomAliasCache";
import { showStartChatInviteDialog } from "../../../../RoomInvite";
import { SettingLevel } from "../../../../settings/SettingLevel";
import SettingsStore from "../../../../settings/SettingsStore";
import { BreadcrumbsStore } from "../../../../stores/BreadcrumbsStore";
import { type RoomNotificationState } from "../../../../stores/notifications/RoomNotificationState";
import { RoomNotificationStateStore } from "../../../../stores/notifications/RoomNotificationStateStore";
import { RecentAlgorithm } from "../../../../stores/room-list/algorithms/tag-sorting/RecentAlgorithm";
import { SdkContextClass } from "../../../../contexts/SDKContext";
import { getMetaSpaceName } from "../../../../stores/spaces";
import SpaceStore from "../../../../stores/spaces/SpaceStore";
import { DirectoryMember, type Member, startDmOnFirstMessage } from "../../../../utils/direct-messages";
import DMRoomMap from "../../../../utils/DMRoomMap";
import { makeUserPermalink } from "../../../../utils/permalinks/Permalinks";
import { buildActivityScores, buildMemberScores, compareMembers } from "../../../../utils/SortMembers";
import { copyPlaintext } from "../../../../utils/strings";
import BaseAvatar from "../../avatars/BaseAvatar";
import DecoratedRoomAvatar from "../../avatars/DecoratedRoomAvatar";
import { SearchResultAvatar } from "../../avatars/SearchResultAvatar";
import { NetworkDropdown } from "../../directory/NetworkDropdown";
import AccessibleButton, { type ButtonEvent } from "../../elements/AccessibleButton";
import Spinner from "../../elements/Spinner";
import NotificationBadge from "../../rooms/NotificationBadge";
import BaseDialog from "../BaseDialog";
import { Option } from "./Option";
import { PublicRoomResultDetails } from "./PublicRoomResultDetails";
import { RoomResultContextMenus } from "./RoomResultContextMenus";
import { RoomContextDetails } from "../../rooms/RoomContextDetails";
import { TooltipOption } from "./TooltipOption";
import { isLocalRoom } from "../../../../utils/localRoom/isLocalRoom";
import RoomAvatar from "../../avatars/RoomAvatar";
import { useFeatureEnabled } from "../../../../hooks/useSettings";
import { filterBoolean } from "../../../../utils/arrays";
import { transformSearchTerm } from "../../../../utils/SearchInput";
import { Filter } from "./Filter";
import "./SpotlightDialog.css";

const MAX_RECENT_SEARCHES = 10;
const SECTION_LIMIT = 50; // only show 50 results per section for performance reasons
const AVATAR_SIZE = "24px";

interface IProps {
    initialText?: string;
    initialFilter?: Filter;
    onFinished(): void;
}

function nodeIsForRecentlyViewed(node?: HTMLElement): boolean {
    return node?.id?.startsWith("mx_SpotlightDialog_button_recentlyViewed_") === true;
}

function getRoomTypes(filter: Filter | null): Set<RoomType | null> {
    const roomTypes = new Set<RoomType | null>();

    if (filter === Filter.PublicRooms) roomTypes.add(null);
    if (filter === Filter.PublicSpaces) roomTypes.add(RoomType.Space);

    return roomTypes;
}

enum Section {
    People,
    Rooms,
    Spaces,
    Suggestions,
    PublicRoomsAndSpaces,
}

function filterToLabel(filter: Filter): string {
    switch (filter) {
        case Filter.People:
            return _t("common|people");
        case Filter.PublicRooms:
            return _t("spotlight_dialog|public_rooms_label");
        case Filter.PublicSpaces:
            return _t("spotlight_dialog|search_messages_label");
    }
}

interface IBaseResult {
    section: Section;
    filter: Filter[];
    query?: string[]; // extra fields to query match, stored as lowercase
}

interface IPublicRoomResult extends IBaseResult {
    publicRoom: IPublicRoomsChunkRoom;
}

interface IRoomResult extends IBaseResult {
    room: Room;
}

interface IMemberResult extends IBaseResult {
    member: Member | RoomMember;
    /**
     * If the result is from a filtered server API then we set true here to avoid locally culling it in our own filters
     */
    alreadyFiltered: boolean;
}

interface IMessageResult extends IBaseResult {
    message: any; // Matrix event
    room: Room;
    content: string;
    sender: string;
    timestamp: number;
    relevanceScore?: number;
}

interface IResult extends IBaseResult {
    avatar: JSX.Element;
    name: string;
    description?: string;
    onClick?(): void;
}

type Result = IRoomResult | IPublicRoomResult | IMemberResult | IMessageResult | IResult;

const isRoomResult = (result: any): result is IRoomResult => !!result?.room && !result?.message;
const isPublicRoomResult = (result: any): result is IPublicRoomResult => !!result?.publicRoom;
const isMemberResult = (result: any): result is IMemberResult => !!result?.member;
const isMessageResult = (result: any): result is IMessageResult => !!result?.message;

const toPublicRoomResult = (publicRoom: IPublicRoomsChunkRoom): IPublicRoomResult => ({
    publicRoom,
    section: Section.PublicRoomsAndSpaces,
    filter: [Filter.PublicRooms, Filter.PublicSpaces],
    query: filterBoolean([
        publicRoom.room_id.toLowerCase(),
        publicRoom.canonical_alias?.toLowerCase(),
        publicRoom.name?.toLowerCase(),
        sanitizeHtml(publicRoom.topic?.toLowerCase() ?? "", { allowedTags: [] }),
        ...(publicRoom.aliases?.map((it) => it.toLowerCase()) || []),
    ]),
});

const toRoomResult = (room: Room): IRoomResult => {
    const myUserId = MatrixClientPeg.safeGet().getUserId();
    const otherUserId = DMRoomMap.shared().getUserIdForRoomId(room.roomId);

    if (otherUserId) {
        const otherMembers = room.getMembers().filter((it) => it.userId !== myUserId);
        const query = [
            ...otherMembers.map((it) => it.name.toLowerCase()),
            ...otherMembers.map((it) => it.userId.toLowerCase()),
        ].filter(Boolean);
        return {
            room,
            section: Section.People,
            filter: [Filter.People],
            query,
        };
    } else if (room.isSpaceRoom()) {
        return {
            room,
            section: Section.Spaces,
            filter: [],
        };
    } else {
        return {
            room,
            section: Section.Rooms,
            filter: [],
        };
    }
};

const toMemberResult = (member: Member | RoomMember, alreadyFiltered: boolean): IMemberResult => ({
    alreadyFiltered,
    member,
    section: Section.Suggestions,
    filter: [Filter.People],
    query: [member.userId.toLowerCase(), member.name.toLowerCase()].filter(Boolean),
});

const searchMessagesInRooms = (cli: MatrixClient, query: string): IMessageResult[] => {
    const results: IMessageResult[] = [];
    const lcQuery = query.toLowerCase();
    
    // Skip search if query is too short
    if (lcQuery.length < 2) {
        console.log(`Query "${query}" is too short, skipping search`);
        return results;
    }
    
    // Get all rooms the user is in
    const rooms = cli.getVisibleRooms().filter(room => 
        room.getMyMembership() === KnownMembership.Join
    );
    
    console.log(`Searching for "${query}" in ${rooms.length} rooms`);
    
    let totalEventsProcessed = 0;
    let totalMessagesFound = 0;
    
    // Process rooms with better performance
    rooms.forEach(room => {
        try {
            // Get recent messages from the room timeline
            const timeline = room.getLiveTimeline();
            const events = timeline?.getEvents() || [];
            
            // Only process if we have events
            if (events.length === 0) {
                console.log(`Room ${room.name} has no events`);
                return;
            }
            
            console.log(`Room ${room.name} has ${events.length} events`);
            totalEventsProcessed += events.length;
            
            let roomMessagesFound = 0;
            
            // Process events in reverse order (newest first) for better performance
            for (let i = events.length - 1; i >= 0; i--) {
                const event = events[i];
                
                try {
                    if (event.getType() === "m.room.message") {
                        const content = event.getContent();
                        // Only process text messages, skip files, images, etc.
                        if (content && content.body && typeof content.body === 'string' && 
                            content.msgtype === 'm.text' && 
                            !content.url && 
                            !content.info) {
                            const messageText = content.body.toLowerCase();
                            
                            // Check if message contains the query (case insensitive)
                            // Also check if any word in the query matches any word in the message
                            const queryWords = lcQuery.split(/\s+/).filter(word => word.length > 0);
                            const messageWords = messageText.split(/\s+/).filter(word => word.length > 0);
                            
                            const hasExactMatch = messageText.includes(lcQuery);
                            const hasWordMatch = queryWords.some(queryWord => 
                                messageWords.some(messageWord => messageWord.includes(queryWord))
                            );
                            
                            // Calculate relevance score
                            let relevanceScore = 0;
                            if (hasExactMatch) relevanceScore += 100;
                            if (hasWordMatch) relevanceScore += queryWords.length * 10;
                            
                            // Additional relevance factors
                            const queryLength = lcQuery.length;
                            const messageLength = messageText.length;
                            
                            // Prefer shorter messages for longer queries (more specific)
                            if (queryLength > 5 && messageLength < 100) {
                                relevanceScore += 20;
                            }
                            
                            // Penalize very long messages unless they have exact match
                            if (messageLength > 200 && !hasExactMatch) {
                                relevanceScore -= 10;
                            }
                            
                            // Heavy penalty for messages that only match single characters
                            const matchedWords = queryWords.filter(queryWord => 
                                messageWords.some(messageWord => messageWord.includes(queryWord))
                            );
                            if (matchedWords.length === 1 && matchedWords[0].length <= 2) {
                                relevanceScore -= 50; // Heavy penalty for single character matches
                            }
                            
                            // Penalize messages with URLs unless they have exact match
                            if (content.body.includes('http') && !hasExactMatch) {
                                relevanceScore -= 30;
                            }
                            
                            // Only include messages with good relevance (minimum threshold)
                            if (relevanceScore >= 20) {
                                console.log(`Found match in room ${room.name}: "${content.body}" contains "${query}"`);
                                // Get sender display name
                                const sender = event.getSender();
                                if (sender) {
                                    const member = room.getMember(sender);
                                    const senderName = member?.rawDisplayName || sender;
                                    
                                    // Get message preview (first 100 characters)
                                    const preview = content.body.length > 100 
                                        ? content.body.substring(0, 100) + '...' 
                                        : content.body;
                                    
                                    console.log(`Found message: "${preview}" from ${senderName} in ${room.name} (relevance: ${relevanceScore})`);
                                    
                                    results.push({
                                        message: event,
                                        room: room,
                                        content: preview,
                                        sender: senderName,
                                        timestamp: event.getTs(),
                                        section: Section.PublicRoomsAndSpaces,
                                        filter: [Filter.PublicSpaces],
                                        query: [content.body.toLowerCase(), room.name.toLowerCase()],
                                        relevanceScore: relevanceScore,
                                    });
                                    
                                    roomMessagesFound++;
                                    totalMessagesFound++;
                                    
                                    // Limit results per room to avoid overwhelming
                                    if (results.length >= 100) {
                                        console.log(`Reached limit of 100 results, stopping search`);
                                        return results
                                            .sort((a, b) => b.timestamp - a.timestamp)
                                            .slice(0, 50);
                                    }
                                }
                            } else {
                                // Debug: Log some messages that don't match to understand why
                                if (roomMessagesFound === 0 && i < 5) {
                                    console.log(`Message in ${room.name} doesn't match: "${content.body}" (searching for "${query}")`);
                                }
                            }
                        }
                    }
                } catch (eventError) {
                    console.error(`Error processing event in room ${room.name}:`, eventError);
                }
            }
            
            if (roomMessagesFound > 0) {
                console.log(`Found ${roomMessagesFound} messages in room ${room.name}`);
            }
            
        } catch (roomError) {
            console.error(`Error processing room ${room.name}:`, roomError);
        }
    });
    
    console.log(`Total events processed: ${totalEventsProcessed}`);
    console.log(`Total message results: ${results.length}`);
    console.log(`Total messages found: ${totalMessagesFound}`);
    
    // Sort by timestamp (newest first) and limit results
    return results
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 50);
};

const recentAlgorithm = new RecentAlgorithm();

export const useWebSearchMetrics = (numResults: number, queryLength: number, viaSpotlight: boolean): void => {
    useEffect(() => {
        if (!queryLength) return;

        // send metrics after a 1s debounce
        const timeoutId = window.setTimeout(() => {
            PosthogAnalytics.instance.trackEvent<WebSearchEvent>({
                eventName: "WebSearch",
                viaSpotlight,
                numResults,
                queryLength,
            });
        }, 1000);

        return () => {
            clearTimeout(timeoutId);
        };
    }, [numResults, queryLength, viaSpotlight]);
};

const findVisibleRooms = (cli: MatrixClient, msc3946ProcessDynamicPredecessor: boolean): Room[] => {
    return cli.getVisibleRooms(msc3946ProcessDynamicPredecessor).filter((room) => {
        // Do not show local rooms
        if (isLocalRoom(room)) return false;

        // TODO we may want to put invites in their own list
        return room.getMyMembership() === KnownMembership.Join || room.getMyMembership() == KnownMembership.Invite;
    });
};

const findVisibleRoomMembers = (visibleRooms: Room[], cli: MatrixClient, filterDMs = true): RoomMember[] => {
    return Object.values(
        visibleRooms
            .filter((room) => !filterDMs || !DMRoomMap.shared().getUserIdForRoomId(room.roomId))
            .reduce(
                (members, room) => {
                    for (const member of room.getJoinedMembers()) {
                        members[member.userId] = member;
                    }
                    return members;
                },
                {} as Record<string, RoomMember>,
            ),
    ).filter((it) => it.userId !== cli.getUserId());
};

const roomAriaUnreadLabel = (room: Room, notification: RoomNotificationState): string | undefined => {
    if (notification.hasMentions) {
        return _t("a11y|n_unread_messages_mentions", {
            count: notification.count,
        });
    } else if (notification.hasUnreadCount) {
        return _t("a11y|n_unread_messages", {
            count: notification.count,
        });
    } else if (notification.isUnread) {
        return _t("a11y|unread_messages");
    } else {
        return undefined;
    }
};

const canAskToJoin = (joinRule?: JoinRule): boolean => {
    return SettingsStore.getValue("feature_ask_to_join") && JoinRule.Knock === joinRule;
};

interface IDirectoryOpts {
    limit: number;
    query: string;
}

const SpotlightDialog: React.FC<IProps> = ({ initialText = "", initialFilter = null, onFinished }) => {
    const inputRef = useRef<HTMLInputElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const cli = MatrixClientPeg.safeGet();
    const rovingContext = useContext(RovingTabIndexContext);
    const [query, _setQuery] = useState(initialText);
    const [recentSearches, clearRecentSearches] = useRecentSearches();
    const [filter, setFilterInternal] = useState<Filter | null>(initialFilter);
    const [messageSearchResults, setMessageSearchResults] = useState<IMessageResult[]>([]);
    const [messageSearchLoading, setMessageSearchLoading] = useState(false);
    
    const setFilter = useCallback((filter: Filter | null) => {
        setFilterInternal(filter);
        inputRef.current?.focus();
        scrollContainerRef.current?.scrollTo?.({ top: 0 });
    }, []);
    
    const memberComparator = useMemo(() => {
        const activityScores = buildActivityScores(cli);
        const memberScores = buildMemberScores(cli);
        return compareMembers(activityScores, memberScores);
    }, [cli]);
    const msc3946ProcessDynamicPredecessor = useFeatureEnabled("feature_dynamic_room_predecessors");

    const ownInviteLink = makeUserPermalink(cli.getUserId()!);
    const [inviteLinkCopied, setInviteLinkCopied] = useState<boolean>(false);
    const trimmedQuery = useMemo(() => query.trim(), [query]);

    // Handle message search when filter is PublicSpaces and query changes
    useEffect(() => {
        if (filter === Filter.PublicSpaces && trimmedQuery) {
            setMessageSearchLoading(true);
            // Use debounced search to avoid too many searches
            const timeoutId = setTimeout(() => {
                const results = searchMessagesInRooms(cli, trimmedQuery);
                setMessageSearchResults(results);
                setMessageSearchLoading(false);
            }, 300); // Increased debounce time for better performance
            
            return () => {
                clearTimeout(timeoutId);
                setMessageSearchLoading(false);
            };
        } else {
            setMessageSearchResults([]);
            setMessageSearchLoading(false);
        }
    }, [filter, trimmedQuery, cli]);

    const [supportsSpaceFiltering, setSupportsSpaceFiltering] = useState(true); // assume it does until we find out it doesn't
    useEffect(() => {
        cli.isVersionSupported("v1.4")
            .then((supported) => {
                return supported || cli.doesServerSupportUnstableFeature("org.matrix.msc3827.stable");
            })
            .then((supported) => {
                setSupportsSpaceFiltering(supported);
            });
    }, [cli]);

    const {
        loading: publicRoomsLoading,
        publicRooms,
        protocols,
        config,
        setConfig,
        search: searchPublicRooms,
        error: publicRoomsError,
    } = usePublicRoomDirectory();
    const { loading: peopleLoading, users: userDirectorySearchResults, search: searchPeople } = useUserDirectory();
    const { loading: profileLoading, profile, search: searchProfileInfo } = useProfileInfo();
    const searchParams: [IDirectoryOpts] = useMemo(
        () => [
            {
                query: trimmedQuery,
                roomTypes: getRoomTypes(filter),
                limit: SECTION_LIMIT,
            },
        ],
        [trimmedQuery, filter],
    );
    useDebouncedCallback(
        filter === Filter.PublicRooms,
        searchPublicRooms,
        searchParams,
    );
    useDebouncedCallback(filter === Filter.People, searchPeople, searchParams);
    useDebouncedCallback(filter === Filter.People, searchProfileInfo, searchParams);

    const possibleResults = useMemo<Result[]>(() => {
        const visibleRooms = findVisibleRooms(cli, msc3946ProcessDynamicPredecessor);
        const roomResults = visibleRooms.map(toRoomResult);
        const userResults: IMemberResult[] = [];

        // If we already have a DM with the user we're looking for, we will show that DM instead of the user themselves
        const alreadyAddedUserIds = roomResults.reduce((userIds, result) => {
            const userId = DMRoomMap.shared().getUserIdForRoomId(result.room.roomId);
            if (!userId) return userIds;
            if (result.room.getJoinedMemberCount() > 2) return userIds;
            userIds.set(userId, result);
            return userIds;
        }, new Map<string, IMemberResult | IRoomResult>());

        function addUserResults(users: Array<Member | RoomMember>, alreadyFiltered: boolean): void {
            for (const user of users) {
                // Make sure we don't have any user more than once
                if (alreadyAddedUserIds.has(user.userId)) {
                    const result = alreadyAddedUserIds.get(user.userId)!;
                    if (alreadyFiltered && isMemberResult(result) && !result.alreadyFiltered) {
                        // But if they were added as not yet filtered then mark them as already filtered to avoid
                        // culling this result based on local filtering.
                        result.alreadyFiltered = true;
                    }
                    continue;
                }
                const result = toMemberResult(user, alreadyFiltered);
                alreadyAddedUserIds.set(user.userId, result);
                userResults.push(result);
            }
        }
        addUserResults(findVisibleRoomMembers(visibleRooms, cli), false);
        addUserResults(userDirectorySearchResults, true);
        if (profile) {
            addUserResults([new DirectoryMember(profile)], true);
        }

        const baseResults: Result[] = [
            ...SpaceStore.instance.enabledMetaSpaces.map((spaceKey) => ({
                section: Section.Spaces,
                filter: [] as Filter[],
                avatar: (
                    <div
                        className={classNames(
                            "mx_SpotlightDialog_metaspaceResult",
                            `mx_SpotlightDialog_metaspaceResult_${spaceKey}`,
                        )}
                    />
                ),
                name: getMetaSpaceName(spaceKey, SpaceStore.instance.allRoomsInHome),
                onClick() {
                    SpaceStore.instance.setActiveSpace(spaceKey);
                },
            })),
            ...roomResults,
            ...userResults,
        ];
        
        // Only include public rooms if not searching for messages
        if (filter !== Filter.PublicSpaces) {
            baseResults.push(...publicRooms.map(toPublicRoomResult));
        }
        
        return baseResults.filter((result) => filter === null || result.filter.includes(filter));
    }, [cli, userDirectorySearchResults, profile, publicRooms, filter, msc3946ProcessDynamicPredecessor]);

    const results = useMemo<Record<Section, Result[]>>(() => {
        const results: Record<Section, Result[]> = {
            [Section.People]: [],
            [Section.Rooms]: [],
            [Section.Spaces]: [],
            [Section.Suggestions]: [],
            [Section.PublicRoomsAndSpaces]: [],
        };

        // Group results in their respective sections
        if (trimmedQuery) {
            console.log(`Filter: ${filter}, Query: "${trimmedQuery}"`);
            console.log(`Filter.PublicSpaces value: ${Filter.PublicSpaces}`);
            console.log(`Filter comparison: ${filter === Filter.PublicSpaces}`);
            console.log(`Message search results count: ${messageSearchResults.length}`);
            
            // If filter is PublicSpaces, use message search results
            if (filter === Filter.PublicSpaces) {
                console.log("Using message search results");
                console.log(`Found ${messageSearchResults.length} message results`);
                results[Section.PublicRoomsAndSpaces].push(...messageSearchResults);
                console.log(`Added ${messageSearchResults.length} message results to section`);
            } else {
                // For other filters, use the normal search logic
                const lcQuery = trimmedQuery.toLowerCase();
                const normalizedQuery = normalize(trimmedQuery);

                possibleResults.forEach((entry) => {
                    if (isRoomResult(entry)) {
                        // If the room is a DM with a user that is part of the user directory search results,
                        // we can assume the user is a relevant result, so include the DM with them too.
                        const userId = DMRoomMap.shared().getUserIdForRoomId(entry.room.roomId);
                        if (!userDirectorySearchResults.some((user) => user.userId === userId)) {
                            if (
                                !entry.room.normalizedName?.includes(normalizedQuery) &&
                                !entry.room.getCanonicalAlias()?.toLowerCase().includes(lcQuery) &&
                                !entry.query?.some((q) => q.includes(lcQuery))
                            ) {
                                return; // bail, does not match query
                            }
                        }
                    } else if (isMemberResult(entry)) {
                        if (!entry.alreadyFiltered && !entry.query?.some((q) => q.includes(lcQuery))) return; // bail, does not match query
                    } else if (isPublicRoomResult(entry)) {
                        if (!entry.query?.some((q) => q.includes(lcQuery))) return; // bail, does not match query
                    } else if (isMessageResult(entry)) {
                        if (!entry.query?.some((q) => q.includes(lcQuery))) return; // bail, does not match query
                    } else {
                        if (!entry.name.toLowerCase().includes(lcQuery) && !entry.query?.some((q) => q.includes(lcQuery)))
                            return; // bail, does not match query
                    }

                    results[entry.section].push(entry);
                });
            }
        } else if (filter === Filter.PublicRooms) {
            // return all results for public rooms if no query is given
            possibleResults.forEach((entry) => {
                if (isPublicRoomResult(entry)) {
                    results[entry.section].push(entry);
                }
            });
        } else if (filter === Filter.PublicSpaces) {
            // When PublicSpaces filter is active but no query, don't show any results
            // This prevents showing user/room results when we want to search messages
        } else if (filter === Filter.People) {
            // return all results for people if no query is given
            possibleResults.forEach((entry) => {
                if (isMemberResult(entry)) {
                    results[entry.section].push(entry);
                }
            });
        }

        // Sort results by most recent activity

        const myUserId = cli.getSafeUserId();
        for (const resultArray of Object.values(results)) {
            resultArray.sort((a: Result, b: Result) => {
                if (isRoomResult(a) || isRoomResult(b)) {
                    // Room results should appear at the top of the list
                    if (!isRoomResult(b)) return -1;
                    if (!isRoomResult(a)) return -1;

                    return recentAlgorithm.getLastTs(b.room, myUserId) - recentAlgorithm.getLastTs(a.room, myUserId);
                } else if (isMemberResult(a) || isMemberResult(b)) {
                    // Member results should appear just after room results
                    if (!isMemberResult(b)) return -1;
                    if (!isMemberResult(a)) return -1;

                    return memberComparator(a.member, b.member);
                } else if (isMessageResult(a) || isMessageResult(b)) {
                    // Message results should be sorted by relevance score first, then by timestamp
                    if (!isMessageResult(b)) return -1;
                    if (!isMessageResult(a)) return -1;

                    // Sort by relevance score (higher first), then by timestamp (newer first)
                    const scoreDiff = (b.relevanceScore || 0) - (a.relevanceScore || 0);
                    if (scoreDiff !== 0) return scoreDiff;
                    return b.timestamp - a.timestamp;
                }
                return 0;
            });
        }

        return results;
    }, [trimmedQuery, filter, cli, possibleResults, userDirectorySearchResults, memberComparator, messageSearchResults]);

    const numResults = sum(Object.values(results).map((it) => it.length));
    useWebSearchMetrics(numResults, query.length, true);

    const activeSpace = SpaceStore.instance.activeSpaceRoom;
    const [spaceResults, spaceResultsLoading] = useSpaceResults(activeSpace ?? undefined, query);

    const setQuery = (e: ChangeEvent<HTMLInputElement>): void => {
        const newQuery = transformSearchTerm(e.currentTarget.value);
        _setQuery(newQuery);
    };
    useEffect(() => {
        setTimeout(() => {
            const node = rovingContext.state.nodes[0];
            if (node) {
                rovingContext.dispatch({
                    type: Type.SetFocus,
                    payload: { node },
                });
                node?.scrollIntoView?.({
                    block: "nearest",
                });
            }
        });
        // we intentionally ignore changes to the rovingContext for the purpose of this hook
        // we only want to reset the focus whenever the results or filters change
        // eslint-disable-next-line
    }, [results, filter]);

    const viewRoom = (
        room: {
            roomId: string;
            roomAlias?: string;
            autoJoin?: boolean;
            shouldPeek?: boolean;
            viaServers?: string[];
            joinRule?: IPublicRoomsChunkRoom["join_rule"];
        },
        persist = false,
        viaKeyboard = false,
    ): void => {
        if (persist) {
            const recents = new Set(SettingsStore.getValue("SpotlightSearch.recentSearches", null).reverse());
            // remove & add the room to put it at the end
            recents.delete(room.roomId);
            recents.add(room.roomId);

            SettingsStore.setValue(
                "SpotlightSearch.recentSearches",
                null,
                SettingLevel.ACCOUNT,
                Array.from(recents).reverse().slice(0, MAX_RECENT_SEARCHES),
            );
        }

        defaultDispatcher.dispatch<ViewRoomPayload>({
            action: Action.ViewRoom,
            metricsTrigger: "WebUnifiedSearch",
            metricsViaKeyboard: viaKeyboard,
            room_id: room.roomId,
            room_alias: room.roomAlias,
            auto_join: room.autoJoin && !canAskToJoin(room.joinRule),
            should_peek: room.shouldPeek,
            via_servers: room.viaServers,
        });

        if (canAskToJoin(room.joinRule)) {
            defaultDispatcher.dispatch({ action: Action.PromptAskToJoin });
        }

        onFinished();
    };

    let otherSearchesSection: JSX.Element | undefined;
    if (trimmedQuery || (filter !== Filter.PublicRooms && filter !== Filter.PublicSpaces)) {
        otherSearchesSection = (
            <div
                className="mx_SpotlightDialog_section mx_SpotlightDialog_otherSearches"
                role="group"
                aria-labelledby="mx_SpotlightDialog_section_otherSearches"
            >
                <h4 id="mx_SpotlightDialog_section_otherSearches">
                    {trimmedQuery
                        ? _t("spotlight_dialog|heading_with_query", { query })
                        : _t("spotlight_dialog|heading_without_query")}
                </h4>
                <div>
                    {filter !== Filter.PublicSpaces && supportsSpaceFiltering && (
                        <Option
                            id="mx_SpotlightDialog_button_explorePublicSpaces"
                            className="mx_SpotlightDialog_explorePublicSpaces"
                            onClick={() => setFilter(Filter.PublicSpaces)}
                        >
                            {filterToLabel(Filter.PublicSpaces)}
                        </Option>
                    )}
                    {filter !== Filter.PublicRooms && (
                        <Option
                            id="mx_SpotlightDialog_button_explorePublicRooms"
                            className="mx_SpotlightDialog_explorePublicRooms"
                            onClick={() => setFilter(Filter.PublicRooms)}
                        >
                            {filterToLabel(Filter.PublicRooms)}
                        </Option>
                    )}
                    {filter !== Filter.People && (
                        <Option
                            id="mx_SpotlightDialog_button_startChat"
                            className="mx_SpotlightDialog_startChat"
                            onClick={() => setFilter(Filter.People)}
                        >
                            {filterToLabel(Filter.People)}
                        </Option>
                    )}
                    {filter === null && (
                        <Option
                            id="mx_SpotlightDialog_button_searchMessages"
                            className="mx_SpotlightDialog_searchMessages"
                            onClick={() => {
                                defaultDispatcher.dispatch({
                                    action: Action.FocusMessageSearch,
                                    initialText: trimmedQuery,
                                });
                                onFinished();
                            }}
                        >
                            {_t("spotlight_dialog|messages_label")}
                        </Option>
                    )}
                </div>
            </div>
        );
    }

    let content: JSX.Element;
    if (trimmedQuery || filter !== null) {
        const resultMapper = (result: Result): JSX.Element => {
            console.log(`Mapping result:`, {
                isRoomResult: isRoomResult(result),
                isPublicRoomResult: isPublicRoomResult(result),
                isMemberResult: isMemberResult(result),
                isMessageResult: isMessageResult(result),
                result: result
            });
            
            if (isRoomResult(result)) {
                const notification = RoomNotificationStateStore.instance.getRoomState(result.room);
                const unreadLabel = roomAriaUnreadLabel(result.room, notification);
                const ariaProperties = {
                    "aria-label": unreadLabel ? `${result.room.name} ${unreadLabel}` : result.room.name,
                    "aria-describedby": `mx_SpotlightDialog_button_result_${result.room.roomId}_details`,
                };
                return (
                    <Option
                        id={`mx_SpotlightDialog_button_result_${result.room.roomId}`}
                        key={`${Section[result.section]}-${result.room.roomId}`}
                        onClick={(ev) => {
                            viewRoom({ roomId: result.room.roomId }, true, ev?.type !== "click");
                        }}
                        endAdornment={<RoomResultContextMenus room={result.room} />}
                        {...ariaProperties}
                    >
                        <DecoratedRoomAvatar room={result.room} size={AVATAR_SIZE} tooltipProps={{ tabIndex: -1 }} />
                        {result.room.name}
                        <NotificationBadge notification={notification} />
                        <RoomContextDetails
                            id={`mx_SpotlightDialog_button_result_${result.room.roomId}_details`}
                            className="mx_SpotlightDialog_result_details"
                            room={result.room}
                        />
                    </Option>
                );
            }
            if (isMemberResult(result)) {
                return (
                    <Option
                        id={`mx_SpotlightDialog_button_result_${result.member.userId}`}
                        key={`${Section[result.section]}-${result.member.userId}`}
                        onClick={() => {
                            startDmOnFirstMessage(cli, [result.member]);
                            onFinished();
                        }}
                        aria-label={
                            result.member instanceof RoomMember ? result.member.rawDisplayName : result.member.name
                        }
                        aria-describedby={`mx_SpotlightDialog_button_result_${result.member.userId}_details`}
                    >
                        <SearchResultAvatar user={result.member} size={AVATAR_SIZE} />
                        {result.member instanceof RoomMember ? result.member.rawDisplayName : result.member.name}
                        <div
                            id={`mx_SpotlightDialog_button_result_${result.member.userId}_details`}
                            className="mx_SpotlightDialog_result_details"
                        >
                            {result.member.userId}
                        </div>
                    </Option>
                );
            }
            if (isPublicRoomResult(result)) {
                const clientRoom = cli.getRoom(result.publicRoom.room_id);
                const joinRule = result.publicRoom.join_rule;
                // Element Web currently does not allow guests to join rooms, so we
                // instead show them view buttons for all rooms. If the room is not
                // world readable, a modal will appear asking you to register first. If
                // it is readable, the preview appears as normal.
                const showViewButton =
                    clientRoom?.getMyMembership() === KnownMembership.Join ||
                    (result.publicRoom.world_readable && !canAskToJoin(joinRule)) ||
                    cli.isGuest();

                const listener = (ev: ButtonEvent): void => {
                    ev.stopPropagation();

                    const { publicRoom } = result;
                    viewRoom(
                        {
                            roomAlias: publicRoom.canonical_alias || publicRoom.aliases?.[0],
                            roomId: publicRoom.room_id,
                            autoJoin: !result.publicRoom.world_readable && !cli.isGuest(),
                            shouldPeek: result.publicRoom.world_readable || cli.isGuest(),
                            viaServers: config ? [config.roomServer] : undefined,
                            joinRule,
                        },
                        true,
                        ev.type !== "click",
                    );
                };

                let buttonLabel;
                if (showViewButton) {
                    buttonLabel = _t("action|view");
                } else {
                    buttonLabel = canAskToJoin(joinRule) ? _t("action|ask_to_join") : _t("action|join");
                }

                return (
                    <Option
                        id={`mx_SpotlightDialog_button_result_${result.publicRoom.room_id}`}
                        className="mx_SpotlightDialog_result_multiline"
                        key={`${Section[result.section]}-${result.publicRoom.room_id}`}
                        onClick={listener}
                        endAdornment={
                            <AccessibleButton
                                kind={showViewButton ? "primary_outline" : "primary"}
                                onClick={listener}
                                tabIndex={-1}
                            >
                                {buttonLabel}
                            </AccessibleButton>
                        }
                        aria-labelledby={`mx_SpotlightDialog_button_result_${result.publicRoom.room_id}_name`}
                        aria-describedby={`mx_SpotlightDialog_button_result_${result.publicRoom.room_id}_alias`}
                        aria-details={`mx_SpotlightDialog_button_result_${result.publicRoom.room_id}_details`}
                    >
                        <RoomAvatar
                            className="mx_SearchResultAvatar"
                            oobData={{
                                roomId: result.publicRoom.room_id,
                                name: result.publicRoom.name,
                                avatarUrl: result.publicRoom.avatar_url,
                                roomType: result.publicRoom.room_type,
                            }}
                            size={AVATAR_SIZE}
                        />
                        <PublicRoomResultDetails
                            room={result.publicRoom}
                            labelId={`mx_SpotlightDialog_button_result_${result.publicRoom.room_id}_name`}
                            descriptionId={`mx_SpotlightDialog_button_result_${result.publicRoom.room_id}_alias`}
                            detailsId={`mx_SpotlightDialog_button_result_${result.publicRoom.room_id}_details`}
                        />
                    </Option>
                );
            }
            if (isMessageResult(result)) {
                // Highlight the search query in the message content
                const highlightQuery = (text: string, query: string): JSX.Element => {
                    if (!query) return <>{text}</>;
                    
                    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const regex = new RegExp(`(${escapedQuery})`, 'gi');
                    const parts = text.split(regex);
                    
                    return (
                        <>
                            {parts.map((part, index) => {
                                const isMatch = regex.test(part);
                                return isMatch ? (
                                    <mark key={index} style={{ 
                                        backgroundColor: '#007bff', 
                                        color: 'white',
                                        padding: '2px 4px',
                                        borderRadius: '3px',
                                        fontWeight: '600',
                                        boxShadow: '0 1px 2px rgba(0, 0, 0, 0.1)'
                                    }}>
                                        {part}
                                    </mark>
                                ) : (
                                    <span key={index}>{part}</span>
                                );
                            })}
                        </>
                    );
                };

                return (
                    <Option
                        id={`mx_SpotlightDialog_button_result_message_${result.message.getId()}`}
                        key={`${Section[result.section]}-message-${result.message.getId()}`}
                        className="mx_SpotlightDialog_messageResult"
                        onClick={() => {
                            // Navigate to the room and highlight the specific message
                            defaultDispatcher.dispatch<ViewRoomPayload>({
                                action: Action.ViewRoom,
                                room_id: result.room.roomId,
                                event_id: result.message.getId(),
                                highlighted: true, // Enable highlighting
                                scroll_into_view: true, // Ensure the message is visible
                                metricsTrigger: "WebUnifiedSearch",
                                metricsViaKeyboard: false,
                            });
                            
                            // Add a small delay to ensure the room is loaded before scrolling
                            setTimeout(() => {
                                // Try to scroll to the highlighted message
                                const eventElement = document.querySelector(`[data-event-id="${result.message.getId()}"]`);
                                if (eventElement) {
                                    eventElement.scrollIntoView({
                                        behavior: 'smooth',
                                        block: 'center'
                                    });
                                    
                                    // Add a simple flash effect
                                    eventElement.classList.add('mx_EventTile_highlight');
                                    
                                    // Remove the highlight class after animation completes
                                    setTimeout(() => {
                                        eventElement.classList.remove('mx_EventTile_highlight');
                                    }, 1000);
                                }
                            }, 500);
                            
                            onFinished();
                        }}
                        aria-label={`Message from ${result.sender} in ${result.room.name}: ${result.content}. Click to view and highlight this message.`}
                    >
                        <DecoratedRoomAvatar room={result.room} size={AVATAR_SIZE} tooltipProps={{ tabIndex: -1 }} />
                        <div style={{ 
                            display: 'flex', 
                            flexDirection: 'column', 
                            flex: 1, 
                            minWidth: 0,
                            gap: '4px'
                        }}>
                            {/* Room name and timestamp */}
                            <div style={{ 
                                display: 'flex', 
                                alignItems: 'center', 
                                gap: '8px',
                                fontSize: '13px'
                            }}>
                                <span className="room-name">
                                    {result.room.name}
                                </span>
                                <span className="timestamp">
                                    {new Date(result.timestamp).toLocaleDateString()} {new Date(result.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                                </span>
                            </div>
                            
                            {/* Sender name */}
                            <div className="sender-name">
                                {result.sender}
                            </div>
                            
                            {/* Message content with highlighted query */}
                            <div className="message-preview">
                                {highlightQuery(result.content, trimmedQuery)}
                            </div>
                        </div>
                    </Option>
                );
            }

            // IResult case
            return (
                <Option
                    id={`mx_SpotlightDialog_button_result_${result.name}`}
                    key={`${Section[result.section]}-${result.name}`}
                    onClick={result.onClick ?? null}
                >
                    {result.avatar}
                    {result.name}
                    {result.description}
                </Option>
            );
        };

        let peopleSection: JSX.Element | undefined;
        if (results[Section.People].length && filter !== Filter.PublicSpaces) {
            peopleSection = (
                <div
                    className="mx_SpotlightDialog_section mx_SpotlightDialog_results"
                    role="group"
                    aria-labelledby="mx_SpotlightDialog_section_people"
                >
                    <h4 id="mx_SpotlightDialog_section_people">{_t("invite|recents_section")}</h4>
                    <div>{results[Section.People].slice(0, SECTION_LIMIT).map(resultMapper)}</div>
                </div>
            );
        }

        let suggestionsSection: JSX.Element | undefined;
        if (results[Section.Suggestions].length && filter === Filter.People) {
            suggestionsSection = (
                <div
                    className="mx_SpotlightDialog_section mx_SpotlightDialog_results"
                    role="group"
                    aria-labelledby="mx_SpotlightDialog_section_suggestions"
                >
                    <h4 id="mx_SpotlightDialog_section_suggestions">{_t("common|suggestions")}</h4>
                    <div>{results[Section.Suggestions].slice(0, SECTION_LIMIT).map(resultMapper)}</div>
                </div>
            );
        }

        let roomsSection: JSX.Element | undefined;
        if (results[Section.Rooms].length && filter !== Filter.PublicSpaces) {
            roomsSection = (
                <div
                    className="mx_SpotlightDialog_section mx_SpotlightDialog_results"
                    role="group"
                    aria-labelledby="mx_SpotlightDialog_section_rooms"
                >
                    <h4 id="mx_SpotlightDialog_section_rooms">{_t("common|rooms")}</h4>
                    <div>{results[Section.Rooms].slice(0, SECTION_LIMIT).map(resultMapper)}</div>
                </div>
            );
        }

        let spacesSection: JSX.Element | undefined;
        if (results[Section.Spaces].length && filter !== Filter.PublicSpaces) {
            spacesSection = (
                <div
                    className="mx_SpotlightDialog_section mx_SpotlightDialog_results"
                    role="group"
                    aria-labelledby="mx_SpotlightDialog_section_spaces"
                >
                    <h4 id="mx_SpotlightDialog_section_spaces">{_t("spotlight_dialog|spaces_title")}</h4>
                    <div>{results[Section.Spaces].slice(0, SECTION_LIMIT).map(resultMapper)}</div>
                </div>
            );
        }

        let publicRoomsSection: JSX.Element | undefined;
        if (filter === Filter.PublicRooms || filter === Filter.PublicSpaces) {
            let content: JSX.Element | JSX.Element[];
            if (publicRoomsError) {
                content = (
                    <div className="mx_SpotlightDialog_otherSearches_messageSearchText">
                        {filter === Filter.PublicRooms
                            ? _t("spotlight_dialog|failed_querying_public_rooms")
                            : _t("spotlight_dialog|failed_querying_public_spaces")}
                    </div>
                );
            } else if (filter === Filter.PublicSpaces && trimmedQuery && !messageSearchLoading && results[Section.PublicRoomsAndSpaces].length === 0) {
                content = (
                    <div className="mx_SpotlightDialog_otherSearches_messageSearchText">
                        {_t("spotlight_dialog|no_messages_found", { query: trimmedQuery })}
                    </div>
                );
            } else if (filter === Filter.PublicSpaces && messageSearchLoading) {
                content = (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '16px' }}>
                        <Spinner w={16} h={16} />
                        <span style={{ color: 'var(--cpd-color-text-secondary)' }}>
                            {_t("action|search")}...
                        </span>
                    </div>
                );
            } else {
                console.log(`Displaying ${results[Section.PublicRoomsAndSpaces].length} results in publicRoomsSection`);
                console.log(`Results:`, results[Section.PublicRoomsAndSpaces]);
                
                // Debug: Check what type each result is
                results[Section.PublicRoomsAndSpaces].forEach((result, index) => {
                    console.log(`Result ${index}:`, {
                        isRoomResult: isRoomResult(result),
                        isPublicRoomResult: isPublicRoomResult(result),
                        isMemberResult: isMemberResult(result),
                        isMessageResult: isMessageResult(result),
                        result: result
                    });
                });
                
                // Filter and sort results by relevance
                const sortedResults = results[Section.PublicRoomsAndSpaces]
                    .filter(result => {
                        if (isMessageResult(result)) {
                            const score = result.relevanceScore || 0;
                            // Only show results with good relevance
                            return score >= 20;
                        }
                        return true;
                    })
                    // Remove exact duplicate messages
                    .filter((result, index, array) => {
                        if (isMessageResult(result)) {
                            // Check if this message is exactly the same as previous ones
                            for (let i = 0; i < index; i++) {
                                const prevResult = array[i];
                                if (isMessageResult(prevResult)) {
                                    if (result.content === prevResult.content && result.sender === prevResult.sender) {
                                        return false;
                                    }
                                }
                            }
                        }
                        return true;
                    })
                    .slice(0, 10); // Limit to top 10 most relevant results
                
                console.log(`Displaying ${sortedResults.length} filtered results out of ${results[Section.PublicRoomsAndSpaces].length} total`);
                content = sortedResults.map(resultMapper);
            }

            publicRoomsSection = (
                <div
                    className="mx_SpotlightDialog_section mx_SpotlightDialog_results"
                    role="group"
                    aria-labelledby="mx_SpotlightDialog_section_publicRooms"
                >
                    <div className="mx_SpotlightDialog_sectionHeader">
                        <h4 id="mx_SpotlightDialog_section_publicRooms">
                            {filter === Filter.PublicSpaces 
                                ? (trimmedQuery 
                                    ? `${_t("spotlight_dialog|search_messages_label")} (${results[Section.PublicRoomsAndSpaces].length})`
                                    : _t("spotlight_dialog|search_messages_label")
                                  )
                                : _t("common|suggestions")
                            }
                        </h4>
                        {filter === Filter.PublicRooms && (
                            <div className="mx_SpotlightDialog_options">
                                <NetworkDropdown protocols={protocols} config={config ?? null} setConfig={setConfig} />
                            </div>
                        )}
                    </div>
                    <div>{content}</div>
                </div>
            );
        }

        let spaceRoomsSection: JSX.Element | undefined;
        if (spaceResults.length && activeSpace && filter === null) {
            spaceRoomsSection = (
                <div
                    className="mx_SpotlightDialog_section mx_SpotlightDialog_results"
                    role="group"
                    aria-labelledby="mx_SpotlightDialog_section_spaceRooms"
                >
                    <h4 id="mx_SpotlightDialog_section_spaceRooms">
                        {_t("spotlight_dialog|other_rooms_in_space", { spaceName: activeSpace.name })}
                    </h4>
                    <div>
                        {spaceResults.slice(0, SECTION_LIMIT).map(
                            (room: HierarchyRoom): JSX.Element => (
                                <Option
                                    id={`mx_SpotlightDialog_button_result_${room.room_id}`}
                                    key={room.room_id}
                                    onClick={(ev) => {
                                        viewRoom({ roomId: room.room_id }, true, ev?.type !== "click");
                                    }}
                                >
                                    <BaseAvatar
                                        name={room.name}
                                        idName={room.room_id}
                                        url={
                                            room.avatar_url
                                                ? mediaFromMxc(room.avatar_url).getSquareThumbnailHttp(
                                                      parseInt(AVATAR_SIZE, 10),
                                                  )
                                                : null
                                        }
                                        size={AVATAR_SIZE}
                                    />
                                    {room.name || room.canonical_alias}
                                    {room.name && room.canonical_alias && (
                                        <div className="mx_SpotlightDialog_result_details">{room.canonical_alias}</div>
                                    )}
                                </Option>
                            ),
                        )}
                        {spaceResultsLoading && <Spinner />}
                    </div>
                </div>
            );
        }

        let joinRoomSection: JSX.Element | undefined;
        if (
            trimmedQuery.startsWith("#") &&
            trimmedQuery.includes(":") &&
            (!getCachedRoomIDForAlias(trimmedQuery) || !cli.getRoom(getCachedRoomIDForAlias(trimmedQuery)))
        ) {
            joinRoomSection = (
                <div className="mx_SpotlightDialog_section mx_SpotlightDialog_otherSearches" role="group">
                    <div>
                        <Option
                            id="mx_SpotlightDialog_button_joinRoomAlias"
                            className="mx_SpotlightDialog_joinRoomAlias"
                            onClick={(ev) => {
                                defaultDispatcher.dispatch<ViewRoomPayload>({
                                    action: Action.ViewRoom,
                                    room_alias: trimmedQuery,
                                    auto_join: true,
                                    metricsTrigger: "WebUnifiedSearch",
                                    metricsViaKeyboard: ev?.type !== "click",
                                });
                                onFinished();
                            }}
                        >
                            {_t("spotlight_dialog|join_button_text", {
                                roomAddress: trimmedQuery,
                            })}
                        </Option>
                    </div>
                </div>
            );
        }

        let hiddenResultsSection: JSX.Element | undefined;
        if (filter === Filter.People) {
            hiddenResultsSection = (
                <div className="mx_SpotlightDialog_section mx_SpotlightDialog_hiddenResults" role="group">
                    <h4>{_t("spotlight_dialog|result_may_be_hidden_privacy_warning")}</h4>
                    <div className="mx_SpotlightDialog_otherSearches_messageSearchText">
                        {_t("spotlight_dialog|cant_find_person_helpful_hint")}
                    </div>
                    <TooltipOption
                        id="mx_SpotlightDialog_button_inviteLink"
                        className="mx_SpotlightDialog_inviteLink"
                        onClick={() => {
                            setInviteLinkCopied(true);
                            copyPlaintext(ownInviteLink);
                        }}
                        onTooltipOpenChange={(open) => {
                            if (!open) setInviteLinkCopied(false);
                        }}
                        title={inviteLinkCopied ? _t("common|copied") : _t("action|copy")}
                    >
                        <span className="mx_AccessibleButton mx_AccessibleButton_hasKind mx_AccessibleButton_kind_primary_outline">
                            {_t("spotlight_dialog|copy_link_text")}
                        </span>
                    </TooltipOption>
                </div>
            );
        } else if (trimmedQuery && (filter === Filter.PublicRooms || filter === Filter.PublicSpaces)) {
            hiddenResultsSection = (
                <div className="mx_SpotlightDialog_section mx_SpotlightDialog_hiddenResults" role="group">
                    <h4>{_t("spotlight_dialog|result_may_be_hidden_warning")}</h4>
                    <div className="mx_SpotlightDialog_otherSearches_messageSearchText">
                        {_t("spotlight_dialog|cant_find_room_helpful_hint")}
                    </div>
                    <Option
                        id="mx_SpotlightDialog_button_createNewRoom"
                        className="mx_SpotlightDialog_createRoom"
                        onClick={() =>
                            defaultDispatcher.dispatch({
                                action: Action.CreateRoom,
                                public: true,
                                defaultName: capitalize(trimmedQuery),
                            })
                        }
                    >
                        <span className="mx_AccessibleButton mx_AccessibleButton_hasKind mx_AccessibleButton_kind_primary_outline">
                            {_t("spotlight_dialog|create_new_room_button")}
                        </span>
                    </Option>
                </div>
            );
        }

        let groupChatSection: JSX.Element | undefined;
        if (filter === Filter.People) {
            groupChatSection = (
                <div
                    className="mx_SpotlightDialog_section mx_SpotlightDialog_otherSearches"
                    role="group"
                    aria-labelledby="mx_SpotlightDialog_section_groupChat"
                >
                    <h4 id="mx_SpotlightDialog_section_groupChat">{_t("spotlight_dialog|group_chat_section_title")}</h4>
                    <Option
                        id="mx_SpotlightDialog_button_startGroupChat"
                        className="mx_SpotlightDialog_startGroupChat"
                        onClick={() => showStartChatInviteDialog(trimmedQuery)}
                    >
                        {_t("spotlight_dialog|start_group_chat_button")}
                    </Option>
                </div>
            );
        }

        content = (
            <>
                {peopleSection}
                {suggestionsSection}
                {roomsSection}
                {spacesSection}
                {spaceRoomsSection}
                {publicRoomsSection}
                {joinRoomSection}
                {hiddenResultsSection}
                {otherSearchesSection}
                {groupChatSection}
            </>
        );
    } else {
        let recentSearchesSection: JSX.Element | undefined;
        if (recentSearches.length) {
            recentSearchesSection = (
                <div
                    className="mx_SpotlightDialog_section mx_SpotlightDialog_recentSearches"
                    role="group"
                    // Firefox sometimes makes this element focusable due to overflow,
                    // so force it out of tab order by default.
                    tabIndex={-1}
                    aria-labelledby="mx_SpotlightDialog_section_recentSearches"
                >
                    <h4>
                        <span id="mx_SpotlightDialog_section_recentSearches">
                            {_t("spotlight_dialog|recent_searches_section_title")}
                        </span>
                        <AccessibleButton kind="link" onClick={clearRecentSearches}>
                            {_t("action|clear")}
                        </AccessibleButton>
                    </h4>
                    <div>
                        {recentSearches.map((room) => {
                            const notification = RoomNotificationStateStore.instance.getRoomState(room);
                            const unreadLabel = roomAriaUnreadLabel(room, notification);
                            const ariaProperties = {
                                "aria-label": unreadLabel ? `${room.name} ${unreadLabel}` : room.name,
                                "aria-describedby": `mx_SpotlightDialog_button_recentSearch_${room.roomId}_details`,
                            };
                            return (
                                <Option
                                    id={`mx_SpotlightDialog_button_recentSearch_${room.roomId}`}
                                    key={room.roomId}
                                    onClick={(ev) => {
                                        viewRoom({ roomId: room.roomId }, true, ev?.type !== "click");
                                    }}
                                    endAdornment={<RoomResultContextMenus room={room} />}
                                    {...ariaProperties}
                                >
                                    <DecoratedRoomAvatar
                                        room={room}
                                        size={AVATAR_SIZE}
                                        tooltipProps={{ tabIndex: -1 }}
                                    />
                                    {room.name}
                                    <NotificationBadge notification={notification} />
                                    <RoomContextDetails
                                        id={`mx_SpotlightDialog_button_recentSearch_${room.roomId}_details`}
                                        className="mx_SpotlightDialog_result_details"
                                        room={room}
                                    />
                                </Option>
                            );
                        })}
                    </div>
                </div>
            );
        }

        content = (
            <>
                <div
                    className="mx_SpotlightDialog_section mx_SpotlightDialog_recentlyViewed"
                    role="group"
                    aria-labelledby="mx_SpotlightDialog_section_recentlyViewed"
                >
                    <h4 id="mx_SpotlightDialog_section_recentlyViewed">
                        {_t("spotlight_dialog|recently_viewed_section_title")}
                    </h4>
                    <div>
                        {BreadcrumbsStore.instance.rooms
                            .filter((r) => r.roomId !== SdkContextClass.instance.roomViewStore.getRoomId())
                            .map((room) => (
                                <TooltipOption
                                    id={`mx_SpotlightDialog_button_recentlyViewed_${room.roomId}`}
                                    title={room.name}
                                    key={room.roomId}
                                    onClick={(ev) => {
                                        viewRoom({ roomId: room.roomId }, false, ev.type !== "click");
                                    }}
                                >
                                    <DecoratedRoomAvatar room={room} size="32px" tooltipProps={{ tabIndex: -1 }} />
                                    {room.name}
                                </TooltipOption>
                            ))}
                    </div>
                </div>

                {recentSearchesSection}
                {otherSearchesSection}
            </>
        );
    }

    const onDialogKeyDown = (ev: KeyboardEvent | React.KeyboardEvent): void => {
        const navigationAction = getKeyBindingsManager().getNavigationAction(ev);
        switch (navigationAction) {
            case KeyBindingAction.FilterRooms:
                ev.stopPropagation();
                ev.preventDefault();
                onFinished();
                break;
        }

        let node: HTMLElement | undefined;
        const accessibilityAction = getKeyBindingsManager().getAccessibilityAction(ev);
        switch (accessibilityAction) {
            case KeyBindingAction.Escape:
                ev.stopPropagation();
                ev.preventDefault();
                onFinished();
                break;
            case KeyBindingAction.ArrowUp:
            case KeyBindingAction.ArrowDown:
                ev.stopPropagation();
                ev.preventDefault();

                if (rovingContext.state.activeNode && rovingContext.state.nodes.length > 0) {
                    let nodes = rovingContext.state.nodes;
                    if (!query && !filter !== null) {
                        // If the current selection is not in the recently viewed row then only include the
                        // first recently viewed so that is the target when the user is switching into recently viewed.
                        const keptRecentlyViewedRef = nodeIsForRecentlyViewed(rovingContext.state.activeNode)
                            ? rovingContext.state.activeNode
                            : nodes.find(nodeIsForRecentlyViewed);
                        // exclude all other recently viewed items from the list so up/down arrows skip them
                        nodes = nodes.filter((ref) => ref === keptRecentlyViewedRef || !nodeIsForRecentlyViewed(ref));
                    }

                    const idx = nodes.indexOf(rovingContext.state.activeNode);
                    node = findSiblingElement(nodes, idx + (accessibilityAction === KeyBindingAction.ArrowUp ? -1 : 1));
                }
                break;

            case KeyBindingAction.ArrowLeft:
            case KeyBindingAction.ArrowRight:
                // only handle these keys when we are in the recently viewed row of options
                if (
                    !query &&
                    !filter !== null &&
                    rovingContext.state.activeNode &&
                    rovingContext.state.nodes.length > 0 &&
                    nodeIsForRecentlyViewed(rovingContext.state.activeNode)
                ) {
                    // we only intercept left/right arrows when the field is empty, and they'd do nothing anyway
                    ev.stopPropagation();
                    ev.preventDefault();

                    const nodes = rovingContext.state.nodes.filter(nodeIsForRecentlyViewed);
                    const idx = nodes.indexOf(rovingContext.state.activeNode);
                    node = findSiblingElement(
                        nodes,
                        idx + (accessibilityAction === KeyBindingAction.ArrowLeft ? -1 : 1),
                    );
                }
                break;
        }

        if (node) {
            rovingContext.dispatch({
                type: Type.SetFocus,
                payload: { node },
            });
            node?.scrollIntoView({
                block: "nearest",
            });
        }
    };

    const onKeyDown = (ev: React.KeyboardEvent): void => {
        const action = getKeyBindingsManager().getAccessibilityAction(ev);

        switch (action) {
            case KeyBindingAction.Backspace:
                if (!query && filter !== null) {
                    ev.stopPropagation();
                    ev.preventDefault();
                    setFilter(null);
                }
                break;
            case KeyBindingAction.Enter:
                ev.stopPropagation();
                ev.preventDefault();
                rovingContext.state.activeNode?.click();
                break;
        }
    };

    const activeDescendant = rovingContext.state.activeNode?.id;

    return (
        <>
            <div id="mx_SpotlightDialog_keyboardPrompt">
                {_t(
                    "spotlight_dialog|keyboard_scroll_hint",
                    {},
                    {
                        arrows: () => (
                            <>
                                <kbd>↓</kbd>
                                <kbd>↑</kbd>
                                {!filter !== null && !query && <kbd>←</kbd>}
                                {!filter !== null && !query && <kbd>→</kbd>}
                            </>
                        ),
                    },
                )}
            </div>

            <BaseDialog
                className="mx_SpotlightDialog"
                onFinished={onFinished}
                hasCancel={false}
                onKeyDown={onDialogKeyDown}
                screenName="UnifiedSearch"
                aria-label={_t("spotlight_dialog|search_dialog")}
            >
                <div className="mx_SpotlightDialog_searchBox mx_textinput">
                    {filter !== null && (
                        <div
                            className={classNames("mx_SpotlightDialog_filter", {
                                mx_SpotlightDialog_filterPeople: filter === Filter.People,
                                mx_SpotlightDialog_filterPublicRooms: filter === Filter.PublicRooms,
                                mx_SpotlightDialog_filterPublicSpaces: filter === Filter.PublicSpaces,
                            })}
                        >
                            <span>{filterToLabel(filter)}</span>
                            <AccessibleButton
                                tabIndex={-1}
                                title={_t("spotlight_dialog|remove_filter", {
                                    filter: filterToLabel(filter),
                                })}
                                className="mx_SpotlightDialog_filter--close"
                                onClick={() => setFilter(null)}
                            />
                        </div>
                    )}
                    <input
                        ref={inputRef}
                        autoFocus
                        type="text"
                        autoComplete="off"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck="false"
                        placeholder={_t("action|search")}
                        value={query}
                        onChange={setQuery}
                        onKeyDown={onKeyDown}
                        aria-owns="mx_SpotlightDialog_content"
                        aria-activedescendant={activeDescendant}
                        aria-label={_t("action|search")}
                        aria-describedby="mx_SpotlightDialog_keyboardPrompt"
                    />
                    {(publicRoomsLoading || peopleLoading || profileLoading || messageSearchLoading) && <Spinner w={24} h={24} />}
                </div>

                <div
                    ref={scrollContainerRef}
                    id="mx_SpotlightDialog_content"
                    role="listbox"
                    aria-activedescendant={activeDescendant}
                    aria-describedby="mx_SpotlightDialog_keyboardPrompt"
                >
                    {content}
                </div>
            </BaseDialog>
        </>
    );
};

const RovingSpotlightDialog: React.FC<IProps> = (props) => {
    return <RovingTabIndexProvider>{() => <SpotlightDialog {...props} />}</RovingTabIndexProvider>;
};

export default RovingSpotlightDialog;
