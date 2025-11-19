/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useMemo } from "react";
import { logger } from "matrix-js-sdk/src/logger";
import { type MatrixClient, type MatrixEvent, type Room } from "matrix-js-sdk/src/matrix";

import BaseDialog from "./BaseDialog";
import DialogButtons from "../elements/DialogButtons";
import Modal from "../../../Modal";
import ReminderDialog from "./ReminderDialog";
import { _t } from "../../../languageHandler";
import ErrorDialog from "./ErrorDialog";
import { formatFullDateNoTime, formatTime } from "../../../DateUtils";
import { sendReminderMessage, type ReminderPayload, type ReminderRepeat } from "../../../reminders/index";

interface Props {
    onFinished(ok?: false): void;
    onFinished(ok: true): void;
    mxEvent: MatrixEvent;
    reminder: ReminderPayload;
    matrixClient: MatrixClient;
    room: Room;
    threadId?: string | null;
    showTwelveHourTime?: boolean;
    replacingEventId?: string;
}

const ReminderDetailDialog: React.FC<Props> = ({
    onFinished,
    mxEvent,
    reminder,
    matrixClient,
    room,
    threadId = null,
    showTwelveHourTime = false,
    replacingEventId,
}) => {
    const repeatLabels = useMemo<Record<ReminderRepeat, string>>(
        () => ({
            none: _t("reminder|repeat_none"),
            daily: _t("reminder|repeat_daily"),
            weekly: _t("reminder|repeat_weekly"),
            monthly: _t("reminder|repeat_monthly"),
        }),
        [],
    );
    const reminderDate = useMemo(() => new Date(reminder.datetime), [reminder.datetime]);
    const formattedDate = useMemo(
        () => formatFullDateNoTime(reminderDate),
        [reminderDate],
    );
    const formattedTime = useMemo(
        () => formatTime(reminderDate, showTwelveHourTime),
        [reminderDate, showTwelveHourTime],
    );

    const onClose = (): void => onFinished(false);

    const onEdit = (): void => {
        const { finished } = Modal.createDialog(ReminderDialog, {
            initialReminder: reminder,
            title: _t("reminder|edit_title"),
            primaryButtonLabel: _t("reminder|update_action"),
        });

        finished.then(async ([confirmed, updatedReminder]) => {
            if (!confirmed || !updatedReminder) return;

            try {
                await sendReminderMessage(matrixClient, room.roomId, updatedReminder, {
                    threadId,
                    replacingEventId: replacingEventId ?? mxEvent.getId() ?? undefined,
                });
                onFinished(true);
            } catch (error) {
                logger.error("Failed to update reminder", error);
                Modal.createDialog(ErrorDialog, {
                    title: _t("reminder|update_error_title"),
                    description: _t("reminder|update_error_description"),
                });
            }
        });
    };

    return (
        <BaseDialog
            className="mx_ReminderDetailDialog"
            onFinished={onFinished}
            title={_t("reminder|detail_title")}
            fixedWidth={false}
        >
            <div className="mx_ReminderDetailDialog_content">
                <div className="mx_ReminderDetailDialog_row">
                    <span className="mx_ReminderDetailDialog_label">{_t("reminder|content_label")}</span>
                    <div className="mx_ReminderDetailDialog_value">{reminder.content}</div>
                </div>
                <div className="mx_ReminderDetailDialog_row">
                    <span className="mx_ReminderDetailDialog_label">{_t("reminder|date_label")}</span>
                    <div className="mx_ReminderDetailDialog_value">{formattedDate}</div>
                </div>
                <div className="mx_ReminderDetailDialog_row">
                    <span className="mx_ReminderDetailDialog_label">{_t("reminder|time_label")}</span>
                    <div className="mx_ReminderDetailDialog_value">{formattedTime}</div>
                </div>
                <div className="mx_ReminderDetailDialog_row">
                    <span className="mx_ReminderDetailDialog_label">{_t("reminder|repeat_label")}</span>
                    <div className="mx_ReminderDetailDialog_value">{repeatLabels[reminder.repeat]}</div>
                </div>
            </div>
            <DialogButtons
                primaryButton={_t("reminder|edit_action")}
                onPrimaryButtonClick={onEdit}
                onCancel={onClose}
                cancelButton={_t("action|close")}
            />
        </BaseDialog>
    );
};

export default ReminderDetailDialog;
