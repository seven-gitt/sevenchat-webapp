/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, {
    type FormEvent,
    type MouseEvent as ReactMouseEvent,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
} from "react";

import BaseDialog from "./BaseDialog";
import DialogButtons from "../elements/DialogButtons";
import { _t } from "../../../languageHandler";

import type { ReminderPayload, ReminderRepeat } from "../../../reminders/index";

interface IProps {
    onFinished(ok?: false): void;
    onFinished(ok: true, result: ReminderPayload): void;
    initialReminder?: ReminderPayload;
    title?: string;
    primaryButtonLabel?: string;
}

const HOURS = Array.from({ length: 24 }, (_, idx) => idx);
const MINUTES = Array.from({ length: 60 }, (_, idx) => idx);

function padTime(value: number): string {
    return value.toString().padStart(2, "0");
}

function formatDateForInput(date: Date): string {
    const year = date.getFullYear();
    const month = padTime(date.getMonth() + 1);
    const day = padTime(date.getDate());
    return `${year}-${month}-${day}`;
}

function getDefaultDate(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = padTime(now.getMonth() + 1);
    const day = padTime(now.getDate());
    return `${year}-${month}-${day}`;
}

const ReminderDialog: React.FC<IProps> = ({
    onFinished,
    initialReminder,
    title,
    primaryButtonLabel,
}) => {
    const initialDate = useMemo(
        () => (initialReminder ? new Date(initialReminder.datetime) : new Date()),
        [initialReminder?.datetime],
    );
    const [content, setContent] = useState(initialReminder?.content ?? "");
    const [date, setDate] = useState<string>(() =>
        initialReminder ? formatDateForInput(initialDate) : getDefaultDate(),
    );
    const [hour, setHour] = useState<number>(initialDate.getHours());
    const [minute, setMinute] = useState<number>(initialDate.getMinutes());
    const [repeat, setRepeat] = useState<ReminderRepeat>(initialReminder?.repeat ?? "none");
    const [isTimePickerOpen, setIsTimePickerOpen] = useState(false);

    const timeDisplayRef = useRef<HTMLButtonElement | null>(null);
    const timePickerRef = useRef<HTMLDivElement | null>(null);
    const timePickerId = useId();

    const canSubmit = content.trim().length > 0;

    const formattedTime = useMemo(() => `${padTime(hour)}:${padTime(minute)}`, [hour, minute]);

    const dialogTitle = title ?? _t("reminder|create_title");
    const primaryButtonText = primaryButtonLabel ?? _t("reminder|create_action");

    useEffect(() => {
        if (!isTimePickerOpen) {
            return undefined;
        }

        const handleClickOutside = (event: globalThis.MouseEvent): void => {
            const target = event.target as Node;

            if (
                !timePickerRef.current?.contains(target) &&
                !timeDisplayRef.current?.contains(target)
            ) {
                setIsTimePickerOpen(false);
            }
        };

        document.addEventListener("mousedown", handleClickOutside);

        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, [isTimePickerOpen]);

    const onSubmit = (event?: FormEvent | ReactMouseEvent): void => {
        event?.preventDefault();
        if (!canSubmit) return;

        const selectedDate = new Date(date);
        selectedDate.setHours(hour, minute, 0, 0);

        onFinished(true, {
            content: content.trim(),
            datetime: selectedDate.toISOString(),
            repeat,
        });
    };

    const onCancel = (): void => onFinished(false);

    return (
        <BaseDialog
            className="mx_ReminderDialog"
            onFinished={onFinished}
            title={dialogTitle}
            fixedWidth={false}
        >
            <form onSubmit={onSubmit} className="mx_ReminderDialog_form">
                <div className="mx_ReminderDialog_section">
                    <label className="mx_ReminderDialog_label" htmlFor="reminder-content">
                        {_t("reminder|content_label")}
                    </label>
                    <textarea
                        id="reminder-content"
                        className="mx_ReminderDialog_textarea"
                        placeholder={_t("reminder|content_placeholder")}
                        value={content}
                        onChange={(event) => setContent(event.target.value)}
                        rows={3}
                        autoFocus
                    />
                </div>
                <div className="mx_ReminderDialog_section">
                    <label className="mx_ReminderDialog_label" htmlFor="reminder-date">
                        {_t("reminder|date_label")}
                    </label>
                    <input
                        id="reminder-date"
                        className="mx_ReminderDialog_dateInput"
                        type="date"
                        value={date}
                        onChange={(event) => setDate(event.target.value)}
                    />
                </div>
                <div className="mx_ReminderDialog_section">
                    <div className="mx_ReminderDialog_timeHeader">
                        <span className="mx_ReminderDialog_label">{_t("reminder|time_label")}</span>
                        <div className="mx_ReminderDialog_timePickerWrapper">
                            <button
                                type="button"
                                ref={timeDisplayRef}
                                className="mx_ReminderDialog_timeDisplay"
                                onClick={() => setIsTimePickerOpen((open) => !open)}
                                aria-haspopup="listbox"
                                aria-expanded={isTimePickerOpen}
                                aria-controls={isTimePickerOpen ? timePickerId : undefined}
                            >
                                <span className="mx_ReminderDialog_timeIcon" aria-hidden />
                                {formattedTime}
                            </button>
                            {isTimePickerOpen && (
                                <div
                                    id={timePickerId}
                                    ref={timePickerRef}
                                    className="mx_ReminderDialog_timePicker"
                                >
                                    <div
                                        className="mx_ReminderDialog_timeColumn"
                                        role="listbox"
                                        aria-label={_t("reminder|hours_label")}
                                    >
                                        {HOURS.map((value) => (
                                            <button
                                                key={`hour-${value}`}
                                                type="button"
                                                className={
                                                    "mx_ReminderDialog_timeOption" +
                                                    (value === hour ? " mx_ReminderDialog_timeOption--active" : "")
                                                }
                                                onClick={() => setHour(value)}
                                            >
                                                {padTime(value)}
                                            </button>
                                        ))}
                                    </div>
                                    <div
                                        className="mx_ReminderDialog_timeColumn"
                                        role="listbox"
                                        aria-label={_t("reminder|minutes_label")}
                                    >
                                        {MINUTES.map((value) => (
                                            <button
                                                key={`minute-${value}`}
                                                type="button"
                                                className={
                                                    "mx_ReminderDialog_timeOption" +
                                                    (value === minute ? " mx_ReminderDialog_timeOption--active" : "")
                                                }
                                                onClick={() => setMinute(value)}
                                            >
                                                {padTime(value)}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
                <div className="mx_ReminderDialog_section">
                    <label className="mx_ReminderDialog_label" htmlFor="reminder-repeat">
                        {_t("reminder|repeat_label")}
                    </label>
                    <select
                        id="reminder-repeat"
                        className="mx_ReminderDialog_select"
                        value={repeat}
                        onChange={(event) => setRepeat(event.target.value as ReminderRepeat)}
                    >
                        <option value="none">{_t("reminder|repeat_none")}</option>
                        <option value="daily">{_t("reminder|repeat_daily")}</option>
                        <option value="weekly">{_t("reminder|repeat_weekly")}</option>
                        <option value="monthly">{_t("reminder|repeat_monthly")}</option>
                    </select>
                </div>
            </form>
            <DialogButtons
                primaryButton={primaryButtonText}
                onPrimaryButtonClick={onSubmit}
                onCancel={onCancel}
                hasCancel={true}
                primaryDisabled={!canSubmit}
            />
        </BaseDialog>
    );
};

export default ReminderDialog;