/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useContext, useMemo } from "react";

import { _t } from "../../../languageHandler";
import { formatFullDateNoTime, formatTime } from "../../../DateUtils";
import MatrixClientContext from "../../../contexts/MatrixClientContext";
import RoomContext from "../../../contexts/RoomContext";
import Modal from "../../../Modal";
import AccessibleButton from "../elements/AccessibleButton";
import ReminderDetailDialog from "../dialogs/ReminderDetailDialog";
import { getReminderFromEvent } from "../../../reminders/index";
import type { IBodyProps } from "./IBodyProps";

const MReminderBody: React.FC<IBodyProps> = ({ mxEvent }) => {
    const matrixClient = useContext(MatrixClientContext);
    const roomContext = useContext(RoomContext);

    const reminder = useMemo(() => getReminderFromEvent(mxEvent), [mxEvent]);

    const fallback = mxEvent.getContent().body ?? "";
    if (!matrixClient || !reminder) {
        return <span className="mx_MReminderBody_fallback">{fallback}</span>;
    }

    const room = roomContext.room ?? matrixClient.getRoom(mxEvent.getRoomId() ?? "");
    if (!room) {
        return <span className="mx_MReminderBody_fallback">{fallback}</span>;
    }

    const reminderDate = new Date(reminder.datetime);
    const formattedDate = formatFullDateNoTime(reminderDate);
    const formattedTime = formatTime(reminderDate, roomContext.showTwelveHourTimestamps);

    const senderId = mxEvent.getSender();
    const isSelf = senderId === matrixClient.getSafeUserId();
    const member = room.getMember(senderId);
    const authorName = isSelf ? _t("reminder|author_you") : member?.name || senderId;

    const summary = _t("reminder|created_summary", {
        author: authorName,
        content: reminder.content,
        date: formattedDate,
        time: formattedTime,
    });

    const onViewDetails = (): void => {
        Modal.createDialog(ReminderDetailDialog, {
            mxEvent,
            reminder,
            matrixClient,
            room,
            threadId: mxEvent.getThread()?.id ?? null,
            showTwelveHourTime: roomContext.showTwelveHourTimestamps,
        });
    };

    return (
        <div className="mx_MReminderBody">
            <div className="mx_MReminderBody_summary">{summary}</div>
            <AccessibleButton
                kind="primary_outline"
                className="mx_MReminderBody_button"
                onClick={onViewDetails}
            >
                {_t("reminder|view_details")}
            </AccessibleButton>
        </div>
    );
};

export default MReminderBody;