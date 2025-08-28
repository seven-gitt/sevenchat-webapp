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
import { REACTION_SHORTCODE_KEY } from "../messages/NewReactionsRow";
import { mediaFromMxc } from "../../../customisations/Media";

interface IProps {
    // The event we're displaying reactions for
    mxEvent: MatrixEvent;
    // The reaction content / key / emoji
    content: string;
    // A list of Matrix reaction events for this key
    reactionEvents: MatrixEvent[];
    // Whether to render custom image reactions
    customReactionImagesEnabled?: boolean;
    // Callback to close the dialog
    onFinished: () => void;
}

export default class ReactionListDialog extends React.PureComponent<IProps> {
    public static contextType = MatrixClientContext;
    declare public context: React.ContextType<typeof MatrixClientContext>;

    public render(): React.ReactNode {
        const { content, reactionEvents, mxEvent, onFinished } = this.props;
        const room = this.context.getRoom(mxEvent.getRoomId());

        if (!room || !reactionEvents.length) {
            return null;
        }

        // Get custom reaction name if available
        let customReactionName: string | undefined;
        if (this.props.customReactionImagesEnabled) {
            customReactionName = REACTION_SHORTCODE_KEY.findIn(reactionEvents[0]?.getContent()) || undefined;
        }

        // Prepare reaction display
        let reactionDisplay = (
            <span className="mx_ReactionListDialog_emoji">{content}</span>
        );

        if (this.props.customReactionImagesEnabled && content.startsWith("mxc://")) {
            const imageSrc = mediaFromMxc(content).srcHttp;
            if (imageSrc) {
                reactionDisplay = (
                    <img
                        className="mx_ReactionListDialog_customEmoji"
                        alt={customReactionName || _t("timeline|reactions|custom_reaction_fallback_label")}
                        src={imageSrc}
                        width="24"
                        height="24"
                    />
                );
            }
        }

        const title = reactionEvents.length === 1 
            ? "Ai đã react"
            : `${reactionEvents.length} người đã react`;

        return (
            <BaseDialog
                className="mx_ReactionListDialog"
                onFinished={onFinished}
                title={
                    <div className="mx_ReactionListDialog_header">
                        {reactionDisplay}
                        <span className="mx_ReactionListDialog_title">{title}</span>
                    </div>
                }
                contentId="mx_ReactionListDialog_content"
            >
                <div className="mx_ReactionListDialog_content" id="mx_ReactionListDialog_content">
                    <div className="mx_ReactionListDialog_list">
                        {reactionEvents.map((reactionEvent, index) => {
                            const sender = reactionEvent.getSender();
                            if (!sender) return null;

                            const member = room.getMember(sender);
                            const displayName = member?.name || sender;
                            const timestamp = new Date(reactionEvent.getTs()).toLocaleString();

                            return (
                                <div key={reactionEvent.getId() || index} className="mx_ReactionListDialog_listItem">
                                    <div className="mx_ReactionListDialog_userInfo">
                                        <MemberAvatar
                                            member={member}
                                            fallbackUserId={sender}
                                            size="32px"
                                            className="mx_ReactionListDialog_avatar"
                                        />
                                        <div className="mx_ReactionListDialog_userDetails">
                                            <div className="mx_ReactionListDialog_displayName">
                                                {displayName}
                                            </div>
                                            <div className="mx_ReactionListDialog_userId">
                                                {sender}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="mx_ReactionListDialog_timestamp">
                                        {timestamp}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </BaseDialog>
        );
    }
}
