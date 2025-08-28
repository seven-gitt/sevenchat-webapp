/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React from "react";
import { EventType, type MatrixEvent, RelationType } from "matrix-js-sdk/src/matrix";

import { _t } from "../../../languageHandler";
import dis from "../../../dispatcher/dispatcher";
import MatrixClientContext from "../../../contexts/MatrixClientContext";
import Modal from "../../../Modal";

interface IProps {
    // The event we're displaying reactions for
    mxEvent: MatrixEvent;
    // The reaction content / key / emoji
    content: string;
    // The count of votes for this key
    count: number;
    // A list of Matrix reaction events for this key
    reactionEvents: MatrixEvent[];
    // A possible Matrix event if the current user has voted for this type
    myReactionEvent?: MatrixEvent;
    // Whether to prevent quick-reactions by clicking on this reaction
    disabled?: boolean;
}

interface IState {
    showTooltip: boolean;
    isProcessing: boolean;
}

export default class NewReactionButton extends React.PureComponent<IProps, IState> {
    public static contextType = MatrixClientContext;
    declare public context: React.ContextType<typeof MatrixClientContext>;

    private isUnmounted = false;

    public constructor(props: IProps) {
        super(props);
        this.state = {
            showTooltip: false,
            isProcessing: false,
        };
    }

    public componentWillUnmount(): void {
        this.isUnmounted = true;
    }

    public onClick = async (): Promise<void> => {
        // Prevent multiple clicks while processing
        if (this.state.isProcessing || this.props.disabled) {
            return;
        }

        const { mxEvent, myReactionEvent, content } = this.props;
        const currentUserId = this.context.getUserId?.() ?? undefined;
        
        this.setState({ isProcessing: true });
        
        try {
            if (
                myReactionEvent &&
                !myReactionEvent.isRedacted() &&
                // Extra safety: only allow redacting reactions that we authored
                myReactionEvent.getSender?.() === currentUserId
            ) {
                // Remove existing reaction
                console.log("Removing reaction:", myReactionEvent.getId());
                await this.context.redactEvent(mxEvent.getRoomId()!, myReactionEvent.getId()!);
                console.log("Reaction removed successfully");
            } else {
                // Add new reaction
                console.log("Adding reaction:", content);
                const result = await this.context.sendEvent(mxEvent.getRoomId()!, EventType.Reaction, {
                    "m.relates_to": {
                        rel_type: RelationType.Annotation,
                        event_id: mxEvent.getId()!,
                        key: content,
                    },
                });
                console.log("Reaction added successfully:", result);
                dis.dispatch({ action: "message_sent" });
            }
        } catch (error) {
            console.error("Error handling reaction:", error);
            // Show user-friendly error message
            alert("Không thể xử lý reaction. Vui lòng thử lại.");
        } finally {
            // Reset processing state quickly to re-enable hover/tooltip
            setTimeout(() => {
                if (!this.isUnmounted) {
                    this.setState({ isProcessing: false });
                }
            }, 150);
        }
    };

    public onRightClick = (e: React.MouseEvent): void => {
        e.preventDefault();
        e.stopPropagation();
        this.showUserList();
    };

    public onMouseEnter = (): void => {
        this.setState({ showTooltip: true });
    };

    public onMouseLeave = (): void => {
        this.setState({ showTooltip: false });
    };

    private showUserList = (): void => {
        try {
            // Filter out redacted/invalid events before opening the dialog
            const validEvents = this.props.reactionEvents.filter((e) => !e.isRedacted());
            if (validEvents.length === 0) return;

            const UserListDialog = require("../dialogs/ReactionUserListDialog").default;
            Modal.createDialog(UserListDialog, {
                mxEvent: this.props.mxEvent,
                reactionKey: this.props.content,
                reactionEvents: validEvents,
            });
        } catch (e) {
            console.error("Failed to open ReactionUserListDialog", e);
        }
    };

    private getTooltipText = (): string => {
        const { reactionEvents } = this.props;
        const room = this.context.getRoom(this.props.mxEvent.getRoomId());
        
        if (!room || !reactionEvents.length) {
            return `React với ${this.props.content}`;
        }

        const senders: string[] = [];
        for (const reactionEvent of reactionEvents) {
            const member = room.getMember(reactionEvent.getSender()!);
            const name = member?.name || reactionEvent.getSender()!;
            senders.push(name);
        }

        if (senders.length === 1) {
            return `${senders[0]} đã react với ${this.props.content}`;
        } else if (senders.length <= 3) {
            return `${senders.join(", ")} đã react với ${this.props.content}`;
        } else {
            return `${senders.slice(0, 2).join(", ")} và ${senders.length - 2} người khác đã react với ${this.props.content}`;
        }
    };

    private renderTooltipContent = (): React.ReactNode => {
        const { reactionEvents } = this.props;
        const room = this.context.getRoom(this.props.mxEvent.getRoomId());
        
        if (!room || !reactionEvents.length) {
            return (
                <div style={{ textAlign: "center", fontSize: "12px", opacity: 0.8 }}>
                    Click để react
                </div>
            );
        }

        const senders: string[] = [];
        for (const reactionEvent of reactionEvents) {
            const member = room.getMember(reactionEvent.getSender()!);
            const name = member?.name || reactionEvent.getSender()!;
            senders.push(name);
        }

        return (
            <div style={{ textAlign: "left" }}>
                {senders.map((name, index) => (
                    <div 
                        key={index}
                        style={{ 
                            fontSize: "13px", 
                            lineHeight: "1.5",
                            padding: "2px 0"
                        }}
                    >
                        {name}
                    </div>
                ))}
            </div>
        );
    };

    public render(): React.ReactNode {
        const { content, count, myReactionEvent, disabled } = this.props;
        const { isProcessing } = this.state;
        
        const isSelected = !!myReactionEvent;
        const isDisabled = disabled; // Cho phép hover/tooltip ngay cả khi đang xử lý
        const tooltipText = this.getTooltipText();

        // Keep the button visible while processing to avoid visual jumps.



        return (
            <div style={{ position: "relative", display: "inline-block" }}>
                <button
                    className={`mx_NewReactionButton ${isSelected ? 'mx_NewReactionButton_selected' : ''} ${isProcessing ? 'mx_NewReactionButton_processing' : ''}`}
                    onClick={this.onClick}
                    onContextMenu={this.onRightClick}
                    onMouseEnter={this.onMouseEnter}
                    onMouseLeave={this.onMouseLeave}
                    disabled={isDisabled}
                    aria-label={isProcessing ? "Đang xử lý..." : tooltipText}
                    type="button"
                >
                    <span className="mx_NewReactionButton_emoji">{content}</span>
                    <span className="mx_NewReactionButton_count">{count}</span>
                </button>
                {this.state.showTooltip && (
                    <div 
                        className="mx_NewReactionButton_tooltip"
                        style={{
                            position: "absolute",
                            bottom: "100%",
                            left: "50%",
                            transform: "translateX(-50%)",
                            backgroundColor: "var(--cpd-color-bg-canvas-default)",
                            color: "var(--cpd-color-text-primary)",
                            padding: "8px 12px",
                            borderRadius: "8px",
                            fontSize: "13px",
                            fontWeight: "400",
                            zIndex: 1000,
                            marginBottom: "8px",
                            boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
                            border: "1px solid var(--cpd-color-border-interactive-secondary)",
                            minWidth: "100px",
                            maxWidth: "180px",
                            maxHeight: "200px",
                            overflowY: "auto"
                        }}
                    >
                        {this.renderTooltipContent()}
                    </div>
                )}
            </div>
        );
    }
}
