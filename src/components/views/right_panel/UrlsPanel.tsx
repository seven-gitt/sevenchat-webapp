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

// Regex để nhận diện URL có protocol (bao gồm cả port)
const URL_WITH_PROTOCOL_REGEX = /https?:\/\/[\w\-._~:/?#[\]@!$&'()*+,;=%]+/gi;
// Regex để nhận diện domain pattern (ví dụ: example.com, sub.example.com)
// Chỉ nhận diện domain có ít nhất 2 phần và phần cuối có ít nhất 2 ký tự
// Loại bỏ các pattern số tiền (ví dụ: 168.000, 1.000.000)
// Cải thiện để nhận diện tốt hơn các domain phức tạp
const DOMAIN_REGEX = /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\b(?:\/[\w\-._~:/?#[\]@!$&'()*+,;=%]*)?/gi;
// Regex để nhận diện domain với port (ví dụ: localhost:3000, example.com:8080)
const DOMAIN_WITH_PORT_REGEX = /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?:\d{1,5}\b(?:\/[\w\-._~:/?#[\]@!$&'()*+,;=%]*)?/gi;
// Regex để nhận diện IP address với port (ví dụ: 192.168.1.1:8080, [::1]:3000)
const IP_WITH_PORT_REGEX = /\b(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}\b(?:\/[\w\-._~:/?#[\]@!$&'()*+,;=%]*)?/gi;

interface UrlInfo {
    original: string;
    processed: string;
}

// Hàm kiểm tra xem có phải là số tiền không
// Loại bỏ các pattern số tiền để tránh nhận diện nhầm là URL
function isCurrencyAmount(text: string): boolean {
    // Pattern cho số tiền: có thể có dấu phẩy, chấm, hoặc khoảng trắng làm phân cách hàng nghìn
    // Ví dụ: 168.000, 1,000, 1 000, 1000.50, 1,000.50, 10.860K, 1.5M, 2.3B
    const currencyPattern = /^\d{1,3}([.,\s]\d{3})*([.,]\d{2})?[KMB]?$/i;
    
    // Pattern cho số tiền với dấu phẩy làm phân cách thập phân (ví dụ: 10,860.50)
    const currencyWithCommaDecimal = /^\d{1,3}([.,\s]\d{3})*,\d{2}[KMB]?$/i;
    
    // Pattern cho số tiền với chấm làm phân cách thập phân (ví dụ: 10.860,50)
    const currencyWithDotDecimal = /^\d{1,3}([.,\s]\d{3})*\.\d{2}[KMB]?$/i;
    
    // Pattern cho số tiền với ký hiệu tiền tệ (ví dụ: $1,000, €1.000, ¥1000)
    const currencyWithSymbol = /^[$\u20AC\u00A5\u00A3\u20A9\u20AB]\s?\d{1,3}([.,\s]\d{3})*([.,]\d{2})?[KMB]?$/i;
    
    // Pattern cho số tiền với ký hiệu ở cuối (ví dụ: 1000$, 1000€, 1000¥)
    const currencyWithSymbolEnd = /^\d{1,3}([.,\s]\d{3})*([.,]\d{2})?[KMB]?\s?[$\u20AC\u00A5\u00A3\u20A9\u20AB]$/i;
    
    return currencyPattern.test(text) || 
           currencyWithCommaDecimal.test(text) || 
           currencyWithDotDecimal.test(text) ||
           currencyWithSymbol.test(text) ||
           currencyWithSymbolEnd.test(text);
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
    const domainWithPortMatches = content.body.match(DOMAIN_WITH_PORT_REGEX) || [];
    const ipWithPortMatches = content.body.match(IP_WITH_PORT_REGEX) || [];
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
                    // Kiểm tra thêm các trường hợp đặc biệt
                    const cleanDomain = domain.replace(/\/$/, ''); // Loại bỏ trailing slash
                    
                    // Kiểm tra xem có phải là domain thực sự không (có ít nhất 2 phần)
                    const parts = cleanDomain.split('.');
                    if (parts.length >= 2 && parts.every(part => part.length > 0)) {
                        const fullUrl = 'https://' + cleanDomain;
                        if (!isMediaUrl(fullUrl)) {
                            urls.push({ original: cleanDomain, processed: fullUrl });
                        }
                    }
                }
            }
        }
    });

    // Thêm domain với port
    domainWithPortMatches.forEach(domainWithPort => {
        if (!protocolDomains.has(domainWithPort)) {
            // Kiểm tra xem có phải là domain với port hợp lệ không
            if (domainWithPort.includes(':') && !domainWithPort.startsWith('.')) {
                // Loại bỏ các pattern số tiền
                if (!isCurrencyAmount(domainWithPort)) {
                    const cleanDomainWithPort = domainWithPort.replace(/\/$/, ''); // Loại bỏ trailing slash
                    const fullUrl = 'https://' + cleanDomainWithPort;
                    if (!isMediaUrl(fullUrl)) {
                        urls.push({ original: cleanDomainWithPort, processed: fullUrl });
                    }
                }
            }
        }
    });

    // Thêm IP address với port
    ipWithPortMatches.forEach(ipWithPort => {
        if (!protocolDomains.has(ipWithPort)) {
            // Kiểm tra xem có phải là IP với port hợp lệ không
            if (ipWithPort.includes(':') && !ipWithPort.startsWith('.')) {
                // Loại bỏ các pattern số tiền
                if (!isCurrencyAmount(ipWithPort)) {
                    const cleanIpWithPort = ipWithPort.replace(/\/$/, ''); // Loại bỏ trailing slash
                    const fullUrl = 'http://' + cleanIpWithPort; // Sử dụng http cho IP addresses
                    if (!isMediaUrl(fullUrl)) {
                        urls.push({ original: cleanIpWithPort, processed: fullUrl });
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

// Cache để lưu trữ kết quả URL cho mỗi phòng
const urlCache = new Map<string, {
    data: Array<{ ev: MatrixEvent; urls: UrlInfo[] }>;
    lastEventId: string | null;
    lastUpdate: number;
}>();

// Hàm để dọn dẹp cache cũ (hơn 1 giờ)
const cleanupOldCache = (): void => {
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    for (const [key, value] of urlCache.entries()) {
        if (value.lastUpdate < oneHourAgo) {
            urlCache.delete(key);
        }
    }
};

// Dọn dẹp cache mỗi 30 phút
setInterval(cleanupOldCache, 30 * 60 * 1000);

const UrlsPanel: React.FC<Props> = ({ room, onClose }) => {
    const client = useContext(MatrixClientContext);
    const [selectedSender, setSelectedSender] = useState<string>("all");
    const [urlEvents, setUrlEvents] = useState<Array<{ ev: MatrixEvent; urls: UrlInfo[] }>>([]);
    const [isLoading, setIsLoading] = useState<boolean>(true);
    const isUnmountedRef = useRef(false);

    useEffect(() => {
        isUnmountedRef.current = false;
        return () => {
            isUnmountedRef.current = true;
            // Không cần dispatch action khi unmount vì có thể gây ảnh hưởng đến scroll position
            // của timeline chính. UrlsPanel chỉ đọc dữ liệu, không thay đổi timeline state.
        };
    }, [room.roomId]);

    // Thu thập toàn bộ link trong lịch sử phòng bằng cách phân trang ngược
    useEffect(() => {
        let cancelled = false;
        const run = async (): Promise<void> => {
            try {
                const cacheKey = room.roomId;
                const cached = urlCache.get(cacheKey);
                
                // Kiểm tra xem có cache hợp lệ không
                if (cached && cached.data.length > 0) {
                    // Lấy event mới nhất từ timeline hiện tại
                    const liveTimeline = room.getLiveTimeline();
                    const currentEvents = liveTimeline.getEvents?.() || [];
                    const latestEvent = currentEvents[currentEvents.length - 1];
                    
                    // Nếu không có event mới, sử dụng cache
                    if (!latestEvent || cached.lastEventId === latestEvent.getId()) {
                        setUrlEvents(cached.data);
                        setIsLoading(false);
                        console.log(`Using cached URLs for room ${room.roomId} (${cached.data.length} URLs)`);
                        return;
                    }
                    
                    // Nếu có event mới, chỉ cần kiểm tra event mới này
                    const newUrls = extractUrlsFromEvent(latestEvent);
                    if (newUrls.length > 0) {
                        // Có URL mới, cần tải lại toàn bộ
                        console.log(`Found ${newUrls.length} new URLs, refreshing cache`);
                    } else {
                        // Không có URL mới, cập nhật cache và sử dụng
                        cached.lastEventId = latestEvent.getId() || null;
                        cached.lastUpdate = Date.now();
                        setUrlEvents(cached.data);
                        setIsLoading(false);
                        console.log(`No new URLs found, using cached data for room ${room.roomId}`);
                        return;
                    }
                }
                
                setIsLoading(true);
                setUrlEvents([]);

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
                };

                // Thu thập từ events hiện có trong timeline
                const liveTimeline = room.getLiveTimeline();
                const initial = liveTimeline.getEvents?.() || [];
                collectFromEvents(initial);

                // Thu thập từ các timeline lân cận hiện có
                const neighbouringTimeline = liveTimeline.getNeighbouringTimeline?.(Direction.Backward);
                if (neighbouringTimeline) {
                    const neighbouringEvents = neighbouringTimeline.getEvents?.() || [];
                    collectFromEvents(neighbouringEvents);
                }

                // Paginate ngược để lấy toàn bộ lịch sử phòng
                let currentTimeline = liveTimeline;
                let hasMoreEvents = true;
                const maxPages = 50; // Giới hạn để tránh vòng lặp vô hạn
                let pageCount = 0;

                while (hasMoreEvents && pageCount < maxPages && !cancelled && !isUnmountedRef.current) {
                    try {
                        // Paginate ngược để lấy thêm events cũ hơn
                        const result = await client.paginateEventTimeline(currentTimeline, {
                            backwards: true,
                            limit: 100
                        });

                        if (result) {
                            // Lấy events từ timeline sau khi paginate
                            const newEvents = currentTimeline.getEvents?.() || [];
                            if (newEvents.length > 0) {
                                collectFromEvents(newEvents);
                                pageCount++;
                                
                                // Cập nhật UI với progress
                                if (pageCount % 5 === 0) {
                                    const list = Array.from(aggregated.values())
                                        .sort((a, b) => (b.ev.getTs() - a.ev.getTs()));
                                    setUrlEvents(list);
                                }
                            } else {
                                hasMoreEvents = false;
                            }
                        } else {
                            hasMoreEvents = false;
                        }
                    } catch (error) {
                        console.warn("Error paginating timeline:", error);
                        hasMoreEvents = false;
                    }
                }

                if (cancelled || isUnmountedRef.current) return;

                // Chuyển Map -> mảng và sắp xếp theo thời gian giảm dần (mới nhất trước)
                // để hiển thị các link mới nhất lên đầu
                const list = Array.from(aggregated.values())
                    .sort((a, b) => (b.ev.getTs() - a.ev.getTs()));
                
                // Lưu vào cache
                const latestEvent = list.length > 0 ? list[0].ev : null;
                urlCache.set(cacheKey, {
                    data: list,
                    lastEventId: latestEvent?.getId() || null,
                    lastUpdate: Date.now()
                });
                
                console.log(`Cached ${list.length} URLs for room ${room.roomId}`);
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
                            Đang tải…
                        </div>
                        
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