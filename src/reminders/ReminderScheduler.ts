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
    getReminderDueFromEvent,
    REMINDER_DUE_MSGTYPE,
    type ReminderPayload,
    type ReminderRepeat,
    sendReminderDueMessage,
} from ".";
import Modal from "../Modal";
import ReminderDetailDialog from "../components/views/dialogs/ReminderDetailDialog";
import SettingsStore from "../settings/SettingsStore";
import PlatformPeg from "../PlatformPeg";
import { localNotificationsAreSilenced } from "../utils/notifications";
import { _t } from "../languageHandler";
import { formatFullDateNoTime, formatTime } from "../DateUtils";

const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const SENT_CACHE_KEY = "sevenchat_sent_reminder_due";
const SENT_CACHE_LIMIT = 200;
const SENT_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const SEND_LOCK_PREFIX = "sevenchat_reminder_due_lock";
const SEND_LOCK_TTL_MS = 1000 * 60 * 10; // 10 minutes

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
    private sentDue = new Set<string>();
    private readonly tabId = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    private constructor() {
        this.loadSentCache();
    }

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

        const room = this.client?.getRoom(roomId);
        const originalEventId = event.getId() ?? event.getTxnId() ?? undefined;

        // If the reminder is already overdue and we can see an existing due card, avoid re-sending after reload.
        if (
            reminder.repeat === "none" &&
            originalEventId &&
            room &&
            reminder.datetime &&
            new Date(reminder.datetime).getTime() <= Date.now() &&
            this.findExistingReminderDue(room, reminder, new Date(), originalEventId)
        ) {
            this.unscheduleReminder(key);
            return;
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

        const originalEventId = entry.event.getId() ?? entry.event.getTxnId() ?? undefined;
        const signature = this.makeDueSignature(entry.reminder, occurrence, room.roomId, originalEventId);

        const shouldSend = await this.shouldSendReminderDue(room, entry.reminder, occurrence, originalEventId, signature);
        if (shouldSend) {
            this.rememberSentReminderDue(signature);
            try {
                await sendReminderDueMessage(client, room.roomId, entry.reminder, occurrence, {
                    threadId: entry.threadId,
                    originalEventId,
                });
            } catch (error) {
                logger.error("Failed to send reminder due message", error);
            }
        } else {
            logger.info("Skipping duplicate reminder due message", {
                roomId: room.roomId,
                originalEventId,
                signature,
            });
        }

        this.showDesktopNotification(room, entry.reminder, occurrence);

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

    private matchesReminderDue(
        event: MatrixEvent,
        reminder: ReminderPayload,
        occurrence: Date,
        originalEventId?: string,
    ): boolean {
        if (event.getType() !== REMINDER_DUE_MSGTYPE) return false;
        const reminderDue = getReminderDueFromEvent(event);
        if (!reminderDue) return false;

        if (originalEventId && reminderDue.originalEventId === originalEventId) {
            return true;
        }

        const triggeredAtMatch = reminderDue.triggeredAt
            ? Math.abs(new Date(reminderDue.triggeredAt).getTime() - occurrence.getTime()) <= 60_000
            : false;

        // Fallback matching when original_event_id is missing or mismatched
        return (
            triggeredAtMatch ||
            reminderDue.content === reminder.content &&
            reminderDue.datetime === reminder.datetime &&
            reminderDue.repeat === reminder.repeat
        );
    }

    private findExistingReminderDue(
        room: Room,
        reminder: ReminderPayload,
        occurrence: Date,
        originalEventId?: string,
    ): MatrixEvent | undefined {
        const timelineEvents = room.getLiveTimeline()?.getEvents() ?? [];
        const pendingEvents = room.getPendingEvents() ?? [];
        const allEvents = [...timelineEvents, ...pendingEvents];
        return allEvents.find((event) => this.matchesReminderDue(event, reminder, occurrence, originalEventId));
    }

    private waitForIncomingReminderDue(
        room: Room,
        reminder: ReminderPayload,
        occurrence: Date,
        originalEventId?: string,
        timeoutMs = 1500,
    ): Promise<boolean> {
        // Give other devices a short window to deliver the due card before we send ours.
        return new Promise((resolve) => {
            let timeoutId: ReturnType<typeof setTimeout> | undefined;

            const onTimeline = (
                event: MatrixEvent,
                eventRoom?: Room,
                toStartOfTimeline?: boolean,
                removed?: boolean,
                data?: IRoomTimelineData,
            ): void => {
                if (eventRoom?.roomId !== room.roomId || toStartOfTimeline || removed || !data?.liveEvent) {
                    return;
                }
                if (this.matchesReminderDue(event, reminder, occurrence, originalEventId)) {
                    cleanup(true);
                }
            };

            const cleanup = (found: boolean): void => {
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = undefined;
                }
                room.removeListener(RoomEvent.Timeline, onTimeline);
                resolve(found);
            };

            room.on(RoomEvent.Timeline, onTimeline);
            timeoutId = window.setTimeout(() => {
                cleanup(false);
            }, timeoutMs);
        });
    }

    private async shouldSendReminderDue(
        room: Room,
        reminder: ReminderPayload,
        occurrence: Date,
        originalEventId: string | undefined,
        signature: string,
    ): Promise<boolean> {
        if (this.hasSentReminderDue(signature)) {
            return false;
        }

        if (this.findExistingReminderDue(room, reminder, occurrence, originalEventId)) {
            return false;
        }

        const foundDuringWait = await this.waitForIncomingReminderDue(room, reminder, occurrence, originalEventId);
        if (foundDuringWait) return false;

        if (!this.acquireSendLock(signature)) {
            return false;
        }

        // One last check in case the event arrived right after the timeout.
        return !this.findExistingReminderDue(room, reminder, occurrence, originalEventId);
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

    private makeDueSignature(
        reminder: ReminderPayload,
        occurrence: Date,
        roomId: string,
        originalEventId?: string,
    ): string {
        return [
            roomId,
            originalEventId ?? "no-id",
            reminder.content,
            reminder.datetime,
            reminder.repeat,
            occurrence.toISOString(),
        ].join("|");
    }

    private hasSentReminderDue(signature: string): boolean {
        return this.sentDue.has(signature);
    }

    private rememberSentReminderDue(signature: string): void {
        this.sentDue.add(signature);
        this.persistSentCache();
    }

    private makeLockKey(signature: string): string {
        return `${SEND_LOCK_PREFIX}:${signature}`;
    }

    private acquireSendLock(signature: string): boolean {
        try {
            if (!window?.localStorage) return true;
            const key = this.makeLockKey(signature);
            const raw = window.localStorage.getItem(key);
            const now = Date.now();
            if (raw) {
                const parsed = JSON.parse(raw) as { tabId: string; ts: number };
                if (parsed.ts && now - parsed.ts < SEND_LOCK_TTL_MS) {
                    // Any fresh lock (even from this tab) means the send already happened or is in-flight.
                    return false;
                }
            }
            window.localStorage.setItem(key, JSON.stringify({ tabId: this.tabId, ts: now }));
            return true;
        } catch (error) {
            logger.warn("Failed to use reminder due lock", error);
            return true; // fail open: still try to send, but our existing checks remain
        }
    }

    private loadSentCache(): void {
        try {
            if (!window?.localStorage) return;
            const raw = window.localStorage.getItem(SENT_CACHE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw) as Array<[string, number]>;
            const now = Date.now();
            parsed.forEach(([sig, ts]) => {
                if (now - ts < SENT_CACHE_TTL_MS) {
                    this.sentDue.add(sig);
                }
            });
        } catch (error) {
            logger.warn("Failed to load reminder due cache", error);
        }
    }

    private persistSentCache(): void {
        try {
            if (!window?.localStorage) return;
            const now = Date.now();
            const entries: Array<[string, number]> = [];
            for (const sig of this.sentDue) {
                entries.push([sig, now]);
            }
            const trimmed = entries.slice(-SENT_CACHE_LIMIT);
            window.localStorage.setItem(SENT_CACHE_KEY, JSON.stringify(trimmed));
        } catch (error) {
            logger.warn("Failed to persist reminder due cache", error);
        }
    }
}

export default ReminderScheduler;
