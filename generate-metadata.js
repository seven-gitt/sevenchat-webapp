#!/usr/bin/env node

/**
 * Script để tự động generate metadata.json từ thư mục stickers
 * Usage: node generate-metadata.js
 */

const fs = require('fs');
const path = require('path');

const CONFIG = {
    stickersDir: './stickers',
    outputFile: './metadata.json',
    defaultCategory: 'general',
    supportedFormats: ['.png', '.jpg', '.jpeg', '.svg', '.gif'],
    maxFileSize: 1024 * 1024, // 1MB
    thumbnailSize: 128
};

// Tạo template metadata cơ bản
function createMetadataTemplate() {
    return {
        name: "SevenChat Stickers",
        description: "Collection of stickers for SevenChat app",
        version: "1.0.0",
        author: "SevenChat Team",
        repository: "https://github.com/seven-gitt/sevenchat-stickers",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        packs: []
    };
}

// Tạo sticker pack từ thư mục
function createStickerPack(packDir, packName) {
    const packPath = path.join(CONFIG.stickersDir, packDir);
    const files = fs.readdirSync(packPath);
    
    const stickers = [];
    let totalSize = 0;
    
    files.forEach(file => {
        const ext = path.extname(file).toLowerCase();
        if (CONFIG.supportedFormats.includes(ext)) {
            const filePath = path.join(packPath, file);
            const stats = fs.statSync(filePath);
            
            if (stats.size <= CONFIG.maxFileSize) {
                const stickerId = path.parse(file).name;
                const stickerName = stickerId.replace(/[-_]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
                
                stickers.push({
                    id: stickerId,
                    name: "", // Ẩn tên để tránh trùng lặp
                    url: `stickers/${packDir}/${file}`,
                    tags: generateTags(stickerId, packName),
                    category: CONFIG.defaultCategory,
                    pack: packName,
                    size: stats.size
                });
                
                totalSize += stats.size;
            } else {
                console.warn(`⚠️  File ${file} quá lớn (${(stats.size / 1024).toFixed(1)}KB), bỏ qua`);
            }
        }
    });
    
    return {
        id: packName,
        name: "", // Ẩn tên pack
        description: `Collection of ${packName.replace('-pack', '')} stickers`,
        author: "SevenChat Team",
        version: "1.0.0",
        thumbnail: `thumbnails/${packName}.png`,
        category: CONFIG.defaultCategory,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        stickers: stickers,
        totalStickers: stickers.length,
        totalSize: totalSize
    };
}

// Tạo tags tự động từ tên sticker
function generateTags(stickerId, packName) {
    const tags = [];
    
    // Thêm pack name làm tag
    const packTag = packName.replace('-pack', '');
    tags.push(packTag);
    
    // Thêm các từ khóa từ tên sticker
    const words = stickerId.split(/[-_\s]+/);
    words.forEach(word => {
        if (word.length > 2 && !tags.includes(word)) {
            tags.push(word.toLowerCase());
        }
    });
    
    // Thêm tags phổ biến
    const commonTags = ['sticker', 'emoji', 'cute', 'fun'];
    commonTags.forEach(tag => {
        if (!tags.includes(tag)) {
            tags.push(tag);
        }
    });
    
    return tags.slice(0, 10); // Giới hạn 10 tags
}

// Tạo thumbnail (placeholder)
function createThumbnail(packName) {
    const thumbnailDir = './thumbnails';
    if (!fs.existsSync(thumbnailDir)) {
        fs.mkdirSync(thumbnailDir, { recursive: true });
    }
    
    const thumbnailPath = path.join(thumbnailDir, `${packName}.png`);
    if (!fs.existsSync(thumbnailPath)) {
        console.log(`📝 Tạo placeholder thumbnail cho ${packName}`);
        // Tạo file placeholder đơn giản
        const placeholderContent = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
        fs.writeFileSync(thumbnailPath, placeholderContent);
    }
}

// Generate metadata chính
function generateMetadata() {
    console.log('🎨 Bắt đầu generate metadata...');
    
    if (!fs.existsSync(CONFIG.stickersDir)) {
        console.error(`❌ Thư mục ${CONFIG.stickersDir} không tồn tại!`);
        console.log('📁 Tạo thư mục stickers và thêm một số stickers mẫu...');
        createSampleStructure();
        return;
    }
    
    const metadata = createMetadataTemplate();
    const packDirs = fs.readdirSync(CONFIG.stickersDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);
    
    if (packDirs.length === 0) {
        console.log('📁 Không tìm thấy thư mục pack nào. Tạo cấu trúc mẫu...');
        createSampleStructure();
        return;
    }
    
    console.log(`📦 Tìm thấy ${packDirs.length} sticker packs:`);
    
    packDirs.forEach(packDir => {
        console.log(`  - ${packDir}`);
        const pack = createStickerPack(packDir, packDir);
        metadata.packs.push(pack);
        
        // Tạo thumbnail
        createThumbnail(packDir);
        
        console.log(`    ✅ ${pack.stickers.length} stickers`);
    });
    
    // Cập nhật thời gian
    metadata.updatedAt = new Date().toISOString();
    
    // Ghi file metadata
    fs.writeFileSync(CONFIG.outputFile, JSON.stringify(metadata, null, 2));
    
    console.log(`✅ Đã tạo ${CONFIG.outputFile} với ${metadata.packs.length} packs và ${metadata.packs.reduce((sum, pack) => sum + pack.stickers.length, 0)} stickers`);
}

// Tạo cấu trúc mẫu
function createSampleStructure() {
    console.log('📁 Tạo cấu trúc thư mục mẫu...');
    
    // Tạo thư mục stickers
    if (!fs.existsSync(CONFIG.stickersDir)) {
        fs.mkdirSync(CONFIG.stickersDir, { recursive: true });
    }
    
    // Tạo thư mục mẫu
    const samplePackDir = path.join(CONFIG.stickersDir, 'pig-pack');
    if (!fs.existsSync(samplePackDir)) {
        fs.mkdirSync(samplePackDir, { recursive: true });
    }
    
    // Tạo file sticker mẫu (1x1 pixel PNG)
    const sampleStickerPath = path.join(samplePackDir, 'pig-helmet.png');
    if (!fs.existsSync(sampleStickerPath)) {
        const sampleImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
        fs.writeFileSync(sampleStickerPath, sampleImage);
        console.log('  ✅ Tạo sticker mẫu: pig-helmet.png');
    }
    
    // Tạo thư mục thumbnails
    const thumbnailDir = './thumbnails';
    if (!fs.existsSync(thumbnailDir)) {
        fs.mkdirSync(thumbnailDir, { recursive: true });
    }
    
    console.log('📁 Cấu trúc thư mục đã được tạo:');
    console.log('  stickers/');
    console.log('  └── pig-pack/');
    console.log('      └── pig-helmet.png');
    console.log('  thumbnails/');
    console.log('  └── pig-pack.png');
    
    // Generate metadata cho cấu trúc mẫu
    generateMetadata();
}

// Validate metadata
function validateMetadata() {
    console.log('🔍 Validating metadata...');
    
    if (!fs.existsSync(CONFIG.outputFile)) {
        console.error('❌ File metadata.json không tồn tại!');
        return;
    }
    
    try {
        const metadata = JSON.parse(fs.readFileSync(CONFIG.outputFile, 'utf8'));
        let totalStickers = 0;
        let missingFiles = 0;
        
        metadata.packs.forEach(pack => {
            console.log(`📦 Pack: ${pack.name} (${pack.stickers.length} stickers)`);
            
            pack.stickers.forEach(sticker => {
                totalStickers++;
                const filePath = path.join('.', sticker.url);
                
                if (!fs.existsSync(filePath)) {
                    console.warn(`  ⚠️  Missing: ${sticker.url}`);
                    missingFiles++;
                }
            });
        });
        
        console.log(`\n📊 Tổng kết:`);
        console.log(`  - Packs: ${metadata.packs.length}`);
        console.log(`  - Stickers: ${totalStickers}`);
        console.log(`  - Missing files: ${missingFiles}`);
        
        if (missingFiles === 0) {
            console.log('✅ Tất cả files đều tồn tại!');
        } else {
            console.log('⚠️  Có một số files bị thiếu. Vui lòng kiểm tra lại.');
        }
        
    } catch (error) {
        console.error('❌ Lỗi khi validate metadata:', error.message);
    }
}

// Xử lý command line arguments
const command = process.argv[2];

switch (command) {
    case 'validate':
        validateMetadata();
        break;
    case 'init':
        createSampleStructure();
        break;
    case 'help':
        console.log(`
🎨 SevenChat Sticker Metadata Generator

Usage:
  node generate-metadata.js          # Generate metadata từ thư mục stickers
  node generate-metadata.js validate # Validate metadata và kiểm tra files
  node generate-metadata.js init     # Tạo cấu trúc thư mục mẫu
  node generate-metadata.js help     # Hiển thị help

Cấu trúc thư mục:
  stickers/
  ├── pack1/
  │   ├── sticker1.png
  │   └── sticker2.png
  └── pack2/
      ├── sticker3.png
      └── sticker4.png

Output:
  metadata.json - File metadata chính
  thumbnails/   - Thư mục thumbnails cho packs
        `);
        break;
    default:
        generateMetadata();
        validateMetadata();
}

console.log('\n🎉 Done!');
