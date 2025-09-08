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

// Hàm helper để format thông tin tìm kiếm với tiếng Việt
function formatSearchSummary(
    count: number, 
    term: string, 
    senders: Array<[string, {member: any, name: string}]> = []
): React.ReactNode {
    // Kiểm tra xem có phải tìm kiếm theo sender không
    const senderMatch = term.match(/sender:([^\s]+)(?:\s+(.*))?/);
    
    if (senderMatch) {
        const senderId = senderMatch[1];
        const keyword = senderMatch[2]?.trim();
        
        // Tìm tên hiển thị của sender
        const senderInfo = senders.find(([id]) => id === senderId);
        const senderName = senderInfo ? senderInfo[1].name : senderId;
        
        if (keyword) {
            // Có cả sender filter và keyword
            return (
                <span>
                    Tìm thấy <strong>{count}</strong> tin nhắn từ <strong>{senderName}</strong> chứa "<strong>{keyword}</strong>"
                </span>
            );
        } else {
            // Chỉ có sender filter
            return (
                <span>
                    Tìm thấy <strong>{count}</strong> tin nhắn từ <strong>{senderName}</strong>
                </span>
            );
        }
    } else if (term) {
        // Tìm kiếm thông thường theo keyword
        return (
            <span>
                Tìm thấy <strong>{count}</strong> tin nhắn chứa "<strong>{term}</strong>"
            </span>
        );
    } else {
        // Không có từ khóa tìm kiếm
        return (
            <span>
                Tìm thấy <strong>{count}</strong> tin nhắn
            </span>
        );
    }
}

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
                            formatSearchSummary(searchInfo.count, searchInfo.term || "", senders)
                        ) : searchInfo?.error !== undefined ? (
                            <span style={{ color: "var(--cpd-color-text-critical)" }}>
                                Lỗi tìm kiếm: {searchInfo?.error.message}
                            </span>
                        ) : (
                            <span>
                                <InlineSpinner /> Đang tìm kiếm...
                            </span>
                        )}
                        <SearchWarning kind={WarningKind.Search} isRoomEncrypted={isRoomEncrypted} showLogo={false} />
                    </div>
                </div>
                <div className="mx_RoomSearchAuxPanel_buttons">
                    {/* Giao diện lọc theo người gửi - hiển thị ngay cả khi không có từ khóa tìm kiếm */}
                    {onSenderChange && (
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
                                        Đang tải...
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
                            ? "Tìm trong phòng này"
                            : "Tìm trong tất cả phòng"}
                    </Link>
                    <IconButton
                        onClick={onCancelClick}
                        destructive
                        tooltip="Hủy"
                        aria-label="Hủy tìm kiếm"
                    >
                        <CloseIcon width="20px" height="20px" />
                    </IconButton>
                </div>
            </div>
        </>
    );
};

export default RoomSearchAuxPanel;
