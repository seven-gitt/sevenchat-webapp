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
import type { ISelectionRange } from "../../../autocomplete/Autocompleter";
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
    };

    private onEditableInput = (ev: React.FormEvent<HTMLDivElement>): void => {
        const target = ev.target as HTMLDivElement;
        const caption = target.innerText || "";
        this.setState({ caption });
    };

    private onCaptionSelect = (): void => {
        const el = this.captionRef.current;
        if (!el) return;

        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;

        const range = selection.getRangeAt(0);
        const preCaretRange = range.cloneRange();
        preCaretRange.selectNodeContents(el);
        preCaretRange.setEnd(range.endContainer, range.endOffset);
        const end = preCaretRange.toString().length;

        preCaretRange.setStart(el, 0);
        preCaretRange.setEnd(range.startContainer, range.startOffset);
        const start = preCaretRange.toString().length;

        this.setState({ selection: { start, end } });
    };

    private onAutoCompleteConfirm = (completion: any): void => {
        const el = this.captionRef.current;
        if (!el) return;

        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;

        const range = selection.getRangeAt(0);
        const mentionNode = document.createElement("a");
        mentionNode.setAttribute("data-mention-type", "user");
        mentionNode.setAttribute("href", completion.href);
        mentionNode.textContent = completion.completion;

        range.deleteContents();
        range.insertNode(mentionNode);

        // Add space after mention
        const spaceNode = document.createTextNode("\u00A0\u200B");
        range.setStartAfter(mentionNode);
        range.insertNode(spaceNode);
        range.setStartAfter(spaceNode);

        selection.removeAllRanges();
        selection.addRange(range);

        this.setState({ query: "" });
        this.onEditableInput({ target: el } as any);
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
                        <div
                            ref={this.captionRef}
                            className="mx_ImageUploadDialog_captionInput"
                            contentEditable
                            onInput={this.onEditableInput}
                            onSelect={this.onCaptionSelect}
                            onKeyDown={this.onCaptionKeyDown}
                            data-placeholder={_t("image_upload|caption_placeholder")}
                        />
                    </div>

                    {room && (
                        <div className="mx_ImageUploadDialog_autocompleteWrapper">
                            <Autocomplete
                                query={query}
                                selection={selection}
                                onConfirm={this.onAutoCompleteConfirm}
                                room={room}
                            />
                        </div>
                    )}
                </div>

                <DialogButtons
                    primaryButton="Send"
                    cancelButton="Cancel"
                    onPrimaryButtonClick={this.onSendClick}
                    onCancel={this.onCancelClick}
                    focus={false}
                    disabled={selectedFiles.length === 0}
                />
            </BaseDialog>
        );
    }
}


