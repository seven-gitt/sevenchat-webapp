/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

import { blobIsAnimated } from "./Image";

/**
 * Utility class for optimizing GIF performance
 */
export class GifOptimizer {
    private static instance: GifOptimizer;
    private cache = new Map<string, string>();
    private preloadQueue = new Set<string>();
    private maxCacheSize = 50;

    static getInstance(): GifOptimizer {
        if (!GifOptimizer.instance) {
            GifOptimizer.instance = new GifOptimizer();
        }
        return GifOptimizer.instance;
    }

    /**
     * Get optimized GIF URL (thumbnail if available)
     */
    getOptimizedUrl(originalUrl: string, size: 'tiny' | 'small' | 'medium' = 'small'): string {
        // Check cache first
        const cacheKey = `${originalUrl}_${size}`;
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey)!;
        }

        // Try to get thumbnail URL based on Tenor URL patterns
        let optimizedUrl = originalUrl;
        
        if (originalUrl.includes('tenor.com') || originalUrl.includes('media.tenor.com')) {
            // Tenor URL optimization
            if (size === 'tiny') {
                optimizedUrl = originalUrl.replace(/\.gif$/, '_200.gif');
            } else if (size === 'small') {
                optimizedUrl = originalUrl.replace(/\.gif$/, '_400.gif');
            }
        } else if (originalUrl.includes('giphy.com')) {
            // Giphy URL optimization
            if (size === 'tiny') {
                optimizedUrl = originalUrl.replace(/\.gif$/, '_200.gif');
            } else if (size === 'small') {
                optimizedUrl = originalUrl.replace(/\.gif$/, '_400.gif');
            }
        }

        // Cache the result
        this.cache.set(cacheKey, optimizedUrl);
        this.cleanupCache();

        return optimizedUrl;
    }

    /**
     * Preload GIF for faster display
     */
    async preloadGif(url: string): Promise<void> {
        if (this.preloadQueue.has(url)) return;
        
        this.preloadQueue.add(url);
        
        try {
            const response = await fetch(url, { method: 'HEAD' });
            if (response.ok) {
                // Preload successful, add to cache
                this.cache.set(url, url);
            }
        } catch (error) {
            console.warn('Failed to preload GIF:', url, error);
        } finally {
            this.preloadQueue.delete(url);
        }
    }

    /**
     * Batch preload multiple GIFs
     */
    async preloadGifs(urls: string[]): Promise<void> {
        const promises = urls.slice(0, 5).map(url => this.preloadGif(url)); // Limit to 5 concurrent
        await Promise.allSettled(promises);
    }

    /**
     * Compress image blob if possible (but preserve GIF animation)
     */
    async compressGif(blob: Blob, maxSizeKB: number = 500): Promise<Blob> {
        if (blob.size <= maxSizeKB * 1024) {
            return blob;
        }

        // Don't compress animated GIFs as it will break animation
        if (blob.type === 'image/gif') {
            try {
                const isAnimated = await blobIsAnimated(blob.type, blob);
                if (isAnimated) {
                    console.log('Skipping compression for animated GIF to preserve animation');
                    return blob;
                }
            } catch (error) {
                console.warn('Could not check if GIF is animated, skipping compression:', error);
                return blob;
            }
        }

        try {
            // Create a canvas to compress the image
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            if (!ctx) return blob;

            const img = new Image();
            const objectUrl = URL.createObjectURL(blob);
            
            return new Promise((resolve) => {
                img.onload = () => {
                    // Calculate new dimensions to reduce file size
                    const maxDimension = 400;
                    let { width, height } = img;
                    
                    if (width > maxDimension || height > maxDimension) {
                        const ratio = Math.min(maxDimension / width, maxDimension / height);
                        width *= ratio;
                        height *= ratio;
                    }

                    canvas.width = width;
                    canvas.height = height;
                    
                    // Draw compressed image
                    ctx.drawImage(img, 0, 0, width, height);
                    
                    // Convert to blob with reduced quality
                    // Use JPEG for better compression for static images
                    canvas.toBlob((compressedBlob) => {
                        URL.revokeObjectURL(objectUrl);
                        resolve(compressedBlob || blob);
                    }, 'image/jpeg', 0.8);
                };
                
                img.onerror = () => {
                    URL.revokeObjectURL(objectUrl);
                    resolve(blob);
                };
                
                img.src = objectUrl;
            });
        } catch (error) {
            console.warn('Failed to compress image:', error);
            return blob;
        }
    }

    /**
     * Get GIF metadata for optimization
     */
    async getGifMetadata(url: string): Promise<{
        size: number;
        dimensions: { width: number; height: number };
        isAnimated: boolean;
    } | null> {
        try {
            const response = await fetch(url);
            const blob = await response.blob();
            
            return new Promise((resolve) => {
                const img = new Image();
                const objectUrl = URL.createObjectURL(blob);
                
                img.onload = () => {
                    URL.revokeObjectURL(objectUrl);
                    resolve({
                        size: blob.size,
                        dimensions: { width: img.width, height: img.height },
                        isAnimated: blob.type === 'image/gif'
                    });
                };
                
                img.onerror = () => {
                    URL.revokeObjectURL(objectUrl);
                    resolve(null);
                };
                
                img.src = objectUrl;
            });
        } catch (error) {
            console.warn('Failed to get GIF metadata:', error);
            return null;
        }
    }

    /**
     * Clean up cache to prevent memory leaks
     */
    private cleanupCache(): void {
        if (this.cache.size > this.maxCacheSize) {
            const entries = Array.from(this.cache.entries());
            const toDelete = entries.slice(0, entries.length - this.maxCacheSize);
            toDelete.forEach(([key]) => this.cache.delete(key));
        }
    }

    /**
     * Clear all caches
     */
    clearCache(): void {
        this.cache.clear();
        this.preloadQueue.clear();
    }

    /**
     * Get cache statistics
     */
    getCacheStats(): { size: number; maxSize: number; preloadQueue: number } {
        return {
            size: this.cache.size,
            maxSize: this.maxCacheSize,
            preloadQueue: this.preloadQueue.size
        };
    }
}

// Export singleton instance
export const gifOptimizer = GifOptimizer.getInstance();
