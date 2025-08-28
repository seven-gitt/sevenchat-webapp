/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type MatrixEvent, type Relations, RelationsEvent, MatrixEventEvent } from "matrix-js-sdk/src/matrix";
import { uniqBy } from "lodash";
import { UnstableValue } from "matrix-js-sdk/src/NamespacedValue";

import { _t } from "../../../languageHandler";
import { isContentActionable } from "../../../utils/EventUtils";

export const REACTION_SHORTCODE_KEY = new UnstableValue("shortcode", "com.beeper.reaction.shortcode");
import NewReactionButton from "./NewReactionButton";
import RoomContext from "../../../contexts/RoomContext";
import AccessibleButton from "../elements/AccessibleButton";

interface IProps {
    // The event we're displaying reactions for
    mxEvent: MatrixEvent;
    // The Relations model from the JS SDK for reactions to `mxEvent`
    reactions?: Relations | null | undefined;
}

interface IState {
    myReactions: MatrixEvent[] | null;
    showAll: boolean;
}



export default class NewReactionsRow extends React.PureComponent<IProps, IState> {
    public static contextType = RoomContext;
    declare public context: React.ContextType<typeof RoomContext>;

    private readonly MAX_VISIBLE_REACTIONS = 8;

    public constructor(props: IProps, context: React.ContextType<typeof RoomContext>) {
        super(props, context);

        this.state = {
            myReactions: this.getMyReactions(),
            showAll: false,
        };
    }

    public componentDidMount(): void {
        const { mxEvent, reactions } = this.props;

        if (mxEvent.isBeingDecrypted() || mxEvent.shouldAttemptDecryption()) {
            mxEvent.once(MatrixEventEvent.Decrypted, this.onDecrypted);
        }

        if (reactions) {
            reactions.on(RelationsEvent.Add, this.onReactionsChange);
            reactions.on(RelationsEvent.Remove, this.onReactionsChange);
            reactions.on(RelationsEvent.Redaction, this.onReactionsChange);
        }
    }

    public componentWillUnmount(): void {
        const { mxEvent, reactions } = this.props;

        mxEvent.off(MatrixEventEvent.Decrypted, this.onDecrypted);

        if (reactions) {
            reactions.off(RelationsEvent.Add, this.onReactionsChange);
            reactions.off(RelationsEvent.Remove, this.onReactionsChange);
            reactions.off(RelationsEvent.Redaction, this.onReactionsChange);
        }
    }

    public componentDidUpdate(prevProps: IProps): void {
        if (this.props.reactions && prevProps.reactions !== this.props.reactions) {
            this.props.reactions.on(RelationsEvent.Add, this.onReactionsChange);
            this.props.reactions.on(RelationsEvent.Remove, this.onReactionsChange);
            this.props.reactions.on(RelationsEvent.Redaction, this.onReactionsChange);
            this.onReactionsChange();
        }
    }

    private onDecrypted = (): void => {
        this.forceUpdate();
    };

    private onReactionsChange = (): void => {
        this.setState({
            myReactions: this.getMyReactions(),
        });
        this.forceUpdate();
    };

    private getMyReactions(): MatrixEvent[] | null {
        const reactions = this.props.reactions;
        if (!reactions) {
            return null;
        }
        const userId = this.context.room?.client.getUserId();
        if (!userId) return null;
        const myReactions = reactions.getAnnotationsBySender()?.[userId];
        if (!myReactions) {
            return null;
        }
        return [...myReactions.values()];
    }

    private onShowAllClick = (): void => {
        this.setState({ showAll: true });
    };

    public render(): React.ReactNode {
        const { mxEvent, reactions } = this.props;
        const { myReactions, showAll } = this.state;



        if (!reactions || !isContentActionable(mxEvent)) {
            return null;
        }

        // Get all reaction data
        let reactionItems = reactions
            .getSortedAnnotationsByKey()
            ?.map(([content, events]) => {
                const count = events.size;
                if (!count) {
                    return null;
                }

                // Deduplicate events by sender
                const deduplicatedEvents = uniqBy([...events], (e) => e.getSender());
                
                // Find my reaction for this emoji
                const myReactionEvent = myReactions?.find((mxEvent) => {
                    if (mxEvent.isRedacted()) {
                        return false;
                    }
                    return mxEvent.getRelation()?.key === content;
                });

                return (
                    <NewReactionButton
                        key={content}
                        mxEvent={mxEvent}
                        content={content}
                        count={deduplicatedEvents.length}
                        reactionEvents={deduplicatedEvents}
                        myReactionEvent={myReactionEvent}
                        disabled={!this.context.canReact || 
                            (myReactionEvent && !myReactionEvent.isRedacted() && !this.context.canSelfRedact)}
                    />
                );
            })
            .filter(Boolean);

        if (!reactionItems?.length) {
            return null;
        }

        // Handle show more/less functionality
        let showAllButton: JSX.Element | undefined;
        if (reactionItems.length > this.MAX_VISIBLE_REACTIONS + 1 && !showAll) {
            reactionItems = reactionItems.slice(0, this.MAX_VISIBLE_REACTIONS);
            showAllButton = (
                <AccessibleButton 
                    kind="link_inline" 
                    className="mx_NewReactionsRow_showAll" 
                    onClick={this.onShowAllClick}
                >
                    Hiển thị tất cả
                </AccessibleButton>
            );
        }

        return (
            <div className="mx_NewReactionsRow" role="toolbar" aria-label="Reactions">
                {reactionItems}
                {showAllButton}
            </div>
        );
    }
}
