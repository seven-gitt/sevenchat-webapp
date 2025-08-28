/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React from "react";
import { type MatrixEvent } from "matrix-js-sdk/src/matrix";

import BaseDialog from "./BaseDialog";
import { _t } from "../../../languageHandler";
import MemberAvatar from "../avatars/MemberAvatar";
import MatrixClientContext from "../../../contexts/MatrixClientContext";

interface IProps {
    // The event we're displaying reactions for
    mxEvent: MatrixEvent;
    // The reaction key/emoji
    reactionKey: string;
    // List of reaction events for this emoji
    reactionEvents: MatrixEvent[];
    // Callback to close the dialog
    onFinished: () => void;
}

interface IUserReaction {
    userId: string;
    displayName: string;
    avatarUrl?: string;
    timestamp: number;
    member?: any;
}

export default class ReactionUserListDialog extends React.PureComponent<IProps> {
    public static contextType = MatrixClientContext;
    declare public context: React.ContextType<typeof MatrixClientContext>;

    private getUserReactions(): IUserReaction[] {
        const { reactionEvents } = this.props;
        const room = this.context.getRoom(this.props.mxEvent.getRoomId());
        
        if (!room) {
            return [];
        }

        return reactionEvents
            .map((event) => {
                const sender = event.getSender();
                if (!sender) return null;

                const member = room.getMember(sender);
                return {
                    userId: sender,
                    displayName: member?.name || sender,
                    avatarUrl: member?.getMxcAvatarUrl(),
                    timestamp: event.getTs(),
                    member: member,
                };
            })
            .filter(Boolean)
            .sort((a, b) => a!.timestamp - b!.timestamp) as IUserReaction[];
    }

    private formatTimestamp(timestamp: number): string {
        const date = new Date(timestamp);
        const now = new Date();
        
        // If today, show time only
        if (date.toDateString() === now.toDateString()) {
            return date.toLocaleTimeString('vi-VN', { 
                hour: '2-digit', 
                minute: '2-digit' 
            });
        }
        
        // If this year, show date and time
        if (date.getFullYear() === now.getFullYear()) {
            return date.toLocaleDateString('vi-VN', { 
                month: 'short', 
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
        }
        
        // Show full date and time
        return date.toLocaleDateString('vi-VN', { 
            year: 'numeric',
            month: 'short', 
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    public render(): React.ReactNode {
        const { reactionKey, onFinished } = this.props;
        const userReactions = this.getUserReactions();

        const title = userReactions.length === 1 
            ? `1 người đã react với ${reactionKey}`
            : `${userReactions.length} người đã react với ${reactionKey}`;

        return (
            <BaseDialog
                className="mx_ReactionUserListDialog"
                onFinished={onFinished}
                title={title}
                contentId="mx_ReactionUserListDialog_content"
            >
                <div className="mx_ReactionUserListDialog_content" id="mx_ReactionUserListDialog_content">
                    {userReactions.length === 0 ? (
                        <div className="mx_ReactionUserListDialog_empty">
                            Không có ai react với emoji này
                        </div>
                    ) : (
                        <div className="mx_ReactionUserListDialog_list">
                            {userReactions.map((userReaction) => (
                                <div key={userReaction.userId} className="mx_ReactionUserListDialog_listItem">
                                    <div className="mx_ReactionUserListDialog_userInfo">
                                        <MemberAvatar
                                            member={userReaction.member}
                                            fallbackUserId={userReaction.userId}
                                            size="40px"
                                            className="mx_ReactionUserListDialog_avatar"
                                        />
                                        <div className="mx_ReactionUserListDialog_userDetails">
                                            <div className="mx_ReactionUserListDialog_displayName">
                                                {userReaction.displayName}
                                            </div>
                                            <div className="mx_ReactionUserListDialog_userId">
                                                {userReaction.userId}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="mx_ReactionUserListDialog_timestamp">
                                        {this.formatTimestamp(userReaction.timestamp)}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </BaseDialog>
        );
    }
}
