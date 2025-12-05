/*
Copyright 2024 New Vector Ltd.
Copyright 2021 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useState } from "react";
import { type Room, EventType, type MatrixClient } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { _t } from "../../../languageHandler";
import AccessibleButton from "../elements/AccessibleButton";
import SpaceBasicSettings from "./SpaceBasicSettings";
import { avatarUrlForRoom } from "../../../Avatar";
import { htmlSerializeFromMdIfNeeded } from "../../../editor/serialize";
import { getTopic } from "../../../hooks/room/useTopic";
import SettingsTab from "../settings/tabs/SettingsTab";
import { SettingsSection } from "../settings/shared/SettingsSection";
import { SettingsSubsection } from "../settings/shared/SettingsSubsection";
import Modal from "../../../Modal";
import QuestionDialog from "../dialogs/QuestionDialog";
import ErrorDialog from "../dialogs/ErrorDialog";
import { leaveRoomBehaviour, leaveSpace } from "../../../utils/leave-behaviour";
import dis from "../../../dispatcher/dispatcher";
import { Action } from "../../../dispatcher/actions";
import { type AfterLeaveRoomPayload } from "../../../dispatcher/payloads/AfterLeaveRoomPayload";
import SpaceStore from "../../../stores/spaces/SpaceStore";

interface IProps {
    matrixClient: MatrixClient;
    space: Room;
}

const SpaceSettingsGeneralTab: React.FC<IProps> = ({ matrixClient: cli, space }) => {
    const [busy, setBusy] = useState(false);
    const [deleteBusy, setDeleteBusy] = useState(false);
    const [error, setError] = useState("");

    const userId = cli.getUserId()!;
    const myPowerLevel = space.getMember(userId)?.powerLevel ?? 0;
    const canDeleteSpace = myPowerLevel >= 100;

    const [newAvatar, setNewAvatar] = useState<File | null | undefined>(null); // undefined means to remove avatar
    const canSetAvatar = space.currentState.maySendStateEvent(EventType.RoomAvatar, userId);
    const avatarChanged = newAvatar !== null;

    const [name, setName] = useState<string>(space.name);
    const canSetName = space.currentState.maySendStateEvent(EventType.RoomName, userId);
    const nameChanged = name !== space.name;

    const currentTopic = getTopic(space)?.text ?? "";
    const [topic, setTopic] = useState(currentTopic);
    const canSetTopic = space.currentState.maySendStateEvent(EventType.RoomTopic, userId);
    const topicChanged = topic !== currentTopic;

    const isFormBusy = busy || deleteBusy;

    const onCancel = (): void => {
        setNewAvatar(null);
        setName(space.name);
        setTopic(currentTopic);
    };

    const onSave = async (): Promise<void> => {
        setBusy(true);
        const promises: Promise<unknown>[] = [];

        if (avatarChanged) {
            if (newAvatar) {
                promises.push(
                    (async (): Promise<void> => {
                        const { content_uri: url } = await cli.uploadContent(newAvatar);
                        await cli.sendStateEvent(space.roomId, EventType.RoomAvatar, { url }, "");
                    })(),
                );
            } else {
                promises.push(cli.sendStateEvent(space.roomId, EventType.RoomAvatar, {}, ""));
            }
        }

        if (nameChanged) {
            promises.push(cli.setRoomName(space.roomId, name));
        }

        if (topicChanged) {
            const htmlTopic = htmlSerializeFromMdIfNeeded(topic, { forceHTML: false });
            promises.push(cli.setRoomTopic(space.roomId, topic, htmlTopic));
        }

        const results = await Promise.allSettled(promises);
        setBusy(false);
        const failures = results.filter((r) => r.status === "rejected");
        if (failures.length > 0) {
            logger.error("Failed to save space settings: ", failures);
            setError(_t("room_settings|general|error_save_space_settings"));
        }
    };

    const getDescendantRooms = (): Room[] => {
        const visited = new Set<string>([space.roomId]);
        const roomsToDelete: Room[] = [];

        const traverse = (currentSpace: Room): void => {
            const children = SpaceStore.instance.getChildren(currentSpace.roomId);
            children.forEach((child) => {
                if (visited.has(child.roomId)) return;
                visited.add(child.roomId);
                if (child.isSpaceRoom()) {
                    traverse(child);
                    roomsToDelete.push(child);
                } else {
                    roomsToDelete.push(child);
                }
            });
        };

        traverse(space);
        return roomsToDelete;
    };

    const deleteRoomAndMembers = async (roomToDelete: Room, reason: string): Promise<void> => {
        const members = roomToDelete.getJoinedMembers().filter((member) => member.userId !== userId);
        for (const member of members) {
            await cli.kick(roomToDelete.roomId, member.userId, reason);
        }
        await cli.leave(roomToDelete.roomId);
    };

    const onDeleteSpace = (): void => {
        const spaceDisplayName = space.name || _t("common|unnamed_space");
        const { finished } = Modal.createDialog(QuestionDialog, {
            title: _t("room_settings|general|delete_space_confirm_title", { spaceName: spaceDisplayName }),
            description: _t("room_settings|general|delete_space_confirm_description"),
            button: _t("action|delete"),
            danger: true,
        });

        finished.then(async ([confirmed]) => {
            if (!confirmed) return;

            setDeleteBusy(true);
            try {
                const deleteReason = _t("room_settings|general|delete_space_reason");
                const childRooms = getDescendantRooms();
                for (const child of childRooms) {
                    await deleteRoomAndMembers(child, deleteReason);
                }

                const members = space
                    .getJoinedMembers()
                    .filter((member) => member.userId !== userId);
                for (const member of members) {
                    await cli.kick(
                        space.roomId,
                        member.userId,
                        deleteReason,
                    );
                }

                await leaveRoomBehaviour(cli, space.roomId);
                dis.dispatch<AfterLeaveRoomPayload>({
                    action: Action.AfterLeaveRoom,
                    room_id: space.roomId,
                });
            } catch (e) {
                logger.error("Failed to delete space:", e);
                setDeleteBusy(false);
                Modal.createDialog(ErrorDialog, {
                    title: _t("common|error"),
                    description: _t("room_settings|general|delete_space_error"),
                });
            }
        });
    };

    return (
        <SettingsTab>
            <SettingsSection heading={_t("common|general")}>
                <div>
                    <div>{_t("room_settings|general|description_space")}</div>

                    {error && <div className="mx_SpaceRoomView_errorText">{error}</div>}

                    <SpaceBasicSettings
                        avatarUrl={avatarUrlForRoom(space, 80, 80, "crop") ?? undefined}
                        avatarDisabled={isFormBusy || !canSetAvatar}
                        setAvatar={setNewAvatar}
                        name={name}
                        nameDisabled={isFormBusy || !canSetName}
                        setName={setName}
                        topic={topic}
                        topicDisabled={isFormBusy || !canSetTopic}
                        setTopic={setTopic}
                    />

                    <AccessibleButton
                        onClick={onCancel}
                        disabled={isFormBusy || !(avatarChanged || nameChanged || topicChanged)}
                        kind="link"
                    >
                        {_t("action|cancel")}
                    </AccessibleButton>
                    <AccessibleButton onClick={onSave} disabled={isFormBusy} kind="primary">
                        {busy ? _t("common|saving") : _t("room_settings|general|save")}
                    </AccessibleButton>
                </div>

                <SettingsSubsection>
                    <div className="mx_SpaceSettingsGeneralTab_actions">
                        <AccessibleButton
                            kind="danger"
                            disabled={isFormBusy}
                            onClick={() => {
                                leaveSpace(space);
                            }}
                        >
                            {_t("room_settings|general|leave_space")}
                        </AccessibleButton>
                        {canDeleteSpace && (
                            <AccessibleButton
                                kind="danger"
                                onClick={onDeleteSpace}
                                disabled={isFormBusy}
                            >
                                {_t("room_settings|general|delete_space")}
                            </AccessibleButton>
                        )}
                    </div>
                </SettingsSubsection>
            </SettingsSection>
        </SettingsTab>
    );
};

export default SpaceSettingsGeneralTab;
