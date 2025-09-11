import React, { useContext, useEffect, useMemo, useRef, useState } from "react";
import BaseCard from "./BaseCard";
import { _t } from "../../../languageHandler";
import { type Room, type MatrixEvent, type RoomMember, Direction } from "matrix-js-sdk/src/matrix";
import MemberAvatar from "../avatars/MemberAvatar";
import MatrixClientContext from "../../../contexts/MatrixClientContext";

interface Props {
    room: Room;
    onClose: () => void;
}

// Regex để nhận diện URL có protocol
const URL_WITH_PROTOCOL_REGEX = /https?:\/\/[\w\-._~:/?#[\]@!$&'()*+,;=%]+/gi;
// Regex để nhận diện domain pattern (ví dụ: example.com, sub.example.com)
// Chỉ nhận diện domain có ít nhất 2 phần và phần cuối có ít nhất 2 ký tự
// Loại bỏ các pattern số tiền (ví dụ: 168.000, 1.000.000)
const DOMAIN_REGEX = /\b(?:[a-zA-Z][\w-]*\.)+[a-zA-Z][\w-]{2,}\b(?:\/[\w\-._~:/?#[\]@!$&'()*+,;=%]*)?/gi;

interface UrlInfo {
    original: string;
    processed: string;
}

// Hàm kiểm tra xem có phải là số tiền không
function isCurrencyAmount(text: string): boolean {
    // Pattern cho số tiền: có thể có dấu phẩy, chấm, hoặc khoảng trắng làm phân cách hàng nghìn
    // Ví dụ: 168.000, 1,000, 1 000, 1000.50, 1,000.50
    const currencyPattern = /^\d{1,3}([.,\s]\d{3})*([.,]\d{2})?$/;
    return currencyPattern.test(text);
}

function extractUrlsFromEvent(ev: MatrixEvent): UrlInfo[] {
    if (ev.getType() !== "m.room.message") return [];
    const content = ev.getContent();
    if (typeof content.body !== "string") return [];
    
    // Kiểm tra xem tin nhắn có phải là media message không
    const msgtype = content.msgtype;
    if (msgtype === "m.image" || msgtype === "m.video" || msgtype === "m.audio" || msgtype === "m.file") {
        return []; // Không extract URL từ media messages
    }
    
    const urls: UrlInfo[] = [];
    
    // Tìm URL có protocol
    const protocolMatches = content.body.match(URL_WITH_PROTOCOL_REGEX) || [];
    protocolMatches.forEach(url => {
        // Lọc bỏ các URL của file media
        if (!isMediaUrl(url)) {
            urls.push({ original: url, processed: url });
        }
    });
    
    // Tìm domain patterns và loại bỏ những cái đã có protocol
    const domainMatches = content.body.match(DOMAIN_REGEX) || [];
    const protocolDomains = new Set(protocolMatches.map(url => {
        try {
            return new URL(url).hostname;
        } catch {
            return url;
        }
    }));
    
    // Thêm domain không có protocol
    domainMatches.forEach(domain => {
        if (!protocolDomains.has(domain)) {
            // Kiểm tra xem có phải là domain hợp lệ không
            if (domain.includes('.') && !domain.startsWith('.')) {
                // Loại bỏ các pattern số tiền
                if (!isCurrencyAmount(domain)) {
                    const fullUrl = 'https://' + domain;
                    if (!isMediaUrl(fullUrl)) {
                        urls.push({ original: domain, processed: fullUrl });
                    }
                }
            }
        }
    });
    
    return urls;
}

// Hàm kiểm tra xem URL có phải là file media không
function isMediaUrl(url: string): boolean {
    try {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname.toLowerCase();
        const hostname = urlObj.hostname.toLowerCase();
        
        // Kiểm tra extension của file
        const mediaExtensions = [
            '.gif', '.jpg', '.jpeg', '.png', '.webp', '.svg', '.bmp', '.ico', // Images
            '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv', // Videos
            '.mp3', '.wav', '.ogg', '.aac', '.flac', '.m4a', // Audio
            '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', // Documents
            '.zip', '.rar', '.7z', '.tar', '.gz' // Archives
        ];
        
        // Kiểm tra extension
        if (mediaExtensions.some(ext => pathname.endsWith(ext))) {
            return true;
        }
        
        // Kiểm tra các domain chuyên về media
        const mediaDomains = [
            'media.tenor.com',
            'c.tenor.com',
            'media.giphy.com',
            'i.giphy.com',
            'cdn.discordapp.com',
            'media.discordapp.net',
            'i.imgur.com',
            'imgur.com',
            'gyazo.com',
            'prnt.sc',
            'prntscr.com'
        ];
        
        if (mediaDomains.some(domain => hostname.includes(domain))) {
            return true;
        }
        
        // Kiểm tra các pattern đặc biệt
        if (pathname.includes('/media/') || 
            pathname.includes('/image/') || 
            pathname.includes('/video/') ||
            pathname.includes('/file/') ||
            pathname.includes('/attachment/')) {
            return true;
        }
        
        return false;
    } catch {
        // Nếu không parse được URL, coi như không phải media
        return false;
    }
}

const UrlsPanel: React.FC<Props> = ({ room, onClose }) => {
    const client = useContext(MatrixClientContext);
    const [selectedSender, setSelectedSender] = useState<string>("all");
    const [urlEvents, setUrlEvents] = useState<Array<{ ev: MatrixEvent; urls: UrlInfo[] }>>([]);
    const [isLoading, setIsLoading] = useState<boolean>(true);
    const [scannedEvents, setScannedEvents] = useState<number>(0);
    const isUnmountedRef = useRef(false);

    useEffect(() => {
        isUnmountedRef.current = false;
        return () => {
            isUnmountedRef.current = true;
        };
    }, []);

    // Thu thập toàn bộ link trong lịch sử phòng bằng cách phân trang ngược
    useEffect(() => {
        let cancelled = false;
        const run = async (): Promise<void> => {
            try {
                setIsLoading(true);
                setUrlEvents([]);
                setScannedEvents(0);

                // Sử dụng Map để dedupe theo eventId + urlProcessed
                const aggregated: Map<string, { ev: MatrixEvent; urls: UrlInfo[] }> = new Map();

                const collectFromEvents = (eventsList: MatrixEvent[]): void => {
                    eventsList.forEach((ev) => {
                        const urls = extractUrlsFromEvent(ev);
                        if (urls.length === 0) return;
                        // Deduplicate per URL within the event
                        const uniqueUrls = new Map<string, UrlInfo>();
                        urls.forEach((u) => uniqueUrls.set(u.processed + "|" + u.original, u));
                        const finalUrls = Array.from(uniqueUrls.values());
                        const keyBase = ev.getId() || `${ev.getSender() || ""}-${ev.getTs()}`;
                        finalUrls.forEach((u, idx) => {
                            const key = `${keyBase}|${u.processed}`;
                            if (!aggregated.has(key)) {
                                aggregated.set(key, { ev, urls: [u] });
                            }
                        });
                    });
                    setScannedEvents((prev) => prev + eventsList.length);
                };

                // Thu thập từ live timeline hiện tại
                const liveTimeline = room.getLiveTimeline();
                const initial = liveTimeline.getEvents?.() || [];
                // Sắp xếp giảm dần thời gian để hiển thị đẹp sau này
                initial.sort((a, b) => b.getTs() - a.getTs());
                collectFromEvents(initial);

                // Phân trang ngược cho đến đầu lịch sử
                // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
                while (!cancelled) {
                    const hasMoreToken = !!liveTimeline.getPaginationToken?.(Direction.Backward);
                    const hasOlderNeighbour = !!liveTimeline.getNeighbouringTimeline?.(Direction.Backward);
                    if (!hasMoreToken && !hasOlderNeighbour) break;
                    // eslint-disable-next-line @typescript-eslint/await-thenable
                    const got = await client!.paginateEventTimeline(liveTimeline, {
                        backwards: true,
                        limit: 200,
                    });
                    if (!got) break;
                    const more = liveTimeline.getEvents?.() || [];
                    collectFromEvents(more);
                }

                if (cancelled || isUnmountedRef.current) return;

                // Chuyển Map -> mảng và sắp xếp theo thời gian giảm dần
                const list = Array.from(aggregated.values())
                    .sort((a, b) => (b.ev.getTs() - a.ev.getTs()));
                setUrlEvents(list);
            } finally {
                if (!cancelled && !isUnmountedRef.current) setIsLoading(false);
            }
        };

        if (client) {
            void run();
        }

        return () => {
            cancelled = true;
        };
    }, [client, room]);

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
            {isLoading ? (
                <div className="mx_RoomView_empty">
                    <div style={{textAlign: 'center', marginTop: 40}}>
                        <div style={{fontSize: 24, marginBottom: 16}}>⏳</div>
                        <div style={{fontWeight: 600, marginBottom: 8}}>
                            Đang thu thập các đường dẫn…
                        </div>
                        <div style={{color: '#888'}}>Đã quét {scannedEvents.toLocaleString()} tin nhắn</div>
                    </div>
                </div>
            ) : filteredUrlEvents.length === 0 ? (
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
                            urls.map((urlInfo, i) => (
                                <li key={ev.getId() + '-' + i} style={{marginBottom: 16, borderBottom: '1px solid #eee', paddingBottom: 8}}>
                                    <div>
                                        <a href={urlInfo.processed} target="_blank" rel="noopener noreferrer" style={{color: '#1976d2', wordBreak: 'break-all'}}>{urlInfo.original}</a>
                                    </div>
                                    <div style={{fontSize: 12, color: '#888', marginTop: 2}}>
                                        {(() => {
                                            const userId = ev.getSender();
                                            const member = userId ? room.getMember?.(userId) : undefined;
                                            const displayName = member?.name || userId || "(unknown)";
                                            return displayName;
                                        })()} &bull; {new Date(ev.getTs()).toLocaleString()}
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