/*
Copyright 2024 New Vector Ltd.
Copyright 2024 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useRef, useImperativeHandle, forwardRef } from "react";
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
        
        // Tìm tên hiển thị của sender từ danh sách senders
        const senderInfo = senders.find(([id]) => id === senderId);
        let senderName = senderId; // fallback to senderId
        
        if (senderInfo && senderInfo[1].name) {
            senderName = senderInfo[1].name;
        } else {
            // Nếu không tìm thấy trong senders list, thử lấy từ senderId
            // Loại bỏ domain để hiển thị ngắn gọn hơn
            const localPart = senderId.split(':')[0];
            if (localPart.startsWith('@')) {
                senderName = localPart.substring(1); // Bỏ ký tự @
            }
        }
        
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
    onRemoveSenderFilter?: () => void;
}

export interface RoomSearchAuxPanelRef {
    closeDropdown(): void;
}

const RoomSearchAuxPanel = forwardRef<RoomSearchAuxPanelRef, Props>(({ 
    searchInfo, 
    isRoomEncrypted, 
    onSearchScopeChange, 
    onCancelClick,
    senders = [],
    selectedSender = "all",
    onSenderChange,
    onRemoveSenderFilter
}, ref) => {
    const scope = searchInfo?.scope ?? SearchScope.Room;
    const selectRef = useRef<HTMLSelectElement>(null);

    useImperativeHandle(ref, () => ({
        closeDropdown: () => {
            if (selectRef.current) {
                selectRef.current.blur();
            }
        }
    }));

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
                            
                            {/* Hiển thị tag với nút X khi đã chọn user cụ thể */}
                            {selectedSender && selectedSender !== "all" ? (
                                <div style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "6px",
                                    padding: "6px 10px",
                                    backgroundColor: "var(--cpd-color-bg-subtle)",
                                    border: "1px solid var(--cpd-color-border-interactive)",
                                    borderRadius: "6px",
                                    fontSize: "13px",
                                    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.1)"
                                }}>
                                    <span style={{ color: "var(--cpd-color-text-primary)" }}>
                                        {(() => {
                                            const senderInfo = senders.find(([id]) => id === selectedSender);
                                            if (senderInfo && senderInfo[1].name) {
                                                return senderInfo[1].name;
                                            }
                                            // Fallback: lấy local part của userId
                                            const localPart = selectedSender.split(':')[0];
                                            return localPart.startsWith('@') ? localPart.substring(1) : localPart;
                                        })()}
                                    </span>
                                    <button
                                        onClick={onRemoveSenderFilter}
                                        style={{
                                            background: "none",
                                            border: "none",
                                            color: "var(--cpd-color-text-secondary)",
                                            cursor: "pointer",
                                            padding: "2px",
                                            fontSize: "14px",
                                            fontWeight: "bold",
                                            lineHeight: "1",
                                            display: "flex",
                                            alignItems: "center",
                                            justifyContent: "center",
                                            width: "20px",
                                            height: "20px",
                                            borderRadius: "3px",
                                            transition: "all 0.2s ease"
                                        }}
                                        onMouseEnter={(e) => {
                                            e.currentTarget.style.backgroundColor = "var(--cpd-color-bg-critical-subtle)";
                                            e.currentTarget.style.color = "var(--cpd-color-text-critical)";
                                            e.currentTarget.style.transform = "scale(1.1)";
                                        }}
                                        onMouseLeave={(e) => {
                                            e.currentTarget.style.backgroundColor = "transparent";
                                            e.currentTarget.style.color = "var(--cpd-color-text-secondary)";
                                            e.currentTarget.style.transform = "scale(1)";
                                        }}
                                        title="Tắt lọc theo user này"
                                    >
                                        ×
                                    </button>
                                </div>
                            ) : (
                                <select
                                    ref={selectRef}
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
                            )}
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
});

RoomSearchAuxPanel.displayName = "RoomSearchAuxPanel";

export default RoomSearchAuxPanel;
