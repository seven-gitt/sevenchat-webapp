/*
Copyright 2024 New Vector Ltd.
Copyright 2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import classNames from "classnames";
import {
    type IEventRelation,
    type Room,
    type MatrixClient,
    THREAD_RELATION_TYPE,
    M_POLL_START,
} from "matrix-js-sdk/src/matrix";
import React, {
    type JSX,
    createContext,
    type ReactElement,
    type ReactNode,
    useContext,
    useRef,
    useState,
    useEffect,
} from "react";

import { _t } from "../../../languageHandler";
import { CollapsibleButton } from "./CollapsibleButton";
import { type MenuProps } from "../../structures/ContextMenu";
import dis from "../../../dispatcher/dispatcher";
import ErrorDialog from "../dialogs/ErrorDialog";
import { LocationButton } from "../location";
import Modal from "../../../Modal";
import PollCreateDialog from "../elements/PollCreateDialog";
import { MatrixClientPeg } from "../../../MatrixClientPeg";
import ContentMessages from "../../../ContentMessages";
import MatrixClientContext from "../../../contexts/MatrixClientContext";
import { useDispatcher } from "../../../hooks/useDispatcher";
import { chromeFileInputFix } from "../../../utils/BrowserWorkarounds";
import IconizedContextMenu, { IconizedContextMenuOptionList } from "../context_menus/IconizedContextMenu";
import { EmojiButton } from "./EmojiButton";
import { filterBoolean } from "../../../utils/arrays";
import { useSettingValue } from "../../../hooks/useSettings";
import AccessibleButton, { type ButtonEvent } from "../elements/AccessibleButton";
import { useScopedRoomContext } from "../../../contexts/ScopedRoomContext";
import ContextMenu, { aboveLeftOf, useContextMenu, ChevronFace } from "../../structures/ContextMenu";
import RoomContext from "../../../contexts/RoomContext";
import { useTheme } from "../../../hooks/useTheme";
import stickerRepository, { type Sticker } from "../../../utils/StickerRepository";

interface IProps {
    addContent: (content: string) => boolean;
    haveRecording: boolean;
    isMenuOpen: boolean;
    isStickerPickerOpen: boolean;
    menuPosition?: MenuProps;
    onRecordStartEndClick: () => void;
    relation?: IEventRelation;
    setStickerPickerOpen: (isStickerPickerOpen: boolean) => void;
    showLocationButton: boolean;
    showPollsButton: boolean;
    showStickersButton: boolean;
    toggleButtonMenu: () => void;
    isRichTextEnabled: boolean;
    onComposerModeClick: () => void;
}

type OverflowMenuCloser = () => void;
export const OverflowMenuContext = createContext<OverflowMenuCloser | null>(null);

const MessageComposerButtons: React.FC<IProps> = (props: IProps) => {
    const matrixClient = useContext(MatrixClientContext);
    const { room, narrow } = useScopedRoomContext("room", "narrow");

    const isWysiwygLabEnabled = useSettingValue("feature_wysiwyg_composer");

    if (!matrixClient || !room || props.haveRecording) {
        return null;
    }

    let mainButtons: ReactNode[];
    let moreButtons: ReactNode[];
    if (narrow) {
        mainButtons = [
            isWysiwygLabEnabled ? (
                <ComposerModeButton
                    key="composerModeButton"
                    isRichTextEnabled={props.isRichTextEnabled}
                    onClick={props.onComposerModeClick}
                />
            ) : (
                emojiButton(props)
            ),
            gifButton(props),
            stickerButton(props),
        ];
        moreButtons = [
            uploadButton(), // props passed via UploadButtonContext
            voiceRecordingButton(props, narrow),
            props.showPollsButton ? pollButton(room, props.relation) : null,
            showLocationButton(props, room, matrixClient),
        ];
    } else {
        mainButtons = [
            isWysiwygLabEnabled ? (
                <ComposerModeButton
                    key="composerModeButton"
                    isRichTextEnabled={props.isRichTextEnabled}
                    onClick={props.onComposerModeClick}
                />
            ) : (
                emojiButton(props)
            ),
            gifButton(props),
            stickerButton(props),
            uploadButton(), // props passed via UploadButtonContext
        ];
        moreButtons = [
            voiceRecordingButton(props, narrow),
            props.showPollsButton ? pollButton(room, props.relation) : null,
            showLocationButton(props, room, matrixClient),
        ];
    }

    mainButtons = filterBoolean(mainButtons);
    moreButtons = filterBoolean(moreButtons);

    const moreOptionsClasses = classNames({
        mx_MessageComposer_button: true,
        mx_MessageComposer_buttonMenu: true,
        mx_MessageComposer_closeButtonMenu: props.isMenuOpen,
    });

    return (
        <UploadButtonContextProvider roomId={room.roomId} relation={props.relation}>
            {mainButtons}
            {moreButtons.length > 0 && (
                <AccessibleButton
                    className={moreOptionsClasses}
                    onClick={props.toggleButtonMenu}
                    title={_t("quick_settings|sidebar_settings")}
                />
            )}
            {props.isMenuOpen && (
                <IconizedContextMenu
                    onFinished={props.toggleButtonMenu}
                    {...props.menuPosition}
                    wrapperClassName="mx_MessageComposer_Menu"
                    compact={true}
                >
                    <OverflowMenuContext.Provider value={props.toggleButtonMenu}>
                        <IconizedContextMenuOptionList>{moreButtons}</IconizedContextMenuOptionList>
                    </OverflowMenuContext.Provider>
                </IconizedContextMenu>
            )}
        </UploadButtonContextProvider>
    );
};

function emojiButton(props: IProps): ReactElement {
    return (
        <EmojiButton
            key="emoji_button"
            addEmoji={props.addContent}
            menuPosition={props.menuPosition}
            className="mx_MessageComposer_button"
        />
    );
}

function GifButton({
    menuPosition,
    className,
    relation,
}: {
    menuPosition?: MenuProps;
    className?: string;
    relation?: IEventRelation;
}): JSX.Element {
    const overflowMenuCloser = useContext(OverflowMenuContext);
    const matrixClient = useContext(MatrixClientContext);
    const { room } = useScopedRoomContext("room");
    const { theme } = useTheme();
    const [menuDisplayed, button, openMenu, closeMenu] = useContextMenu();
    const [search, setSearch] = useState("");
    const [gifs, setGifs] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [uploadError, setUploadError] = useState("");
    const [recentGifs, setRecentGifs] = useState<string[]>([]);

    // Khi menuDisplayed hoặc search thay đổi, nếu search rỗng thì load recentGifs và setGifs ngay lập tức
    useEffect(() => {
        if (!menuDisplayed) return;
        if (search.trim() === "") {
            const stored = localStorage.getItem("recentGifs");
            let recents: string[] = [];
            if (stored) {
                try {
                    recents = JSON.parse(stored);
                } catch {}
            }
            setRecentGifs(recents);
            setGifs(recents.map((url) => ({ id: url, media_formats: { gif: { url } } })));
            setLoading(false);
            setError("");
            return;
        }
        // Nếu có keyword thì fetch GIFs
        setLoading(true);
        setError("");
        setUploadError("");
        const key = "AIzaSyAMs-zGFu1BFxDdc6p9f1K84snQadw9uGw";
        const q = search.trim();
        fetch(`https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(q)}&key=${key}&limit=100&media_filter=gif`)
            .then((res) => res.json())
            .then((data) => {
                setGifs(data.results || []);
                setLoading(false);
            })
            .catch(() => {
                setError("Không thể tải GIF. Vui lòng thử lại.");
                setLoading(false);
            });
    }, [menuDisplayed, search]);

    async function handleGifClick(gifUrl: string) {
        setUploadError("");
        if (!room) return;
        try {
            const res = await fetch(gifUrl);
            const blob = await res.blob();
            // Lấy tên file từ url hoặc random
            const fileName = gifUrl.split("/").pop()?.split("?")[0] || `tenor.gif`;
            const file = new File([blob], fileName, { type: blob.type || "image/gif" });
            await ContentMessages.sharedInstance().sendContentToRoom(
                file,
                room.roomId,
                relation,
                matrixClient,
                undefined, // replyToEvent nếu cần, có thể truyền thêm
            );
            // Lưu vào recentGifs (localStorage)
            let updated = [gifUrl, ...recentGifs.filter((url) => url !== gifUrl)];
            if (updated.length > 20) updated = updated.slice(0, 20);
            setRecentGifs(updated);
            localStorage.setItem("recentGifs", JSON.stringify(updated));
            closeMenu();
            overflowMenuCloser?.();
        } catch (e) {
            setUploadError("Không tải lên được GIF. Vui lòng thử lại.");
        }
    }

    function handleRemoveRecentGif(gifUrl: string) {
        const updated = recentGifs.filter((url) => url !== gifUrl);
        setRecentGifs(updated);
        localStorage.setItem("recentGifs", JSON.stringify(updated));
        setGifs(updated.map((url) => ({ id: url, media_formats: { gif: { url } } })));
    }

    let contextMenu: React.ReactElement | null = null;
    if (menuDisplayed && button.current) {
        const position = menuPosition ?? aboveLeftOf(button.current.getBoundingClientRect());
        const onFinished = (): void => {
            closeMenu();
            overflowMenuCloser?.();
        };
        // Style cho theme
        const isDark = theme === "dark";
        const inputStyle = {
            width: "90%",
            padding: 8,
            borderRadius: 4,
            border: isDark ? "1px solid #444" : "1px solid #ccc",
            fontSize: 14,
            outline: "none",
            transition: "border 0.2s",
            boxShadow: isDark ? "0 1px 2px rgba(0,0,0,0.6)" : "0 1px 2px rgba(0,0,0,0.03)",
            background: isDark ? "#23272f" : "#fafbfc",
            color: isDark ? "#fff" : "#222",
            marginBottom: 12,
        };
        const popupStyle: React.CSSProperties = {
            display: "flex",
            flexDirection: "column" as const,
            alignItems: "center",
            padding: 16,
            background: isDark ? "#181a20" : "#fff",
            borderRadius: 12,
        };
        const gridStyle: React.CSSProperties = {
            display: "grid",
            gridTemplateColumns: "repeat(4, 70px)",
            gap: 8,
            maxHeight: 260,
            overflowY: "auto" as const,
            justifyContent: "center",
        };
        contextMenu = (
            <ContextMenu {...position} onFinished={onFinished} managed={false}>
                <div style={popupStyle}>
                    <div style={{ width: 304 }}>
                        <input
                            type="text"
                            placeholder="Tìm GIF..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            style={inputStyle}
                            autoFocus
                        />
                        {search.trim() === "" && recentGifs.length > 0 && (
                            <div style={{ fontWeight: 500, marginBottom: 8 }}>Đã dùng gần đây</div>
                        )}
                        {loading && <div>Đang tải...</div>}
                        {error && <div style={{ color: "red" }}>{error}</div>}
                        {uploadError && <div style={{ color: "red" }}>{uploadError}</div>}
                        <div style={gridStyle}>
                            {gifs.map((gif, idx) => {
                                const gifUrl = gif.media_formats?.gif?.url || gif.media[0]?.gif?.url;
                                // Nếu là recentGifs (search rỗng), hiển thị nút X
                                const isRecent = search.trim() === "" && recentGifs.includes(gifUrl);
                                return (
                                    <div key={gif.id || idx} style={{ position: "relative" }}>
                                        <img
                                            src={gifUrl}
                                            alt={gif.content_description || "gif"}
                                            style={{
                                                width: 70,
                                                height: 70,
                                                objectFit: "cover",
                                                borderRadius: 6,
                                                cursor: "pointer",
                                                background: isDark ? "#222" : "#eee",
                                            }}
                                            onClick={() => handleGifClick(gifUrl)}
                                            loading="lazy"
                                        />
                                        {isRecent && (
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleRemoveRecentGif(gifUrl);
                                                }}
                                                style={{
                                                    position: "absolute",
                                                    top: 2,
                                                    right: 2,
                                                    background: "rgba(0,0,0,0.5)",
                                                    color: "white",
                                                    border: "none",
                                                    borderRadius: "50%",
                                                    width: 18,
                                                    height: 18,
                                                    cursor: "pointer",
                                                    fontSize: 12,
                                                    lineHeight: "18px",
                                                    padding: 0,
                                                    zIndex: 2,
                                                }}
                                                title="Xoá GIF này khỏi danh sách"
                                            >
                                                ×
                                            </button>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                        {!loading && gifs.length === 0 && !error && <div>Không tìm thấy GIF phù hợp.</div>}
                    </div>
                </div>
            </ContextMenu>
        );
    }
    const computedClassName = classNames("mx_GifButton", className, {
        mx_GifButton_highlight: menuDisplayed,
    });
    return (
        <>
            <CollapsibleButton
                className={computedClassName}
                iconClassName="mx_MessageComposer_gif"
                onClick={openMenu}
                title={"GIF"}
                inputRef={button}
            />
            {contextMenu}
        </>
    );
}

function gifButton(props: IProps): ReactElement {
    return (
        <GifButton
            key="gif_button"
            menuPosition={props.menuPosition}
            className="mx_MessageComposer_button"
            relation={props.relation}
        />
    );
}

function StickerButton({
    menuPosition,
    className,
    relation,
}: {
    menuPosition?: MenuProps;
    className?: string;
    relation?: IEventRelation;
}): JSX.Element {
    const overflowMenuCloser = useContext(OverflowMenuContext);
    const matrixClient = useContext(MatrixClientContext);
    const { room } = useScopedRoomContext("room");
    const { theme } = useTheme();
    const isDark = theme === "dark";
    const [menuDisplayed, button, openMenu, closeMenu] = useContextMenu();
    const [search, setSearch] = useState("");
    const [stickers, setStickers] = useState<Sticker[]>([]);
    const [stickerPacks, setStickerPacks] = useState<any[]>([]);
    const [selectedPack, setSelectedPack] = useState<string>("all");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [uploadError, setUploadError] = useState("");
    const [recentStickers, setRecentStickers] = useState<Sticker[]>([]);

    // Load stickers from GitHub repository when menu opens
    useEffect(() => {
        if (!menuDisplayed) return;

        setLoading(true);
        setError("");
        setUploadError("");

        const loadStickers = async () => {
            try {
                let allStickers: Sticker[] = [];

                if (search.trim() === "") {
                    // Load all stickers from repository
                    allStickers = await stickerRepository.loadAllStickers();
                } else {
                    // Search stickers based on query
                    allStickers = await stickerRepository.searchStickers(search);
                }

                // Convert relative URLs to absolute URLs
                const stickersWithAbsoluteUrls = allStickers.map((sticker) => ({
                    ...sticker,
                    url: sticker.url.startsWith("http")
                        ? sticker.url
                        : `https://raw.githubusercontent.com/seven-gitt/sevenchat-stickers/main/${sticker.url}`,
                }));

                setStickers(stickersWithAbsoluteUrls);

                // Group stickers by pack
                const packs = new Map<string, Sticker[]>();
                stickersWithAbsoluteUrls.forEach((sticker) => {
                    const packName = sticker.pack || "unknown";
                    if (!packs.has(packName)) {
                        packs.set(packName, []);
                    }
                    packs.get(packName)!.push(sticker);
                });

                // Create pack list with metadata
                const packList = Array.from(packs.entries()).map(([packName, packStickers]) => ({
                    id: packName,
                    name: packName
                        .replace("-pack", "")
                        .replace(/[-_]/g, " ")
                        .replace(/\b\w/g, (l) => l.toUpperCase()),
                    count: packStickers.length,
                    stickers: packStickers,
                }));

                setStickerPacks(packList);

                // Reset selected pack to "all" when opening
                setSelectedPack("all");
            } catch (error) {
                console.error("Error loading stickers:", error);
                setError("Không thể tải stickers từ repository. Vui lòng thử lại sau.");
            } finally {
                setLoading(false);
            }
        };

        loadStickers();
    }, [menuDisplayed, search]);

    // Auto-refresh stickers every 30 seconds when menu is open
    useEffect(() => {
        if (!menuDisplayed) return;

        const refreshInterval = setInterval(async () => {
            try {
                console.log("🔄 Auto-refreshing stickers...");
                let allStickers: Sticker[] = [];

                if (search.trim() === "") {
                    allStickers = await stickerRepository.loadAllStickers();
                } else {
                    allStickers = await stickerRepository.searchStickers(search);
                }

                const stickersWithAbsoluteUrls = allStickers.map((sticker) => ({
                    ...sticker,
                    url: sticker.url.startsWith("http")
                        ? sticker.url
                        : `https://raw.githubusercontent.com/seven-gitt/sevenchat-stickers/main/${sticker.url}`,
                }));

                setStickers(stickersWithAbsoluteUrls);

                // Update packs as well
                const packs = new Map<string, Sticker[]>();
                stickersWithAbsoluteUrls.forEach((sticker) => {
                    const packName = sticker.pack || "unknown";
                    if (!packs.has(packName)) {
                        packs.set(packName, []);
                    }
                    packs.get(packName)!.push(sticker);
                });

                const packList = Array.from(packs.entries()).map(([packName, packStickers]) => ({
                    id: packName,
                    name: packName
                        .replace("-pack", "")
                        .replace(/[-_]/g, " ")
                        .replace(/\b\w/g, (l) => l.toUpperCase()),
                    count: packStickers.length,
                    stickers: packStickers,
                }));

                setStickerPacks(packList);
                console.log("✅ Stickers refreshed successfully");
            } catch (error) {
                console.error("Error auto-refreshing stickers:", error);
            }
        }, 30000); // Refresh every 30 seconds

        return () => clearInterval(refreshInterval);
    }, [menuDisplayed, search]);

    async function handleStickerClick(sticker: Sticker) {
        setUploadError("");
        if (!room) return;
        try {
            // Fetch sticker image from GitHub
            const res = await fetch(sticker.url);
            if (!res.ok) {
                throw new Error(`Failed to fetch sticker: ${res.statusText}`);
            }

            const blob = await res.blob();
            const fileName = sticker.url.split("/").pop()?.split("?")[0] || `${sticker.id}.png`;
            const file = new File([blob], fileName, { type: blob.type || "image/png" });

            await ContentMessages.sharedInstance().sendContentToRoom(
                file,
                room.roomId,
                relation,
                matrixClient,
                undefined,
            );

            // Add to recent stickers
            const updatedRecentStickers = [sticker, ...recentStickers.filter((s) => s.id !== sticker.id)].slice(0, 10);
            setRecentStickers(updatedRecentStickers);
            closeMenu();
            overflowMenuCloser?.();
        } catch (e) {
            console.error("Error sending sticker:", e);
            setUploadError("Không tải lên được sticker. Vui lòng thử lại.");
        }
    }

    function handleRemoveRecentSticker(sticker: Sticker) {
        const updatedRecentStickers = recentStickers.filter((s) => s.id !== sticker.id);
        setRecentStickers(updatedRecentStickers);
    }

    let contextMenu: React.ReactElement | null = null;
    if (menuDisplayed && button.current) {
        const rect = button.current.getBoundingClientRect();
        contextMenu = (
            <ContextMenu {...aboveLeftOf(rect)} onFinished={closeMenu} managed={false} zIndex={3500}>
                <div
                    className="mx_StickerPicker"
                    style={{
                        width: "400px",
                        maxHeight: "450px",
                        overflow: "hidden",
                        background: isDark ? "#23272f" : "white",
                        borderRadius: "8px",
                        boxShadow: isDark ? "0 4px 12px rgba(0,0,0,0.4)" : "0 4px 12px rgba(0,0,0,0.15)",
                        display: "flex",
                        flexDirection: "column",
                        border: isDark ? "1px solid #444" : "none",
                    }}
                >
                    <div
                        className="mx_StickerPicker_search"
                        style={{
                            padding: "12px",
                            borderBottom: isDark ? "1px solid #444" : "1px solid #eee",
                            background: isDark ? "#1a1d23" : "#f8f9fa",
                            display: "flex",
                            gap: "8px",
                            alignItems: "center",
                        }}
                    >
                        <input
                            type="text"
                            placeholder="Tìm kiếm sticker..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            style={{
                                flex: "1",
                                padding: "8px 12px",
                                border: isDark ? "1px solid #555" : "1px solid #ddd",
                                borderRadius: "6px",
                                fontSize: "14px",
                                outline: "none",
                                background: isDark ? "#2d3139" : "white",
                                color: isDark ? "#fff" : "#333",
                            }}
                        />
                    </div>

                    {error && <div style={{ color: "#ff6b6b", padding: "8px", textAlign: "center" }}>{error}</div>}

                    {uploadError && (
                        <div style={{ color: "#ff6b6b", padding: "8px", textAlign: "center" }}>{uploadError}</div>
                    )}

                    {loading ? (
                        <div
                            style={{ textAlign: "center", padding: "20px", flex: "1", color: isDark ? "#ccc" : "#666" }}
                        >
                            <div>Đang tải stickers...</div>
                        </div>
                    ) : (
                        <>
                            {/* Main Stickers Area */}
                            <div
                                className="mx_StickerPicker_content"
                                style={{
                                    padding: "12px",
                                    flex: "1",
                                    overflowY: "auto",
                                }}
                            >
                                {/* Stickers Display */}
                                {(() => {
                                    if (selectedPack === "all") {
                                        // Hiển thị theo từng pack khi chọn "Tất cả"
                                        if (stickerPacks.length === 0) {
                                            return (
                                                <div
                                                    style={{
                                                        textAlign: "center",
                                                        padding: "20px",
                                                        color: isDark ? "#ccc" : "#666",
                                                    }}
                                                >
                                                    {search.trim()
                                                        ? "Không tìm thấy stickers phù hợp"
                                                        : "Không có stickers"}
                                                </div>
                                            );
                                        }

                                        return (
                                            <div
                                                style={{
                                                    display: "flex",
                                                    flexDirection: "column",
                                                    gap: "20px",
                                                    width: "100%",
                                                }}
                                            >
                                                {stickerPacks.map((pack) => (
                                                    <div
                                                        key={pack.id}
                                                        style={{
                                                            width: "100%",
                                                            borderBottom: isDark
                                                                ? "1px solid #444"
                                                                : "1px solid #f0f0f0",
                                                            paddingBottom: "16px",
                                                        }}
                                                    >
                                                        {/* Pack Title */}
                                                        <div
                                                            style={{
                                                                fontSize: "16px",
                                                                fontWeight: "bold",
                                                                color: isDark ? "#fff" : "#333",
                                                                marginBottom: "12px",
                                                                padding: "0 4px",
                                                            }}
                                                        >
                                                            {pack.name}
                                                        </div>

                                                        {/* Pack Stickers Grid */}
                                                        <div
                                                            style={{
                                                                display: "grid",
                                                                gridTemplateColumns: "repeat(4, 1fr)",
                                                                gap: "14px",
                                                                width: "100%",
                                                            }}
                                                        >
                                                            {pack.stickers.map((sticker: Sticker) => (
                                                                <div
                                                                    key={sticker.id}
                                                                    className="mx_StickerPicker_item"
                                                                    onClick={() => handleStickerClick(sticker)}
                                                                    title={`${sticker.name}${sticker.pack ? ` (${sticker.pack})` : ""}`}
                                                                    style={{
                                                                        position: "relative",
                                                                        cursor: "pointer",
                                                                        padding: "8px",
                                                                        borderRadius: "10px",
                                                                        border: isDark
                                                                            ? "1px solid #555"
                                                                            : "1px solid #eee",
                                                                        background: isDark ? "#2d3139" : "white",
                                                                        transition: "all 0.2s ease",
                                                                        display: "flex",
                                                                        flexDirection: "column",
                                                                        alignItems: "center",
                                                                    }}
                                                                    onMouseEnter={(e) => {
                                                                        e.currentTarget.style.transform = "scale(1.05)";
                                                                        e.currentTarget.style.boxShadow =
                                                                            "0 2px 8px rgba(0,0,0,0.1)";
                                                                    }}
                                                                    onMouseLeave={(e) => {
                                                                        e.currentTarget.style.transform = "scale(1)";
                                                                        e.currentTarget.style.boxShadow = "none";
                                                                    }}
                                                                >
                                                                    <img
                                                                        src={sticker.url}
                                                                        alt={sticker.name}
                                                                        style={{
                                                                            width: "60px",
                                                                            height: "60px",
                                                                            objectFit: "contain",
                                                                            borderRadius: "6px",
                                                                        }}
                                                                        onError={(e) => {
                                                                            console.error(
                                                                                "Failed to load sticker image:",
                                                                                sticker.url,
                                                                            );
                                                                            e.currentTarget.style.display = "none";
                                                                        }}
                                                                    />
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        );
                                    } else {
                                        // Hiển thị stickers của pack được chọn
                                        const selectedPackData = stickerPacks.find((p) => p.id === selectedPack);
                                        const displayStickers = selectedPackData ? selectedPackData.stickers : [];

                                        if (displayStickers.length === 0) {
                                            return (
                                                <div
                                                    style={{
                                                        textAlign: "center",
                                                        padding: "20px",
                                                        color: isDark ? "#ccc" : "#666",
                                                    }}
                                                >
                                                    {search.trim()
                                                        ? "Không tìm thấy stickers phù hợp"
                                                        : "Không có stickers"}
                                                </div>
                                            );
                                        }

                                        return (
                                            <div
                                                style={{
                                                    display: "grid",
                                                    gridTemplateColumns: "repeat(4, 1fr)",
                                                    gap: "14px",
                                                }}
                                            >
                                                {displayStickers.map((sticker: Sticker) => (
                                                    <div
                                                        key={sticker.id}
                                                        className="mx_StickerPicker_item"
                                                        onClick={() => handleStickerClick(sticker)}
                                                        title={`${sticker.name}${sticker.pack ? ` (${sticker.pack})` : ""}`}
                                                        style={{
                                                            position: "relative",
                                                            cursor: "pointer",
                                                            padding: "8px",
                                                            borderRadius: "10px",
                                                            border: isDark ? "1px solid #555" : "1px solid #eee",
                                                            background: isDark ? "#2d3139" : "white",
                                                            transition: "all 0.2s ease",
                                                            display: "flex",
                                                            flexDirection: "column",
                                                            alignItems: "center",
                                                        }}
                                                        onMouseEnter={(e) => {
                                                            e.currentTarget.style.transform = "scale(1.05)";
                                                            e.currentTarget.style.boxShadow =
                                                                "0 2px 8px rgba(0,0,0,0.1)";
                                                        }}
                                                        onMouseLeave={(e) => {
                                                            e.currentTarget.style.transform = "scale(1)";
                                                            e.currentTarget.style.boxShadow = "none";
                                                        }}
                                                    >
                                                        <img
                                                            src={sticker.url}
                                                            alt={sticker.name}
                                                            style={{
                                                                width: "60px",
                                                                height: "60px",
                                                                objectFit: "contain",
                                                                borderRadius: "6px",
                                                            }}
                                                            onError={(e) => {
                                                                console.error(
                                                                    "Failed to load sticker image:",
                                                                    sticker.url,
                                                                );
                                                                e.currentTarget.style.display = "none";
                                                            }}
                                                        />
                                                    </div>
                                                ))}
                                            </div>
                                        );
                                    }
                                })()}
                            </div>

                            {/* Pack Selection Bar (Bottom) - Like Zalo */}
                            {stickerPacks.length > 0 && (
                                <div
                                    style={{
                                        borderTop: isDark ? "1px solid #444" : "1px solid #eee",
                                        padding: "8px 12px",
                                        background: isDark ? "#1a1d23" : "#f8f9fa",
                                        display: "flex",
                                        alignItems: "center",
                                        gap: "8px",
                                        overflowX: "auto",
                                        overflowY: "hidden",
                                        minHeight: "60px",
                                        maxWidth: "100%",
                                        scrollbarWidth: "thin",
                                        scrollbarColor: isDark ? "#555 #1a1d23" : "#ccc #f8f9fa",
                                        // Webkit scrollbar styles
                                        ...(isDark
                                            ? {
                                                  "&::-webkit-scrollbar": { height: "6px" },
                                                  "&::-webkit-scrollbar-track": { background: "#1a1d23" },
                                                  "&::-webkit-scrollbar-thumb": {
                                                      background: "#555",
                                                      borderRadius: "3px",
                                                  },
                                              }
                                            : {
                                                  "&::-webkit-scrollbar": { height: "6px" },
                                                  "&::-webkit-scrollbar-track": { background: "#f8f9fa" },
                                                  "&::-webkit-scrollbar-thumb": {
                                                      background: "#ccc",
                                                      borderRadius: "3px",
                                                  },
                                              }),
                                    }}
                                >
                                    {/* Recent Button */}
                                    <button
                                        onClick={() => setSelectedPack("all")}
                                        style={{
                                            minWidth: "50px",
                                            width: "50px",
                                            height: "50px",
                                            background:
                                                selectedPack === "all" ? "#007bff" : isDark ? "#2d3139" : "#fff",
                                            color: selectedPack === "all" ? "white" : isDark ? "#fff" : "#333",
                                            border: isDark ? "1px solid #555" : "1px solid #ddd",
                                            borderRadius: "8px",
                                            cursor: "pointer",
                                            display: "flex",
                                            flexDirection: "column",
                                            alignItems: "center",
                                            justifyContent: "center",
                                            fontSize: "10px",
                                            fontWeight: selectedPack === "all" ? "bold" : "normal",
                                            flexShrink: 0,
                                            whiteSpace: "nowrap",
                                        }}
                                    >
                                        <div>Tất cả</div>
                                    </button>

                                    {/* Pack Buttons */}
                                    {stickerPacks.map((pack) => (
                                        <button
                                            key={pack.id}
                                            onClick={() => setSelectedPack(pack.id)}
                                            style={{
                                                minWidth: "50px",
                                                width: "50px",
                                                height: "50px",
                                                background:
                                                    selectedPack === pack.id ? "#007bff" : isDark ? "#2d3139" : "#fff",
                                                color: selectedPack === pack.id ? "white" : isDark ? "#fff" : "#333",
                                                border: isDark ? "1px solid #555" : "1px solid #ddd",
                                                borderRadius: "8px",
                                                cursor: "pointer",
                                                display: "flex",
                                                flexDirection: "column",
                                                alignItems: "center",
                                                justifyContent: "center",
                                                fontSize: "10px",
                                                fontWeight: selectedPack === pack.id ? "bold" : "normal",
                                                flexShrink: 0,
                                                position: "relative",
                                                whiteSpace: "nowrap",
                                            }}
                                        >
                                            {/* Pack Thumbnail */}
                                            {pack.stickers.length > 0 && (
                                                <img
                                                    src={pack.stickers[0].url}
                                                    alt={pack.name}
                                                    style={{
                                                        width: "32px",
                                                        height: "32px",
                                                        objectFit: "contain",
                                                        borderRadius: "4px",
                                                        marginBottom: "2px",
                                                    }}
                                                    onError={(e) => {
                                                        e.currentTarget.style.display = "none";
                                                    }}
                                                />
                                            )}
                                            <div>{pack.name}</div>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </>
                    )}
                </div>
            </ContextMenu>
        );
    }

    const computedClassName = classNames(className, {
        mx_MessageComposer_button_active: menuDisplayed,
    });

    return (
        <>
            <CollapsibleButton
                className={computedClassName}
                iconClassName="mx_MessageComposer_stickers"
                onClick={openMenu}
                title={"Sticker"}
                inputRef={button}
            />
            {contextMenu}
        </>
    );
}

function stickerButton(props: IProps): ReactElement {
    return (
        <StickerButton
            key="sticker_button"
            menuPosition={props.menuPosition}
            className="mx_MessageComposer_button"
            relation={props.relation}
        />
    );
}

function uploadButton(): ReactElement {
    return <UploadButton key="controls_upload" />;
}

type UploadButtonFn = () => void;
export const UploadButtonContext = createContext<UploadButtonFn | null>(null);

interface IUploadButtonProps {
    roomId: string;
    relation?: IEventRelation;
    children: ReactNode;
}

// We put the file input outside the UploadButton component so that it doesn't get killed when the context menu closes.
const UploadButtonContextProvider: React.FC<IUploadButtonProps> = ({ roomId, relation, children }) => {
    const cli = useContext(MatrixClientContext);
    const roomContext = useScopedRoomContext("timelineRenderingType");
    const uploadInput = useRef<HTMLInputElement>(null);

    const onUploadClick = (): void => {
        if (cli?.isGuest()) {
            dis.dispatch({ action: "require_registration" });
            return;
        }
        uploadInput.current?.click();
    };

    useDispatcher(dis, (payload) => {
        if (roomContext.timelineRenderingType === payload.context && payload.action === "upload_file") {
            onUploadClick();
        }
    });

    const onUploadFileInputChange = (ev: React.ChangeEvent<HTMLInputElement>): void => {
        if (ev.target.files?.length === 0) return;

        // Take a copy, so we can safely reset the value of the form control
        ContentMessages.sharedInstance().sendContentListToRoom(
            Array.from(ev.target.files!),
            roomId,
            relation,
            cli,
            roomContext.timelineRenderingType,
        );

        // This is the onChange handler for a file form control, but we're
        // not keeping any state, so reset the value of the form control
        // to empty.
        // NB. we need to set 'value': the 'files' property is immutable.
        ev.target.value = "";
    };

    const uploadInputStyle = { display: "none" };
    return (
        <UploadButtonContext.Provider value={onUploadClick}>
            {children}

            <input
                ref={uploadInput}
                type="file"
                style={uploadInputStyle}
                multiple
                onClick={chromeFileInputFix}
                onChange={onUploadFileInputChange}
            />
        </UploadButtonContext.Provider>
    );
};

// Must be rendered within an UploadButtonContextProvider
const UploadButton: React.FC = () => {
    const overflowMenuCloser = useContext(OverflowMenuContext);
    const uploadButtonFn = useContext(UploadButtonContext);

    const onClick = (): void => {
        uploadButtonFn?.();
        overflowMenuCloser?.(); // close overflow menu
    };

    return (
        <CollapsibleButton
            className="mx_MessageComposer_button"
            iconClassName="mx_MessageComposer_upload"
            onClick={onClick}
            title={_t("common|attachment")}
        />
    );
};

function showStickersButton(props: IProps): ReactElement | null {
    return props.showStickersButton ? (
        <CollapsibleButton
            id="stickersButton"
            key="controls_stickers"
            className="mx_MessageComposer_button"
            iconClassName="mx_MessageComposer_stickers"
            onClick={() => props.setStickerPickerOpen(!props.isStickerPickerOpen)}
            title={props.isStickerPickerOpen ? _t("composer|close_sticker_picker") : _t("common|sticker")}
        />
    ) : null;
}

function voiceRecordingButton(props: IProps, narrow: boolean): ReactElement | null {
    // XXX: recording UI does not work well in narrow mode, so hide for now
    return narrow ? null : (
        <CollapsibleButton
            key="voice_message_send"
            className="mx_MessageComposer_button"
            iconClassName="mx_MessageComposer_voiceMessage"
            onClick={props.onRecordStartEndClick}
            title={_t("composer|voice_message_button")}
        />
    );
}

function pollButton(room: Room, relation?: IEventRelation): ReactElement {
    return <PollButton key="polls" room={room} relation={relation} />;
}

interface IPollButtonProps {
    room: Room;
    relation?: IEventRelation;
}

class PollButton extends React.PureComponent<IPollButtonProps> {
    public static contextType = OverflowMenuContext;
    declare public context: React.ContextType<typeof OverflowMenuContext>;

    private onCreateClick = (): void => {
        this.context?.(); // close overflow menu
        const canSend = this.props.room.currentState.maySendEvent(
            M_POLL_START.name,
            MatrixClientPeg.safeGet().getSafeUserId(),
        );
        if (!canSend) {
            Modal.createDialog(ErrorDialog, {
                title: _t("composer|poll_button_no_perms_title"),
                description: _t("composer|poll_button_no_perms_description"),
            });
        } else {
            const threadId =
                this.props.relation?.rel_type === THREAD_RELATION_TYPE.name ? this.props.relation.event_id : undefined;

            Modal.createDialog(
                PollCreateDialog,
                {
                    room: this.props.room,
                    threadId,
                },
                "mx_CompoundDialog",
                false, // isPriorityModal
                true, // isStaticModal
            );
        }
    };

    public render(): React.ReactNode {
        // do not allow sending polls within threads at this time
        if (this.props.relation?.rel_type === THREAD_RELATION_TYPE.name) return null;

        return (
            <CollapsibleButton
                className="mx_MessageComposer_button"
                iconClassName="mx_MessageComposer_poll"
                onClick={this.onCreateClick}
                title={_t("composer|poll_button")}
            />
        );
    }
}

function showLocationButton(props: IProps, room: Room, matrixClient: MatrixClient): ReactElement | null {
    const sender = room.getMember(matrixClient.getSafeUserId());

    return props.showLocationButton && sender ? (
        <LocationButton
            key="location"
            roomId={room.roomId}
            relation={props.relation}
            sender={sender}
            menuPosition={props.menuPosition}
        />
    ) : null;
}

interface WysiwygToggleButtonProps {
    isRichTextEnabled: boolean;
    onClick: (ev: ButtonEvent) => void;
}

function ComposerModeButton({ isRichTextEnabled, onClick }: WysiwygToggleButtonProps): JSX.Element {
    const title = isRichTextEnabled ? _t("composer|mode_plain") : _t("composer|mode_rich_text");

    return (
        <CollapsibleButton
            className="mx_MessageComposer_button"
            iconClassName={classNames({
                mx_MessageComposer_plain_text: !isRichTextEnabled,
                mx_MessageComposer_rich_text: isRichTextEnabled,
            })}
            onClick={onClick}
            title={title}
        />
    );
}

export default MessageComposerButtons;
