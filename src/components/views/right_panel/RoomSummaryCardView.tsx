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
import { MatrixClientPeg } from "../../../MatrixClientPeg";
import { Direction } from "matrix-js-sdk/src/matrix";
import dispatcher from "../../../dispatcher/dispatcher";
import { Action } from "../../../dispatcher/actions";
import { SdkContextClass } from "../../../contexts/SDKContext";
import RoomScrollStateStore from "../../../stores/RoomScrollStateStore";

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
    const [showDateFilter, setShowDateFilter] = useState(false);
    const [selectedDate, setSelectedDate] = useState<string>("");
    const [calendarYear, setCalendarYear] = useState<number>(new Date().getFullYear());
    const [calendarMonth, setCalendarMonth] = useState<number>(new Date().getMonth()); // 0-11

    const daysOfWeek = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"]; // Vietnamese labels
    const monthNames = [
        "Thg 1", "Thg 2", "Thg 3", "Thg 4", "Thg 5", "Thg 6",
        "Thg 7", "Thg 8", "Thg 9", "Thg 10", "Thg 11", "Thg 12",
    ];

    const toISODate = (d: Date): string => {
        const year = `${d.getFullYear()}`.padStart(4, "0");
        const month = `${d.getMonth() + 1}`.padStart(2, "0");
        const day = `${d.getDate()}`.padStart(2, "0");
        return `${year}-${month}-${day}`;
    };

    const getCalendarCells = (): Array<{ date: Date | null; isToday: boolean; isSelected: boolean; isFuture: boolean }[]> => {
        const firstOfMonth = new Date(calendarYear, calendarMonth, 1);
        const startDay = (firstOfMonth.getDay() + 6) % 7; // convert Sun(0) -> 6, Mon(1) -> 0
        const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
        const todayISO = toISODate(new Date());
        const selectedISO = selectedDate || "";
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const cells: Array<{ date: Date | null; isToday: boolean; isSelected: boolean; isFuture: boolean }[]> = [];
        let currentRow: { date: Date | null; isToday: boolean; isSelected: boolean; isFuture: boolean }[] = [];

        // leading blanks
        for (let i = 0; i < startDay; i++) {
            currentRow.push({ date: null, isToday: false, isSelected: false, isFuture: false });
        }

        for (let day = 1; day <= daysInMonth; day++) {
            const date = new Date(calendarYear, calendarMonth, day);
            const iso = toISODate(date);
            const isFuture = new Date(date.getFullYear(), date.getMonth(), date.getDate()) > today;
            currentRow.push({ date, isToday: iso === todayISO, isSelected: iso === selectedISO, isFuture });
            if (currentRow.length === 7) {
                cells.push(currentRow);
                currentRow = [];
            }
        }
        // trailing blanks
        if (currentRow.length) {
            while (currentRow.length < 7) currentRow.push({ date: null, isToday: false, isSelected: false, isFuture: false });
            cells.push(currentRow);
        }
        return cells;
    };

    const goPrevMonth = (): void => {
        const d = new Date(calendarYear, calendarMonth - 1, 1);
        setCalendarYear(d.getFullYear());
        setCalendarMonth(d.getMonth());
    };
    const goNextMonth = (): void => {
        const d = new Date(calendarYear, calendarMonth + 1, 1);
        setCalendarYear(d.getFullYear());
        setCalendarMonth(d.getMonth());
    };

    const jumpToDate = async (inputDate: Date): Promise<void> => {
        try {
            const cli = MatrixClientPeg.safeGet();
            const unixTimestamp = inputDate.getTime();
            const roomIdForJumpRequest = room.roomId;
            const { event_id: eventId } = await cli.timestampToEvent(roomIdForJumpRequest, unixTimestamp, Direction.Forward);

            const currentRoomId = SdkContextClass.instance.roomViewStore.getRoomId();
            if (currentRoomId === roomIdForJumpRequest) {
                // Thoát chế độ tìm kiếm (nếu đang bật) để đảm bảo nhảy trên timeline chính
                onSearchCancel?.();
                // Đánh dấu để mở lại dropdown sau khi timeline re-render (RightPanel có thể remount)
                (window as any).__reopenDateDropdown = true;
                // Lưu pixelOffset mong muốn; sẽ tinh chỉnh lại bằng DOM ngay sau khi render
                RoomScrollStateStore.setScrollState(roomIdForJumpRequest, { focussedEvent: eventId, pixelOffset: 0 });
                dispatcher.dispatch({
                    action: Action.ViewRoom,
                    event_id: eventId,
                    highlighted: true,
                    scroll_into_view: true,
                    room_id: roomIdForJumpRequest,
                    metricsTrigger: undefined,
                });

                // Căn chính xác header ngày tương ứng với eventId vừa nhảy đến
                const alignHeader = () => {
                    const scrollNode = document.querySelector('.mx_ScrollPanel') as HTMLElement | null;
                    const targetNode = document.querySelector(`[data-scroll-token="${CSS.escape(eventId)}"]`) as HTMLElement | null;
                    const headers = Array.from(document.querySelectorAll('.mx_DateSeparator_dateContent')) as HTMLElement[];
                    if (!scrollNode || !targetNode || headers.length === 0) return;
                    let chosen: HTMLElement | null = null;
                    for (const h of headers) {
                        if (h.offsetTop <= targetNode.offsetTop) chosen = h; else break;
                    }
                    if (chosen) scrollNode.scrollTop = chosen.offsetTop;
                };
                // Gọi nhiều nhịp để đảm bảo sau khi timeline render xong
                window.requestAnimationFrame(alignHeader);
                setTimeout(alignHeader, 80);
                setTimeout(alignHeader, 200);
            }
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error("Jump to date failed", e);
        }
    };
    
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
        // Nếu có yêu cầu mở lại dropdown lịch sau khi remount, thực hiện ngay
        if ((window as any).__reopenDateDropdown) {
            setShowDateFilter(true);
            (window as any).__reopenDateDropdown = false;
        }
        // Sau khi timeline ổn định, cố gắng căn header ngày sát top
        const adjustToDateHeader = () => {
            const scrollNode = document.querySelector('.mx_ScrollPanel') as HTMLElement | null;
            const headers = Array.from(document.querySelectorAll('.mx_DateSeparator_dateContent')) as HTMLElement[];
            if (!scrollNode || !headers.length) return;
            const currentTop = scrollNode.scrollTop;
            let candidate: HTMLElement | null = null;
            for (const h of headers) {
                if (h.offsetTop >= currentTop - 4) { candidate = h; break; }
            }
            if (candidate) scrollNode.scrollTop = candidate.offsetTop;
        };
        setTimeout(adjustToDateHeader, 60);
        window.requestAnimationFrame(adjustToDateHeader);
        setTimeout(adjustToDateHeader, 180);
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
                            paddingRight: "76px", // Tạo không gian cho 2 nút filter (user + date)
                            flex: 1
                        }}
                    />
                    
                    {/* Nhóm icon filter bên trong ô tìm kiếm: User filter + Date filter */}
                    <div style={{ 
                        position: "absolute", 
                        right: "8px", 
                        top: "50%", 
                        transform: "translateY(-50%)",
                        zIndex: 1,
                        display: "flex",
                        alignItems: "center",
                        gap: "6px"
                    }}>
                        {/* Nút lọc theo người gửi (giữ nguyên) */}
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

                        {/* Nút chọn ngày (UI only) */}
                        <IconButton
                            onClick={() => {
                                setShowDateFilter((v) => !v);
                                // Đảm bảo chỉ một dropdown hiển thị tại một thời điểm
                                if (!showDateFilter) setShowUserFilter(false);
                            }}
                            size="sm"
                            kind="secondary"
                            tooltip="Lọc theo ngày"
                            aria-label="Lọc theo ngày"
                            style={{
                                width: "24px",
                                height: "24px",
                                minWidth: "24px",
                                padding: "0"
                            }}
                        >
                            {/* SVG icon lịch tối giản để tránh phụ thuộc biểu tượng mới */}
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                                <rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
                                <path d="M3 9H21" stroke="currentColor" strokeWidth="2" />
                                <path d="M8 3V7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                <path d="M16 3V7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                            </svg>
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

            {/* Dropdown chọn ngày (UI only) */}
            {showDateFilter && (
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
                    marginTop: "8px",
                    padding: "16px",
                    backdropFilter: "blur(12px)"
                }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
                        <Text as="label" style={{ fontWeight: 600, color: "var(--cpd-color-text-primary)" }}>
                            Chọn ngày
                        </Text>
                        <button
                            type="button"
                            onClick={() => setShowDateFilter(false)}
                            style={{
                                appearance: "none",
                                background: "transparent",
                                border: 0,
                                color: "var(--cpd-color-text-secondary)",
                                cursor: "pointer",
                                fontSize: "12px",
                                fontWeight: 600
                            }}
                        >
                            Đóng
                        </button>
                    </div>
                    {/* Lịch hiển thị trực tiếp */}
                    <div style={{
                        border: "1px solid var(--cpd-color-border-subtle)",
                        borderRadius: "12px",
                        overflow: "hidden",
                        background: "var(--cpd-color-bg-subtle-secondary)"
                    }}
                        onWheel={(e) => {
                            e.stopPropagation();
                            const isHorizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
                            const delta = isHorizontal ? e.deltaX : e.deltaY;
                            if (delta > 0) {
                                goNextMonth();
                            } else if (delta < 0) {
                                goPrevMonth();
                            }
                        }}
                    >
                        {/* Header tháng */}
                        <div style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            padding: "8px 10px",
                            background: "var(--cpd-color-bg-canvas-default)",
                            borderBottom: "1px solid var(--cpd-color-border-subtle)"
                        }}>
                            <button type="button" onClick={goPrevMonth} aria-label="Tháng trước" style={{
                                appearance: "none",
                                background: "transparent",
                                border: 0,
                                color: "var(--cpd-color-text-primary)",
                                cursor: "pointer",
                                padding: "4px 6px",
                                borderRadius: "8px"
                            }}>
                                ‹
                            </button>
                            <div style={{ fontWeight: 700, color: "var(--cpd-color-text-primary)" }}>
                                {monthNames[calendarMonth]} {calendarYear}
                            </div>
                            <button type="button" onClick={goNextMonth} aria-label="Tháng sau" style={{
                                appearance: "none",
                                background: "transparent",
                                border: 0,
                                color: "var(--cpd-color-text-primary)",
                                cursor: "pointer",
                                padding: "4px 6px",
                                borderRadius: "8px"
                            }}>
                                ›
                            </button>
                        </div>
                        {/* Tên các ngày trong tuần */}
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "0", padding: "6px 6px 0 6px" }}>
                            {daysOfWeek.map((d) => (
                                <div key={d} style={{
                                    textAlign: "center",
                                    fontSize: "12px",
                                    fontWeight: 700,
                                    color: "var(--cpd-color-text-secondary)",
                                    padding: "4px 0"
                                }}>{d}</div>
                            ))}
                        </div>
                        {/* Lưới ngày */}
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "6px", padding: "6px" }}>
                            {getCalendarCells().flat().map((cell, idx) => (
                                <button
                                    key={idx}
                                    type="button"
                                    disabled={!cell.date || cell.isFuture}
                                    onClick={() => {
                                        if (cell.date && !cell.isFuture) {
                                            setSelectedDate(toISODate(cell.date));
                                            const d = new Date(cell.date.getFullYear(), cell.date.getMonth(), cell.date.getDate(), 0, 0, 0, 0);
                                            // Giữ dropdown mở, chỉ thực hiện nhảy timeline
                                            jumpToDate(d);
                                        }
                                    }}
                                    style={{
                                        aspectRatio: "1 / 1",
                                        width: "100%",
                                        borderRadius: "10px",
                                        border: cell.isSelected
                                            ? "2px solid #007A61"
                                            : cell.isFuture
                                                ? "1px solid var(--cpd-color-border-subtle)"
                                                : cell.isToday
                                                    ? "2px solid #007A61"
                                                    : "1px solid var(--cpd-color-border-subtle)",
                                        background: cell.isSelected
                                            ? "#007A61"
                                            : "var(--cpd-color-bg-canvas-default)",
                                        color: cell.isSelected
                                            ? "#FFFFFF"
                                            : cell.isFuture
                                                ? "var(--cpd-color-text-disabled)"
                                                : cell.isToday
                                                    ? "#007A61"
                                                    : cell.date
                                                        ? "var(--cpd-color-text-primary)"
                                                        : "transparent",
                                        boxShadow: cell.isSelected ? "0 0 0 2px rgba(0, 122, 97, 0.15) inset" : "none",
                                        cursor: cell.date && !cell.isFuture ? "pointer" : "not-allowed",
                                        fontWeight: cell.isToday ? 800 : 600,
                                        opacity: cell.isFuture ? 0.5 : 1,
                                    }}
                                >
                                    {cell.date ? cell.date.getDate() : ""}
                                </button>
                            ))}
                        </div>
                    </div>
                    {selectedDate && (
                        <div style={{ marginTop: "10px", fontSize: "12px", color: "var(--cpd-color-text-secondary)" }}>
                            Ngày đã chọn: {selectedDate}
                        </div>
                    )}
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
