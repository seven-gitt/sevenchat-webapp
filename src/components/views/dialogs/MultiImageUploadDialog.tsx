/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React from "react";
import { _t } from "../../../languageHandler";
import BaseDialog from "./BaseDialog";
import DialogButtons from "../elements/DialogButtons";
import Autocomplete from "../rooms/Autocomplete";
import type { ISelectionRange, ICompletion } from "../../../autocomplete/Autocompleter";
import { MatrixClientPeg } from "../../../MatrixClientPeg";
import type { Room } from "matrix-js-sdk/src/matrix";
import { SdkContextClass } from "../../../contexts/SDKContext";


interface IProps {
    files: File[];
    onFinished: (proceed: boolean, files?: File[], caption?: string, captionFormatted?: string) => void;
}

interface IState {
    caption: string;
    query: string;
    selection: ISelectionRange;
    room: Room | null;
    selectedFiles: File[];
}

export default class MultiImageUploadDialog extends React.Component<IProps, IState> {
    private captionRef = React.createRef<HTMLDivElement>();

    constructor(props: IProps) {
        super(props);
        
        const roomId = SdkContextClass.instance.roomViewStore.getRoomId();
        const room = roomId ? MatrixClientPeg.safeGet().getRoom(roomId) : null;
        
        this.state = {
            caption: "",
            query: "",
            selection: { start: 0, end: 0 },
            room: room,
            selectedFiles: [...props.files],
        };
    }

    public componentDidMount(): void {
        // Focus caption like single-image dialog
        window.setTimeout(() => {
            const el = this.captionRef.current;
            if (el) {
                el.focus();
                const range = document.createRange();
                range.selectNodeContents(el);
                range.collapse(false);
                const sel = window.getSelection();
                sel?.removeAllRanges();
                sel?.addRange(range);
            }
        }, 0);
    }

    private onCaptionKeyDown = (ev: React.KeyboardEvent): void => {
        if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            this.onSendClick();
        }
        // Update autocomplete after key handling
        window.setTimeout(() => this.updateAutocompleteState(), 0);
    };

    private onEditableInput = (ev: React.FormEvent<HTMLDivElement>): void => {
        const target = ev.target as HTMLDivElement;
        const caption = target.innerText || "";
        this.setState({ caption }, () => this.updateAutocompleteState());
    };

    private onCaptionSelect = (): void => {
        this.updateAutocompleteState();
    };

    private updateAutocompleteState(): void {
        const root = this.captionRef.current;
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
                    selection: { start, end: caret },
                },
                () => {
                    // Ensure autocomplete list scrolls to bottom
                    window.setTimeout(() => {
                        const autocompleteWrapper = document.querySelector(".mx_ImageUploadDialog_autocompleteWrapper");
                        if (autocompleteWrapper) {
                            autocompleteWrapper.scrollTop = autocompleteWrapper.scrollHeight;
                        }
                    }, 0);
                },
            );
        } else {
            this.setState({ query: "", selection: { start: 0, end: 0 } });
        }
    }

    private onAutoCompleteConfirm = (completion: ICompletion): void => {
        const root = this.captionRef.current;
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

    private buildFormattedCaption = (): string => {
        const el = this.captionRef.current;
        return el ? el.innerHTML : "";
    };

    private onSendClick = (): void => {
        const captionFormatted = this.buildFormattedCaption();
        this.props.onFinished(true, this.state.selectedFiles, this.state.caption, captionFormatted);
    };

    private onCancelClick = (): void => {
        // Khi cancel, không gửi ảnh nào
        this.props.onFinished(false);
    };

    private onRemoveImage = (index: number): void => {
        const newSelectedFiles = [...this.state.selectedFiles];
        newSelectedFiles.splice(index, 1);
        
        if (newSelectedFiles.length === 0) {
            // Khi không còn ảnh nào, hủy việc gửi ảnh
            this.props.onFinished(false);
            return;
        }
        
        this.setState({ selectedFiles: newSelectedFiles });
    };

    public render(): React.ReactElement {
        const { selectedFiles } = this.state;
        const { caption, query, selection, room } = this.state;

        return (
            <BaseDialog
                className="mx_MultiImageUploadDialog"
                onFinished={this.onCancelClick}
                title={`${_t("image_upload|title_multiple")} (${selectedFiles.length})`}
            >
                <div className="mx_Dialog_content">
                    {/* Image previews in grid layout */}
                    <div className="mx_ImageUploadDialog_previewOuter">
                        {selectedFiles.length > 0 ? (
                            <div className="mx_ImageUploadDialog_previewInner">
                                {selectedFiles.map((file, index) => (
                                    <div key={index} className="mx_ImageUploadDialog_imagePreview">
                                        <div className="mx_ImageUploadDialog_imageContainer">
                                            <img
                                                src={URL.createObjectURL(file)}
                                                alt={file.name}
                                            />
                                            <button
                                                className="mx_ImageUploadDialog_removeButton"
                                                onClick={() => this.onRemoveImage(index)}
                                                aria-label={_t("image_upload|remove_image")}
                                            >
                                                ✕
                                            </button>
                                        </div>
                                        <div className="mx_ImageUploadDialog_fileInfo">
                                            <span className="mx_ImageUploadDialog_fileName">{file.name}</span>
                                            <span className="mx_ImageUploadDialog_fileSize">
                                                ({(file.size / 1024).toFixed(2)} KB)
                                            </span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="mx_ImageUploadDialog_emptyState">
                                <div className="mx_ImageUploadDialog_emptyIcon">
                                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                        <path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z" fill="currentColor"/>
                                    </svg>
                                </div>
                                <p className="mx_ImageUploadDialog_emptyText">Không còn ảnh nào được chọn</p>
                            </div>
                        )}
                    </div>

                    <div className="mx_ImageUploadDialog_captionSection">
                        <p className="mx_ImageUploadDialog_hint">
                            {_t("image_upload|hint")}
                        </p>
                        {room && query && (
                            <div className="mx_ImageUploadDialog_autocompleteWrapper">
                                <Autocomplete
                                    query={query}
                                    onConfirm={this.onAutoCompleteConfirm}
                                    selection={selection}
                                    room={room}
                                />
                            </div>
                        )}

                        <div className="mx_ImageUploadDialog_captionContainer">
                            <div
                                ref={this.captionRef}
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
                    disabled={selectedFiles.length === 0}
                />
            </BaseDialog>
        );
    }
}


