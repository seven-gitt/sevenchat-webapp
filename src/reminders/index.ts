/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/src/logger";
import {
    type MatrixClient,
    type MatrixEvent,
    type RoomMessageEventContent,
} from "matrix-js-sdk/src/matrix";

import { formatFullDateNoTime, formatTime } from "../DateUtils";
import { doMaybeLocalRoomAction } from "../utils/local-room";

export type ReminderRepeat = "none" | "daily" | "weekly" | "monthly";

export interface ReminderPayload {
    content: string;
    datetime: string;
    repeat: ReminderRepeat;
}

const REMINDER_VERSION = 1;
export const REMINDER_MSGTYPE = "vn.sevenchat.reminder";
export const REMINDER_CONTENT_KEY = "sevenchat_reminder";
const REMINDER_DUE_VERSION = 1;
export const REMINDER_DUE_MSGTYPE = "vn.sevenchat.reminder_due";
export const REMINDER_DUE_CONTENT_KEY = "sevenchat_reminder_due";

interface ReminderContent extends ReminderPayload {
    version: number;
}

export type ReminderMessageContent = RoomMessageEventContent & {
    msgtype: typeof REMINDER_MSGTYPE;
    body: string;
    [REMINDER_CONTENT_KEY]: ReminderContent;
};

interface ReminderDueContent extends ReminderPayload {
    version: number;
    triggered_at: string;
    original_event_id?: string;
}

export interface ReminderDuePayload extends ReminderPayload {
    triggeredAt: string;
    originalEventId?: string;
}

export type ReminderDueMessageContent = RoomMessageEventContent & {
    msgtype: typeof REMINDER_DUE_MSGTYPE;
    body: string;
    [REMINDER_DUE_CONTENT_KEY]: ReminderDueContent;
};

const isReminderContent = (value: unknown): value is ReminderContent => {
    if (!value || typeof value !== "object") return false;

    const content = value as Partial<ReminderContent>;
    return (
        typeof content.version === "number" &&
        typeof content.content === "string" &&
        typeof content.datetime === "string" &&
        typeof content.repeat === "string"
    );
};

export const parseReminderContent = (
    content: RoomMessageEventContent | undefined,
): ReminderPayload | undefined => {
    if (!content) return undefined;

    const reminder = content[REMINDER_CONTENT_KEY];
    if (!isReminderContent(reminder) || reminder.version !== REMINDER_VERSION) {
        return undefined;
    }

    return {
        content: reminder.content,
        datetime: reminder.datetime,
        repeat: reminder.repeat as ReminderRepeat,
    };
};

export const getReminderFromEvent = (event: MatrixEvent): ReminderPayload | undefined => {
    const currentContent = event.getContent<RoomMessageEventContent>();
    const parsed = parseReminderContent(currentContent);
    if (parsed) return parsed;

    const originalContent = event.getOriginalContent<RoomMessageEventContent>();
    return parseReminderContent(originalContent);
};

const createReminderFallback = (reminder: ReminderPayload): string => {
    const date = new Date(reminder.datetime);
    const formattedDate = formatFullDateNoTime(date);
    const formattedTime = formatTime(date);

    return `Reminder: ${reminder.content} - ${formattedDate} ${formattedTime}`;
};

const createReminderDueFallback = (
    reminder: ReminderPayload,
    triggeredAt: string,
): string => {
    const occurrence = new Date(triggeredAt);
    const formattedDate = formatFullDateNoTime(occurrence);
    const formattedTime = formatTime(occurrence);

    return `Reminder due: ${reminder.content} - ${formattedDate} ${formattedTime}`;
};

const buildReminderContent = (reminder: ReminderPayload): ReminderMessageContent => ({
    msgtype: REMINDER_MSGTYPE,
    body: createReminderFallback(reminder),
    [REMINDER_CONTENT_KEY]: {
        version: REMINDER_VERSION,
        content: reminder.content,
        datetime: reminder.datetime,
        repeat: reminder.repeat,
    },
});

interface SendReminderOptions {
    threadId?: string | null;
    replacingEventId?: string;
}

export const sendReminderMessage = async (
    client: MatrixClient,
    roomId: string,
    reminder: ReminderPayload,
    { threadId = null, replacingEventId }: SendReminderOptions = {},
): Promise<void> => {
    const content = buildReminderContent(reminder);
    const payload: RoomMessageEventContent = replacingEventId
        ? ({
              ...content,
              "m.relates_to": {
                  rel_type: "m.replace",
                  event_id: replacingEventId,
              },
              "m.new_content": buildReminderContent(reminder),
          } as RoomMessageEventContent)
        : content;

    await doMaybeLocalRoomAction(
        roomId,
        (actualRoomId: string) => client.sendMessage(actualRoomId, threadId, payload),
        client,
    ).catch((error) => {
        logger.error("Failed to send reminder", error);
        throw error;
    });
};

const buildReminderDueContent = (
    reminder: ReminderPayload,
    triggeredAt: string,
    originalEventId?: string,
): ReminderDueMessageContent => ({
    msgtype: REMINDER_DUE_MSGTYPE,
    body: createReminderDueFallback(reminder, triggeredAt),
    [REMINDER_DUE_CONTENT_KEY]: {
        version: REMINDER_DUE_VERSION,
        content: reminder.content,
        datetime: reminder.datetime,
        repeat: reminder.repeat,
        triggered_at: triggeredAt,
        ...(originalEventId ? { original_event_id: originalEventId } : {}),
    },
});

const isReminderDueContent = (value: unknown): value is ReminderDueContent => {
    if (!value || typeof value !== "object") return false;
    const content = value as Partial<ReminderDueContent>;
    return (
        typeof content.version === "number" &&
        typeof content.content === "string" &&
        typeof content.datetime === "string" &&
        typeof content.repeat === "string" &&
        typeof content.triggered_at === "string"
    );
};

export const parseReminderDueContent = (
    content: RoomMessageEventContent | undefined,
): ReminderDuePayload | undefined => {
    if (!content) return undefined;

    const reminderDue = content[REMINDER_DUE_CONTENT_KEY];
    if (!isReminderDueContent(reminderDue) || reminderDue.version !== REMINDER_DUE_VERSION) {
        return undefined;
    }

    return {
        content: reminderDue.content,
        datetime: reminderDue.datetime,
        repeat: reminderDue.repeat as ReminderRepeat,
        triggeredAt: reminderDue.triggered_at,
        originalEventId: reminderDue.original_event_id,
    };
};

export const getReminderDueFromEvent = (event: MatrixEvent): ReminderDuePayload | undefined => {
    const currentContent = event.getContent<RoomMessageEventContent>();
    const parsed = parseReminderDueContent(currentContent);
    if (parsed) return parsed;

    const originalContent = event.getOriginalContent<RoomMessageEventContent>();
    return parseReminderDueContent(originalContent);
};

interface SendReminderDueOptions {
    threadId?: string | null;
    originalEventId?: string;
}

export const sendReminderDueMessage = async (
    client: MatrixClient,
    roomId: string,
    reminder: ReminderPayload,
    triggeredAt: Date,
    { threadId = null, originalEventId }: SendReminderDueOptions = {},
): Promise<void> => {
    const content = buildReminderDueContent(reminder, triggeredAt.toISOString(), originalEventId);

    await doMaybeLocalRoomAction(
        roomId,
        (actualRoomId: string) => client.sendMessage(actualRoomId, threadId, content),
        client,
    ).catch((error) => {
        logger.error("Failed to send reminder due notification", error);
        throw error;
    });
};
