/*
Copyright 2025 New Vector Ltd.
SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { useEffect, useRef, useState } from "react";
import { EventType, type JoinRule, type Room, RoomStateEvent } from "matrix-js-sdk/src/matrix";

import { useMatrixClientContext } from "../../../contexts/MatrixClientContext";
import { useIsEncrypted } from "../../../hooks/useIsEncrypted";
import { useScopedRoomContext } from "../../../contexts/ScopedRoomContext";
import { type E2EStatus } from "../../../utils/ShieldUtils";
import { isVideoRoom as calcIsVideoRoom } from "../../../utils/video-rooms";
import { useRoomState } from "../../../hooks/useRoomState";
import { useAccountData } from "../../../hooks/useAccountData";
import { useDispatcher } from "../../../hooks/useDispatcher";
import defaultDispatcher from "../../../dispatcher/dispatcher";
import { Action } from "../../../dispatcher/actions";
import RoomListStore, { LISTS_UPDATE_EVENT } from "../../../stores/room-list/RoomListStore";
import { canInviteTo } from "../../../utils/room/canInviteTo";
import { DefaultTagID } from "../../../stores/room-list/models";
import { useEventEmitterState } from "../../../hooks/useEventEmitter";
import RightPanelStore from "../../../stores/right-panel/RightPanelStore";
import { RightPanelPhases } from "../../../stores/right-panel/RightPanelStorePhases";
import PosthogTrackers from "../../../PosthogTrackers";
import { PollHistoryDialog } from "../../views/dialogs/PollHistoryDialog";
import Modal from "../../../Modal";
import ExportDialog from "../../views/dialogs/ExportDialog";
import { ShareDialog } from "../../views/dialogs/ShareDialog";
import QuestionDialog from "../../views/dialogs/QuestionDialog";
import { _t } from "../../../languageHandler";
import React from "react";
import { type RoomPermalinkCreator } from "../../../utils/permalinks/Permalinks";
import { ReportRoomDialog } from "../../views/dialogs/ReportRoomDialog";
import { Key } from "../../../Keyboard";
import { usePinnedEvents } from "../../../hooks/usePinnedEvents";
import { tagRoom } from "../../../utils/room/tagRoom";
import { inviteToRoom } from "../../../utils/room/inviteToRoom";
import ErrorDialog from "../../views/dialogs/ErrorDialog";
import { logger } from "matrix-js-sdk/src/logger";

export interface RoomSummaryCardState {
    isDirectMessage: boolean;
    /**
     * Whether the room is encrypted, used to display the correct badge and icon
     */
    isRoomEncrypted: boolean;
    /**
     * The e2e status of the room, used to display the correct badge and icon
     */
    e2eStatus: E2EStatus | undefined;
    /**
     * The join rule of the room, used to display the correct badge and icon
     */
    roomJoinRule: JoinRule;
    /**
     * if it is a video room, it should not display export chat, polls, files, extensions
     */
    isVideoRoom: boolean;
    /**
     * display the alias of the room, if it exists
     */
    alias: string;
    /**
     * value to check if the room is a favorite or not
     */
    isFavorite: boolean;
    /**
     * value to check if we disable invite button or not
     */
    canInviteToState: boolean;
    /**
     * Getting the number of pinned messages in the room, next to the pin button
     */
    pinCount: number;
    searchInputRef: React.RefObject<HTMLInputElement | null>;
    /**
     * The callback when new value is entered in the search input
     */
    onUpdateSearchInput: (e: React.KeyboardEvent<HTMLInputElement>) => void;
    /**
     * Callbacks to all the actions button in the right panel
     */
    onRoomMembersClick: () => void;
    onRoomThreadsClick: () => void;
    onRoomFilesClick: () => void;
    onRoomExtensionsClick: () => void;
    onRoomUrlsClick: () => void;
    onRoomPinsClick: () => void;
    onRoomSettingsClick: (ev: Event) => void;
    onLeaveRoomClick: () => void;
    onShareRoomClick: () => void;
    onRoomExportClick: () => Promise<void>;
    onRoomPollHistoryClick: () => void;
    onReportRoomClick: () => Promise<void>;
    onFavoriteToggleClick: () => void;
    onInviteToRoomClick: () => void;
    onDeleteRoomClick: () => Promise<void>;
    canDeleteRoom: boolean;
}

/**
 * Hook to check if the room is a direct message or not
 * @param room - The room to check
 * @returns Whether the room is a direct message
 */
const useIsDirectMessage = (room: Room): boolean => {
    const directRoomsList = useAccountData<Record<string, string[]>>(room.client, EventType.Direct);
    const [isDirectMessage, setDirectMessage] = useState(false);

    useEffect(() => {
        for (const [, dmRoomList] of Object.entries(directRoomsList)) {
            if (dmRoomList.includes(room?.roomId ?? "")) {
                setDirectMessage(true);
                break;
            }
        }
    }, [room, directRoomsList]);

    return isDirectMessage;
};

/**
 * Hook to handle the search input in the right panel
 * @param onSearchCancel - The callback when the search input is cancelled
 * @param onSearchChange - The callback when the search input value changes
 * @param onCloseUserFilter - The callback to close user filter dropdown
 * @returns The search input ref and the callback when the search input is updated
 */
const useSearchInput = (
    onSearchCancel?: () => void,
    onSearchChange?: (term: string) => void,
    onCloseUserFilter?: () => void,
): {
    searchInputRef: React.RefObject<HTMLInputElement | null>;
    onUpdateSearchInput: (e: React.KeyboardEvent<HTMLInputElement>) => void;
} => {
    const searchInputRef = useRef<HTMLInputElement>(null);

    const onUpdateSearchInput = (e: React.KeyboardEvent<HTMLInputElement>): void => {
        if (searchInputRef.current && e.key === Key.ESCAPE) {
            searchInputRef.current.value = "";
            onSearchCancel?.();
        }
        // Xử lý phím Enter để thực hiện tìm kiếm
        if (e.key === Key.ENTER) {
            e.preventDefault();
            // Gọi onSearchChange với giá trị hiện tại để thực hiện tìm kiếm
            const currentValue = searchInputRef.current?.value || "";
            if (currentValue.trim() && onSearchChange) {
                onSearchChange(currentValue.trim());
            }
            // Đóng dropdown lọc user nếu đang mở
            onCloseUserFilter?.();
        }
    };

    // Focus the search field when the user clicks on the search button component
    useDispatcher(defaultDispatcher, (payload) => {
        if (payload.action === Action.FocusMessageSearch) {
            searchInputRef.current?.focus();
        }
    });

    return {
        searchInputRef,
        onUpdateSearchInput,
    };
};

export function useRoomSummaryCardViewModel(
    room: Room,
    permalinkCreator: RoomPermalinkCreator,
    onSearchCancel?: () => void,
    onSearchChange?: (term: string) => void,
    onCloseUserFilter?: () => void,
): RoomSummaryCardState {
    const cli = useMatrixClientContext();

    const isRoomEncrypted = useIsEncrypted(cli, room) ?? false;
    const roomContext = useScopedRoomContext("e2eStatus", "timelineRenderingType");
    const e2eStatus = roomContext.e2eStatus;
    const isVideoRoom = calcIsVideoRoom(room);

    const roomState = useRoomState(room);
    // used to check if the room is public or not
    const roomJoinRule = roomState.getJoinRule();
    const alias = room.getCanonicalAlias() || room.getAltAliases()[0] || "";
    const pinCount = usePinnedEvents(room).length;
    // value to check if the user can invite to the room
    const canInviteToState = useEventEmitterState(room, RoomStateEvent.Update, () => canInviteTo(room));

    const roomTags = useEventEmitterState(RoomListStore.instance, LISTS_UPDATE_EVENT, () =>
        RoomListStore.instance.getTagsForRoom(room),
    );
    const isFavorite = roomTags.includes(DefaultTagID.Favourite);

    const isDirectMessage = useIsDirectMessage(room);

    const onRoomMembersClick = (): void => {
        RightPanelStore.instance.pushCard({ phase: RightPanelPhases.MemberList }, true);
    };

    const onRoomThreadsClick = (): void => {
        RightPanelStore.instance.pushCard({ phase: RightPanelPhases.ThreadPanel }, true);
    };

    const onRoomFilesClick = (): void => {
        RightPanelStore.instance.pushCard({ phase: RightPanelPhases.FilePanel }, true);
    };

    const onRoomExtensionsClick = (): void => {
        RightPanelStore.instance.pushCard({ phase: RightPanelPhases.Extensions }, true);
    };

    const onRoomUrlsClick = (): void => {
        RightPanelStore.instance.pushCard({ phase: RightPanelPhases.UrlsPanel }, true);
    };

    const onRoomPinsClick = (): void => {
        PosthogTrackers.trackInteraction("PinnedMessageRoomInfoButton");
        RightPanelStore.instance.pushCard({ phase: RightPanelPhases.PinnedMessages }, true);
    };

    const onRoomSettingsClick = (ev: Event): void => {
        defaultDispatcher.dispatch({ action: "open_room_settings" });
        PosthogTrackers.trackInteraction("WebRightPanelRoomInfoSettingsButton", ev);
    };

    const onShareRoomClick = (): void => {
        Modal.createDialog(ShareDialog, {
            target: room,
        });
    };

    const onRoomExportClick = async (): Promise<void> => {
        Modal.createDialog(ExportDialog, {
            room,
        });
    };

    const onRoomPollHistoryClick = (): void => {
        Modal.createDialog(PollHistoryDialog, {
            room,
            matrixClient: cli,
            permalinkCreator,
        });
    };

    const onLeaveRoomClick = (): void => {
        defaultDispatcher.dispatch({
            action: "leave_room",
            room_id: room.roomId,
        });
    };

    const onReportRoomClick = async (): Promise<void> => {
        const [leave] = await Modal.createDialog(ReportRoomDialog, {
            roomId: room.roomId,
        }).finished;
        if (leave) {
            defaultDispatcher.dispatch({
                action: "leave_room",
                room_id: room.roomId,
            });
        }
    };

    const onFavoriteToggleClick = (): void => {
        tagRoom(room, DefaultTagID.Favourite);
    };

    const onInviteToRoomClick = (): void => {
        inviteToRoom(room);
    };

    // Check if current user is admin (power level 100) and room is not a direct message
    // Direct messages (1:1 chats) should not have delete functionality as they are not "groups"
    const canDeleteRoom = (() => {
        const me = room.getMember(cli.getUserId() || "");
        return me?.powerLevel === 100 && !isDirectMessage;
    })();

    const onDeleteRoomClick = async (): Promise<void> => {
        const { finished } = Modal.createDialog(QuestionDialog, {
            title: _t("action|delete_room"),
            description: (
                <span>
                    {_t("room|delete_room_warning", {
                        roomName: room.name || _t("common|unnamed_room"),
                    })}
                </span>
            ),
            button: _t("action|delete"),
            danger: true,
        });

        const [confirmed] = await finished;
        if (!confirmed) return;

        try {
            // Kick all members from the room
            const members = room.getJoinedMembers();
            for (const member of members) {
                if (member.userId !== cli.getUserId()) {
                    await cli.kick(room.roomId, member.userId, "Room deleted by admin");
                }
            }
            
            // Leave the room (which will delete it if we're the last member)
            await cli.leave(room.roomId);
            
            // Navigate to home page
            defaultDispatcher.dispatch({ action: Action.ViewHomePage });
        } catch (error) {
            logger.error("Failed to delete room:", error);
            Modal.createDialog(ErrorDialog, {
                title: _t("common|error"),
                description: _t("room|delete_room_error"),
            });
        }
    };

    // Room Search element ref
    const { searchInputRef, onUpdateSearchInput } = useSearchInput(onSearchCancel, onSearchChange, onCloseUserFilter);

    return {
        isDirectMessage,
        isRoomEncrypted,
        roomJoinRule,
        e2eStatus,
        isVideoRoom,
        alias,
        isFavorite,
        canInviteToState,
        searchInputRef,
        pinCount,
        onRoomMembersClick,
        onRoomThreadsClick,
        onRoomFilesClick,
        onRoomExtensionsClick,
        onRoomUrlsClick,
        onRoomPinsClick,
        onRoomSettingsClick,
        onLeaveRoomClick,
        onShareRoomClick,
        onRoomExportClick,
        onRoomPollHistoryClick,
        onReportRoomClick,
        onUpdateSearchInput,
        onFavoriteToggleClick,
        onInviteToRoomClick,
        onDeleteRoomClick,
        canDeleteRoom,
    };
}
