/*
Copyright 2024 New Vector Ltd.
Copyright 2024 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React from "react";
import SearchIcon from "@vector-im/compound-design-tokens/assets/web/icons/search";
import CloseIcon from "@vector-im/compound-design-tokens/assets/web/icons/close";
import { IconButton, Link } from "@vector-im/compound-web";

import { _t } from "../../../languageHandler";
import { PosthogScreenTracker } from "../../../PosthogTrackers";
import SearchWarning, { WarningKind } from "../elements/SearchWarning";
import { type SearchInfo, SearchScope } from "../../../Searching";
import InlineSpinner from "../elements/InlineSpinner";

interface Props {
    searchInfo?: SearchInfo;
    isRoomEncrypted: boolean;
    onSearchScopeChange(scope: SearchScope): void;
    onCancelClick(): void;
    // Props cho giao diện lọc theo người gửi
    senders?: Array<[string, {member: any, name: string}]>;
    selectedSender?: string;
    onSenderChange?: (senderId: string) => void;
}

const RoomSearchAuxPanel: React.FC<Props> = ({ 
    searchInfo, 
    isRoomEncrypted, 
    onSearchScopeChange, 
    onCancelClick,
    senders = [],
    selectedSender = "all",
    onSenderChange
}) => {
    const scope = searchInfo?.scope ?? SearchScope.Room;

    return (
        <>
            <PosthogScreenTracker screenName="RoomSearch" />
            <div className="mx_RoomSearchAuxPanel">
                <div className="mx_RoomSearchAuxPanel_summary">
                    <SearchIcon width="24px" height="24px" />
                    <div className="mx_RoomSearchAuxPanel_summary_text">
                        {searchInfo?.count !== undefined ? (
                            _t(
                                "room|search|summary",
                                { count: searchInfo.count },
                                { query: () => <strong>{searchInfo.term}</strong> },
                            )
                        ) : searchInfo?.error !== undefined ? (
                            searchInfo?.error.message
                        ) : (
                            <InlineSpinner />
                        )}
                        <SearchWarning kind={WarningKind.Search} isRoomEncrypted={isRoomEncrypted} showLogo={false} />
                    </div>
                </div>
                <div className="mx_RoomSearchAuxPanel_buttons">
                    {/* Giao diện lọc theo người gửi */}
                    {searchInfo?.term && onSenderChange && (
                        <div style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            marginRight: "12px"
                        }}>
                            <span style={{
                                fontSize: "14px",
                                color: "var(--cpd-color-text-secondary)",
                                whiteSpace: "nowrap"
                            }}>
                                Lọc theo:
                            </span>
                            <select
                                value={selectedSender}
                                onChange={(e) => onSenderChange(e.target.value)}
                                style={{
                                    padding: "4px 8px",
                                    border: "1px solid var(--cpd-color-border-interactive)",
                                    borderRadius: "4px",
                                    backgroundColor: "var(--cpd-color-bg-canvas)",
                                    color: "var(--cpd-color-text-primary)",
                                    fontSize: "13px",
                                    minWidth: "120px",
                                    cursor: "pointer"
                                }}
                            >
                                <option value="all">Tất cả</option>
                                {senders.length > 0 ? (
                                    senders.map(([senderId, {name}]) => (
                                        <option key={senderId} value={senderId}>
                                            {name}
                                        </option>
                                    ))
                                ) : (
                                    <option value="all" disabled>
                                        Đang tìm kiếm...
                                    </option>
                                )}
                            </select>
                        </div>
                    )}
                    
                    <Link
                        onClick={() =>
                            onSearchScopeChange(scope === SearchScope.Room ? SearchScope.All : SearchScope.Room)
                        }
                        kind="primary"
                    >
                        {scope === SearchScope.All
                            ? _t("room|search|this_room_button")
                            : _t("room|search|all_rooms_button")}
                    </Link>
                    <IconButton
                        onClick={onCancelClick}
                        destructive
                        tooltip={_t("action|cancel")}
                        aria-label={_t("action|cancel")}
                    >
                        <CloseIcon width="20px" height="20px" />
                    </IconButton>
                </div>
            </div>
        </>
    );
};

export default RoomSearchAuxPanel;
