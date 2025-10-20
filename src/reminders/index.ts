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

interface ReminderContent extends ReminderPayload {
    version: number;
}

export type ReminderMessageContent = RoomMessageEventContent & {
    msgtype: typeof REMINDER_MSGTYPE;
    body: string;
    [REMINDER_CONTENT_KEY]: ReminderContent;
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