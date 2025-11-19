/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { type Room } from "matrix-js-sdk/src/matrix";

import { _t } from "../languageHandler";
import { formatFullDateNoTime, formatTime } from "../DateUtils";
import GenericToast from "../components/views/toasts/GenericToast";
import ToastStore from "../stores/ToastStore";
import SettingsStore from "../settings/SettingsStore";
import { type ReminderPayload } from "../reminders";

interface ReminderToastOptions {
    toastKey: string;
    room: Room;
    reminder: ReminderPayload;
    occurrence: Date;
    onViewDetails(): void;
    onDismiss?(): void;
}

export const showReminderToast = ({
    toastKey,
    room,
    reminder,
    occurrence,
    onViewDetails,
    onDismiss,
}: ReminderToastOptions): void => {
    const showTwelveHour = SettingsStore.getValue("showTwelveHourTimestamps");
    const formattedDate = formatFullDateNoTime(occurrence);
    const formattedTime = formatTime(occurrence, showTwelveHour);

    const dismissToast = (): void => {
        ToastStore.sharedInstance().dismissToast(toastKey);
        onDismiss?.();
    };

    ToastStore.sharedInstance().addOrReplaceToast({
        key: toastKey,
        icon: "reminder",
        title: _t("reminder|due_toast_title", { roomName: room.name || room.roomId }),
        component: GenericToast,
        priority: 80,
        props: {
            description: reminder.content,
            detail: _t("reminder|due_toast_description", { date: formattedDate, time: formattedTime }),
            primaryLabel: _t("reminder|view_details"),
            onPrimaryClick: () => {
                ToastStore.sharedInstance().dismissToast(toastKey);
                onViewDetails();
            },
            secondaryLabel: _t("action|dismiss"),
            onSecondaryClick: dismissToast,
        },
    });
};
