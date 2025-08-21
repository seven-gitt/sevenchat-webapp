/*
Copyright 2024 New Vector Ltd.
Copyright 2019-2021 The Matrix.org Foundation C.I.C.
Copyright 2019 Michael Telatynski <7t3chguy@gmail.com>

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX } from "react";
import { FilesIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { _t } from "../../../languageHandler";
import { getBlobSafeMimeType } from "../../../utils/blobs";
import BaseDialog from "./BaseDialog";
import DialogButtons from "../elements/DialogButtons";
import { fileSize } from "../../../utils/FileUtils";
import Autocomplete from "../rooms/Autocomplete";
import type { ICompletion, ISelectionRange } from "../../../autocomplete/Autocompleter";
import { MatrixClientPeg } from "../../../MatrixClientPeg";
import type { Room } from "matrix-js-sdk/src/matrix";
import { SdkContextClass } from "../../../contexts/SDKContext";

interface IProps {
    file: File;
    currentIndex: number;
    totalFiles: number;
    onFinished: (uploadConfirmed: boolean, caption?: string, uploadAll?: boolean) => void;
    roomId?: string; // to resolve room context for mentions
}

interface IState {
    caption: string;
    query: string;
    selection: ISelectionRange;
    room?: Room | null;
    mentionTokens: Array<{ text: string; href: string }>;
}

export default class ImageUploadDialog extends React.Component<IProps, IState> {
    private readonly objectUrl: string;
    private readonly mimeType: string;
    private captionInputRef = React.createRef<HTMLDivElement>();
    private autocompleteWrapperRef = React.createRef<HTMLDivElement>();

    public static defaultProps: Partial<IProps> = {
        totalFiles: 1,
        currentIndex: 0,
    };

    public constructor(props: IProps) {
        super(props);

        this.state = {
            caption: "",
            query: "",
            selection: { start: 0, end: 0 },
            room: this.props.roomId ? MatrixClientPeg.safeGet().getRoom(this.props.roomId) : undefined,
            mentionTokens: [],
        };

        // Create a fresh `Blob` for previewing (even though `File` already is
        // one) so we can adjust the MIME type if needed.
        this.mimeType = getBlobSafeMimeType(props.file.type);
        const blob = new Blob([props.file], { type: this.mimeType });
        this.objectUrl = URL.createObjectURL(blob);
    }

    public componentWillUnmount(): void {
        if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    }

    public componentDidMount(): void {
        // Focus the caption input so the user can start typing immediately
        // Delay to ensure dialog layout has mounted and not overridden by button focus
        window.setTimeout(() => {
            const input = this.captionInputRef.current;
            if (input) {
                input.focus();
                // Move caret to end in contentEditable
                const range = document.createRange();
                range.selectNodeContents(input);
                range.collapse(false);
                const sel = window.getSelection();
                sel?.removeAllRanges();
                sel?.addRange(range);
            }
        }, 0);

        // Resolve current room if not provided
        if (!this.state.room) {
            const currentRoomId = SdkContextClass.instance.roomViewStore.getRoomId();
            if (currentRoomId) {
                const room = MatrixClientPeg.safeGet().getRoom(currentRoomId) ?? undefined;
                if (room) this.setState({ room });
            }
        }
    }

    public componentDidUpdate(prevProps: IProps, prevState: IState): void {
        // When the query becomes active or changes, ensure the list is scrolled to bottom
        if (this.state.query && this.state.query !== prevState.query) {
            this.scrollAutocompleteToBottom();
        }
    }

    private onCancelClick = (): void => {
        this.props.onFinished(false);
    };

    private onSendClick = (): void => {
        const formatted = this.buildFormattedCaption();
        // Pass the formatted HTML as the 4th value; caller can optionally use it
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore dialog finished payload shape is flexible
        this.props.onFinished(true, this.state.caption, undefined, formatted);
    };

    private onUploadAllClick = (): void => {
        const formatted = this.buildFormattedCaption();
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore dialog finished payload shape is flexible
        this.props.onFinished(true, this.state.caption, true, formatted);
    };

    private onEditableInput = (): void => {
        const el = this.captionInputRef.current;
        if (!el) return;
        // Keep both html and text versions
        const text = el.innerText;
        this.setState({ caption: text }, () => this.updateAutocompleteState());
    };

    private onCaptionKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
        // Basic mention autocomplete trigger: if user types '@', we leave focus so global autocompleter can pick up
        // Note: element-web's autocompleter expects content-editable inputs; here we mimic by not preventing default
        // and letting providers parse the current value if integrated in future.
        if (event.key === "Enter" && !event.shiftKey) {
            // Send on Enter, allow Shift+Enter to insert newline
            event.preventDefault();
            this.onSendClick();
        }
        // Update autocomplete after key handling
        window.setTimeout(() => this.updateAutocompleteState(), 0);
    };

    private onCaptionSelect = (): void => {
        this.updateAutocompleteState();
    };

    private updateAutocompleteState(): void {
        const root = this.captionInputRef.current;
        if (!root) return;
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const rangeToCaret = document.createRange();
        rangeToCaret.setStart(root, 0);
        const caretRange = sel.getRangeAt(0);
        try {
            rangeToCaret.setEnd(caretRange.endContainer, caretRange.endOffset);
        } catch {}
        const caret = rangeToCaret.toString().length;
        const value = root.innerText;
        // Find the token start - after last whitespace/newline before caret
        let start = caret;
        for (let i = caret - 1; i >= 0; i--) {
            const ch = value[i];
            if (ch === " " || ch === "\n" || ch === "\t") {
                start = i + 1;
                break;
            }
            start = i;
        }
        const token = value.slice(start, caret);
        if (token.startsWith("@")) {
            const q = token;
            this.setState(
                {
                    query: q,
                    selection: { start: q.length, end: q.length, beginning: true },
                },
                () => this.scrollAutocompleteToBottom(),
            );
        } else {
            if (this.state.query !== "") this.setState({ query: "", selection: { start: 0, end: 0 } });
        }
    }

    private scrollAutocompleteToBottom(): void {
        // Find the inner scroll container created by Autocomplete and scroll to bottom
        const wrapper = this.autocompleteWrapperRef.current;
        if (!wrapper) return;
        // Defer to allow Autocomplete to render items
        window.setTimeout(() => {
            const scroller = (wrapper.querySelector(
                ".mx_Autocomplete_Completion_container_pill",
            ) || wrapper.querySelector(".mx_Autocomplete")) as HTMLElement | null;
            if (scroller) {
                scroller.scrollTop = scroller.scrollHeight;
            }
            // Also ensure the dialog content scrolls to bottom so action buttons remain visible
            const dialogContent = document.getElementById("mx_Dialog_content");
            if (dialogContent) {
                dialogContent.scrollTop = dialogContent.scrollHeight;
            }
        }, 0);
    }

    private onAutoCompleteConfirm = (completion: ICompletion): void => {
        const root = this.captionInputRef.current;
        if (!root) return;
        const qLen = this.state.query.length;

        // Helper to get a Range for character offsets within the root element's text content
        const getRangeForOffsets = (start: number, end: number): Range | null => {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let node: Node | null = walker.nextNode();
            let acc = 0;
            let startNode: Node | null = null;
            let startOffset = 0;
            let endNode: Node | null = null;
            let endOffset = 0;
            while (node) {
                const len = node.nodeValue?.length ?? 0;
                if (!startNode && start <= acc + len) {
                    startNode = node;
                    startOffset = Math.max(0, start - acc);
                }
                if (!endNode && end <= acc + len) {
                    endNode = node;
                    endOffset = Math.max(0, end - acc);
                    break;
                }
                acc += len;
                node = walker.nextNode();
            }
            if (startNode && endNode) {
                const r = document.createRange();
                r.setStart(startNode, startOffset);
                r.setEnd(endNode, endOffset);
                return r;
            }
            return null;
        };

        // Determine caret character index
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const tmp = document.createRange();
        tmp.setStart(root, 0);
        const caretRange = sel.getRangeAt(0);
        try {
            tmp.setEnd(caretRange.endContainer, caretRange.endOffset);
        } catch {}
        const caretIndex = tmp.toString().length;
        const startIndex = Math.max(0, caretIndex - qLen);
        const range = getRangeForOffsets(startIndex, caretIndex);
        if (!range) return;

        // Replace text with anchor element
        range.deleteContents();
        const anchor = document.createElement("a");
        // Show display name but keep permalink so timeline renders a pill
        anchor.textContent = completion.completion;
        if (completion.href) anchor.setAttribute("href", completion.href);
        anchor.setAttribute("data-mention-type", "user");
        range.insertNode(anchor);
        // Insert a visible space plus a zero-width space to ensure caret is outside the link
        const suffix = document.createTextNode((completion.suffix || " ") + "\u200B");
        anchor.after(suffix);

        // Move caret after inserted suffix
        const afterRange = document.createRange();
        const len = suffix.nodeValue ? suffix.nodeValue.length : 1;
        afterRange.setStart(suffix, len);
        afterRange.setEnd(suffix, len);
        sel.removeAllRanges();
        sel.addRange(afterRange);

        // Update state and clear query
        this.setState({ query: "", selection: { start: 0, end: 0 }, caption: root.innerText });
    };

    // escapeHtml removed: not used after switching to contentEditable HTML output

    private buildFormattedCaption(): string | undefined {
        const el = this.captionInputRef.current;
        if (!el) return undefined;
        // Use editor HTML to preserve <a href="...">...</a> mentions for pillification
        const html = el.innerHTML;
        return html && html.trim().length > 0 ? html : undefined;
    }

    public render(): React.ReactNode {
        let title: string;
        if (this.props.totalFiles > 1 && this.props.currentIndex !== undefined) {
            title = _t("upload_file|title_progress", {
                current: this.props.currentIndex + 1,
                total: this.props.totalFiles,
            });
        } else {
            title = _t("image_upload|title");
        }

        const fileId = `mx-imageuploaddialog-${this.props.file.name}`;
        let preview: JSX.Element | undefined;
        let placeholder: JSX.Element | undefined;
        
        if (this.mimeType.startsWith("image/")) {
            preview = (
                <div className="mx_ImageUploadDialog_imagePreview">
                    <img src={this.objectUrl} aria-labelledby={fileId} />
                </div>
            );
        } else if (this.mimeType.startsWith("video/")) {
            preview = (
                <video
                    className="mx_ImageUploadDialog_imagePreview"
                    src={this.objectUrl}
                    playsInline
                    controls={false}
                />
            );
        } else {
            placeholder = <FilesIcon className="mx_ImageUploadDialog_fileIcon" height="18px" width="18px" />;
        }

        let uploadAllButton: JSX.Element | undefined;
        if (this.props.currentIndex + 1 < this.props.totalFiles) {
            uploadAllButton = <button onClick={this.onUploadAllClick}>{_t("upload_file|upload_all_button")}</button>;
        }

        return (
            <BaseDialog
                className="mx_ImageUploadDialog"
                fixedWidth={false}
                onFinished={this.onCancelClick}
                title={title}
                contentId="mx_Dialog_content"
            >
                <div id="mx_Dialog_content">
                    <div className="mx_ImageUploadDialog_previewOuter">
                        <div className="mx_ImageUploadDialog_previewInner">
                            {preview && <div>{preview}</div>}
                            <div id={fileId}>
                                {placeholder}
                                {this.props.file.name} ({fileSize(this.props.file.size)})
                            </div>
                        </div>
                    </div>
                    
                    <div className="mx_ImageUploadDialog_captionSection">
                        <p className="mx_ImageUploadDialog_hint">
                            {_t("image_upload|hint")}
                        </p>
                        {this.state.room && this.state.query && (
                            <div className="mx_ImageUploadDialog_autocompleteWrapper" ref={this.autocompleteWrapperRef}>
                                <Autocomplete
                                    query={this.state.query}
                                    onConfirm={this.onAutoCompleteConfirm}
                                    selection={this.state.selection}
                                    room={this.state.room}
                                />
                            </div>
                        )}

                        <div className="mx_ImageUploadDialog_captionContainer">
                            <div
                                ref={this.captionInputRef}
                                className="mx_ImageUploadDialog_captionInput"
                                autoFocus
                                contentEditable
                                role="textbox"
                                aria-multiline="true"
                                data-placeholder={_t("image_upload|caption_placeholder")}
                                onInput={this.onEditableInput}
                                onKeyDown={this.onCaptionKeyDown}
                                onSelect={this.onCaptionSelect}
                            />
                        </div>
                    </div>
                </div>

                <DialogButtons
                    primaryButton="Gửi"
                    hasCancel={true}
                    cancelButton="Thoát"
                    onPrimaryButtonClick={this.onSendClick}
                    onCancel={this.onCancelClick}
                    focus={false}
                >
                    {uploadAllButton}
                </DialogButtons>
            </BaseDialog>
        );
    }
}
