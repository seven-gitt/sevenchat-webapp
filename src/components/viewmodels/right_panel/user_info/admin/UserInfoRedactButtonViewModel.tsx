/*
Copyright 2025 New Vector Ltd.
SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { type RoomMember, EventTimeline } from "matrix-js-sdk/src/matrix";

import { useMatrixClientContext } from "../../../../../contexts/MatrixClientContext";

export interface RedactMessagesButtonState {
    onRedactAllMessagesClick: () => void;
}

/**
 * The view model for the redact messages button used in the UserInfoAdminToolsContainer
 * @param {RoomMember} member - the selected member to redact messages for
 * @returns {RedactMessagesButtonState} the redact messages button state
 */
export const useRedactMessagesButtonViewModel = (member: RoomMember): RedactMessagesButtonState => {
    const cli = useMatrixClientContext();

    const onRedactAllMessagesClick = (): void => {
        const room = cli.getRoom(member.roomId);
        if (!room) return;

        // Directly delete messages without confirmation dialog
        // This will trigger the bulk redact process immediately
        let timeline: EventTimeline | null = room.getLiveTimeline();
        const eventsToRedact: any[] = [];
        
        // Collect recent messages from the user
        while (timeline) {
            const events = timeline.getEvents();
            for (const event of events) {
                if (event.getSender() === member.userId && event.getType() === "m.room.message") {
                    eventsToRedact.push(event);
                }
            }
            const nextTimeline = timeline.getNeighbouringTimeline(EventTimeline.BACKWARDS);
            timeline = nextTimeline; // This can be null
        }

        // Delete messages directly
        eventsToRedact.reverse().forEach(async (event) => {
            try {
                await cli.redactEvent(room.roomId, event.getId()!);
            } catch (err) {
                console.error("Could not redact", event.getId(), err);
            }
        });
    };

    return {
        onRedactAllMessagesClick,
    };
};
