#!/usr/bin/env node

/**
 * Script để tự động generate metadata.json từ thư mục stickers
 * Usage: node scripts/generate-metadata.js
 */

const fs = require('fs');
const path = require('path');

// Cấu hình
const CONFIG = {
    stickersDir: './stickers',
    outputFile: './metadata.json',
    defaultCategory: 'general',
    supportedFormats: ['.png', '.jpg', '.jpeg', '.svg', '.gif'],
    maxFileSize: 1024 * 1024, // 1MB
    thumbnailSize: 128
};

// Tạo metadata template
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
    
    if (!fs.existsSync(packPath)) {
        console.log(`⚠️  Pack directory not found: ${packPath}`);
        return null;
    }
    
    const files = fs.readdirSync(packPath);
    const stickers = [];
    
    files.forEach((file, index) => {
        const ext = path.extname(file).toLowerCase();
        if (!CONFIG.supportedFormats.includes(ext)) {
            console.log(`Skipping unsupported file: ${file}`);
            return;
        }
        
        const filePath = path.join(packPath, file);
        const stats = fs.statSync(filePath);
        
        if (stats.size > CONFIG.maxFileSize) {
            console.log(`Skipping large file: ${file} (${stats.size} bytes)`);
            return;
        }
        
        const stickerId = `${packName}-${index + 1}`;
        const stickerName = path.parse(file).name.replace(/[-_]/g, ' ');
        
        // Tạo tags từ tên file
        const tags = generateTags(stickerName, packName);
        
        stickers.push({
            id: stickerId,
            name: stickerName,
            url: `stickers/${packDir}/${file}`,
            tags: tags,
            category: packName,
            pack: `${packName}-pack`,
            size: stats.size
        });
    });
    
    return {
        id: `${packName}-pack`,
        name: `${packName.charAt(0).toUpperCase() + packName.slice(1)} Pack`,
        description: `Collection of ${packName} stickers`,
        author: "SevenChat Team",
        version: "1.0.0",
        thumbnail: `thumbnails/${packName}-pack.png`,
        category: packName,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        stickers: stickers
    };
}

// Tạo tags từ tên file và pack
function generateTags(stickerName, packName) {
    const tags = [packName];
    
    // Thêm tags dựa trên tên
    const words = stickerName.toLowerCase().split(' ');
    tags.push(...words.filter(word => word.length > 2));
    
    // Thêm tags dựa trên pack name
    switch (packName.toLowerCase()) {
        case 'emotions':
            tags.push('emotion', 'feeling', 'mood');
            break;
        case 'animals':
            tags.push('animal', 'pet', 'cute');
            break;
        case 'food':
            tags.push('food', 'delicious', 'yummy');
            break;
        case 'celebration':
            tags.push('party', 'happy', 'celebration');
            break;
        case 'pig':
            tags.push('pig', 'cute', 'animal', 'pet');
            break;
        default:
            tags.push('sticker');
    }
    
    // Loại bỏ duplicates
    return [...new Set(tags)];
}

// Tạo thumbnail cho pack
function createThumbnail(packDir, packName) {
    const packPath = path.join(CONFIG.stickersDir, packDir);
    
    if (!fs.existsSync(packPath)) {
        return;
    }
    
    const files = fs.readdirSync(packPath);
    
    if (files.length === 0) return;
    
    // Lấy file đầu tiên làm thumbnail
    const firstFile = files.find(file => 
        CONFIG.supportedFormats.includes(path.extname(file).toLowerCase())
    );
    
    if (firstFile) {
        const thumbnailDir = path.dirname(CONFIG.outputFile);
        const thumbnailsDir = path.join(thumbnailDir, 'thumbnails');
        
        if (!fs.existsSync(thumbnailsDir)) {
            fs.mkdirSync(thumbnailsDir, { recursive: true });
        }
        
        const sourcePath = path.join(packPath, firstFile);
        const targetPath = path.join(thumbnailsDir, `${packName}-pack.png`);
        
        // Copy file làm thumbnail (có thể resize sau)
        fs.copyFileSync(sourcePath, targetPath);
        console.log(`✅ Created thumbnail: ${targetPath}`);
    }
}

// Main function
function generateMetadata() {
    console.log('🎨 Generating sticker metadata...');
    
    if (!fs.existsSync(CONFIG.stickersDir)) {
        console.error(`❌ Stickers directory not found: ${CONFIG.stickersDir}`);
        console.log('📁 Creating stickers directory...');
        fs.mkdirSync(CONFIG.stickersDir, { recursive: true });
    }
    
    const metadata = createMetadataTemplate();
    const packDirs = fs.readdirSync(CONFIG.stickersDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);
    
    console.log(`📁 Found ${packDirs.length} sticker packs:`, packDirs);
    
    if (packDirs.length === 0) {
        console.log('⚠️  No sticker packs found. Creating sample structure...');
        createSampleStructure();
        return;
    }
    
    packDirs.forEach(packDir => {
        console.log(`\n📦 Processing pack: ${packDir}`);
        
        try {
            const pack = createStickerPack(packDir, packDir);
            if (pack) {
                metadata.packs.push(pack);
                
                // Tạo thumbnail
                createThumbnail(packDir, packDir);
                
                console.log(`✅ Added ${pack.stickers.length} stickers to ${pack.name}`);
            }
        } catch (error) {
            console.error(`❌ Error processing pack ${packDir}:`, error.message);
        }
    });
    
    // Tính tổng số stickers
    const totalStickers = metadata.packs.reduce((sum, pack) => sum + pack.stickers.length, 0);
    console.log(`\n📊 Total: ${metadata.packs.length} packs, ${totalStickers} stickers`);
    
    // Lưu metadata
    const outputPath = path.resolve(CONFIG.outputFile);
    fs.writeFileSync(outputPath, JSON.stringify(metadata, null, 2));
    
    console.log(`\n✅ Metadata saved to: ${outputPath}`);
    
    // Tạo summary
    console.log('\n📋 Summary:');
    metadata.packs.forEach(pack => {
        console.log(`  - ${pack.name}: ${pack.stickers.length} stickers`);
    });
}

// Tạo cấu trúc mẫu
function createSampleStructure() {
    console.log('📁 Creating sample sticker structure...');
    
    // Tạo thư mục mẫu
    const sampleDirs = ['emotions', 'animals', 'food', 'celebration'];
    
    sampleDirs.forEach(dir => {
        const dirPath = path.join(CONFIG.stickersDir, dir);
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
            console.log(`✅ Created directory: ${dirPath}`);
        }
    });
    
    console.log('\n📝 Sample structure created. Please add your sticker files to the directories:');
    sampleDirs.forEach(dir => {
        console.log(`  - ${CONFIG.stickersDir}/${dir}/`);
    });
    
    console.log('\n🔄 Run this script again after adding stickers to generate metadata.');
}

// Validate metadata
function validateMetadata() {
    console.log('\n🔍 Validating metadata...');
    
    if (!fs.existsSync(CONFIG.outputFile)) {
        console.error(`❌ Metadata file not found: ${CONFIG.outputFile}`);
        return;
    }
    
    const metadata = JSON.parse(fs.readFileSync(CONFIG.outputFile, 'utf8'));
    
    let isValid = true;
    let totalSize = 0;
    let missingFiles = [];
    
    metadata.packs.forEach(pack => {
        pack.stickers.forEach(sticker => {
            const filePath = path.resolve(sticker.url);
            
            if (!fs.existsSync(filePath)) {
                console.error(`❌ Missing file: ${sticker.url}`);
                missingFiles.push(sticker.url);
                isValid = false;
            } else {
                const stats = fs.statSync(filePath);
                totalSize += stats.size;
            }
        });
    });
    
    if (isValid) {
        console.log(`✅ All files exist`);
        console.log(`📊 Total size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
    } else {
        console.error(`❌ Validation failed - ${missingFiles.length} missing files`);
        console.log('💡 Make sure all sticker files are in the correct directories');
    }
}

// CLI commands
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
🎨 Sticker Metadata Generator

Usage:
  node scripts/generate-metadata.js [command]

Commands:
  (no command)    Generate metadata from stickers directory
  validate        Validate existing metadata
  init           Create sample directory structure
  help           Show this help

Configuration:
  - Stickers directory: ${CONFIG.stickersDir}
  - Output file: ${CONFIG.outputFile}
  - Supported formats: ${CONFIG.supportedFormats.join(', ')}
  - Max file size: ${CONFIG.maxFileSize / 1024} KB

Directory structure:
  ${CONFIG.stickersDir}/
  ├── emotions/
  │   ├── happy.png
  │   └── sad.png
  ├── animals/
  │   ├── cat.png
  │   └── dog.png
  └── ...

Output:
  - metadata.json
  - thumbnails/

Examples:
  node scripts/generate-metadata.js init    # Create sample structure
  node scripts/generate-metadata.js         # Generate metadata
  node scripts/generate-metadata.js validate # Validate metadata
        `);
        break;
    default:
        generateMetadata();
        validateMetadata();
}

console.log('\n🎉 Done!');
