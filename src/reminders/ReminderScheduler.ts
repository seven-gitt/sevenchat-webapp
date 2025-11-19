/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {
    type MatrixClient,
    type MatrixEvent,
    MatrixEventEvent,
    type Room,
    RoomEvent,
    type IRoomTimelineData,
} from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import {
    getReminderFromEvent,
    type ReminderPayload,
    type ReminderRepeat,
    sendReminderDueMessage,
} from ".";
import { showReminderToast } from "../toasts/ReminderToast";
import Modal from "../Modal";
import ReminderDetailDialog from "../components/views/dialogs/ReminderDetailDialog";
import SettingsStore from "../settings/SettingsStore";
import PlatformPeg from "../PlatformPeg";
import { localNotificationsAreSilenced } from "../utils/notifications";
import { _t } from "../languageHandler";
import { formatFullDateNoTime, formatTime } from "../DateUtils";

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

interface ScheduledReminder {
    key: string;
    roomId: string;
    threadId: string | null;
    reminder: ReminderPayload;
    nextOccurrence: Date;
    lastOccurrence?: Date;
    event: MatrixEvent;
    timeoutId?: ReturnType<typeof setTimeout>;
    replaceHandler?: () => void;
    redactionHandler?: () => void;
}

export class ReminderScheduler {
    private static instance?: ReminderScheduler;

    public static sharedInstance(): ReminderScheduler {
        if (!ReminderScheduler.instance) {
            ReminderScheduler.instance = new ReminderScheduler();
        }
        return ReminderScheduler.instance;
    }

    private client?: MatrixClient;
    private scheduled = new Map<string, ScheduledReminder>();

    private constructor() {}

    public start(client: MatrixClient): void {
        if (this.client === client) return;

        this.stop();
        this.client = client;
        client.on(RoomEvent.Timeline, this.onRoomTimeline);
        client.on(RoomEvent.LocalEchoUpdated, this.onLocalEchoUpdated);
    }

    public stop(): void {
        if (!this.client) return;

        this.client.removeListener(RoomEvent.Timeline, this.onRoomTimeline);
        this.client.removeListener(RoomEvent.LocalEchoUpdated, this.onLocalEchoUpdated);
        this.client = undefined;
        this.clearAll();
    }

    private clearAll(): void {
        for (const key of Array.from(this.scheduled.keys())) {
            this.unscheduleReminder(key);
        }
        this.scheduled.clear();
    }

    private onRoomTimeline = (
        event: MatrixEvent,
        room?: Room,
        toStartOfTimeline?: boolean,
        removed?: boolean,
        data?: IRoomTimelineData,
    ): void => {
        if (!room || toStartOfTimeline || removed || !data?.liveEvent) return;
        this.maybeScheduleFromEvent(event);
    };

    private onLocalEchoUpdated = (event: MatrixEvent, room: Room, oldEventId?: string): void => {
        if (!room) return;

        const oldKey = oldEventId ?? event.getTxnId();
        const newKey = this.getEventKey(event);
        if (oldKey && newKey && oldKey !== newKey) {
            const entry = this.scheduled.get(oldKey);
            if (entry) {
                this.scheduled.delete(oldKey);
                entry.key = newKey;
                this.scheduled.set(newKey, entry);
            }
        }

        this.maybeScheduleFromEvent(event);
    };

    private maybeScheduleFromEvent(event: MatrixEvent): void {
        if (!event.getRoomId()) return;

        const reminder = getReminderFromEvent(event);
        if (!reminder) {
            if (event.isBeingDecrypted() || event.shouldAttemptDecryption()) {
                event.once(MatrixEventEvent.Decrypted, () => this.maybeScheduleFromEvent(event));
            }
            return;
        }

        const currentUserId = this.client?.getUserId();
        if (!currentUserId || event.getSender() !== currentUserId) {
            return;
        }

        this.scheduleReminder(event, reminder);
    }

    private scheduleReminder(event: MatrixEvent, reminder: ReminderPayload): void {
        const key = this.getEventKey(event);
        const roomId = event.getRoomId();
        if (!key || !roomId) return;

        const existingEntry = this.findEntryByEvent(event);
        if (existingEntry && existingEntry.key !== key) {
            this.scheduled.delete(existingEntry.key);
        }

        const entry = existingEntry ?? this.scheduled.get(key) ?? {
            key,
            roomId,
            threadId: event.getThread()?.id ?? null,
            reminder,
            nextOccurrence: new Date(),
            event,
        };

        entry.key = key;
        entry.roomId = roomId;
        entry.threadId = event.getThread()?.id ?? null;
        entry.reminder = reminder;
        entry.event = event;
        entry.lastOccurrence = undefined;

        const nextOccurrence = this.calculateNextOccurrence(reminder);
        if (!nextOccurrence) {
            this.unscheduleReminder(key);
            return;
        }

        entry.nextOccurrence = nextOccurrence;
        this.scheduled.set(key, entry);
        this.attachEventListeners(entry);
        this.armTimeout(entry);
    }

    private attachEventListeners(entry: ScheduledReminder): void {
        if (entry.replaceHandler) {
            entry.event.removeListener(MatrixEventEvent.Replaced, entry.replaceHandler);
        }
        if (entry.redactionHandler) {
            entry.event.removeListener(MatrixEventEvent.BeforeRedaction, entry.redactionHandler);
        }

        const onReplaced = (): void => this.onReminderEventUpdated(entry.event);
        const onBeforeRedaction = (): void => this.onReminderEventRedacted(entry.event);
        entry.event.on(MatrixEventEvent.Replaced, onReplaced);
        entry.event.on(MatrixEventEvent.BeforeRedaction, onBeforeRedaction);
        entry.replaceHandler = onReplaced;
        entry.redactionHandler = onBeforeRedaction;
    }

    private onReminderEventUpdated(event: MatrixEvent): void {
        const entry = this.findEntryByEvent(event);
        if (!entry) return;

        const reminder = getReminderFromEvent(event);
        if (!reminder) {
            this.unscheduleReminder(entry.key);
            return;
        }

        entry.reminder = reminder;
        entry.lastOccurrence = undefined;
        const nextOccurrence = this.calculateNextOccurrence(reminder);
        if (!nextOccurrence) {
            this.unscheduleReminder(entry.key);
            return;
        }

        entry.nextOccurrence = nextOccurrence;
        this.armTimeout(entry);
    }

    private onReminderEventRedacted(event: MatrixEvent): void {
        const entry = this.findEntryByEvent(event);
        if (!entry) return;
        this.unscheduleReminder(entry.key);
    }

    private armTimeout(entry: ScheduledReminder): void {
        if (entry.timeoutId) {
            clearTimeout(entry.timeoutId);
        }

        const diff = entry.nextOccurrence.getTime() - Date.now();
        if (diff <= 0) {
            window.setTimeout(() => this.onReminderDue(entry.key), 0);
            return;
        }

        const delay = Math.min(diff, MAX_TIMEOUT_MS);
        entry.timeoutId = window.setTimeout(() => {
            const current = this.scheduled.get(entry.key);
            if (!current) return;

            if (Date.now() + 50 >= current.nextOccurrence.getTime()) {
                void this.onReminderDue(current.key);
            } else {
                this.armTimeout(current);
            }
        }, delay);
    }

    private unscheduleReminder(key: string): void {
        const entry = this.scheduled.get(key);
        if (!entry) return;

        if (entry.timeoutId) {
            clearTimeout(entry.timeoutId);
            entry.timeoutId = undefined;
        }

        if (entry.replaceHandler) {
            entry.event.removeListener(MatrixEventEvent.Replaced, entry.replaceHandler);
            entry.replaceHandler = undefined;
        }
        if (entry.redactionHandler) {
            entry.event.removeListener(MatrixEventEvent.BeforeRedaction, entry.redactionHandler);
            entry.redactionHandler = undefined;
        }

        this.scheduled.delete(key);
    }

    private async onReminderDue(key: string): Promise<void> {
        const entry = this.scheduled.get(key);
        const client = this.client;
        if (!entry || !client) return;

        const room = client.getRoom(entry.roomId);
        if (!room) {
            this.unscheduleReminder(key);
            return;
        }

        const occurrence = entry.nextOccurrence;
        entry.lastOccurrence = occurrence;

        const toastKey = `reminder_due_${key}`;
        showReminderToast({
            toastKey,
            room,
            reminder: entry.reminder,
            occurrence,
            onViewDetails: () => this.openReminderDetails(entry, room),
        });

        this.showDesktopNotification(room, entry.reminder, occurrence);

        try {
            await sendReminderDueMessage(client, room.roomId, entry.reminder, occurrence, {
                threadId: entry.threadId,
                originalEventId: entry.event.getId() ?? entry.event.getTxnId() ?? undefined,
            });
        } catch (error) {
            logger.error("Failed to send reminder due message", error);
        }

        if (entry.reminder.repeat === "none") {
            this.unscheduleReminder(key);
            return;
        }

        const nextOccurrence = this.calculateNextOccurrence(entry.reminder, occurrence);
        if (!nextOccurrence) {
            this.unscheduleReminder(key);
            return;
        }

        entry.nextOccurrence = nextOccurrence;
        this.armTimeout(entry);
    }

    private openReminderDetails(entry: ScheduledReminder, room: Room): void {
        if (!this.client) return;

        const showTwelveHour = SettingsStore.getValue("showTwelveHourTimestamps");
        Modal.createDialog(ReminderDetailDialog, {
            mxEvent: entry.event,
            reminder: entry.reminder,
            matrixClient: this.client,
            room,
            threadId: entry.threadId,
            showTwelveHourTime: showTwelveHour,
            replacingEventId: entry.event.getId() ?? entry.event.getTxnId() ?? undefined,
        });
    }

    private showDesktopNotification(room: Room, reminder: ReminderPayload, occurrence: Date): void {
        if (!this.client) return;
        const platform = PlatformPeg.get();
        if (!platform?.supportsNotifications() || !platform.maySendNotifications()) {
            return;
        }

        if (localNotificationsAreSilenced(this.client)) {
            return;
        }

        const showTwelveHour = SettingsStore.getValue("showTwelveHourTimestamps");
        const formattedDate = formatFullDateNoTime(occurrence);
        const formattedTime = formatTime(occurrence, showTwelveHour);
        const title = _t("reminder|due_notification_title", { roomName: room.name || room.roomId });
        const body = _t("reminder|due_notification_body", {
            content: reminder.content,
            date: formattedDate,
            time: formattedTime,
        });

        platform.displayNotification(title, body, null, room);
    }

    private calculateNextOccurrence(
        reminder: ReminderPayload,
        fromDate?: Date,
    ): Date | undefined {
        const baseDate = fromDate ? new Date(fromDate.getTime()) : new Date(reminder.datetime);
        if (Number.isNaN(baseDate.getTime())) {
            return undefined;
        }

        let occurrence = new Date(baseDate.getTime());
        if (reminder.repeat === "none") {
            return occurrence;
        }

        const now = Date.now();
        let safety = 0;
        while (occurrence.getTime() < now && safety < 1000) {
            occurrence = this.addInterval(occurrence, reminder.repeat);
            safety++;
        }

        if (safety >= 1000) {
            logger.warn("Failed to calculate next reminder occurrence", reminder);
            return undefined;
        }

        return occurrence;
    }

    private addInterval(date: Date, repeat: ReminderRepeat): Date {
        const updated = new Date(date.getTime());
        switch (repeat) {
            case "daily":
                updated.setDate(updated.getDate() + 1);
                break;
            case "weekly":
                updated.setDate(updated.getDate() + 7);
                break;
            case "monthly":
                updated.setMonth(updated.getMonth() + 1);
                break;
            default:
                break;
        }
        return updated;
    }

    private getEventKey(event: MatrixEvent): string | undefined {
        return event.getId() ?? event.getTxnId() ?? undefined;
    }

    private findEntryByEvent(event: MatrixEvent): ScheduledReminder | undefined {
        for (const entry of this.scheduled.values()) {
            if (entry.event === event) return entry;
        }
        return undefined;
    }
}

export default ReminderScheduler;
