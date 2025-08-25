# 🎨 Hướng dẫn Setup Sticker Repository trên GitHub

## 📋 Tổng quan
Hướng dẫn này sẽ giúp bạn tạo một GitHub repository để lưu trữ và quản lý stickers cho SevenChat app.

## 🚀 Bước 1: Tạo GitHub Repository

### 1.1 Tạo repository mới
1. Đăng nhập vào GitHub
2. Click "New repository"
3. Đặt tên: `sevenchat-stickers`
4. Chọn **Public** (để có thể truy cập từ app)
5. Không chọn README (sẽ tạo sau)
6. Click "Create repository"

### 1.2 Clone về máy local
```bash
git clone https://github.com/your-username/sevenchat-stickers.git
cd sevenchat-stickers
```

## 📁 Bước 2: Tạo cấu trúc thư mục

```bash
# Tạo cấu trúc thư mục
mkdir stickers
mkdir thumbnails
mkdir categories
mkdir docs

# Tạo thư mục con cho từng pack
mkdir stickers/emotions
mkdir stickers/animals
mkdir stickers/food
mkdir stickers/celebration
```

## 📄 Bước 3: Tạo file metadata.json

Tạo file `metadata.json` trong thư mục gốc:

```json
{
  "name": "SevenChat Stickers",
  "description": "Collection of stickers for SevenChat app",
  "version": "1.0.0",
  "author": "Your Name",
  "repository": "https://github.com/your-username/sevenchat-stickers",
  "packs": [
    {
      "id": "emotions-pack",
      "name": "Emotions Pack",
      "description": "Collection of emotional expression stickers",
      "author": "Your Name",
      "version": "1.0.0",
      "thumbnail": "thumbnails/emotions-pack.png",
      "category": "emotions",
      "createdAt": "2024-01-01T00:00:00Z",
      "updatedAt": "2024-01-01T00:00:00Z",
      "stickers": [
        {
          "id": "happy-1",
          "name": "Happy Face",
          "url": "stickers/emotions/happy-1.png",
          "tags": ["happy", "smile", "joy"],
          "category": "emotions",
          "pack": "emotions-pack"
        },
        {
          "id": "sad-1",
          "name": "Sad Face",
          "url": "stickers/emotions/sad-1.png",
          "tags": ["sad", "cry", "sorrow"],
          "category": "emotions",
          "pack": "emotions-pack"
        }
      ]
    },
    {
      "id": "animals-pack",
      "name": "Animals Pack",
      "description": "Cute animal stickers",
      "author": "Your Name",
      "version": "1.0.0",
      "thumbnail": "thumbnails/animals-pack.png",
      "category": "animals",
      "createdAt": "2024-01-01T00:00:00Z",
      "updatedAt": "2024-01-01T00:00:00Z",
      "stickers": [
        {
          "id": "cat-1",
          "name": "Cute Cat",
          "url": "stickers/animals/cat-1.png",
          "tags": ["cat", "cute", "pet"],
          "category": "animals",
          "pack": "animals-pack"
        }
      ]
    }
  ]
}
```

## 🖼️ Bước 4: Upload Stickers

### 4.1 Chuẩn bị file stickers
- **Format**: PNG hoặc SVG (khuyến nghị PNG)
- **Kích thước**: 128x128px hoặc 256x256px
- **Tên file**: Sử dụng format `pack-name-number.png`
- **Chất lượng**: Tối ưu hóa để giảm dung lượng

### 4.2 Upload lên GitHub
```bash
# Copy stickers vào thư mục tương ứng
cp your-stickers/*.png stickers/emotions/

# Thêm vào git
git add .

# Commit
git commit -m "Add emotion stickers pack"

# Push lên GitHub
git push origin main
```

## 🔧 Bước 5: Cập nhật App

### 5.1 Cập nhật StickerRepository.ts
Thay đổi URL trong file `src/utils/StickerRepository.ts`:

```typescript
this.addRepository({
    name: 'sevenchat-stickers',
    description: 'SevenChat Sticker Collection',
    baseUrl: 'https://raw.githubusercontent.com/YOUR_USERNAME/sevenchat-stickers/main',
    metadataUrl: 'https://raw.githubusercontent.com/YOUR_USERNAME/sevenchat-stickers/main/metadata.json',
    packs: []
});
```

### 5.2 Test kết nối
```typescript
// Test kết nối repository
const isConnected = await stickerRepository.testRepositoryConnection('sevenchat-stickers');
console.log('Repository connected:', isConnected);
```

## 📖 Bước 6: Tạo README.md

Tạo file `README.md` để mô tả repository:

```markdown
# 🎨 SevenChat Stickers

Collection of stickers for SevenChat app.

## 📦 Sticker Packs

### Emotions Pack
- **ID**: `emotions-pack`
- **Description**: Collection of emotional expression stickers
- **Stickers**: 24 stickers
- **Tags**: happy, sad, angry, surprised, etc.

### Animals Pack
- **ID**: `animals-pack`
- **Description**: Cute animal stickers
- **Stickers**: 16 stickers
- **Tags**: cat, dog, rabbit, etc.

## 🚀 Usage

### In SevenChat App
```typescript
import stickerRepository from './utils/StickerRepository';

// Load all stickers
const stickers = await stickerRepository.loadAllStickers();

// Search stickers
const results = await stickerRepository.searchStickers('happy');

// Get stickers by category
const emotionStickers = await stickerRepository.getStickersByCategory('emotions');
```

### Direct URLs
- Metadata: `https://raw.githubusercontent.com/your-username/sevenchat-stickers/main/metadata.json`
- Sticker: `https://raw.githubusercontent.com/your-username/sevenchat-stickers/main/stickers/emotions/happy-1.png`

## 📝 Adding New Stickers

1. Add sticker files to appropriate folder
2. Update `metadata.json` with new sticker info
3. Commit and push changes
4. App will automatically load new stickers

## 🤝 Contributing

1. Fork this repository
2. Add your stickers
3. Update metadata
4. Submit pull request

## 📄 License

This project is licensed under the MIT License.
```

## 🔄 Bước 7: Tự động hóa (Tùy chọn)

### 7.1 GitHub Actions để tự động validate
Tạo file `.github/workflows/validate.yml`:

```yaml
name: Validate Stickers

on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

jobs:
  validate:
    runs-on: ubuntu-latest
    
    steps:
    - uses: actions/checkout@v2
    
    - name: Validate metadata.json
      run: |
        node -e "
          const fs = require('fs');
          const metadata = JSON.parse(fs.readFileSync('metadata.json', 'utf8'));
          console.log('Metadata is valid JSON');
          console.log('Packs found:', metadata.packs.length);
        "
    
    - name: Check sticker files exist
      run: |
        node -e "
          const fs = require('fs');
          const metadata = JSON.parse(fs.readFileSync('metadata.json', 'utf8'));
          
          for (const pack of metadata.packs) {
            for (const sticker of pack.stickers) {
              if (!fs.existsSync(sticker.url)) {
                console.error('Missing sticker file:', sticker.url);
                process.exit(1);
              }
            }
          }
          console.log('All sticker files exist');
        "
```

## 🎯 Bước 8: Tối ưu hóa

### 8.1 Tối ưu hình ảnh
```bash
# Sử dụng ImageOptim hoặc TinyPNG để nén
# Hoặc sử dụng script tự động
npm install -g imagemin-cli
imagemin stickers/**/*.png --out-dir=stickers-optimized
```

### 8.2 CDN (Tùy chọn)
Nếu có nhiều traffic, có thể sử dụng CDN:
- **Cloudflare**: Tự động cache
- **jsDelivr**: `https://cdn.jsdelivr.net/gh/your-username/sevenchat-stickers@main/`
- **GitHub Pages**: Tạo branch `gh-pages`

## 🐛 Troubleshooting

### Lỗi thường gặp:

1. **404 Not Found**
   - Kiểm tra URL trong `metadata.json`
   - Đảm bảo file tồn tại trong repository

2. **CORS Error**
   - Sử dụng `raw.githubusercontent.com` thay vì `github.com`
   - Hoặc setup proxy server

3. **Cache Issues**
   - Clear cache: `stickerRepository.clearCache()`
   - Thêm version parameter vào URL

## 📊 Monitoring

### GitHub Insights
- Xem traffic: Settings > Insights > Traffic
- Monitor bandwidth usage
- Check popular stickers

### App Analytics
```typescript
// Track sticker usage
const trackStickerUsage = (stickerId: string) => {
    // Send analytics data
    analytics.track('sticker_used', { stickerId });
};
```

## 🎉 Kết quả

Sau khi hoàn thành, bạn sẽ có:
- ✅ GitHub repository với stickers
- ✅ Metadata JSON để quản lý
- ✅ App có thể load stickers từ GitHub
- ✅ Hệ thống cache và tối ưu
- ✅ Dễ dàng thêm stickers mới

## 🔗 Links hữu ích

- [GitHub Raw Content](https://docs.github.com/en/repositories/working-with-files/using-files/viewing-a-file#viewing-or-downloading-raw-file-content)
- [GitHub API](https://docs.github.com/en/rest)
- [Image Optimization](https://web.dev/fast/#optimize-your-images)
- [CDN Options](https://www.jsdelivr.com/features#gh)
