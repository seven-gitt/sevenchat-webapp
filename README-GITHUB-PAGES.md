# SevenChat - GitHub Pages Deployment

## Cấu hình GitHub Pages

### 1. Tự động deploy với GitHub Actions

Tạo file `.github/workflows/deploy.yml`:

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
    - name: Checkout
      uses: actions/checkout@v4
      
    - name: Setup Node.js
      uses: actions/setup-node@v4
      with:
        node-version: '18'
        cache: 'yarn'
        
    - name: Install dependencies
      run: yarn install --frozen-lockfile
      
    - name: Build
      run: yarn build
      
    - name: Copy installer files
      run: |
        mkdir -p webapp/install
        cp -r install/* webapp/install/
        
    - name: Setup Pages
      uses: actions/configure-pages@v4
      
    - name: Upload artifact
      uses: actions/upload-pages-artifact@v3
      with:
        path: './webapp'

  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
    - name: Deploy to GitHub Pages
      id: deployment
      uses: actions/deploy-pages@v4
```

### 2. Cấu hình Repository

1. Vào **Settings** → **Pages**
2. Chọn **Source**: GitHub Actions
3. Domain sẽ là: `https://username.github.io/sevenchat`

### 3. File cài đặt

- Thêm file installer thực tế vào:
  - `install/mac/SevenChat-macOS.dmg`
  - `install/windows/SevenChat-Windows.exe`

### 4. Cấu hình tên miền tùy chỉnh (tùy chọn)

Nếu muốn dùng domain riêng:
1. Tạo file `CNAME` trong thư mục `webapp/` với nội dung tên miền
2. Cấu hình DNS A record trỏ về GitHub Pages IP

### 5. Build local để test

```bash
yarn build
cp -r install/* webapp/install/
# Test local server
cd webapp && python -m http.server 8080
```

## Lưu ý

- File `webapp/config.json` đã được cấu hình cho `sevenchat.space`
- Download buttons sẽ hoạt động khi có file thực tế trong thư mục `install/`
- GitHub Pages hỗ trợ HTTPS mặc định
