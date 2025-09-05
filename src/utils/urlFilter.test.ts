/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

/**
 * Test utility for URL filtering logic
 */

// Hàm kiểm tra xem URL có phải là file media không (copy từ UrlsPanel.tsx)
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

// Test cases
const testCases = [
    // Should be filtered out (media URLs)
    { url: 'https://media.tenor.com/abc123.gif', expected: true, description: 'Tenor GIF URL' },
    { url: 'https://c.tenor.com/xyz789.gif', expected: true, description: 'Tenor CDN GIF URL' },
    { url: 'https://media.giphy.com/media/abc123/giphy.gif', expected: true, description: 'Giphy GIF URL' },
    { url: 'https://i.giphy.com/xyz789.gif', expected: true, description: 'Giphy image URL' },
    { url: 'https://example.com/image.jpg', expected: true, description: 'JPG image URL' },
    { url: 'https://example.com/video.mp4', expected: true, description: 'MP4 video URL' },
    { url: 'https://example.com/audio.mp3', expected: true, description: 'MP3 audio URL' },
    { url: 'https://example.com/document.pdf', expected: true, description: 'PDF document URL' },
    { url: 'https://example.com/media/file.gif', expected: true, description: 'Media path URL' },
    { url: 'https://example.com/image/photo.png', expected: true, description: 'Image path URL' },
    
    // Should NOT be filtered out (regular URLs)
    { url: 'https://example.com', expected: false, description: 'Regular website URL' },
    { url: 'https://www.google.com', expected: false, description: 'Google URL' },
    { url: 'https://github.com/user/repo', expected: false, description: 'GitHub repository URL' },
    { url: 'https://stackoverflow.com/questions/123', expected: false, description: 'Stack Overflow URL' },
    { url: 'https://example.com/page', expected: false, description: 'Regular page URL' },
    { url: 'https://example.com/blog/post-title', expected: false, description: 'Blog post URL' },
    { url: 'https://example.com/api/data', expected: false, description: 'API endpoint URL' },
    { url: 'https://example.com/search?q=test', expected: false, description: 'Search URL with query' },
    { url: 'https://example.com/user/profile', expected: false, description: 'User profile URL' },
    { url: 'https://example.com/news/article', expected: false, description: 'News article URL' },
];

// Run tests
console.log('Testing URL filtering logic...\n');

let passed = 0;
let failed = 0;

testCases.forEach(({ url, expected, description }) => {
    const result = isMediaUrl(url);
    const status = result === expected ? '✅ PASS' : '❌ FAIL';
    
    if (result === expected) {
        passed++;
    } else {
        failed++;
    }
    
    console.log(`${status} ${description}`);
    console.log(`   URL: ${url}`);
    console.log(`   Expected: ${expected ? 'Media URL (filtered)' : 'Regular URL (kept)'}`);
    console.log(`   Got: ${result ? 'Media URL (filtered)' : 'Regular URL (kept)'}\n`);
});

console.log(`\nTest Results: ${passed} passed, ${failed} failed`);

if (failed === 0) {
    console.log('🎉 All tests passed!');
} else {
    console.log('⚠️  Some tests failed. Please review the logic.');
}

export { isMediaUrl };
