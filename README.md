# 🎨 SevenChat Stickers

Collection of stickers for SevenChat app.

## 📦 Sticker Packs

### Pig Stickers Pack
- **ID**: `pig-pack`
- **Description**: Collection of cute pig stickers with various emotions and expressions
- **Stickers**: 26 stickers
- **Tags**: pig, cute, animal, pet, emotions, expressions
- **Category**: animals

## 🚀 Usage

### In SevenChat App
```typescript
import stickerRepository from './utils/StickerRepository';

// Load all stickers
const stickers = await stickerRepository.loadAllStickers();

// Search stickers
const results = await stickerRepository.searchStickers('pig');

// Get stickers by category
const animalStickers = await stickerRepository.getStickersByCategory('animals');

// Get stickers by pack
const pigStickers = await stickerRepository.getStickersByPack('pig-pack');
```

### Direct URLs
- **Metadata**: `https://raw.githubusercontent.com/seven-gitt/sevenchat-stickers/main/metadata.json`
- **Sticker**: `https://raw.githubusercontent.com/seven-gitt/sevenchat-stickers/main/stickers/pig/pig-happy.png`

## 📁 Repository Structure

```
sevenchat-stickers/
├── metadata.json          # Sticker metadata
├── README.md              # This file
├── scripts/               # Automation scripts
│   └── generate-metadata.js
├── stickers/              # Sticker files
│   └── pig/               # Pig stickers pack
│       ├── pig-helmet.png
│       ├── pig-push-cart.png
│       ├── pig-hug.png
│       └── ...
└── thumbnails/            # Pack thumbnails
    └── pig-pack.png
```

## 🛠️ Development

### Adding New Stickers

1. **Add sticker files** to appropriate folder (e.g., `stickers/pig/`)
2. **Run metadata generator**:
   ```bash
   node scripts/generate-metadata.js
   ```
3. **Validate metadata**:
   ```bash
   node scripts/generate-metadata.js validate
   ```
4. **Commit and push** changes to GitHub

### Scripts

- `node scripts/generate-metadata.js` - Generate metadata from stickers
- `node scripts/generate-metadata.js validate` - Validate existing metadata
- `node scripts/generate-metadata.js init` - Create sample directory structure
- `node scripts/generate-metadata.js help` - Show help

### Supported Formats

- PNG (recommended)
- JPG/JPEG
- SVG
- GIF

### File Naming Convention

- Use descriptive names: `pig-happy.png`, `pig-sad.png`
- Use lowercase and hyphens
- Include pack name prefix: `pig-`, `emotions-`, etc.

## 🔧 Integration

### Update App Configuration

In your SevenChat app, update the repository URLs:

```typescript
// src/utils/StickerRepository.ts
this.addRepository({
    name: 'sevenchat-stickers',
    description: 'SevenChat Sticker Collection',
    baseUrl: 'https://raw.githubusercontent.com/seven-gitt/sevenchat-stickers/main',
    metadataUrl: 'https://raw.githubusercontent.com/seven-gitt/sevenchat-stickers/main/metadata.json',
    packs: []
});
```

### Test Connection

```typescript
// Test repository connection
const isConnected = await stickerRepository.testRepositoryConnection('sevenchat-stickers');
console.log('Repository connected:', isConnected);
```

## 📊 Sticker Categories

### Animals
- **Pig Pack**: 26 cute pig stickers with various emotions

### Planned Categories
- **Emotions**: Happy, sad, angry, surprised, etc.
- **Food**: Delicious food stickers
- **Celebration**: Party, birthday, congratulations
- **Nature**: Flowers, trees, weather
- **Objects**: Everyday objects and items

## 🤝 Contributing

1. **Fork** this repository
2. **Add** your stickers to appropriate folders
3. **Run** metadata generator: `node scripts/generate-metadata.js`
4. **Test** validation: `node scripts/generate-metadata.js validate`
5. **Commit** and push changes
6. **Submit** pull request

### Guidelines

- **Quality**: Use high-quality, optimized images
- **Size**: Keep files under 1MB each
- **Format**: Prefer PNG with transparent background
- **Naming**: Use descriptive, consistent naming
- **Tags**: Add relevant tags for better search

## 📄 License

This project is licensed under the MIT License.

## 🔗 Links

- **Repository**: https://github.com/seven-gitt/sevenchat-stickers
- **Raw Content**: https://raw.githubusercontent.com/seven-gitt/sevenchat-stickers/main/
- **Issues**: https://github.com/seven-gitt/sevenchat-stickers/issues

## 📈 Statistics

- **Total Stickers**: 26
- **Packs**: 1
- **Categories**: 1
- **Total Size**: ~2.5 MB

---

Made with ❤️ for SevenChat
