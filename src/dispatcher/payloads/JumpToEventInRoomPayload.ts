/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { Action } from "../actions";
import { type ActionPayload } from "../payloads";

export interface JumpToEventInRoomPayload extends ActionPayload {
    action: Action.JumpToEventInRoom;

    room_id: string;
    event_id: string;
    highlighted?: boolean;
    scroll_into_view?: boolean;
}
