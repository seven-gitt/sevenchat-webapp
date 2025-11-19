/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useContext, useMemo } from "react";

import MatrixClientContext from "../../../contexts/MatrixClientContext";
import RoomContext from "../../../contexts/RoomContext";
import { _t } from "../../../languageHandler";
import { formatFullDateNoTime, formatTime } from "../../../DateUtils";
import AccessibleButton from "../elements/AccessibleButton";
import Modal from "../../../Modal";
import ReminderDetailDialog from "../dialogs/ReminderDetailDialog";
import { getReminderDueFromEvent, type ReminderPayload } from "../../../reminders/index";
import type { IBodyProps } from "./IBodyProps";

const MReminderDueBody: React.FC<IBodyProps> = ({ mxEvent }) => {
    const matrixClient = useContext(MatrixClientContext);
    const roomContext = useContext(RoomContext);

    const reminderDue = useMemo(() => getReminderDueFromEvent(mxEvent), [mxEvent]);

    const fallback = mxEvent.getContent().body ?? "";
    if (!reminderDue || !matrixClient) {
        return <span className="mx_MReminderBody_fallback">{fallback}</span>;
    }

    const room = roomContext.room ?? matrixClient.getRoom(mxEvent.getRoomId() ?? "");
    if (!room) {
        return <span className="mx_MReminderBody_fallback">{fallback}</span>;
    }

    const reminder: ReminderPayload = {
        content: reminderDue.content,
        datetime: reminderDue.datetime,
        repeat: reminderDue.repeat,
    };

    const occurrenceDate = new Date(reminderDue.triggeredAt);
    const formattedDate = formatFullDateNoTime(occurrenceDate);
    const formattedTime = formatTime(occurrenceDate, roomContext.showTwelveHourTimestamps);
    const weekday = occurrenceDate.toLocaleDateString(undefined, { weekday: "short" });
    const day = occurrenceDate.toLocaleDateString(undefined, { day: "2-digit" });
    const month = occurrenceDate.toLocaleDateString(undefined, { month: "short" });

    const repeatLabels: Record<ReminderPayload["repeat"], string> = useMemo(
        () => ({
            none: _t("reminder|repeat_none"),
            daily: _t("reminder|repeat_daily"),
            weekly: _t("reminder|repeat_weekly"),
            monthly: _t("reminder|repeat_monthly"),
        }),
        [],
    );

    const showRepeat = reminder.repeat !== "none";

    const onViewDetails = (): void => {
        Modal.createDialog(ReminderDetailDialog, {
            mxEvent,
            reminder,
            matrixClient,
            room,
            threadId: mxEvent.getThread()?.id ?? null,
            showTwelveHourTime: roomContext.showTwelveHourTimestamps,
            replacingEventId: reminderDue.originalEventId ?? mxEvent.getId() ?? undefined,
        });
    };

    return (
        <div className="mx_MReminderDueBody">
            <div className="mx_MReminderDueBody_date">
                <span className="mx_MReminderDueBody_weekday">{weekday}</span>
                <span className="mx_MReminderDueBody_day">{day}</span>
                <span className="mx_MReminderDueBody_month">{month}</span>
            </div>
            <div className="mx_MReminderDueBody_content">
                <div className="mx_MReminderDueBody_heading">{_t("reminder|due_card_heading")}</div>
                <div className="mx_MReminderDueBody_summary">{reminder.content}</div>
                <div className="mx_MReminderDueBody_meta">
                    <span>{formattedDate}</span>
                    <span className="mx_MReminderDueBody_separator">•</span>
                    <span>{formattedTime}</span>
                </div>
                {showRepeat && (
                    <div className="mx_MReminderDueBody_repeat">
                        {_t("reminder|due_card_repeat", { repeat: repeatLabels[reminder.repeat] })}
                    </div>
                )}
                <AccessibleButton
                    kind="primary_outline"
                    className="mx_MReminderDueBody_button"
                    onClick={onViewDetails}
                >
                    {_t("reminder|view_details")}
                </AccessibleButton>
            </div>
        </div>
    );
};

export default MReminderDueBody;
