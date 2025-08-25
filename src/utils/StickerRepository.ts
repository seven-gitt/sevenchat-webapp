// Sticker Repository Service - Quản lý stickers từ GitHub
export interface Sticker {
    id: string;
    name: string;
    url: string;
    tags: string[];
    category?: string;
    pack?: string;
    size?: number;
}

export interface StickerPack {
    id: string;
    name: string;
    description?: string;
    author?: string;
    version?: string;
    stickers: Sticker[];
    thumbnail?: string;
    createdAt: string;
    updatedAt: string;
}

export interface StickerRepository {
    name: string;
    description?: string;
    baseUrl: string;
    metadataUrl: string;
    packs: StickerPack[];
}

class StickerRepositoryService {
    private repositories: Map<string, StickerRepository> = new Map();
    private cache: Map<string, any> = new Map();
    private cacheExpiry = 30 * 1000; // 30 giây (giảm từ 5 phút xuống 30 giây để cập nhật nhanh hơn)

    constructor() {
        // Thêm repository mặc định
        this.addRepository({
            name: 'sevenchat-stickers',
            description: 'SevenChat Sticker Collection',
            baseUrl: 'https://raw.githubusercontent.com/seven-gitt/sevenchat-stickers/main',
            metadataUrl: 'https://raw.githubusercontent.com/seven-gitt/sevenchat-stickers/main/metadata.json',
            packs: []
        });
    }

    // Thêm repository mới
    addRepository(repo: StickerRepository): void {
        this.repositories.set(repo.name, repo);
    }

    // Lấy danh sách repositories
    getRepositories(): StickerRepository[] {
        return Array.from(this.repositories.values());
    }

    // Tải metadata từ repository
    async loadRepositoryMetadata(repoName: string): Promise<StickerPack[]> {
        const repo = this.repositories.get(repoName);
        if (!repo) {
            throw new Error(`Repository ${repoName} not found`);
        }

        // Kiểm tra cache
        const cacheKey = `metadata_${repoName}`;
        const cached = this.cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
            return cached.data;
        }

        try {
            const response = await fetch(repo.metadataUrl);
            if (!response.ok) {
                throw new Error(`Failed to load metadata: ${response.statusText}`);
            }

            const metadata = await response.json();
            const packs: StickerPack[] = metadata.packs || [];

            // Cập nhật cache
            this.cache.set(cacheKey, {
                data: packs,
                timestamp: Date.now()
            });

            // Cập nhật repository
            repo.packs = packs;
            this.repositories.set(repoName, repo);

            return packs;
        } catch (error) {
            console.error(`Error loading repository metadata:`, error);
            throw error;
        }
    }

    // Tải tất cả stickers từ tất cả repositories
    async loadAllStickers(): Promise<Sticker[]> {
        const allStickers: Sticker[] = [];

        for (const [repoName] of this.repositories) {
            try {
                const packs = await this.loadRepositoryMetadata(repoName);
                for (const pack of packs) {
                    allStickers.push(...pack.stickers);
                }
            } catch (error) {
                console.error(`Error loading stickers from ${repoName}:`, error);
            }
        }

        return allStickers;
    }

    // Tìm kiếm stickers
    async searchStickers(query: string): Promise<Sticker[]> {
        const allStickers = await this.loadAllStickers();
        const lowerQuery = query.toLowerCase();

        return allStickers.filter(sticker => 
            sticker.name.toLowerCase().includes(lowerQuery) ||
            sticker.tags.some(tag => tag.toLowerCase().includes(lowerQuery)) ||
            (sticker.category && sticker.category.toLowerCase().includes(lowerQuery)) ||
            (sticker.pack && sticker.pack.toLowerCase().includes(lowerQuery))
        );
    }

    // Lấy stickers theo category
    async getStickersByCategory(category: string): Promise<Sticker[]> {
        const allStickers = await this.loadAllStickers();
        return allStickers.filter(sticker => sticker.category === category);
    }

    // Lấy stickers theo pack
    async getStickersByPack(packId: string): Promise<Sticker[]> {
        const allStickers = await this.loadAllStickers();
        return allStickers.filter(sticker => sticker.pack === packId);
    }

    // Lấy danh sách categories
    async getCategories(): Promise<string[]> {
        const allStickers = await this.loadAllStickers();
        const categories = new Set<string>();
        
        allStickers.forEach(sticker => {
            if (sticker.category) {
                categories.add(sticker.category);
            }
        });

        return Array.from(categories).sort();
    }

    // Lấy danh sách packs
    async getPacks(): Promise<StickerPack[]> {
        const allPacks: StickerPack[] = [];
        
        for (const [repoName] of this.repositories) {
            try {
                const packs = await this.loadRepositoryMetadata(repoName);
                allPacks.push(...packs);
            } catch (error) {
                console.error(`Error loading packs from ${repoName}:`, error);
            }
        }

        return allPacks;
    }

    // Tạo URL cho sticker
    getStickerUrl(repoName: string, stickerPath: string): string {
        const repo = this.repositories.get(repoName);
        if (!repo) {
            throw new Error(`Repository ${repoName} not found`);
        }

        // Nếu là URL tuyệt đối, trả về nguyên
        if (stickerPath.startsWith('http')) {
            return stickerPath;
        }

        // Nếu là đường dẫn tương đối, thêm base URL
        return `${repo.baseUrl}/${stickerPath}`;
    }

    // Xóa cache
    clearCache(): void {
        this.cache.clear();
    }

    // Xóa cache cho repository cụ thể
    clearRepositoryCache(repoName: string): void {
        const cacheKey = `metadata_${repoName}`;
        this.cache.delete(cacheKey);
    }

    // Force refresh cache cho repository cụ thể
    async forceRefreshRepository(repoName: string): Promise<StickerPack[]> {
        this.clearRepositoryCache(repoName);
        return await this.loadRepositoryMetadata(repoName);
    }

    // Force refresh tất cả repositories
    async forceRefreshAll(): Promise<Sticker[]> {
        this.clearCache();
        return await this.loadAllStickers();
    }

    // Kiểm tra kết nối repository
    async testRepositoryConnection(repoName: string): Promise<boolean> {
        try {
            await this.loadRepositoryMetadata(repoName);
            return true;
        } catch (error) {
            console.error(`Repository connection test failed for ${repoName}:`, error);
            return false;
        }
    }

    // Tạo cấu trúc metadata cho GitHub repository
    generateMetadataTemplate(): string {
        return JSON.stringify({
            name: "SevenChat Stickers",
            description: "Collection of stickers for SevenChat",
            version: "1.0.0",
            author: "Your Name",
            packs: [
                {
                    id: "sample-pack",
                    name: "Sample Pack",
                    description: "A sample sticker pack",
                    author: "Your Name",
                    version: "1.0.0",
                    thumbnail: "thumbnails/sample-pack.png",
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    stickers: [
                        {
                            id: "sample-1",
                            name: "Sample Sticker 1",
                            url: "stickers/sample-1.png",
                            tags: ["sample", "test"],
                            category: "general",
                            pack: "sample-pack"
                        }
                    ]
                }
            ]
        }, null, 2);
    }

    // Hướng dẫn setup GitHub repository
    getSetupInstructions(): string {
        return `
# Hướng dẫn setup GitHub Repository cho Stickers

## 1. Tạo GitHub Repository
- Tạo repository mới: \`sevenchat-stickers\`
- Đặt visibility: Public
- Clone về máy local

## 2. Tạo cấu trúc thư mục
\`\`\`
sevenchat-stickers/
├── metadata.json          # File metadata chính
├── README.md              # Mô tả repository
├── stickers/              # Thư mục chứa stickers
│   ├── pack1/
│   │   ├── sticker1.png
│   │   └── sticker2.png
│   └── pack2/
│       ├── sticker3.png
│       └── sticker4.png
├── thumbnails/            # Thumbnails cho packs
│   ├── pack1.png
│   └── pack2.png
└── categories/            # Metadata theo category
    ├── emotions.json
    └── animals.json
\`\`\`

## 3. Tạo file metadata.json
Sử dụng template từ \`generateMetadataTemplate()\`

## 4. Upload stickers
- Upload tất cả file stickers vào thư mục \`stickers/\`
- Upload thumbnails vào thư mục \`thumbnails/\`
- Commit và push lên GitHub

## 5. Cập nhật URL trong app
Thay đổi \`baseUrl\` và \`metadataUrl\` trong \`addRepository()\`
        `;
    }
}

// Export singleton instance
const stickerRepository = new StickerRepositoryService();
export default stickerRepository;
