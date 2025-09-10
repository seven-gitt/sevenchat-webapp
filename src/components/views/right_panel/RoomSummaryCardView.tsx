/*
Copyright 2024, 2025 New Vector Ltd.
Copyright 2020 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useEffect, useState, useRef, type JSX } from "react";
import classNames from "classnames";
import {
    MenuItem,
    Separator,
    ToggleMenuItem,
    Text,
    Badge,
    Heading,
    IconButton,
    Link,
    Search,
    Form,
} from "@vector-im/compound-web";
import FavouriteIcon from "@vector-im/compound-design-tokens/assets/web/icons/favourite";
import UserAddIcon from "@vector-im/compound-design-tokens/assets/web/icons/user-add";
import FilterIcon from "@vector-im/compound-design-tokens/assets/web/icons/filter";
// import CloseIcon from "@vector-im/compound-design-tokens/assets/web/icons/close";
import LinkIcon from "@vector-im/compound-design-tokens/assets/web/icons/link";
import SettingsIcon from "@vector-im/compound-design-tokens/assets/web/icons/settings";
import ExportArchiveIcon from "@vector-im/compound-design-tokens/assets/web/icons/export-archive";
import LeaveIcon from "@vector-im/compound-design-tokens/assets/web/icons/leave";
import FilesIcon from "@vector-im/compound-design-tokens/assets/web/icons/files";
import UserProfileIcon from "@vector-im/compound-design-tokens/assets/web/icons/user-profile";
import ThreadsIcon from "@vector-im/compound-design-tokens/assets/web/icons/threads";
import PollsIcon from "@vector-im/compound-design-tokens/assets/web/icons/polls";
import PinIcon from "@vector-im/compound-design-tokens/assets/web/icons/pin";
import LockIcon from "@vector-im/compound-design-tokens/assets/web/icons/lock-solid";
import PublicIcon from "@vector-im/compound-design-tokens/assets/web/icons/public";
import ErrorSolidIcon from "@vector-im/compound-design-tokens/assets/web/icons/error-solid";
import ChevronDownIcon from "@vector-im/compound-design-tokens/assets/web/icons/chevron-down";
import DeleteIcon from "@vector-im/compound-design-tokens/assets/web/icons/delete";
import { JoinRule, type Room } from "matrix-js-sdk/src/matrix";

import BaseCard from "./BaseCard";
import { _t } from "../../../languageHandler";
import RoomAvatar from "../avatars/RoomAvatar";
import MemberAvatar from "../avatars/MemberAvatar";
import { E2EStatus } from "../../../utils/ShieldUtils";
import { type RoomPermalinkCreator } from "../../../utils/permalinks/Permalinks";
import RoomName from "../elements/RoomName";
import { Flex } from "../../utils/Flex";
import { Linkify, topicToHtml } from "../../../HtmlUtils";
import { Box } from "../../utils/Box";
import { ReleaseAnnouncement } from "../../structures/ReleaseAnnouncement";
import { useRoomSummaryCardViewModel } from "../../viewmodels/right_panel/RoomSummaryCardViewModel";
import { useRoomTopicViewModel } from "../../viewmodels/right_panel/RoomSummaryCardTopicViewModel";

interface IProps {
    room: Room;
    permalinkCreator: RoomPermalinkCreator;
    onSearchChange?: (term: string) => void;
    onSearchCancel?: () => void;
    focusRoomSearch?: boolean;
    searchTerm?: string;
    onInitializeFilter?: () => void;
    selectedSender?: string;
}

const RoomTopic: React.FC<Pick<IProps, "room">> = ({ room }): JSX.Element | null => {
    const vm = useRoomTopicViewModel(room);

    const body = topicToHtml(vm.topic?.text, vm.topic?.html);

    if (!body && !vm.canEditTopic) {
        return null;
    }

    if (!body) {
        return (
            <Flex
                as="section"
                direction="column"
                justify="center"
                gap="var(--cpd-space-2x)"
                className="mx_RoomSummaryCard_topic"
            >
                <Box flex="1">
                    <Link kind="primary" onClick={vm.onEditClick}>
                        <Text size="sm" weight="regular">
                            {_t("right_panel|add_topic")}
                        </Text>
                    </Link>
                </Box>
            </Flex>
        );
    }

    const content = vm.expanded ? <Linkify>{body}</Linkify> : body;

    return (
        <Flex
            as="section"
            direction="column"
            justify="center"
            gap="var(--cpd-space-2x)"
            className={classNames("mx_RoomSummaryCard_topic", {
                mx_RoomSummaryCard_topic_collapsed: !vm.expanded,
            })}
        >
            <Box flex="1" className="mx_RoomSummaryCard_topic_container">
                <Text size="sm" weight="regular" onClick={vm.onTopicLinkClick}>
                    {content}
                </Text>
                <IconButton className="mx_RoomSummaryCard_topic_chevron" size="24px" onClick={vm.onExpandedClick}>
                    <ChevronDownIcon />
                </IconButton>
            </Box>
            {vm.expanded && vm.canEditTopic && (
                <Box flex="1" className="mx_RoomSummaryCard_topic_edit">
                    <Link kind="primary" onClick={vm.onEditClick}>
                        <Text size="sm" weight="regular">
                            {_t("action|edit")}
                        </Text>
                    </Link>
                </Box>
            )}
        </Flex>
    );
};

const RoomSummaryCardView: React.FC<IProps> = ({
    room,
    permalinkCreator,
    onSearchChange,
    onSearchCancel,
    focusRoomSearch,
    searchTerm = "",
    onInitializeFilter,
    selectedSender,
}) => {
    const vm = useRoomSummaryCardViewModel(room, permalinkCreator, onSearchCancel, onSearchChange, () => setShowUserFilter(false));

    // The search field is controlled and onSearchChange is debounced in RoomView,
    // so we need to set the value of the input right away
    const [searchValue, setSearchValue] = useState(searchTerm);
    const [showUserFilter, setShowUserFilter] = useState(false);
    
    // Ref để track focus state
    const lastFocusState = useRef(false);
    

    useEffect(() => {
        // Lưu lại focus state trước khi update
        const wasInputFocused = vm.searchInputRef.current === document.activeElement;
        
        // Không hiển thị "sender:..." trong ô tìm kiếm khi lọc theo người gửi
        if (searchTerm?.startsWith?.('sender:')) {
            // Tách keyword từ sender: term để hiển thị trong input
            const parts = searchTerm.split(/\s+/);
            const senderPart = parts.find(p => p.startsWith('sender:'));
            const keywordParts = parts.filter(p => p !== senderPart);
            const keyword = keywordParts.join(' ');
            setSearchValue(keyword);
        } else {
            setSearchValue(searchTerm);
        }
        
        // Khôi phục focus nếu input đang được focus trước đó
        if (wasInputFocused) {
            // Sử dụng setTimeout để đảm bảo DOM đã được update
            setTimeout(() => {
                vm.searchInputRef.current?.focus();
            }, 0);
        }
        
        // Lưu focus state cho lần render tiếp theo
        lastFocusState.current = wasInputFocused;
    }, [searchTerm, vm.searchInputRef]);
    
    // Effect để bảo vệ focus khi component re-render do các props khác
    useEffect(() => {
        // Kiểm tra xem có phải input đang được focus không
        const isInputFocused = vm.searchInputRef.current === document.activeElement;
        
        // Nếu input đã mất focus nhưng trước đó đang được focus, khôi phục lại
        if (!isInputFocused && lastFocusState.current) {
            setTimeout(() => {
                if (vm.searchInputRef.current && document.activeElement !== vm.searchInputRef.current) {
                    vm.searchInputRef.current.focus();
                }
            }, 10);
        }
        
        // Cập nhật focus state
        lastFocusState.current = isInputFocused;
    });

    // Đóng dropdown khi click bên ngoài
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (showUserFilter) {
                const target = event.target as Element;
                if (!target.closest('.mx_RoomSummaryCard_search_container')) {
                    setShowUserFilter(false);
                }
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [showUserFilter]);


    // Lấy danh sách user trong phòng
    const getRoomUsers = () => {
        const members = room.getMembers();
        return members
            .filter(member => member.membership === 'join' || member.membership === 'invite')
            .map(member => ({
                id: member.userId,
                name: member.name || member.userId,
                avatar: member.getMxcAvatarUrl()
            }));
    };

    // Xử lý khi chọn user
    const handleUserSelect = (userId: string) => {
        setShowUserFilter(false);
        // Kết hợp keyword hiện tại với sender filter
        if (onSearchChange) {
            const currentKeyword = searchValue.trim();
            const newTerm = currentKeyword ? `sender:${userId} ${currentKeyword}` : `sender:${userId}`;
            onSearchChange(newTerm);
        }
    };

    // Xử lý khi bỏ chọn user
    // const handleClearUserFilter = () => {
    //     if (onSearchCancel) {
    //         onSearchCancel();
    //     }
    // };

    const roomInfo = (
        <header className="mx_RoomSummaryCard_container">
            <RoomAvatar room={room} size="80px" viewAvatarOnClick />
            <RoomName room={room}>
                {(name) => (
                    <Heading
                        as="h1"
                        size="md"
                        weight="semibold"
                        className="mx_RoomSummaryCard_roomName text-primary"
                        title={name}
                    >
                        {name}
                    </Heading>
                )}
            </RoomName>
            <Text
                as="div"
                size="sm"
                weight="semibold"
                className="mx_RoomSummaryCard_alias text-secondary"
                title={vm.alias}
            >
                {vm.alias}
            </Text>

            <Flex as="section" justify="center" gap="var(--cpd-space-2x)" className="mx_RoomSummaryCard_badges">
                {!vm.isDirectMessage && vm.roomJoinRule === JoinRule.Public && (
                    <Badge kind="grey">
                        <PublicIcon width="1em" />
                        {_t("common|public_room")}
                    </Badge>
                )}

                {vm.isRoomEncrypted && vm.e2eStatus !== E2EStatus.Warning && (
                    <Badge kind="green">
                        <LockIcon width="1em" />
                        {_t("common|encrypted")}
                    </Badge>
                )}

                {/* Ẩn badge "Không được mã hóa" */}
                {/* {!vm.isRoomEncrypted && (
                    <Badge kind="grey">
                        <LockOffIcon width="1em" />
                        {_t("common|unencrypted")}
                    </Badge>
                )} */}

                {vm.e2eStatus === E2EStatus.Warning && (
                    <Badge kind="red">
                        <ErrorSolidIcon width="1em" />
                        {_t("common|not_trusted")}
                    </Badge>
                )}
            </Flex>

            <RoomTopic room={room} />
        </header>
    );

    const header = onSearchChange && (
        <div className="mx_RoomSummaryCard_search_container" style={{ position: "relative" }}>
            <Form.Root className="mx_RoomSummaryCard_search" onSubmit={(e) => e.preventDefault()}>
                <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
                    <Search
                        placeholder={_t("room|search|placeholder")}
                        name="room_message_search"
                        onChange={(e) => {
                            const raw = e.currentTarget.value;
                            setSearchValue(raw);
                            // Nếu đang chọn một người gửi, luôn kết hợp thành truy vấn duy nhất
                            const term = selectedSender && selectedSender !== "all"
                                ? `sender:${selectedSender}${raw ? ` ${raw}` : ""}`
                                : raw;
                            // Handle search term change
                            onSearchChange(term);
                        }}
                        value={searchValue}
                        className="mx_no_textinput"
                        ref={vm.searchInputRef}
                        autoFocus={focusRoomSearch}
                        onKeyDown={vm.onUpdateSearchInput}
                        style={{ 
                            paddingRight: "40px", // Tạo không gian cho nút filter
                            flex: 1
                        }}
                    />
                    
                    {/* Icon lọc user bên trong ô tìm kiếm */}
                    <div style={{ 
                        position: "absolute", 
                        right: "8px", 
                        top: "50%", 
                        transform: "translateY(-50%)",
                        zIndex: 1
                    }}>
                        <IconButton
                            onClick={() => setShowUserFilter(!showUserFilter)}
                            size="sm"
                            kind={selectedSender && selectedSender !== "all" ? "primary" : "secondary"}
                            tooltip="Lọc tin nhắn theo người gửi"
                            aria-label="Lọc tin nhắn theo người gửi"
                            style={{
                                width: "24px",
                                height: "24px",
                                minWidth: "24px",
                                padding: "0"
                            }}
                        >
                            <FilterIcon width="14px" height="14px" />
                        </IconButton>
                    </div>
                </div>
            </Form.Root>
            
            {/* Dropdown danh sách user */}
            {showUserFilter && (
                <div style={{
                    position: "absolute",
                    top: "100%",
                    left: 0,
                    right: 0,
                    backgroundColor: "var(--cpd-color-bg-canvas-default)",
                    border: "2px solid var(--cpd-color-border-interactive-secondary)",
                    borderRadius: "16px",
                    boxShadow: "0 12px 32px rgba(0, 0, 0, 0.3), 0 4px 16px rgba(0, 0, 0, 0.2)",
                    zIndex: 1000,
                    maxHeight: "350px",
                    overflowY: "auto",
                    marginTop: "8px",
                    backdropFilter: "blur(12px)"
                }}>
                    
                    <div style={{ padding: "16px 0" }}>
                        {getRoomUsers().map((user, index) => (
                            <div
                                key={user.id}
                                onClick={() => handleUserSelect(user.id)}
                                style={{
                                    padding: "16px 24px",
                                    cursor: "pointer",
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "16px",
                                    backgroundColor: selectedSender === user.id ? "var(--cpd-color-bg-accent-primary)" : "transparent",
                                    transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
                                    position: "relative",
                                    margin: "0 12px",
                                    borderRadius: "12px",
                                    border: selectedSender === user.id ? "2px solid var(--cpd-color-border-accent)" : "2px solid transparent"
                                }}
                                onMouseEnter={(e) => {
                                    if (selectedSender !== user.id) {
                                        e.currentTarget.style.backgroundColor = "var(--cpd-color-bg-subtle-secondary)";
                                        e.currentTarget.style.transform = "translateX(4px)";
                                        e.currentTarget.style.border = "2px solid var(--cpd-color-border-interactive-secondary)";
                                    }
                                }}
                                onMouseLeave={(e) => {
                                    if (selectedSender !== user.id) {
                                        e.currentTarget.style.backgroundColor = "transparent";
                                        e.currentTarget.style.transform = "translateX(0)";
                                        e.currentTarget.style.border = "2px solid transparent";
                                    }
                                }}
                            >
                                {/* Avatar thực tế của user */}
                                <div style={{
                                    position: "relative",
                                    width: "48px",
                                    height: "48px",
                                    borderRadius: "50%",
                                    overflow: "hidden",
                                    boxShadow: selectedSender === user.id 
                                        ? "0 6px 16px var(--cpd-color-border-accent-alpha-20)" 
                                        : "0 3px 8px rgba(0, 0, 0, 0.15)",
                                    transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
                                    border: selectedSender === user.id 
                                        ? "2px solid var(--cpd-color-border-accent)" 
                                        : "2px solid transparent"
                                }}>
                                    <MemberAvatar
                                        member={room.getMember(user.id)}
                                        size="48px"
                                        hideTitle={true}
                                    />
                                    {/* Hiệu ứng shimmer cho avatar được chọn */}
                                    {selectedSender === user.id && (
                                        <div style={{
                                            position: "absolute",
                                            top: 0,
                                            left: "-100%",
                                            width: "100%",
                                            height: "100%",
                                            background: "linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.3), transparent)",
                                            animation: "shimmer 2s infinite",
                                            pointerEvents: "none"
                                        }}></div>
                                    )}
                                </div>
                                
                                {/* Thông tin user */}
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ 
                                        fontSize: "16px", 
                                        fontWeight: selectedSender === user.id ? "700" : "600",
                                        color: selectedSender === user.id ? "var(--cpd-color-text-accent-primary)" : "var(--cpd-color-text-primary)",
                                        marginBottom: "4px",
                                        whiteSpace: "nowrap",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis"
                                    }}>
                                        {user.name}
                                    </div>
                                    <div style={{ 
                                        fontSize: "13px", 
                                        color: selectedSender === user.id ? "var(--cpd-color-text-accent-primary)" : "var(--cpd-color-text-secondary)",
                                        whiteSpace: "nowrap",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        fontWeight: "500"
                                    }}>
                                        {user.id}
                                    </div>
                                </div>
                                
                                {/* Indicator cho user được chọn */}
                                {selectedSender && selectedSender !== "all" && selectedSender === user.id && (
                                    <div style={{
                                        width: "12px",
                                        height: "12px",
                                        borderRadius: "50%",
                                        backgroundColor: "var(--cpd-color-bg-success-primary)",
                                        boxShadow: `0 0 0 3px var(--cpd-color-bg-canvas-default), 0 0 0 6px var(--cpd-color-bg-success-primary)`,
                                        animation: "pulse 2s infinite"
                                    }}></div>
                                )}
                            </div>
                        ))}
                    </div>
                    
                    {/* Footer với thông tin */}
                    <div style={{
                        padding: "16px 24px",
                        borderTop: "2px solid var(--cpd-color-border-subtle)",
                        backgroundColor: "var(--cpd-color-bg-subtle-secondary)",
                        borderRadius: "0 0 16px 16px",
                        textAlign: "center"
                    }}>
                        <div style={{
                            fontSize: "13px",
                            color: "var(--cpd-color-text-secondary)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            gap: "8px",
                            fontWeight: "600"
                        }}>
                            <div style={{
                                width: "6px",
                                height: "6px",
                                borderRadius: "50%",
                                backgroundColor: "#28a745",
                                boxShadow: "0 0 4px rgba(40, 167, 69, 0.5)"
                            }}></div>
                            {getRoomUsers().length} thành viên trong phòng
                        </div>
                    </div>
                </div>
            )}
        </div>
    );

    return (
        <>
            {/* CSS Animations */}
            <style>
                {`
                    @keyframes shimmer {
                        0% { left: -100%; }
                        100% { left: 100%; }
                    }
                    
                    @keyframes pulse {
                        0%, 100% { 
                            transform: scale(1);
                            opacity: 1;
                        }
                        50% { 
                            transform: scale(1.1);
                            opacity: 0.8;
                        }
                    }
                `}
            </style>
            
            <BaseCard
                id="room-summary-panel"
                className="mx_RoomSummaryCard"
                ariaLabelledBy="room-summary-panel-tab"
                role="tabpanel"
                header={header}
            >
            {roomInfo}

            <Separator />

            <div role="menubar" aria-orientation="vertical">
                <ToggleMenuItem
                    Icon={FavouriteIcon}
                    label={_t("room|context_menu|favourite")}
                    checked={vm.isFavorite}
                    onSelect={vm.onFavoriteToggleClick}
                />
                <MenuItem
                    Icon={UserAddIcon}
                    label={_t("action|invite")}
                    disabled={!vm.canInviteToState}
                    onSelect={vm.onInviteToRoomClick}
                />

                <Separator />

                <MenuItem Icon={UserProfileIcon} label={_t("common|people")} onSelect={vm.onRoomMembersClick} />
                <MenuItem Icon={ThreadsIcon} label={_t("common|threads")} onSelect={vm.onRoomThreadsClick} />
                {!vm.isVideoRoom && (
                    <>
                        <ReleaseAnnouncement
                            feature="pinningMessageList"
                            header={_t("right_panel|pinned_messages|release_announcement|title")}
                            description={_t("right_panel|pinned_messages|release_announcement|description")}
                            closeLabel={_t("right_panel|pinned_messages|release_announcement|close")}
                            placement="top"
                        >
                            <div>
                                <MenuItem
                                    Icon={PinIcon}
                                    label={_t("right_panel|pinned_messages_button")}
                                    onSelect={vm.onRoomPinsClick}
                                >
                                    <Text as="span" size="sm">
                                        {vm.pinCount}
                                    </Text>
                                </MenuItem>
                            </div>
                        </ReleaseAnnouncement>
                        <MenuItem
                            Icon={FilesIcon}
                            label={_t("right_panel|files_button")}
                            onSelect={vm.onRoomFilesClick}
                        />
                        <MenuItem
                            Icon={LinkIcon}
                            label="Link"
                            onSelect={vm.onRoomUrlsClick}
                        />
                        {/* Extensions hidden */}
                    </>
                )}

                <Separator />
                {/* Copy link hidden */}

                {!vm.isVideoRoom && (
                    <>
                        <MenuItem
                            Icon={PollsIcon}
                            label={_t("right_panel|polls_button")}
                            onSelect={vm.onRoomPollHistoryClick}
                        />
                        <MenuItem
                            Icon={ExportArchiveIcon}
                            label={_t("export_chat|title")}
                            onSelect={vm.onRoomExportClick}
                        />
                    </>
                )}

                <MenuItem Icon={SettingsIcon} label={_t("common|settings")} onSelect={vm.onRoomSettingsClick} />

                <Separator />
                <div className="mx_RoomSummaryCard_bottomOptions">
                    {/* <MenuItem
                        Icon={ErrorIcon}
                        kind="critical"
                        label={_t("action|report_room")}
                        onSelect={vm.onReportRoomClick}
                    /> */}
                    {vm.canDeleteRoom && (
                        <MenuItem
                            className="mx_RoomSummaryCard_delete"
                            Icon={DeleteIcon}
                            kind="critical"
                            label={_t("action|delete_room")}
                            onSelect={vm.onDeleteRoomClick}
                        />
                    )}
                    <MenuItem
                        className="mx_RoomSummaryCard_leave"
                        Icon={LeaveIcon}
                        kind="critical"
                        label={_t("action|leave_room")}
                        onSelect={vm.onLeaveRoomClick}
                    />
                </div>
            </div>
        </BaseCard>
        </>
    );
};

export default RoomSummaryCardView;
