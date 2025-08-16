import React, { useMemo, useState } from "react";
import BaseCard from "./BaseCard";
import { _t } from "../../../languageHandler";
import { type Room, type MatrixEvent, type RoomMember } from "matrix-js-sdk/src/matrix";
import MemberAvatar from "../avatars/MemberAvatar";

interface Props {
    room: Room;
    onClose: () => void;
}

const URL_REGEX = /https?:\/\/[\w\-._~:/?#[\]@!$&'()*+,;=%]+/gi;

function extractUrlsFromEvent(ev: MatrixEvent): string[] {
    if (ev.getType() !== "m.room.message") return [];
    const content = ev.getContent();
    if (typeof content.body !== "string") return [];
    return content.body.match(URL_REGEX) || [];
}

const UrlsPanel: React.FC<Props> = ({ room, onClose }) => {
    const [selectedSender, setSelectedSender] = useState<string>("all");

    // Lấy tất cả events từ liveTimeline và pending events
    const events: MatrixEvent[] = [
        ...(room.getLiveTimeline().getEvents?.() || []),
        ...(room.getPendingEvents?.() || []),
    ];
    // Sắp xếp events theo thời gian giảm dần (mới nhất trước)
    events.sort((a, b) => b.getTs() - a.getTs());

    // Lọc ra các event có chứa URL
    const urlEvents = events
        .map(ev => ({
            ev,
            urls: extractUrlsFromEvent(ev),
        }))
        .filter(item => item.urls.length > 0);

    // Lấy danh sách người gửi có gửi URL
    const senders = useMemo(() => {
        const map = new Map<string, RoomMember | undefined>();
        urlEvents.forEach(({ev}) => {
            const userId = ev.getSender();
            if (userId && !map.has(userId)) {
                const member = room.getMember?.(userId) || undefined;
                map.set(userId, member);
            }
        });
        return Array.from(map.entries());
    }, [urlEvents, room]);

    // Lọc theo người gửi nếu đã chọn
    const filteredUrlEvents = selectedSender === "all"
        ? urlEvents
        : urlEvents.filter(item => item.ev.getSender() === selectedSender);

    return (
        <BaseCard
            className="mx_UrlsPanel"
            onClose={onClose}
            header="Link"
        >
            <div style={{padding: 16, paddingBottom: 0}}>
                <label style={{fontWeight: 500, marginRight: 8}}>Lọc theo người gửi:</label>
                <select
                    value={selectedSender}
                    onChange={e => setSelectedSender(e.target.value)}
                    style={{padding: '4px 8px', borderRadius: 4, minWidth: 120}}
                >
                    <option value="all">Tất cả</option>
                    {senders.map(([userId, member]) => (
                        <option value={userId} key={userId}>
                            {member ? member.name || userId : userId}
                        </option>
                    ))}
                </select>
                {selectedSender !== "all" && (
                    <span style={{marginLeft: 8, verticalAlign: 'middle'}}>
                        {(() => {
                            const member = senders.find(([id]) => id === selectedSender)?.[1];
                            if (member !== undefined) {
                                return <MemberAvatar member={member} size="20" style={{display: 'inline-block', verticalAlign: 'middle', marginRight: 4}} />;
                            }
                            return null;
                        })()}
                    </span>
                )}
            </div>
            {filteredUrlEvents.length === 0 ? (
                <div className="mx_RoomView_empty">
                    <div style={{textAlign: 'center', marginTop: 40}}>
                        <div style={{fontSize: 24, marginBottom: 16}}>🔗</div>
                        <div style={{fontWeight: 600, marginBottom: 8}}>
                            Chưa có đường dẫn nào trong phòng này
                        </div>
                        <div style={{color: '#888'}}>Các đường dẫn được gửi trong phòng sẽ hiển thị tại đây.</div>
                    </div>
                </div>
            ) : (
                <div style={{padding: 16}}>
                    <ul style={{listStyle: 'none', padding: 0, margin: 0}}>
                        {filteredUrlEvents.map(({ev, urls}, idx) => (
                            urls.map((url, i) => (
                                <li key={ev.getId() + '-' + i} style={{marginBottom: 16, borderBottom: '1px solid #eee', paddingBottom: 8}}>
                                    <div>
                                        <a href={url} target="_blank" rel="noopener noreferrer" style={{color: '#1976d2', wordBreak: 'break-all'}}>{url}</a>
                                    </div>
                                    <div style={{fontSize: 12, color: '#888', marginTop: 2}}>
                                        {ev.getSender() || "(unknown)"} &bull; {new Date(ev.getTs()).toLocaleString()}
                                    </div>
                                </li>
                            ))
                        ))}
                    </ul>
                </div>
            )}
        </BaseCard>
    );
};

export default UrlsPanel; 