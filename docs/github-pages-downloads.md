# GitHub Pages Download Management Guide

Hướng dẫn quản lý file download cho SevenChat thông qua GitHub Pages.

## 📁 Cấu trúc thư mục

```
res/install/               # Source files (được copy vào webapp/install/)
├── mac/
│   └── SevenChat-macOS.dmg
└── windows/
    └── SevenChat-Windows.exe

webapp/install/           # Files được deploy lên GitHub Pages
├── mac/
│   └── SevenChat-macOS.dmg
└── windows/
    └── SevenChat-Windows.exe
```

## 🔧 Cấu hình hiện tại

### Config trong element.io/app/config.json:
```json
{
  "branding": {
    "download_mac_url": "install/mac/SevenChat-macOS.dmg",
    "download_windows_url": "install/windows/SevenChat-Windows.exe"
  }
}
```

### URLs trên GitHub Pages:
- Mac: `https://yourusername.github.io/sevenchat/install/mac/SevenChat-macOS.dmg`
- Windows: `https://yourusername.github.io/sevenchat/install/windows/SevenChat-Windows.exe`

## 🚀 Workflow cập nhật file download

### Option 1: Cập nhật file existing (Đơn giản nhất)
1. **Thay thế file cũ:**
   ```bash
   # Copy file mới vào thư mục
   cp SevenChat-v1.5.0-macOS.dmg res/install/mac/SevenChat-macOS.dmg
   cp SevenChat-v1.5.0-Windows.exe res/install/windows/SevenChat-Windows.exe
   ```

2. **Commit và push:**
   ```bash
   git add res/install/
   git commit -m "Update download files to v1.5.0"
   git push origin main
   ```

3. **Kết quả:** GitHub Actions sẽ tự động deploy, users sẽ thấy file mới ngay lập tức!

### Option 2: Tạo versioned files
1. **Thêm file mới với version:**
   ```bash
   cp SevenChat-v1.5.0-macOS.dmg res/install/mac/
   cp SevenChat-v1.5.0-Windows.exe res/install/windows/
   ```

2. **Cập nhật config:**
   ```json
   {
     "branding": {
       "download_mac_url": "install/mac/SevenChat-v1.5.0-macOS.dmg",
       "download_windows_url": "install/windows/SevenChat-v1.5.0-Windows.exe"
     }
   }
   ```

3. **Deploy:**
   ```bash
   git add .
   git commit -m "Release v1.5.0 - Update download links"
   git push origin main
   ```

### Option 3: Sử dụng GitHub Releases (Khuyến nghị cho production)
1. **Tạo GitHub Release:**
   ```bash
   gh release create v1.5.0 \
     res/install/mac/SevenChat-macOS.dmg \
     res/install/windows/SevenChat-Windows.exe \
     --title "SevenChat v1.5.0" \
     --notes "New features and bug fixes"
   ```

2. **Cập nhật config sử dụng release URLs:**
   ```json
   {
     "branding": {
       "download_mac_url": "https://github.com/yourusername/sevenchat/releases/download/v1.5.0/SevenChat-macOS.dmg",
       "download_windows_url": "https://github.com/yourusername/sevenchat/releases/download/v1.5.0/SevenChat-Windows.exe"
     }
   }
   ```

## 🎯 Các scenarios thực tế

### Scenario 1: Emergency hotfix
```bash
# 1. Build hotfix
./build-hotfix.sh

# 2. Quick replace
cp dist/SevenChat-hotfix.dmg res/install/mac/SevenChat-macOS.dmg

# 3. Deploy ngay lập tức  
git add res/install/mac/SevenChat-macOS.dmg
git commit -m "Hotfix: Critical security update"
git push origin main
```

### Scenario 2: Staging vs Production
```json
// Config cho staging branch
{
  "branding": {
    "download_mac_url": "install/beta/SevenChat-beta-macOS.dmg",
    "download_windows_url": "install/beta/SevenChat-beta-Windows.exe"
  }
}

// Config cho main branch  
{
  "branding": {
    "download_mac_url": "install/mac/SevenChat-macOS.dmg",
    "download_windows_url": "install/windows/SevenChat-Windows.exe"
  }
}
```

### Scenario 3: A/B Testing
```json
{
  "branding": {
    "download_mac_url": "install/mac/SevenChat-macOS.dmg",
    "download_windows_url": "install/windows/SevenChat-Windows.exe",
    "download_mac_beta_url": "install/beta/SevenChat-beta-macOS.dmg"
  }
}
```

## 📊 Monitoring và Analytics

### Theo dõi download stats:
1. **GitHub Insights:** Repository → Insights → Traffic
2. **GitHub Pages Analytics:** Settings → Pages → Analytics
3. **Custom tracking:** Thêm Google Analytics vào welcome.html

### Log download events:
```html
<!-- Thêm vào welcome.html -->
<a href="$downloadMacUrl" 
   onclick="gtag('event', 'download', { 'file_name': 'mac' })"
   class="mx_ButtonParent mx_ButtonDownloadMac">
```

## ⚠️ Lưu ý quan trọng

1. **File size limits:** GitHub có giới hạn 100MB/file, 1GB/repo
2. **Bandwidth:** GitHub Pages có quota 100GB/tháng
3. **CDN:** GitHub tự động có CDN global
4. **Cache:** Files được cache, có thể mất vài phút để update worldwide
5. **Security:** Không commit sensitive keys vào repo

## 🔧 Troubleshooting

### File không update:
```bash
# Clear browser cache
Ctrl+F5

# Check GitHub Actions logs
gh run list
gh run view [run-id]

# Verify file deploy
curl -I https://yourusername.github.io/sevenchat/install/mac/SevenChat-macOS.dmg
```

### 404 errors:
```bash
# Kiểm tra file path
ls -la webapp/install/

# Kiểm tra GitHub Pages settings
# Repository → Settings → Pages
```

## 🎉 Kết luận

Với setup này, bạn có thể:
✅ **Update dễ dàng:** Chỉ cần copy file và push  
✅ **Zero downtime:** File mới available ngay lập tức  
✅ **Version control:** Full git history của mọi releases  
✅ **Global CDN:** Fast download worldwide via GitHub CDN  
✅ **Free hosting:** Không tốn chi phí hosting  
✅ **HTTPS:** Secure downloads by default  

Chỉ cần `git push` là file download mới đã sẵn sàng cho users! 🚀
