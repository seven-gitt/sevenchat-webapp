import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import BaseCard from "./BaseCard";
import { _t } from "../../../languageHandler";
import { type Room, type MatrixEvent, type RoomMember, Direction } from "matrix-js-sdk/src/matrix";
import MemberAvatar from "../avatars/MemberAvatar";
import MatrixClientContext from "../../../contexts/MatrixClientContext";

interface Props {
    room: Room;
    onClose: () => void;
}

// Regex tối ưu hóa để nhận diện URL có protocol
const URL_WITH_PROTOCOL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
// Regex đơn giản hóa để nhận diện domain pattern
const DOMAIN_REGEX = /\b[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}\b/gi;
// Regex để nhận diện domain với port
const DOMAIN_WITH_PORT_REGEX = /\b[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}:\d{1,5}\b/gi;
// Regex để nhận diện IP address với port
const IP_WITH_PORT_REGEX = /\b(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}\b/gi;

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
    const body = content.body;
    
    // Tìm URL có protocol trước (ưu tiên cao nhất)
    const protocolMatches = body.match(URL_WITH_PROTOCOL_REGEX) || [];
    const protocolDomains = new Set<string>();
    
    protocolMatches.forEach(url => {
        if (!isMediaUrl(url)) {
            urls.push({ original: url, processed: url });
            // Lưu hostname để tránh trùng lặp
            try {
                protocolDomains.add(new URL(url).hostname);
            } catch {
                // Ignore invalid URLs
            }
        }
    });
    
    // Tìm domain patterns (chỉ nếu chưa có protocol)
    if (protocolMatches.length === 0) {
        const domainMatches = body.match(DOMAIN_REGEX) || [];
        const domainWithPortMatches = body.match(DOMAIN_WITH_PORT_REGEX) || [];
        const ipWithPortMatches = body.match(IP_WITH_PORT_REGEX) || [];
        
        // Xử lý domain thường
        domainMatches.forEach(domain => {
            if (!isCurrencyAmount(domain) && domain.includes('.') && !domain.startsWith('.')) {
                const parts = domain.split('.');
                if (parts.length >= 2 && parts.every(part => part.length > 0)) {
                    const fullUrl = 'https://' + domain;
                    if (!isMediaUrl(fullUrl)) {
                        urls.push({ original: domain, processed: fullUrl });
                    }
                }
            }
        });

        // Xử lý domain với port
        domainWithPortMatches.forEach(domainWithPort => {
            if (!isCurrencyAmount(domainWithPort) && domainWithPort.includes(':')) {
                const fullUrl = 'https://' + domainWithPort;
                if (!isMediaUrl(fullUrl)) {
                    urls.push({ original: domainWithPort, processed: fullUrl });
                }
            }
        });

        // Xử lý IP với port
        ipWithPortMatches.forEach(ipWithPort => {
            if (!isCurrencyAmount(ipWithPort) && ipWithPort.includes(':')) {
                const fullUrl = 'http://' + ipWithPort;
                if (!isMediaUrl(fullUrl)) {
                    urls.push({ original: ipWithPort, processed: fullUrl });
                }
            }
        });
    }
    
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
    const [hasMoreUrls, setHasMoreUrls] = useState<boolean>(true);
    const [loadingMore, setLoadingMore] = useState<boolean>(false);
    const [displayLimit, setDisplayLimit] = useState<number>(50);
    const isUnmountedRef = useRef(false);

    useEffect(() => {
        isUnmountedRef.current = false;
        return () => {
            isUnmountedRef.current = true;
            // Không cần dispatch action khi unmount vì có thể gây ảnh hưởng đến scroll position
            // của timeline chính. UrlsPanel chỉ đọc dữ liệu, không thay đổi timeline state.
        };
    }, [room.roomId]);

    // Thu thập link trong lịch sử phòng với progressive loading
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
                        setUrlEvents(cached.data.slice(0, displayLimit));
                        setHasMoreUrls(cached.data.length > displayLimit);
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
                        setUrlEvents(cached.data.slice(0, displayLimit));
                        setHasMoreUrls(cached.data.length > displayLimit);
                        setIsLoading(false);
                        console.log(`No new URLs found, using cached data for room ${room.roomId}`);
                        return;
                    }
                }
                
                setIsLoading(true);
                setUrlEvents([]);
                setHasMoreUrls(true);

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

                // Hiển thị ngay những URL đã tìm thấy
                if (aggregated.size > 0) {
                    const initialList = Array.from(aggregated.values())
                        .sort((a, b) => (b.ev.getTs() - a.ev.getTs()))
                        .slice(0, displayLimit);
                    setUrlEvents(initialList);
                    setIsLoading(false);
                }

                // Paginate ngược để lấy thêm lịch sử (giới hạn 10 trang để tăng tốc)
                let currentTimeline = liveTimeline;
                let hasMoreEvents = true;
                const maxPages = 10; // Giảm từ 50 xuống 10 để tăng tốc
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
                                
                                // Cập nhật UI với progress mỗi 2 trang
                                if (pageCount % 2 === 0) {
                                    const list = Array.from(aggregated.values())
                                        .sort((a, b) => (b.ev.getTs() - a.ev.getTs()));
                                    setUrlEvents(list.slice(0, displayLimit));
                                    setHasMoreUrls(list.length > displayLimit);
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
                setUrlEvents(list.slice(0, displayLimit));
                setHasMoreUrls(list.length > displayLimit);
                
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
    }, [client, room, displayLimit]);

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

    // Hàm để tải thêm URL
    const loadMoreUrls = useCallback(() => {
        if (loadingMore || !hasMoreUrls) return;
        
        setLoadingMore(true);
        const cacheKey = room.roomId;
        const cached = urlCache.get(cacheKey);
        
        if (cached && cached.data.length > displayLimit) {
            const newLimit = displayLimit + 50;
            setDisplayLimit(newLimit);
            setUrlEvents(cached.data.slice(0, newLimit));
            setHasMoreUrls(cached.data.length > newLimit);
        }
        
        setLoadingMore(false);
    }, [loadingMore, hasMoreUrls, displayLimit, room.roomId]);

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
                    
                    {/* Nút Load More */}
                    {hasMoreUrls && (
                        <div style={{textAlign: 'center', marginTop: 16, paddingTop: 16, borderTop: '1px solid #eee'}}>
                            <button
                                onClick={loadMoreUrls}
                                disabled={loadingMore}
                                style={{
                                    padding: '8px 16px',
                                    backgroundColor: '#1976d2',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: 4,
                                    cursor: loadingMore ? 'not-allowed' : 'pointer',
                                    opacity: loadingMore ? 0.6 : 1,
                                    fontSize: 14,
                                    fontWeight: 500
                                }}
                            >
                                {loadingMore ? 'Đang tải...' : 'Tải thêm'}
                            </button>
                            <div style={{fontSize: 12, color: '#888', marginTop: 8}}>
                                Hiển thị {filteredUrlEvents.length} URL gần nhất
                            </div>
                        </div>
                    )}
                </div>
            )}
        </BaseCard>
    );
};

export default UrlsPanel; 