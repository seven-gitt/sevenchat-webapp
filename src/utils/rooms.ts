/*
Copyright 2024 New Vector Ltd.
Copyright 2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import { shouldForceDisableEncryption } from "./crypto/shouldForceDisableEncryption";
import { getE2EEWellKnown } from "./WellKnownUtils";

export function privateShouldBeEncrypted(client: MatrixClient): boolean {
    // Đã chỉnh sửa: Luôn trả về false để phòng mới không tự động bật mã hóa
    return false;
}
