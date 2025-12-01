/*
Copyright 2024 New Vector Ltd.
Copyright 2019-2022 The Matrix.org Foundation C.I.C.
Copyright 2016 OpenMarket Ltd

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { createRef } from "react";
import {
    Filter,
    type EventTimelineSet,
    type IRoomTimelineData,
    type Direction,
    type MatrixEvent,
    MatrixEventEvent,
    type Room,
    RoomEvent,
    type TimelineWindow,
} from "matrix-js-sdk/src/matrix";
import { type IFilterDefinition } from "matrix-js-sdk/src/filter";
import { logger } from "matrix-js-sdk/src/logger";
import FilesIcon from "@vector-im/compound-design-tokens/assets/web/icons/files";
import ImageIcon from "@vector-im/compound-design-tokens/assets/web/icons/image";

import { MatrixClientPeg } from "../../MatrixClientPeg";
import EventIndexPeg from "../../indexing/EventIndexPeg";
import { _t } from "../../languageHandler";
import SearchWarning, { WarningKind } from "../views/elements/SearchWarning";
import BaseCard from "../views/right_panel/BaseCard";
import type ResizeNotifier from "../../utils/ResizeNotifier";
import TimelinePanel from "./TimelinePanel";
import Spinner from "../views/elements/Spinner";
import { Layout } from "../../settings/enums/Layout";
import RoomContext, { TimelineRenderingType } from "../../contexts/RoomContext";
import Measured from "../views/elements/Measured";
import EmptyState from "../views/right_panel/EmptyState";
import { ScopedRoomContextProvider } from "../../contexts/ScopedRoomContext";

type FilePanelVariant = "files" | "images";

interface IProps {
    roomId: string;
    onClose: () => void;
    resizeNotifier: ResizeNotifier;
    variant?: FilePanelVariant;
}

interface IState {
    timelineSet: EventTimelineSet | null;
    narrow: boolean;
}

/*
 * Component which shows the filtered file using a TimelinePanel
 */
class FilePanel extends React.Component<IProps, IState> {
    public static contextType = RoomContext;
    declare public context: React.ContextType<typeof RoomContext>;

    // This is used to track if a decrypted event was a live event and should be
    // added to the timeline.
    private decryptingEvents = new Set<string>();
    public noRoom = false;
    private card = createRef<HTMLDivElement>();

    public state: IState = {
        timelineSet: null,
        narrow: false,
    };

    private onRoomTimeline = (
        ev: MatrixEvent,
        room: Room | undefined,
        toStartOfTimeline: boolean | undefined,
        removed: boolean,
        data: IRoomTimelineData,
    ): void => {
        if (room?.roomId !== this.props.roomId) return;
        if (toStartOfTimeline || !data || !data.liveEvent || ev.isRedacted()) return;

        const client = MatrixClientPeg.safeGet();
        client.decryptEventIfNeeded(ev);

        if (ev.isBeingDecrypted()) {
            this.decryptingEvents.add(ev.getId()!);
        } else {
            this.addEncryptedLiveEvent(ev);
        }
    };

    private onEventDecrypted = (ev: MatrixEvent, err?: any): void => {
        if (ev.getRoomId() !== this.props.roomId) return;
        const eventId = ev.getId()!;

        if (!this.decryptingEvents.delete(eventId)) return;
        if (err) return;

        this.addEncryptedLiveEvent(ev);
    };

    private removeEventIfIrrelevant = (ev: MatrixEvent): void => {
        if (ev.getRoomId() !== this.props.roomId) return;
        if (this.isAllowedFileEvent(ev)) return;
        const eventId = ev.getId();
        if (!eventId) return;
        this.state.timelineSet?.removeEvent(eventId);
    };

    private onFilteredTimelineEvent = (
        ev: MatrixEvent,
        room: Room | undefined,
        toStartOfTimeline: boolean | undefined,
        removed: boolean,
    ): void => {
        if (removed || toStartOfTimeline) return;
        if (room?.roomId !== this.props.roomId) return;
        this.removeEventIfIrrelevant(ev);
    };

    private onFilteredDecryptedEvent = (ev: MatrixEvent): void => {
        this.removeEventIfIrrelevant(ev);
    };

    private get variant(): FilePanelVariant {
        return this.props.variant ?? "files";
    }

    private get headerLabel(): string {
        return this.variant === "images" ? _t("right_panel|images_button") : _t("right_panel|files_button");
    }

    private get emptyStateCopy(): { title: string; description: string } {
        if (this.variant === "images") {
            return {
                title: _t("image_panel|empty_heading"),
                description: _t("image_panel|empty_description"),
            };
        }

        return {
            title: _t("file_panel|empty_heading"),
            description: _t("file_panel|empty_description"),
        };
    }

    private get emptyStateIcon(): typeof FilesIcon {
        return this.variant === "images" ? ImageIcon : FilesIcon;
    }

    private isAllowedFileEvent(ev: MatrixEvent): boolean {
        const eventType = ev.getType();
        if (eventType !== "m.room.message" && eventType !== "m.room.encrypted") return false;

        const msgtype = ev.getContent().msgtype;
        if (!msgtype) return true;

        if (this.variant === "images") {
            return msgtype === "m.image";
        }

        return ["m.file", "m.video", "m.audio"].includes(msgtype);
    }

    private filterTimelineSet(timelineSet: EventTimelineSet | null): void {
        if (!timelineSet) return;

        const disallowed: string[] = [];
        for (const timeline of timelineSet.getTimelines()) {
            for (const event of timeline.getEvents()) {
                if (!this.isAllowedFileEvent(event)) {
                    const eventId = event.getId();
                    if (eventId) {
                        disallowed.push(eventId);
                    }
                }
            }
        }

        for (const eventId of disallowed) {
            timelineSet.removeEvent(eventId);
        }
    }

    public addEncryptedLiveEvent(ev: MatrixEvent): void {
        if (!this.state.timelineSet) return;

        const timeline = this.state.timelineSet.getLiveTimeline();
        if (!this.isAllowedFileEvent(ev)) return;

        if (!this.state.timelineSet.eventIdToTimeline(ev.getId()!)) {
            this.state.timelineSet.addEventToTimeline(ev, timeline, {
                fromCache: false,
                addToState: false,
                toStartOfTimeline: false,
            });
        }
    }

    public async componentDidMount(): Promise<void> {
        const client = MatrixClientPeg.safeGet();

        await this.updateTimelineSet(this.props.roomId);

        client.on(RoomEvent.Timeline, this.onFilteredTimelineEvent);
        client.on(MatrixEventEvent.Decrypted, this.onFilteredDecryptedEvent);

        if (!client.isRoomEncrypted(this.props.roomId)) return;

        // The timelineSets filter makes sure that encrypted events that contain
        // URLs never get added to the timeline, even if they are live events.
        // These methods are here to manually listen for such events and add
        // them despite the filter's best efforts.
        //
        // We do this only for encrypted rooms and if an event index exists,
        // this could be made more general in the future or the filter logic
        // could be fixed.
        if (EventIndexPeg.get() !== null) {
            client.on(RoomEvent.Timeline, this.onRoomTimeline);
            client.on(MatrixEventEvent.Decrypted, this.onEventDecrypted);
        }
    }

    public componentWillUnmount(): void {
        const client = MatrixClientPeg.get();
        if (client === null) return;

        client.removeListener(RoomEvent.Timeline, this.onFilteredTimelineEvent);
        client.removeListener(MatrixEventEvent.Decrypted, this.onFilteredDecryptedEvent);

        if (!client.isRoomEncrypted(this.props.roomId)) return;

        if (EventIndexPeg.get() !== null) {
            client.removeListener(RoomEvent.Timeline, this.onRoomTimeline);
            client.removeListener(MatrixEventEvent.Decrypted, this.onEventDecrypted);
        }
    }

    public async fetchFileEventsServer(room: Room): Promise<EventTimelineSet> {
        const client = MatrixClientPeg.safeGet();
        const isEncryptedRoom = client.isRoomEncrypted(room.roomId);

        const filterDefinition: IFilterDefinition = {
            room: {
                timeline: {
                    types: ["m.room.message"],
                },
            },
        };

        const timelineFilter = filterDefinition.room?.timeline;
        if (timelineFilter) {
            if (isEncryptedRoom) {
                timelineFilter.types?.push("m.room.encrypted");
            } else {
                timelineFilter.contains_url = true;
            }
        }

        const filter = new Filter(client.getSafeUserId());
        filter.setDefinition(filterDefinition);

        const variantPrefix = this.variant === "images" ? "FILTER_FILES_IMAGES_" : "FILTER_FILES_ALL_";
        const encryptionSuffix = isEncryptedRoom ? "ENCRYPTED_" : "UNENCRYPTED_";

        filter.filterId = await client.getOrCreateFilter(
            variantPrefix + encryptionSuffix + client.credentials.userId,
            filter,
        );

        // The filtered timeline set is cached per filter. Force a fresh instance each time we
        // open the panel so previously removed events don't leave the panel empty.
        room.removeFilteredTimelineSet(filter);

        return room.getOrCreateFilteredTimelineSet(filter);
    }

    private onPaginationRequest = async (
        timelineWindow: TimelineWindow,
        direction: Direction,
        limit: number,
    ): Promise<boolean> => {
        const client = MatrixClientPeg.safeGet();
        const eventIndex = EventIndexPeg.get();
        const roomId = this.props.roomId;

        const room = client.getRoom(roomId);
        let result: boolean;

        // We override the pagination request for encrypted rooms so that we ask
        // the event index to fulfill the pagination request. Asking the server
        // to paginate won't ever work since the server can't correctly filter
        // out events containing URLs
        if (room && client.isRoomEncrypted(roomId) && eventIndex !== null) {
            result = await eventIndex.paginateTimelineWindow(room, timelineWindow, direction, limit);
        } else {
            result = await timelineWindow.paginate(direction, limit);
        }

        if (result && this.state.timelineSet) {
            this.filterTimelineSet(this.state.timelineSet);
        }

        return result;
    };

    private onMeasurement = (narrow: boolean): void => {
        this.setState({ narrow });
    };

    public async updateTimelineSet(roomId: string): Promise<void> {
        const client = MatrixClientPeg.safeGet();
        const room = client.getRoom(roomId);
        const eventIndex = EventIndexPeg.get();

        this.noRoom = !room;

        if (room) {
            let timelineSet;

            try {
                timelineSet = await this.fetchFileEventsServer(room);

                // If this room is encrypted the file panel won't be populated
                // correctly since the defined filter doesn't support encrypted
                // events and the server can't check if encrypted events contain
                // URLs.
                //
                // This is where our event index comes into place, we ask the
                // event index to populate the timelineSet for us. This call
                // will add 10 events to the live timeline of the set. More can
                // be requested using pagination.
                if (client.isRoomEncrypted(roomId) && eventIndex !== null) {
                    const timeline = timelineSet.getLiveTimeline();
                    await eventIndex.populateFileTimeline(timelineSet, timeline, room, 10);
                }

                this.filterTimelineSet(timelineSet);
                this.setState({ timelineSet: timelineSet });
            } catch (error) {
                logger.error("Failed to get or create file panel filter", error);
            }
        } else {
            logger.error("Failed to add filtered timelineSet for FilePanel as no room!");
        }
    }

    public render(): React.ReactNode {
        const headerLabel = this.headerLabel;
        const { title: emptyTitle, description: emptyDescription } = this.emptyStateCopy;
        const EmptyStateIcon = this.emptyStateIcon;

        if (MatrixClientPeg.safeGet().isGuest()) {
            return (
                <BaseCard
                    className="mx_FilePanel mx_RoomView_messageListWrapper"
                    onClose={this.props.onClose}
                    header={headerLabel}
                >
                    <div className="mx_RoomView_empty">
                        {_t(
                            "file_panel|guest_note",
                            {},
                            {
                                a: (sub) => (
                                    <a href="#/register" key="sub">
                                        {sub}
                                    </a>
                                ),
                            },
                        )}
                    </div>
                </BaseCard>
            );
        } else if (this.noRoom) {
            return (
                <BaseCard
                    className="mx_FilePanel mx_RoomView_messageListWrapper"
                    onClose={this.props.onClose}
                    header={headerLabel}
                >
                    <div className="mx_RoomView_empty">{_t("file_panel|peek_note")}</div>
                </BaseCard>
            );
        }

        // wrap a TimelinePanel with the jump-to-event bits turned off.

        const emptyState = (
            <EmptyState Icon={EmptyStateIcon} title={emptyTitle} description={emptyDescription} />
        );

        const isRoomEncrypted = this.noRoom ? false : MatrixClientPeg.safeGet().isRoomEncrypted(this.props.roomId);

        if (this.state.timelineSet) {
            return (
                <ScopedRoomContextProvider
                    {...this.context}
                    timelineRenderingType={TimelineRenderingType.File}
                    narrow={this.state.narrow}
                >
                    <BaseCard
                        className="mx_FilePanel"
                        onClose={this.props.onClose}
                        withoutScrollContainer
                        ref={this.card}
                        header={headerLabel}
                    >
                        <Measured sensor={this.card} onMeasurement={this.onMeasurement} />
                        <SearchWarning isRoomEncrypted={isRoomEncrypted} kind={WarningKind.Files} />
                        <TimelinePanel
                            manageReadReceipts={false}
                            manageReadMarkers={false}
                            timelineSet={this.state.timelineSet}
                            showUrlPreview={false}
                            onPaginationRequest={this.onPaginationRequest}
                            resizeNotifier={this.props.resizeNotifier}
                            empty={emptyState}
                            layout={Layout.Group}
                        />
                    </BaseCard>
                </ScopedRoomContextProvider>
            );
        } else {
            return (
                <ScopedRoomContextProvider {...this.context} timelineRenderingType={TimelineRenderingType.File}>
                    <BaseCard
                        className="mx_FilePanel"
                        onClose={this.props.onClose}
                        header={headerLabel}
                    >
                        <Spinner />
                    </BaseCard>
                </ScopedRoomContextProvider>
            );
        }
    }
}

export default FilePanel;
